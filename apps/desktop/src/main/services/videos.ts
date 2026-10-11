// The master folder (settings `videos.root`): folder names for new videos and the list of videos in it.
// No electron imports, so it is unit-tested directly (test/videos.test.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { previewCandidates } from '../../shared/project';
import type { Variant, VideoEntry, VideoList, VideoStatus } from '../../shared/types';

export { folderSlug, videoFolderName } from '../../shared/videoName';

/** `<parent>/<name>`, or `<name>-2`, `-3`… when that already exists. */
export function uniqueChild(parent: string, name: string, exists: (p: string) => boolean = existsSync): string {
  let dir = join(parent, name);
  for (let i = 2; exists(dir); i++) {
    if (i > 9999) throw new Error(`too many folders named ${name} in ${parent}`);
    dir = join(parent, `${name}-${i}`);
  }
  return dir;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function hasFile(dir: string, test: (name: string) => boolean): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && test(e.name));
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function posted(dir: string): boolean {
  const res = readJson(join(dir, '.solocut', 'publish-result.json'));
  if (isObj(res) && Array.isArray(res.results) && res.results.some((r) => isObj(r) && r.ok === true)) return true;
  const st = readJson(join(dir, '.solocut', 'status.json'));
  const steps = isObj(st) ? st.steps : st;
  if (Array.isArray(steps) && steps.some((s) => isObj(s) && s.step === 'publish' && s.state === 'done')) return true;
  const tl = readJson(join(dir, 'timeline.json'));
  const outputs = isObj(tl) ? tl.outputs : undefined;
  return Array.isArray(outputs) && outputs.some((o) => isObj(o) && isObj(o.publish) && (o.publish.status === 'published' || o.publish.status === 'scheduled'));
}

/** Cheap status from the project files: a post result / published output → posted, a render (renders/youtube/final.mp4…) → done, a take → editing, else new. */
export function videoStatus(dir: string): VideoStatus {
  if (posted(dir)) return 'posted';
  const video = (n: string) => /\.(mp4|mov|webm)$/i.test(n) && !n.endsWith('.part');
  if (existsSync(join(dir, 'renders', 'youtube', 'final.mp4')) || existsSync(join(dir, 'renders', 'final.mp4')) || hasFile(join(dir, 'renders'), video)) return 'done';
  if (hasFile(join(dir, 'media', 'takes'), (n) => !n.startsWith('.')) || hasFile(join(dir, 'media', 'imports'), (n) => !n.startsWith('.'))) return 'editing';
  return 'new';
}

export function readVideo(dir: string, name: string): VideoEntry {
  const j = readJson(join(dir, 'solocut.json'));
  const title = isObj(j) && typeof j.title === 'string' && j.title.trim() ? j.title : name;
  const updatedAt = Math.max(mtime(dir), mtime(join(dir, 'solocut.json')), mtime(join(dir, 'timeline.json')), mtime(join(dir, '.solocut', 'status.json')));
  return { dir, name, title, status: videoStatus(dir), updatedAt };
}

/** Subfolders of the master folder that are Solocut projects (have solocut.json), newest first. Never throws. */
export function listVideos(root: string): VideoList {
  if (!existsSync(root)) return { root, exists: false, videos: [] };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { root, exists: true, videos: [], error: code === 'EACCES' || code === 'EPERM' ? 'permission' : code === 'ENOTDIR' ? 'notDir' : String((e as Error).message ?? e) };
  }
  const videos: VideoEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    try {
      if (!existsSync(join(dir, 'solocut.json'))) continue;
      videos.push(readVideo(dir, e.name));
    } catch {
      // an unreadable subfolder is skipped, the rest is listed
    }
  }
  videos.sort((a, b) => b.updatedAt - a.updatedAt || b.name.localeCompare(a.name));
  return { root, exists: true, videos };
}

/** Where a finished video of a variant is written (the main video: renders/youtube/final.mp4). */
export function finalCandidates(variant: Variant): string[] {
  if (variant === 'main') return ['renders/youtube/final.mp4', 'renders/final.mp4'];
  return [`renders/${variant}/final.mp4`, `variants/${variant}/renders/final.mp4`];
}

function firstExisting(dir: string, rels: string[]): { path: string; mtimeMs: number } | null {
  for (const rel of rels) {
    const p = join(dir, rel);
    const m = mtime(p);
    if (m > 0 || existsSync(p)) return { path: p, mtimeMs: m };
  }
  return null;
}

/**
 * Newest playable render of a variant: the newer of its preview and its final video (a finished final.mp4 wins over
 * an older preview; on a tie the final), else (main only) the newest video under renders/.
 */
export function latestRender(dir: string, variant: Variant = 'main'): { path: string; mtimeMs: number } | null {
  const preview = firstExisting(dir, previewCandidates(variant));
  const final = firstExisting(dir, finalCandidates(variant));
  if (preview || final) return !final ? preview : !preview ? final : preview.mtimeMs > final.mtimeMs ? preview : final;
  const root = variant === 'main' ? join(dir, 'renders') : join(dir, 'renders', variant);
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (d: string, depth: number) => {
    if (depth > 2 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      // the main video never picks up a vertical variant's render
      if (e.isDirectory()) {
        if (variant === 'main' && (e.name === 'tiktok' || e.name === 'youtube-shorts' || e.name === 'thumbnails')) continue;
        walk(p, depth + 1);
      } else if (/\.(mp4|mov|webm)$/i.test(e.name) && !e.name.endsWith('.part')) {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: p, mtimeMs: m };
      }
    }
  };
  walk(root, 0);
  return best;
}

/**
 * Does a watcher event under media/takes matter to the preview? A new take folder (a top-level name without an
 * extension) or a take.json at any depth. Media files being written while recording and hidden files do not.
 */
export function takeChange(name: string | null): 'takes' | null {
  if (!name) return null;
  const parts = name.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p.startsWith('.'))) return null;
  const last = parts[parts.length - 1]!;
  if (last === 'take.json') return 'takes';
  return parts.length === 1 && !/\.[A-Za-z0-9]{1,5}$/.test(last) ? 'takes' : null;
}
