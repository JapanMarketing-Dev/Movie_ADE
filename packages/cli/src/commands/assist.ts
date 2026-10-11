import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  applyTracks, benchmarkProfile, cameraMaterial, checkCameraSwitches, fpsValue, frameToTimecode, overlaysFromInputLogs,
  profileToTemplatePatch, sfxFromRules, type BenchmarkSample, type LicenseRef, type Mask, type Op, type SfxLibraryItem,
  type StyleProfile, type Timeline,
} from '@solocut/core';
import { solocutHome } from '@solocut/toolchain';
import { loadAnalysis } from '../analysis.js';
import { piiMaskOps, type PiiFile } from '../pii.js';
import { CliError, emit, opts, t, type Ctx } from '../ctx.js';
import { applyEdit, openProject, projectTemplate, readJsonFile, readTimeline, setStep, writeAtomic, writeTemplateOverride, type Project } from '../project.js';
import { media, readTranscript } from './media.js';

// CLI for the engine's round-5 helpers: template sfx rules, PII masks, multicam material, tracked zoom / input
// overlays and benchmark profiles. Each command computes ops with core and applies them as one undoable edit.

const by = (ctx: Ctx) => ({ by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}) });
const relp = (p: Project, f: string) => relative(p.dir, f).split('\\').join('/');

/** Apply ops (or only validate with --dry-run); returns whether anything changed. */
async function apply(ctx: Ctx, p: Project, ops: Op[], note: string, dryRun: boolean): Promise<{ changed: boolean; warnings: string[] }> {
  if (!ops.length) return { changed: false, warnings: [] };
  const r = await applyEdit(p, ops, { ...by(ctx), note, dryRun });
  return { changed: r.changed, warnings: r.issues.map((i) => `${i.level}: ${i.path}: ${i.message}`) };
}

// ---------- sfx apply ----------

const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac']);

interface Sidecar { id?: string; kind?: string; category?: string; features?: { durationMs?: number }; license?: { spdx?: string; url?: string }; author?: string; sourceUrl?: string; title?: string }

function walk(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const f = join(dir, name);
    if (statSync(f).isDirectory()) out.push(...walk(f, depth - 1));
    else if (AUDIO_EXT.has(extname(name).toLowerCase())) out.push(f);
  }
  return out;
}

const safeId = (s: string) => s.normalize('NFKC').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'x';

/**
 * Sound effects the rules can pick from: sfx already in the timeline (asset sources whose id / assetId looks like
 * `sfx_<category>_…`), the project's assets/sfx/<category>/ files and the downloaded library cache
 * (~/.solocut/library/cache/sfx/<category>/). A `<file>.json` sidecar (docs/16) gives id, category, duration and
 * license. Files outside the project are copied into assets/library/ when used.
 */
