// Publish screen data: per-target metadata (from `solocut meta --json`, else timeline.json outputs), the files
// that can be posted, and the history in ~/.solocut/publish-history.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PublishDraft, PublishRecord, PublishTarget } from '../../shared/types';
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

export async function loadDraft(projectDir: string): Promise<PublishDraft> {
  let targets: PublishTarget[] = [];
  let metaSource: PublishDraft['metaSource'] = 'timeline';
  const r = await runCli(['meta'], { cwd: projectDir, timeoutMs: 30_000 });
  if (r.ok && isObj(r.data) && Array.isArray(r.data.outputs)) {
    targets = r.data.outputs.filter(isObj).map((o) => targetFrom(projectDir, o)).filter((x): x is PublishTarget => x !== null);
    metaSource = 'cli';
  } else {
    try {
      const tl = JSON.parse(readFileSync(join(projectDir, 'timeline.json'), 'utf8')) as Dict;
      const outs = Array.isArray(tl.outputs) ? tl.outputs.filter(isObj) : [];
      targets = outs.map((o) => targetFrom(projectDir, o)).filter((x): x is PublishTarget => x !== null);
      if (targets.length === 0 && isObj(tl.meta)) {
        for (const tg of strs(tl.meta.targets)) targets.push({ target: tg, title: String(tl.meta.title ?? ''), titleCandidates: [], description: '', tags: [] });
      }
    } catch {
      /* no timeline yet */
    }
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
