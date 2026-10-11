// Publish screen data: per-target metadata (from `solocut meta --json`, else timeline.json outputs), the files
// that can be posted, and the history in ~/.solocut/publish-history.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CliResult, PublishDraft, PublishRecord, PublishTarget, Variant } from '../../shared/types';
import { variantArgs, variantTimelinePath } from '../../shared/project';
import { runCli } from '../services/cli';
import { home } from '../services/platform';

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function historyFile(): string {
  return join(home(), 'publish-history.jsonl');
}

export function appendHistory(r: PublishRecord): void {
  mkdirSync(dirname(historyFile()), { recursive: true });
  appendFileSync(historyFile(), JSON.stringify(r) + '\n');
}

export function readHistory(projectDir?: string, limit = 50): PublishRecord[] {
  if (!existsSync(historyFile())) return [];
  const out: PublishRecord[] = [];
  for (const line of readFileSync(historyFile(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PublishRecord;
      if (!projectDir || r.project === projectDir) out.push(r);
    } catch {
      /* skip broken line */
    }
  }
  return out.slice(-limit).reverse();
}

function files(dir: string, re: RegExp, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, n: number) => {
    if (n > depth || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, n + 1);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function absIn(projectDir: string, p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  const a = isAbsolute(p) ? p : resolve(projectDir, p);
  return existsSync(a) ? a : undefined;
}

/** Normalizes one output entry from `meta --json` or timeline.json outputs[]. */
export function targetFrom(projectDir: string, o: Dict): PublishTarget | null {
  const target = typeof o.target === 'string' ? o.target : null;
  if (!target) return null;
  const md = isObj(o.metadata) ? o.metadata : o;
  const t: PublishTarget = {
    target,
    title: typeof md.title === 'string' ? md.title : '',
    titleCandidates: strs(md.titleCandidates),
    description: typeof md.description === 'string' ? md.description : '',
    tags: strs(md.tags),
  };
  const render = absIn(projectDir, isObj(o.render) ? o.render.path : o.render);
  const thumb = absIn(projectDir, isObj(o.thumbnail) ? o.thumbnail.path : o.thumbnail);
  const caps = absIn(projectDir, isObj(o.captions) ? (o.captions.srt ?? o.captions.path) : o.captions);
  if (render) t.render = render;
  if (thumb) t.thumbnail = thumb;
  if (caps) t.captions = caps;
  return t;
}

const VARIANT_OF: Record<'youtube' | 'tiktok' | 'youtube-shorts', Variant> = { youtube: 'main', tiktok: 'tiktok', 'youtube-shorts': 'youtube-shorts' };

/** The three posts of docs/18 (YouTube main, TikTok, Shorts): metadata from `meta show` per variant, files from the timelines. */
export async function loadDraft(projectDir: string): Promise<PublishDraft> {
  const targets: PublishTarget[] = [];
  let metaSource: PublishDraft['metaSource'] = 'timeline';
  for (const target of ['youtube', 'tiktok', 'youtube-shorts'] as const) {
    const v = VARIANT_OF[target];
    let tl: Dict = {};
    try {
      tl = JSON.parse(readFileSync(join(projectDir, variantTimelinePath(v)), 'utf8')) as Dict;
    } catch {
      /* variant not derived yet */
    }
    const outs = Array.isArray(tl.outputs) ? tl.outputs.filter(isObj) : [];
    const fromTl = outs.find((o) => o.target === target);
    const r = await runCli(['meta', 'show', '--target', target, ...variantArgs(v)], { cwd: projectDir, timeoutMs: 30_000 });
    const fromCli = r.ok && isObj(r.data) && Array.isArray(r.data.outputs) ? r.data.outputs.filter(isObj).find((o) => o.target === target) : undefined;
    if (fromCli) metaSource = 'cli';
    const merged: Dict = { ...(fromTl ?? {}), ...(fromCli ?? {}), target };
    const t = targetFrom(projectDir, merged) ?? { target, title: '', titleCandidates: [], description: '', tags: [] };
    if (!t.title && isObj(tl.meta) && typeof tl.meta.title === 'string') t.title = tl.meta.title;
    if (!t.render) {
      const guess = files(join(projectDir, 'renders', target), /\.(mp4|mov)$/i, 1)[0];
      if (guess) t.render = guess;
    }
    targets.push(t);
  }
  const renders = join(projectDir, 'renders');
  return {
    targets,
    videos: files(renders, /\.(mp4|mov|webm)$/i),
    images: files(renders, /\.(jpe?g|png)$/i),
    captions: [...files(join(projectDir, 'captions'), /\.srt$/i), ...files(renders, /\.srt$/i)],
    history: readHistory(projectDir),
    metaSource,
  };
}

/** Writes the approved title / description / tags back with `solocut meta set` (so the timeline matches what was posted). */
export async function saveMeta(projectDir: string, target: 'youtube' | 'tiktok' | 'youtube-shorts', m: { title: string; description: string; tags: string[] }): Promise<CliResult> {
  const file = join(tmpdir(), `solocut-desc-${process.pid}-${Date.now()}.txt`);
  writeFileSync(file, m.description);
  try {
    const args = ['meta', 'set', '--target', target, '--title', m.title, '--description-file', file, ...variantArgs(VARIANT_OF[target])];
    if (m.tags.length) args.push('--tags', m.tags.join(','));
    return await runCli(args, { cwd: projectDir });
  } finally {
    rmSync(file, { force: true });
  }
}