async function sfxLibrary(p: Project, tl: Timeline, warnings: string[]): Promise<{ items: SfxLibraryItem[]; copies: Map<string, string> }> {
  const items: SfxLibraryItem[] = [];
  const copies = new Map<string, string>();   // project-relative destination → absolute source
  const seen = new Set<string>();
  const m = await media();
  const durationMs = async (file: string): Promise<number | null> => {
    try {
      return Math.round((await m.probe(file)).durationSec * 1000);
    } catch {
      warnings.push(`cannot read ${file}`);
      return null;
    }
  };
  for (const [id, s] of Object.entries(tl.sources)) {
    if (s.kind !== 'asset') continue;
    const cat = /^sfx[_-]([a-z]+)/i.exec(s.assetId)?.[1] ?? /^sfx[_-]([a-z]+)/i.exec(id)?.[1];
    if (!cat) continue;
    const f = join(p.dir, s.path);
    const d = existsSync(f) ? await durationMs(f) : null;
    if (d === null) continue;
    items.push({ id, kind: cat.toLowerCase(), durationMs: d });
    seen.add(resolve(f));
  }
  const roots: { dir: string; inProject: boolean }[] = [
    { dir: join(p.dir, 'assets', 'sfx'), inProject: true },
    { dir: join(solocutHome(), 'library', 'cache', 'sfx'), inProject: false },
  ];
  for (const root of roots) {
    for (const f of walk(root.dir)) {
      if (seen.has(resolve(f))) continue;
      seen.add(resolve(f));
      let side: Sidecar = {};
      for (const sc of [`${f}.json`, join(dirname(f), `${basename(f, extname(f))}.json`)]) {
        if (!existsSync(sc)) continue;
        try {
          side = JSON.parse(readFileSync(sc, 'utf8')) as Sidecar;
        } catch {
          warnings.push(`${sc}: invalid JSON`);
        }
        break;
      }
      if (side.kind && side.kind !== 'sfx') continue;
      const relDir = relative(root.dir, dirname(f)).split('\\').join('/');
      const kind = (side.category ?? (relDir && relDir !== '.' ? relDir.split('/')[0]! : basename(f, extname(f)).split(/[_-]/)[0]!)).toLowerCase();
      const d = side.features?.durationMs ?? (await durationMs(f));
      if (d === null || !(d > 0)) continue;
      const id = side.id && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(side.id) ? side.id : `sfx_${safeId(kind)}_${safeId(basename(f, extname(f)))}`;
      if (tl.sources[id]) continue;
      const path = root.inProject ? relp(p, f) : `assets/library/${id}${extname(f).toLowerCase()}`;
      if (!root.inProject) copies.set(path, f);
      const credit = side.author ? `${side.title ?? id} — ${side.author}${side.license?.spdx ? ` (${side.license.spdx})` : ''}` : undefined;
      const license: LicenseRef = { id: side.license?.spdx ?? (root.inProject ? 'user-import' : 'unknown'), ...(credit ? { credit } : {}), ...(side.sourceUrl ? { sourceUrl: side.sourceUrl } : {}) };
      items.push({ id, kind, durationMs: d, path, license });
    }
  }
  return { items, copies };
}

const sfx0 = (ops: Op[]) => ops.some((o) => o.op === 'addSfx');

