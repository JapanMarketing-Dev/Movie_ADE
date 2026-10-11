import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToolSync } from '@solocut/toolchain';

function which(cmd: string): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() || null : null;
}

/** Prefer env SOLOCUT_FFMPEG/FFPROBE, then the toolchain-managed build (~/.solocut/tools or $SOLOCUT_HOME; includes libass), then PATH. */
function find(tool: 'ffmpeg' | 'ffprobe'): string | null {
  try {
    const r = resolveToolSync(tool);
    if (r) return r.path;
  } catch {
    // toolchain unavailable: fall through to PATH
  }
  return which(tool);
}

export const FFMPEG = find('ffmpeg');
export const FFPROBE = find('ffprobe');
export const HAVE_FFMPEG = !!FFMPEG && !!FFPROBE;
if (HAVE_FFMPEG) {
  process.env.SOLOCUT_FFMPEG = FFMPEG!;
  process.env.SOLOCUT_FFPROBE = FFPROBE!;
  console.info(`[media tests] using ${FFMPEG}`);
} else {
  console.warn('[media tests] ffmpeg/ffprobe not found on PATH: media integration tests are skipped');
}

export const HAVE_LIBASS = HAVE_FFMPEG && /\bsubtitles\b/.test(execFileSync(FFMPEG!, ['-hide_banner', '-filters'], { encoding: 'utf8' }));

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `solocut-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run ffmpeg synchronously (test input synthesis). */
export function ff(args: string[], cwd?: string): void {
  const r = spawnSync(FFMPEG!, ['-hide_banner', '-v', 'error', '-y', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`);
}

/** Speech-like test audio: noise gated by an aperiodic envelope (unique alignment). */
export function gatedNoiseExpr(seed = 0): string {
  return `(random(${seed})*2-1)*(0.03+0.97*gt(sin(5.3*t)+sin(2.17*t+1)+sin(11.1*t+2)+sin(0.71*t+3),1.4))`;
}

/** Average luma (0–255) of frame `n` of a video. */
export function frameLuma(path: string, n: number): number {
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length === 0) throw new Error(`cannot read frame ${n} of ${path}: ${r.stderr}`);
  let s = 0;
  for (const b of r.stdout) s += b;
  return s / r.stdout.length;
}

/** Luma of a pixel region (x,y,w,h) of frame n. */
export function regionLuma(path: string, n: number, x: number, y: number, w: number, h: number): number {
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n}),crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  if (r.status !== 0 || r.stdout.length === 0) throw new Error(`cannot read frame ${n}: ${r.stderr}`);
  let s = 0;
  for (const b of r.stdout) s += b;
  return s / r.stdout.length;
}

export function countFrames(path: string): number {
  const r = spawnSync(FFPROBE!, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

/** Brightest luma (0–255) in frame n. */
export function maxLuma(path: string, n: number): number {
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length === 0) throw new Error(`cannot read frame ${n}: ${r.stderr}`);
  let m = 0;
  for (const b of r.stdout) if (b > m) m = b;
  return m;
}
