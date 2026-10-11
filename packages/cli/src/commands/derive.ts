import {
  deriveVariant, durationFrames, pickHighlights, validateTimeline, variantStale, type DeriveOptions, type Op, type Timeline,
} from '@solocut/core';
import { decide } from '@solocut/decide';
import { loadSettings } from '@solocut/settings';
import { derivedTargets, type Template } from '@solocut/templates';
import { CliError, emit, info, intOpt, opts, t, type Ctx } from '../ctx.js';
import {
  VARIANTS, applyEdit, openProject, paths, projectTemplate, readStatus, readTimeline, setStep, variantExists, vpaths, writeTimeline,
  type Project, type Variant,
} from '../project.js';
import { apiKeyFor } from '../keys.js';
import { buildCaptionsFor, readTranscript } from './media.js';

// docs/18: derive the vertical variants (TikTok, YouTube Shorts) from the main timeline. The engine does the
// conversion (core.deriveVariant / pickHighlights / variantStale); the CLI picks the selection, keeps human edits of an
// existing variant, rebuilds its captions and records history/status.

/** Whether a variant was made from an older main timeline. */
export function isStale(main: Timeline, variant: Timeline): boolean {
  return variantStale(main, variant);
}

export interface VariantInfo { exists: boolean; stale: boolean; lastCheckFailed: number }

/** Exists / stale / last check of every variant the template derives (for `next` and `status`). */
export function variantInfo(p: Project, tpl: Template, main: Timeline | null): Record<string, VariantInfo> {
  const out: Record<string, VariantInfo> = {};
  for (const v of derivedTargets(tpl)) {
    if (!(VARIANTS as readonly string[]).includes(v)) continue;
    if (!variantExists(p.dir, v as Variant)) {
      out[v] = { exists: false, stale: false, lastCheckFailed: 0 };
      continue;
    }
    try {
      const vt = readTimeline({ dir: p.dir, variant: v as Variant });
      out[v] = { exists: true, stale: main ? isStale(main, vt) : false, lastCheckFailed: vt.review.lastCheck?.failed ?? 0 };
    } catch {
      out[v] = { exists: true, stale: true, lastCheckFailed: 0 };
    }
  }
  return out;
}

/** Ops that turn `old` into `next` (same canvas), so a re-derive is one undoable history entry. */
export function replacementOps(old: Timeline, next: Timeline): Op[] {
  const ops: Op[] = [];
  for (const [id, s] of Object.entries(next.sources)) if (JSON.stringify(old.sources[id]) !== JSON.stringify(s)) ops.push({ op: 'addSource', id, source: s });
  ops.push({ op: 'setMeta', patch: next.meta });
  ops.push({ op: 'setOutline', outline: next.outline });
  ops.push({ op: 'setSegments', segments: next.segments });
  ops.push({ op: 'setCaptions', captions: next.captions });
  for (const o of old.overlays) ops.push({ op: 'removeOverlay', id: o.id });
  for (const o of next.overlays) ops.push({ op: 'addOverlay', overlay: o });
  for (const s of old.scenes) ops.push({ op: 'removeScene', id: s.id });
  for (const s of next.scenes) ops.push({ op: 'addScene', scene: s });
  for (const s of old.audio.sfx) ops.push({ op: 'removeSfx', id: s.id });
  for (const s of next.audio.sfx) ops.push({ op: 'addSfx', sfx: s });
  ops.push({ op: 'setBgm', bgm: next.audio.bgm });
  ops.push({ op: 'setVoice', patch: next.audio.voice });
  for (const m of old.masks) ops.push({ op: 'removeMask', id: m.id });
  for (const m of next.masks) ops.push({ op: 'addMask', mask: m });
  ops.push({ op: 'setMarkers', markers: next.markers });
  for (const o of old.outputs) if (!next.outputs.some((x) => x.target === o.target)) ops.push({ op: 'removeOutput', target: o.target });
  for (const o of next.outputs) ops.push({ op: 'setOutput', output: o });
  ops.push({ op: 'setReview', patch: next.review });
  if (JSON.stringify(old.transcript ?? null) !== JSON.stringify(next.transcript ?? null)) ops.push({ op: 'setTranscript', transcript: next.transcript ?? null });
  for (const id of Object.keys(old.sources)) if (!next.sources[id]) ops.push({ op: 'removeSource', id });
  return ops;
}

/**
 * Carry over what a human changed in the old variant: overlays, scenes, sfx and masks decided by a human (when they
 * fit the new length and do not collide), and the output's metadata / thumbnail / publish record.
 */