async function cmdSfxApply(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { seed: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  if (!tpl.sfx?.rules.length) {
    throw new CliError('no-rules', t(ctx, `テンプレート ${tpl.id} に sfx.rules がありません。solocut edit addSfx で入れてください`, `template ${tpl.id} has no sfx.rules; add effects with solocut edit addSfx`));
  }
  const warnings: string[] = [];
  const { items, copies } = await sfxLibrary(p, tl, warnings);
  // earlier template-placed sfx are replaced (re-running is idempotent); human/agent-placed ones stay and count
  const old = values.keep ? [] : tl.audio.sfx.filter((s) => s.decided?.by === 'template');
  const base: Timeline = { ...tl, audio: { ...tl.audio, sfx: tl.audio.sfx.filter((s) => !old.includes(s)) } };
  const maxPerMin = tpl.sfx.maxPerMin ?? tpl.audio.sfx?.maxPerMinute;
  const gainDb = tpl.sfx.gainDb ?? tpl.audio.sfx?.gainDb;
  const added = sfxFromRules(base, {
    rules: tpl.sfx.rules, seed: values.seed ?? p.file.id,
    ...(maxPerMin !== undefined ? { maxPerMin } : {}), ...(gainDb !== undefined ? { gainDb } : {}),
    ...(tpl.sfx.minSpacingMs !== undefined ? { minSpacingMs: tpl.sfx.minSpacingMs } : {}),
  }, items);
  const kinds = [...new Set(tpl.sfx.rules.filter((r) => r.kind !== 'none').map((r) => r.kind))];
  const missing = kinds.filter((k) => !items.some((i) => i.kind === k));
  if (missing.length) warnings.push(t(ctx, `ライブラリに無い種類: ${missing.join(', ')}（assets/sfx/<種類>/ に置くと使います）`, `no library sound for: ${missing.join(', ')} (put files in assets/sfx/<kind>/)`));
  const ops: Op[] = [...old.map((s) => ({ op: 'removeSfx' as const, id: s.id })), ...added];
  const dryRun = !!values['dry-run'];
  if (!dryRun) {
    for (const op of added) {
      if (op.op !== 'addSource' || op.source.kind !== 'asset') continue;
      const src = copies.get(op.source.path);
      if (src) {
        mkdirSync(dirname(join(p.dir, op.source.path)), { recursive: true });
        copyFileSync(src, join(p.dir, op.source.path));
      }
    }
  }
  const r = await apply(ctx, p, ops, 'sfx apply', dryRun);
  if (!dryRun && !p.variant) setStep(p, 'sfx', 'done', sfx0(added) ? undefined : t(ctx, 'ライブラリに合う効果音がなかった', 'no matching sound in the library'));
  const fps = tl.canvas.fps;
  const sfx = added.flatMap((o) => (o.op === 'addSfx' ? [{ id: o.sfx.id, at: o.sfx.at, timecode: frameToTimecode(o.sfx.at, fps), trigger: o.sfx.trigger ?? null, asset: o.sfx.asset, gainDb: o.sfx.gainDb }] : []));
  emit(ctx, { variant: p.variant ?? 'main', added: sfx.length, removed: old.length, sfx, library: items.length, dryRun, changed: r.changed, warnings: [...warnings, ...r.warnings] }, () => [
    t(ctx, `効果音を ${sfx.length} 個入れました（前のテンプレートの効果音 ${old.length} 個は入れ替え）${dryRun ? '（確認のみ）' : ''}`, `added ${sfx.length} sound effect(s), replaced ${old.length} template one(s)${dryRun ? ' (dry run)' : ''}`),
    ...sfx.map((s) => `  ${s.timecode} ${s.trigger ?? ''} ${s.asset} ${s.gainDb} dB`),
    ...[...warnings, ...r.warnings].map((w) => `! ${w}`),
  ]);
}

export async function cmdSfx(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'apply') return cmdSfxApply(ctx, rest);
  throw new CliError('usage', 'usage: solocut sfx apply [--seed s] [--keep] [--dry-run]');
}

// ---------- masks from-analysis ----------

const MASK_KINDS = ['pixelate', 'blur', 'fill'] as const;

