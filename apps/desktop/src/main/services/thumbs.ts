// Thumbnails (docs/10): candidates and generation go through the CLI; favorites are kept in
// .solocut/thumbnails.json so agents can read them too.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CliResult, ThumbCandidate, ThumbImage, Variant } from '../../shared/types';
import { variantArgs } from '../../shared/project';
import { runCli } from './cli';

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

function abs(dir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dir, p);
}

function favFile(dir: string): string {
  return join(dir, '.solocut', 'thumbnails.json');
}

export function readFavorites(dir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(favFile(dir), 'utf8')) as { favorites?: unknown };
    return Array.isArray(j.favorites) ? j.favorites.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setFavorite(dir: string, path: string, on: boolean): string[] {
  const rel = relative(dir, abs(dir, path)).split('\\').join('/');
  if (rel.startsWith('..')) throw new Error('not a project file');
  const set = new Set(readFavorites(dir));
  if (on) set.add(rel);
  else set.delete(rel);
  const favorites = [...set];
  mkdirSync(join(dir, '.solocut'), { recursive: true });
  writeFileSync(`${favFile(dir)}.tmp`, JSON.stringify({ favorites }, null, 2) + '\n');
  renameSync(`${favFile(dir)}.tmp`, favFile(dir));
  return favorites;
}

export function parseCandidates(dir: string, data: unknown): ThumbCandidate[] {
  const arr = isObj(data) && Array.isArray(data.candidates) ? data.candidates : Array.isArray(data) ? data : [];
  const out: ThumbCandidate[] = [];
  for (const c of arr) {
    if (!isObj(c) || typeof c.image !== 'string' || typeof c.frame !== 'number') continue;
    const t: ThumbCandidate = { frame: c.frame, timecode: typeof c.timecode === 'string' ? c.timecode : '', image: abs(dir, c.image) };
    if (typeof c.score === 'number') t.score = c.score;
    out.push(t);
  }
  return out;
}

/** `thumb gen --json` → `{ thumbnails: [{ format, file, base, provider }] }` (older shape: `{ images }`). */
export function parseImages(dir: string, data: unknown): ThumbImage[] {
  const arr = isObj(data) && Array.isArray(data.thumbnails) ? data.thumbnails : isObj(data) && Array.isArray(data.images) ? data.images : [];
  const favs = new Set(readFavorites(dir).map((f) => abs(dir, f)));
  return arr
    .map((x) => (typeof x === 'string' ? { path: x } : isObj(x) && typeof x.file === 'string' ? { ...x, path: x.file } : x))
    .filter((x): x is Dict & { path: string } => isObj(x) && typeof x.path === 'string')
    .map((x) => {
      const p = abs(dir, x.path);
      const img: ThumbImage = { path: p, favorite: favs.has(p) };
      if (typeof x.provider === 'string') img.provider = x.provider;
      return img;
    });
}

export async function candidates(dir: string, variant: Variant = 'main'): Promise<CliResult<ThumbCandidate[]>> {
  const r = await runCli(['thumb', 'candidates', ...variantArgs(variant)], { cwd: dir, timeoutMs: 10 * 60_000 });
  return r.ok ? { ...r, data: parseCandidates(dir, r.data) } : { ...r, data: undefined };
}

export async function generate(dir: string, o: { frame: number; n: number; provider?: string; title?: string; variant?: Variant }): Promise<CliResult<ThumbImage[]>> {
  const v = o.variant ?? 'main';
  // main → 16:9 YouTube thumbnails; vertical variants → 9:16 (Shorts; TikTok uses a cover frame time)
  const args = ['thumb', 'gen', '--frame', String(o.frame), '--n', String(Math.max(1, Math.min(6, Math.floor(o.n)))), '--formats', v === 'main' ? 'youtube' : 'shorts', ...variantArgs(v)];
  if (o.provider) args.push('--provider', o.provider);
  if (o.title?.trim()) args.push('--title', o.title.trim()); // empty: the CLI uses the post title
  const r = await runCli(args, { cwd: dir, timeoutMs: 20 * 60_000 });
  return r.ok ? { ...r, data: parseImages(dir, r.data) } : { ...r, data: undefined };
}

/** Existing images under renders/thumbnails (results of earlier runs). */
export function existing(dir: string): ThumbImage[] {
  const root = join(dir, 'renders', 'thumbnails');
  if (!existsSync(root)) return [];
  const favs = new Set(readFavorites(dir).map((f) => abs(dir, f)));
  return readdirSync(root)
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
    .map((n) => join(root, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .map((p) => ({ path: p, favorite: favs.has(p) }));
}