export function keepHumanEdits(old: Timeline, next: Timeline): { timeline: Timeline; kept: string[] } {
  const total = durationFrames(next);
  const ids = new Set<string>([...next.overlays.map((x) => x.id), ...next.scenes.map((x) => x.id), ...next.audio.sfx.map((x) => x.id), ...next.masks.map((x) => x.id)]);
  const human = (d: unknown) => (d as { by?: string } | undefined)?.by === 'human';
  const fits = (r: { start: number; end: number }) => r.end <= total;
  const kept: string[] = [];
  const take = <T extends { id: string }>(list: T[], ok: (x: T) => boolean): T[] => list.filter((x) => {
    if (ids.has(x.id) || !ok(x)) return false;
    kept.push(x.id);
    return true;
  });
  const overlays = take(old.overlays, (o) => (o.kind === 'telop' || o.kind === 'image') && human(o.decided) && fits(o.range));
  const scenes = take(old.scenes, (s) => human(s.decided) && fits(s.range));
  const sfx = take(old.audio.sfx, (s) => human(s.decided) && s.at < total);
  const masks = take(old.masks, (m) => human(m.decided));
  const sources = { ...next.sources };
  for (const x of [...overlays, ...scenes, ...sfx, ...masks]) {
    const refs = JSON.stringify(x).match(/"(?:asset|source)":"([^"]+)"/g) ?? [];
    for (const r of refs) {
      const id = r.slice(r.indexOf(':') + 2, -1);
      if (!sources[id] && old.sources[id]) sources[id] = old.sources[id]!;
    }
  }
  const outputs = next.outputs.map((o) => {
    const prev = old.outputs.find((x) => x.target === o.target);
    return prev ? { ...o, metadata: prev.metadata, ...(prev.thumbnail ? { thumbnail: prev.thumbnail } : {}), ...(prev.publish ? { publish: prev.publish } : {}) } : o;
  });
  return {
    timeline: {
      ...next, sources, overlays: [...next.overlays, ...overlays], scenes: [...next.scenes, ...scenes], masks: [...next.masks, ...masks],
      audio: { ...next.audio, sfx: [...next.audio.sfx, ...sfx] }, outputs,
    },
    kept,
  };
}

/** Decision-model scores "is this segment interesting / understandable on its own" (0..1), when configured. */
async function highlightScores(ctx: Ctx, p: Project, main: Timeline, warnings: string[]): Promise<Record<string, number> | undefined> {
  const s = loadSettings();
  if (s.decision.provider === 'off') return undefined;
  const segs = main.segments.filter((x) => x.text.trim()).slice(0, 80);
  if (!segs.length) return undefined;
  try {
    const key = apiKeyFor(ctx.io.env, s.decision.apiKeyRef, s.decision.provider);
    const answers = await decide({
      state: { title: main.meta.title, goal: main.meta.goal, audience: main.meta.audience, segments: segs.map((x) => ({ id: x.id, role: x.role, text: x.text })) },
      questions: segs.map((x) => ({ id: x.id, kind: 'score' as const, text: t(ctx, `区間 ${x.id} は、縦型の短い動画の一部として単体で見て面白い・分かるか`, `Is segment ${x.id} interesting and understandable on its own in a short vertical video?`) })),
    }, {
      provider: s.decision.provider, model: s.decision.model, ...(s.decision.endpoint ? { endpoint: s.decision.endpoint } : {}),
      ...(key ? { apiKey: key } : {}), cacheDir: `${paths(p.dir).cache}/decisions`,
    });
    return Object.fromEntries(answers.map((a) => [a.id, a.score ?? 0]));
  } catch (e) {
    warnings.push(`decision model: ${(e as Error).message}`);
    return undefined;
  }
}