async function cmdMasksFromAnalysis(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { source: { type: 'string' }, kinds: { type: 'string' }, kind: { type: 'string' }, 'dry-run': { type: 'boolean' } }, { max: 0 });
  const kind = (values.kind ?? 'pixelate') as Mask['kind'];
  if (!(MASK_KINDS as readonly string[]).includes(kind)) throw new CliError('usage', `--kind must be one of ${MASK_KINDS.join(', ')}`);
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const an = loadAnalysis(p.dir, tl);
  if (values.source && !tl.sources[values.source]) throw new CliError('not-found', `unknown source: ${values.source}`);
  const ids = Object.keys(an.pii).filter((id) => !values.source || id === values.source).sort();
  // same ids as the desktop app (pii.ts): masks it (or an earlier run) already added are skipped, never replaced
  const existing = new Set(tl.masks.map((mk) => mk.id));
  const before = existing.size;
  const added: Op[] = [];
  for (const id of ids) {
    const s = tl.sources[id]!;
    if (s.kind !== 'camera' && s.kind !== 'screen') continue;
    added.push(...piiMaskOps(an.pii[id] as PiiFile, id, existing, {
      size: s.size, sourceFps: fpsValue(s.fps), maskKind: kind,
      ...(values.kinds ? { kinds: values.kinds.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
    }));
  }
  const dryRun = !!values['dry-run'];
  const r = await apply(ctx, p, added, 'masks from-analysis', dryRun);
  const warnings = [...an.warnings, ...r.warnings];
  if (!ids.length) warnings.push(t(ctx, '個人情報の解析ファイル（derived/analysis/pii.<素材>.json）がありません', 'no PII analysis (derived/analysis/pii.<source>.json)'));
  if (!dryRun && !p.variant) setStep(p, 'masks', 'done', ids.length ? (added.length ? t(ctx, `${added.length} 個のモザイクは要確認`, `${added.length} mask(s) need review`) : undefined) : t(ctx, '解析ファイルなし', 'no analysis files'));
  const masks = added.flatMap((o) => (o.op === 'addMask' ? [{ id: o.mask.id, source: o.mask.source, reason: o.mask.reason, kind: o.mask.kind, from: o.mask.track[0]!.frame, to: o.mask.track.at(-1)!.frame, keyframes: o.mask.track.length }] : []));
  emit(ctx, { variant: p.variant ?? 'main', added: masks.length, existing: before, masks, sources: ids, files: an.files, dryRun, changed: r.changed, warnings }, () => [
    t(ctx, `モザイクを ${masks.length} 個入れました（要確認）`, `added ${masks.length} mask(s) (marked for review)`),
    ...masks.map((mk) => `  ${mk.id} ${mk.reason} ${mk.source} ${mk.from}–${mk.to}`),
    ...warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdMasks(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'from-analysis') return cmdMasksFromAnalysis(ctx, rest);
  throw new CliError('usage', 'usage: solocut masks from-analysis [--source id] [--kinds email,phone,token] [--kind pixelate|blur|fill] [--dry-run]');
}

// ---------- multicam material ----------

/** Transcript words by take (take seconds), for camera material and switch checks. */
export function wordsByTake(p: Project): Record<string, { w: string; start: number; end: number }[]> {
  const tr = readTranscript(p);
  return tr ? { [tr.take]: tr.words.map(({ w, start, end }) => ({ w, start, end })) } : {};
}

async function cmdMulticamMaterial(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const an = loadAnalysis(p.dir, tl);
  const words = wordsByTake(p);
  const segments = cameraMaterial(tl, an.tracks, words);
  const cameras = Object.entries(tl.sources).filter(([, s]) => s.kind === 'camera').map(([id, s]) => ({ id, role: s.kind === 'camera' ? s.role : 'other', take: 'take' in s ? s.take ?? null : null }));
  const check = checkCameraSwitches(tl, { words, ...(tpl.multicam ? { maxShotSec: tpl.multicam.maxShotSec, minShotSec: tpl.multicam.minShotSec } : {}) });
  const warnings = [...an.warnings];
  if (!an.tracks.faces) warnings.push(t(ctx, '顔の解析（derived/analysis/faces.<素材>.json）がないので、顔の映り具合は分かりません', 'no face tracks (derived/analysis/faces.<source>.json): face visibility is unknown'));
  emit(ctx, {
    variant: p.variant ?? 'main', cameras, segments, check,
    rules: { maxShotSec: tpl.multicam?.maxShotSec ?? null, minShotSec: tpl.multicam?.minShotSec ?? null, prompt: tpl.promptFiles.multicam ?? null },
    files: an.files, warnings,
  }, () => [
    t(ctx, `カメラ ${cameras.length} 台、区間 ${segments.length}。切り替えの判断は prompts/multicam.md に沿って`, `${cameras.length} camera(s), ${segments.length} segment(s). Decide the switches following prompts/multicam.md`),
    ...segments.map((s) => `  ${s.segment} ${s.durationSec.toFixed(1)}s ${s.current ?? '-'} ${s.speaking ? t(ctx, '発話あり', 'speaking') : ''} ${s.cameras.map((c) => `${c.id}:${c.faceVisible === null ? '?' : Math.round(c.faceVisible * 100) + '%'}`).join(' ')}`),
    `${check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '!'} camera-switch: ${check.note}`,
    ...warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdMulticam(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'material') return cmdMulticamMaterial(ctx, rest);
  throw new CliError('usage', 'usage: solocut multicam material');
}

// ---------- tracks apply ----------

async function cmdTracksApply(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, {
    'follow-clicks': { type: 'boolean' }, 'no-follow-clicks': { type: 'boolean' }, 'no-overlays': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  }, { max: 0 });
  if (values['follow-clicks'] && values['no-follow-clicks']) throw new CliError('usage', 'choose --follow-clicks or --no-follow-clicks');
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const an = loadAnalysis(p.dir, tl);
  const followClicks = values['no-follow-clicks'] ? false : values['follow-clicks'] ? (tpl.zoom?.followClicks || true) : (tpl.zoom?.followClicks ?? false);
  const segments = applyTracks(tl, an.tracks, { followClicks });
  const ops: Op[] = [];
  if (JSON.stringify(segments) !== JSON.stringify(tl.segments)) ops.push({ op: 'setSegments', segments });
  // click rings and keystroke badges come from the input logs; earlier generated ones (ov_click_* / ov_key_*) are rebuilt
  const clicks = tpl.features.cursorHighlight;
  const keys = tpl.features.keystrokes;
  let overlays = 0;
  let removed = 0;
  if (!values['no-overlays'] && (clicks || keys)) {
    const old = tl.overlays.filter((o) => (o.kind === 'click-ring' || o.kind === 'keystroke') && /^ov_(click|key)_/.test(o.id));
    removed = old.length;
    const base: Timeline = { ...tl, segments, overlays: tl.overlays.filter((o) => !old.includes(o)) };
    const add = overlaysFromInputLogs(base, an.tracks, { clicks, keys });
    overlays = add.length;
    ops.push(...old.map((o) => ({ op: 'removeOverlay' as const, id: o.id })), ...add.map((overlay) => ({ op: 'addOverlay' as const, overlay })));
  }
  const dryRun = !!values['dry-run'];
  const r = await apply(ctx, p, ops, 'tracks apply', dryRun);
  const zooms = segments.reduce((n, s) => n + (s.zoom?.length ?? 0), 0) - tl.segments.reduce((n, s) => n + (s.zoom?.length ?? 0), 0);
  const warnings = [...an.warnings, ...r.warnings];
  if (!an.files.length) warnings.push(t(ctx, '解析ファイル（顔・カーソル・キー）がありません', 'no analysis files (faces, cursor, keys)'));
  emit(ctx, {
    variant: p.variant ?? 'main', segmentsChanged: ops.some((o) => o.op === 'setSegments'), zoomKeyframesAdded: zooms, followClicks: !!followClicks,
    overlays, removedOverlays: removed, files: an.files, dryRun, changed: r.changed, warnings,
  }, () => [
    t(ctx, `追従ズームを反映しました（キーフレーム ${zooms >= 0 ? '+' : ''}${zooms}）。クリック・キー表示 ${overlays} 個`, `applied tracked zoom (${zooms >= 0 ? '+' : ''}${zooms} keyframes); ${overlays} click/key overlay(s)`),
    ...warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdTracks(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'apply') return cmdTracksApply(ctx, rest);
  throw new CliError('usage', 'usage: solocut tracks apply [--follow-clicks|--no-follow-clicks] [--no-overlays] [--dry-run]');
}

// ---------- bench profile / apply ----------

function validSamples(raw: unknown): BenchmarkSample[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { samples?: unknown }).samples) ? (raw as { samples: unknown[] }).samples : null;
  if (!list) throw new CliError('invalid-samples', 'samples must be an array (or { samples: [...] })');
  if (!list.length) throw new CliError('invalid-samples', 'no samples');
  list.forEach((s, i) => {
    const x = s as Partial<BenchmarkSample>;
    if (!x || typeof x !== 'object' || typeof x.t !== 'number' || !Array.isArray(x.captionBoxes) || !Array.isArray(x.cutTimes)
      || typeof x.loudness !== 'number' || !Array.isArray(x.sfxOnsets) || typeof x.charsPerMin !== 'number') {
      throw new CliError('invalid-samples', `sample #${i + 1} needs t, captionBoxes[], cutTimes[], loudness, sfxOnsets[], charsPerMin`);
    }
  });
  return list as BenchmarkSample[];
}

async function cmdBenchProfile(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { out: { type: 'string' }, url: { type: 'string' }, platform: { type: 'string' } }, { min: 1, max: 1, usage: 'solocut bench profile <samples.json> [--out profile.json] [--url <reference url>] [--platform youtube|tiktok|…]' });
  const raw = readJsonFile<unknown>(resolve(ctx.io.cwd, positionals[0]!));
  const samples = validSamples(raw);
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { source?: StyleProfile['source'] }).source : undefined;
  const source = { ...given, ...(values.url ? { url: values.url } : {}), ...(values.platform ? { platform: values.platform } : {}), analyzed: new Date().toISOString() };
  const profile = benchmarkProfile(samples, { source });
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const out = values.out ? resolve(ctx.io.cwd, values.out) : join(solocutHome(), 'benchmarks', `bench_${now}.json`);
  writeAtomic(out, JSON.stringify(profile, null, 2) + '\n');
  const patch = profileToTemplatePatch(profile);
  emit(ctx, { path: out, profile, patch }, () => [
    t(ctx, `参考動画の傾向を保存しました: ${out}`, `saved the style profile: ${out}`),
    t(ctx, `テンプレートに入れるには: solocut bench apply ${out} --template <id>`, `to use it: solocut bench apply ${out} --template <id>`),
  ]);
}

async function cmdBenchApply(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { template: { type: 'string' }, 'dry-run': { type: 'boolean' } }, { min: 1, max: 1, usage: 'solocut bench apply <profile.json> --template <id> [--dry-run]' });
  const file = resolve(ctx.io.cwd, positionals[0]!);
  const profile = readJsonFile<StyleProfile>(file);
  if (!profile || typeof profile !== 'object' || typeof profile.durationSec !== 'number' || !profile.captions || typeof profile.captions !== 'object') {
    throw new CliError('invalid-profile', `${positionals[0]} is not a style profile (solocut bench profile writes one)`);
  }
  let p: Project | null = null;
  try {
    p = openProject(ctx);
  } catch {
    p = null;
  }
  const id = values.template ?? p?.file.template.id;
  if (!id) throw new CliError('usage', '--template <id> is required outside a project');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CliError('usage', `invalid template id: ${id}`);
  const patch = profileToTemplatePatch(profile) as Record<string, unknown>;
  // the project's own template → a project override; any other id → a user override in ~/.solocut/templates
  const inProject = !!p && p.file.template.id === id;
  const root = inProject ? join(p!.dir, 'templates') : join(solocutHome(), 'templates');
  if (values['dry-run']) {
    emit(ctx, { template: id, scope: inProject ? 'project' : 'user', patch, dryRun: true }, () => JSON.stringify(patch, null, 2));
    return;
  }
  const r = writeTemplateOverride(root, id, patch, `solocut bench apply ${basename(file)}`, inProject ? { project: p!.dir } : {});
  emit(ctx, { template: id, scope: inProject ? 'project' : 'user', file: r.file, patch, dryRun: false }, () => [
    t(ctx, `テンプレート ${id} に参考動画の傾向を入れました: ${r.file}`, `merged the style profile into template ${id}: ${r.file}`),
    `  captions: ${r.template.captions.style}, ${r.template.captions.maxCharsPerLine} × ${r.template.captions.maxLines}`,
  ]);
}

export async function cmdBench(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'profile') return cmdBenchProfile(ctx, rest);
  if (sub === 'apply') return cmdBenchApply(ctx, rest);
  throw new CliError('usage', 'usage: solocut bench profile <samples.json> | solocut bench apply <profile.json> --template <id>');
}

