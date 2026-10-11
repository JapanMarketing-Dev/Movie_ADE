import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { frameToSeconds, type LicenseRef, type Output, type Target, type Timeline } from '@solocut/core';
import { CliError, emit, opts, t, type Ctx } from '../ctx.js';
import { applyEdit, openProject, readTimeline, setStep, writeAtomic, type Project } from '../project.js';

// Publishing text (docs/06 「同時に出すメタデータ」, docs/16 credits): the agent writes titles/description/tags, the CLI
// stores them in outputs[].metadata and renders renders/<target>/metadata.md + credits.txt.

export const TARGETS = ['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels'] as const;
const VERTICAL = new Set<Target>(['youtube-shorts', 'tiktok', 'instagram-reels']);

/** YouTube chapters "00:00 Title" from the outline; null with the reason when YouTube would reject them. */
export function youtubeChapters(tl: Timeline): { text: string | null; reason?: string } {
  const ch = [...tl.outline].sort((a, b) => a.start - b.start);
  if (ch.length < 3) return { text: null, reason: 'YouTube needs at least 3 chapters' };
  if (ch[0]!.start !== 0) return { text: null, reason: 'the first chapter must start at 00:00' };
  const fps = tl.canvas.fps;
  const end = tl.segments.reduce((m, s) => Math.max(m, s.range.end), 0);
  for (let i = 0; i < ch.length; i++) {
    const next = ch[i + 1]?.start ?? end;
    if (frameToSeconds(next - ch[i]!.start, fps) < 10) return { text: null, reason: `chapter "${ch[i]!.title}" is shorter than 10 seconds` };
  }
  const clock = (f: number) => {
    const s = Math.floor(frameToSeconds(f, fps));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  return { text: ch.map((c) => `${clock(c.start)} ${c.title}`).join('\n') };
}

/** Asset sources actually used by the timeline. */
export function usedAssets(tl: Timeline): { id: string; path: string; license: LicenseRef }[] {
  const ids = new Set<string>();
  for (const b of tl.audio.bgm) ids.add(b.asset);
  for (const s of tl.audio.sfx) ids.add(s.asset);
  for (const o of tl.overlays) if (o.kind === 'image' || o.kind === 'logo') ids.add(o.asset);
  for (const sc of tl.scenes) for (const v of Object.values(sc.slots)) if (v.kind === 'image') ids.add(v.asset);
  const out: { id: string; path: string; license: LicenseRef }[] = [];
  for (const id of [...ids].sort()) {
    const s = tl.sources[id];
    if (s?.kind === 'asset') out.push({ id, path: s.path, license: s.license });
  }
  return out;
}

/** Credit lines (unique, in first-use order) for assets whose license requires attribution. */
export function creditLines(tl: Timeline): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of usedAssets(tl)) {
    const line = a.license.credit?.trim();
    if (line && !seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

export function emptyOutput(tl: Timeline, target: Target): Output {
  const vertical = VERTICAL.has(target);
  const canvas = vertical === tl.canvas.height > tl.canvas.width ? tl.canvas : { ...tl.canvas, width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080 };
  return { target, canvas, preset: target, metadata: { title: tl.meta.title, titleCandidates: [], description: '', tags: [], chapters: !vertical } };
}

export function metadataMarkdown(tl: Timeline, o: Output, lang: 'ja' | 'en'): string {
  const ja = lang === 'ja';
  const m = o.metadata;
  const ch = o.metadata.chapters && o.target === 'youtube' ? youtubeChapters(tl) : { text: null };
  const credits = creditLines(tl);
  const fullDescription = [m.description.trim(), ch.text ?? '', credits.length ? (ja ? 'クレジット:\n' : 'Credits:\n') + credits.join('\n') : '']
    .filter(Boolean).join('\n\n');
  return [
    `# ${m.title}`,
    '',
    `- ${ja ? '出力先' : 'target'}: ${o.target}`,
    ...(m.titleCandidates.length ? ['', `## ${ja ? 'タイトルの候補' : 'Title candidates'}`, '', ...m.titleCandidates.map((x, i) => `${i + 1}. ${x}`)] : []),
    '',
    `## ${ja ? '説明文（投稿用。チャプターとクレジットを含む）' : 'Description (as posted, with chapters and credits)'}`,
    '',
    fullDescription || (ja ? '（未記入）' : '(empty)'),
    ...(m.tags.length ? ['', `## ${ja ? 'タグ' : 'Tags'}`, '', m.tags.join(', ')] : []),
    ...(o.metadata.chapters && o.target === 'youtube' && !ch.text ? ['', `> ${ja ? 'チャプターを付けられません' : 'chapters omitted'}: ${(ch as { reason?: string }).reason}`] : []),
    '',
  ].join('\n');
}

interface MetaInput { title?: string; titleCandidates?: string[]; description?: string; tags?: string[]; chapters?: boolean }

function readMetaFile(ctx: Ctx, path: string): Record<string, MetaInput> | MetaInput {
  const abs = resolve(ctx.io.cwd, path);
  if (!existsSync(abs)) throw new CliError('not-found', `file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as Record<string, MetaInput>;
  } catch (e) {
    throw new CliError('invalid-json', `${path}: ${(e as Error).message}`);
  }
}

function checkInput(m: MetaInput, where: string): void {
  if (m.title !== undefined && (typeof m.title !== 'string' || !m.title.trim())) throw new CliError('usage', `${where}: title must be a non-empty string`);
  if (m.title && m.title.length > 100) throw new CliError('usage', `${where}: YouTube titles are at most 100 characters`);
  if (m.description !== undefined && typeof m.description !== 'string') throw new CliError('usage', `${where}: description must be a string`);
  if (m.description && m.description.length > 5000) throw new CliError('usage', `${where}: descriptions are at most 5000 characters`);
  for (const k of ['tags', 'titleCandidates'] as const) {
    const v = m[k];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) throw new CliError('usage', `${where}: ${k} must be a list of strings`);
  }
}

function writeFiles(p: Project, tl: Timeline, targets: Target[], lang: 'ja' | 'en'): string[] {
  const files: string[] = [];
  for (const target of targets) {
    const o = tl.outputs.find((x) => x.target === target);
    if (!o) continue;
    writeAtomic(join(p.dir, 'renders', target, 'metadata.md'), metadataMarkdown(tl, o, lang));
    files.push(`renders/${target}/metadata.md`);
    const credits = creditLines(tl);
    writeAtomic(join(p.dir, 'renders', target, 'credits.txt'), credits.length ? credits.join('\n') + '\n' : '');
    files.push(`renders/${target}/credits.txt`);
  }
  return files;
}

export async function cmdMeta(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const p = openProject(ctx);
  if (sub === 'set') {
    const { values } = opts(rest, {
      target: { type: 'string', multiple: true }, title: { type: 'string' }, description: { type: 'string' }, 'description-file': { type: 'string' },
      tags: { type: 'string' }, candidates: { type: 'string', multiple: true }, chapters: { type: 'boolean' }, 'no-chapters': { type: 'boolean' }, file: { type: 'string' },
    }, { max: 0, usage: 'solocut meta set [--target youtube] --title … [--description …|--description-file f] [--tags a,b] [--candidates …] | --file meta.json' });
    const tl = readTimeline(p.dir);
    const targets = (values.target ?? tl.meta.targets) as Target[];
    for (const x of targets) if (!(TARGETS as readonly string[]).includes(x)) throw new CliError('usage', `unknown target: ${x}`);
    if (!targets.length) throw new CliError('usage', 'no targets (set meta.targets or pass --target)');
    const perTarget: Record<string, MetaInput> = {};
    if (values.file) {
      const raw = readMetaFile(ctx, values.file);
      const keyed = Object.keys(raw).some((k) => (TARGETS as readonly string[]).includes(k));
      for (const x of targets) perTarget[x] = keyed ? ((raw as Record<string, MetaInput>)[x] ?? {}) : (raw as MetaInput);
    } else {
      const description = values['description-file'] ? readFileSync(resolve(ctx.io.cwd, values['description-file']), 'utf8') : values.description;
      const m: MetaInput = {
        ...(values.title !== undefined ? { title: values.title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(values.tags !== undefined ? { tags: values.tags.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean) } : {}),
        ...(values.candidates ? { titleCandidates: values.candidates } : {}),
        ...(values.chapters ? { chapters: true } : values['no-chapters'] ? { chapters: false } : {}),
      };
      for (const x of targets) perTarget[x] = m;
    }
    const ops = targets.map((target) => {
      const m = perTarget[target]!;
      checkInput(m, target);
      const base = tl.outputs.find((o) => o.target === target) ?? emptyOutput(tl, target);
      const metadata = { ...base.metadata, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) } as Output['metadata'];
      return { op: 'setOutput' as const, output: { ...base, metadata } };
    });
    const r = await applyEdit(p, ops, { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), note: 'meta set' });
    const files = writeFiles(p, r.timeline, targets, p.file.language);
    setStep(p, 'metadata', 'done');
    emit(ctx, { targets, files, metadata: Object.fromEntries(r.timeline.outputs.filter((o) => targets.includes(o.target)).map((o) => [o.target, o.metadata])) }, () =>
      t(ctx, `投稿文を保存しました: ${files.filter((f) => f.endsWith('.md')).join(', ')}`, `saved: ${files.filter((f) => f.endsWith('.md')).join(', ')}`));
    return;
  }
  if (sub === 'show' || sub === undefined) {
    const { values } = opts(rest, { target: { type: 'string' } }, { max: 0 });
    const tl = readTimeline(p.dir);
    const outs = tl.outputs.filter((o) => !values.target || o.target === values.target);
    const chapters = youtubeChapters(tl);
    emit(ctx, { outputs: outs.map((o) => ({ target: o.target, metadata: o.metadata })), chapters, credits: creditLines(tl), assets: usedAssets(tl) }, () =>
      outs.length ? outs.map((o) => metadataMarkdown(tl, o, p.file.language)).join('\n---\n') : t(ctx, '投稿文はまだありません（solocut meta set）', 'no metadata yet (solocut meta set)'));
    return;
  }
  if (sub === 'write') {
    opts(rest, {}, { max: 0 });
    const tl = readTimeline(p.dir);
    const files = writeFiles(p, tl, tl.outputs.map((o) => o.target), p.file.language);
    emit(ctx, { files }, () => files.join('\n'));
    return;
  }
  throw new CliError('usage', 'usage: solocut meta show [--target t] | set … | write');
}