export async function cmdDerive(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, {
    target: { type: 'string' }, 'max-sec': { type: 'string' }, selection: { type: 'string' }, replace: { type: 'boolean' }, 'no-captions': { type: 'boolean' },
  }, { max: 0, usage: 'solocut derive --target tiktok|youtube-shorts [--max-sec N] [--selection seg_1,seg_2] [--replace]' });
  const target = values.target as Variant | undefined;
  if (!target || !(VARIANTS as readonly string[]).includes(target)) throw new CliError('usage', `--target must be one of ${VARIANTS.join(', ')}`);
  const p0 = openProject({ ...ctx, variant: undefined } as Ctx);
  const p: Project = { ...p0, variant: null };
  const pv: Project = { ...p0, variant: target };
  const tpl = projectTemplate(p);
  const main = readTimeline(p);
  if (!main.segments.length) throw new CliError('no-segments', t(ctx, '本編に区間がありません。先に本編を編集してください', 'the main timeline has no segments yet'));
  type OutCfg = NonNullable<NonNullable<Template['outputs']>[Variant]>;
  const cfg: Partial<OutCfg> = tpl.outputs?.[target] ?? { derive: 'vertical', maxSec: target === 'youtube-shorts' ? 60 : 90, captions: 'tiktok-bold' };
  if (tpl.outputs && !derivedTargets(tpl).includes(target)) {
    throw new CliError('disabled', t(ctx, `テンプレート ${tpl.id} は ${target} を作らない設定です（outputs.${target}）`, `template ${tpl.id} does not derive ${target} (outputs.${target})`));
  }
  const fps = main.canvas.fps.num / main.canvas.fps.den;
  const maxSec = values['max-sec'] !== undefined ? intOpt(values['max-sec'], 'max-sec')! : cfg.maxSec ?? (target === 'youtube-shorts' ? 60 : 90);
  if (!(maxSec >= 5 && maxSec <= 600)) throw new CliError('usage', '--max-sec must be 5..600');
  const maxFrames = Math.round(maxSec * fps);
  const warnings: string[] = [];
  const exists = variantExists(p.dir, target);
  const old = exists ? readTimeline(pv) : null;
  if (old && !values.replace && !isStale(main, old) && !values.selection) {
    throw new CliError('exists', t(ctx, `${target} の版はすでにあり、本編から変わっていません。作り直すなら --replace`, `${target} already exists and is up to date; use --replace to rebuild`));
  }
  // selection: explicit → same as another variant → highlights (decision-model scores when configured)
  let selection: string[];
  if (values.selection) {
    selection = values.selection.split(',').map((x) => x.trim()).filter(Boolean);
    const missing = selection.filter((id) => !main.segments.some((s) => s.id === id));
    if (missing.length) throw new CliError('usage', t(ctx, `本編にない区間: ${missing.join(', ')}`, `not in the main timeline: ${missing.join(', ')}`));
  } else {
    const same = cfg.sameAs && cfg.sameAs !== target && (VARIANTS as readonly string[]).includes(cfg.sameAs) && variantExists(p.dir, cfg.sameAs as Variant)
      ? readTimeline({ dir: p.dir, variant: cfg.sameAs as Variant }).meta.derivedFrom?.selection.map((x) => x.segment).filter((id) => main.segments.some((s) => s.id === id))
      : undefined;
    if (same?.length) {
      // the same picks, trimmed to this target's length by the engine
      const scores = Object.fromEntries(main.segments.map((s) => [s.id, same.includes(s.id) ? 1 : 0]));
      selection = pickHighlights(main, { maxFrames, scores }).filter((id) => same.includes(id));
      if (!selection.length) selection = same;
    } else {
      const scores = await highlightScores(ctx, p, main, warnings);
      selection = pickHighlights(main, { maxFrames, ...(scores ? { scores } : {}) });
    }
  }
  if (!selection.length) throw new CliError('nothing-selected', t(ctx, '選べる区間がありませんでした', 'no segments could be selected'));
  const layoutMap = cfg.layout && tpl.layouts.default !== cfg.layout ? { [tpl.layouts.default]: cfg.layout } as DeriveOptions['layoutMap'] : undefined;
  let next = deriveVariant(main, target, {
    selection, maxFrames, ...(cfg.captions ? { captionStyle: cfg.captions } : {}), ...(layoutMap ? { layoutMap } : {}),
    reframe: 'face', hookSegment: selection[0]!, rules: `prompts/vertical.md (${tpl.id}@${tpl.version})`,
  });
  let kept: string[] = [];
  if (old) ({ timeline: next, kept } = keepHumanEdits(old, next));
  const v = validateTimeline(next);
  if (!v.ok) throw new CliError('invalid-result', `derived ${target} timeline is invalid: ${v.issues.filter((i) => i.level === 'error').slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')}`, v.issues);
  if (old && JSON.stringify(old.canvas) === JSON.stringify(v.timeline.canvas)) {
    await applyEdit(pv, replacementOps(old, v.timeline), { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), note: `derive ${target}` });
  } else {
    writeTimeline(pv, v.timeline);
  }
  let captions = 0;
  if (!values['no-captions'] && readTranscript(p)) {
    try {
      captions = (await buildCaptionsFor(ctx, pv)).captions;
    } catch (e) {
      warnings.push(`captions: ${(e as Error).message}`);
    }
  }
  setStep(p, `derive:${target}`, 'done');
  const checkState = readStatus(p, tpl).find((s) => s.step === `check:${target}`)?.state;
  if (checkState === 'done') setStep(p, `check:${target}`, 'todo', t(ctx, '作り直したので、もう一度チェックする', 're-derived: check again'));
  const tl = readTimeline(pv);
  const dur = durationFrames(tl) / fps;
  info(ctx, t(ctx, `次: solocut render --preview --variant ${target} → solocut check --variant ${target}`, `next: solocut render --preview --variant ${target} → solocut check --variant ${target}`));
  emit(ctx, {
    target, variant: target, path: vpaths(pv).timeline.slice(p.dir.length + 1).split('\\').join('/'), selection, segments: tl.segments.length,
    durationSec: Math.round(dur * 10) / 10, maxSec, captions, kept, replaced: !!old, warnings,
  }, () => [
    t(ctx, `${target} の版を作りました: ${tl.segments.length} 区間、${Math.round(dur)} 秒（上限 ${maxSec} 秒）`, `derived ${target}: ${tl.segments.length} segments, ${Math.round(dur)}s (max ${maxSec}s)`),
    `  ${t(ctx, '選んだ区間', 'selection')}: ${selection.join(', ')}`,
    ...(kept.length ? [t(ctx, `  人が直した要素を残しました: ${kept.join(', ')}`, `  kept human edits: ${kept.join(', ')}`)] : []),
    ...warnings.map((w) => `! ${w}`),
  ]);
}
