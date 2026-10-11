// Small pure formatters for the shell (status bar, sidebar, popovers). Unit-tested.
import type { AnalysisStatus, StepState, ToolState, UpdateState } from '@shared/types';

/** 00:00 / 12:34 / 1:02:03 from milliseconds (negative and NaN count as 0). */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 512 B / 1.2 KB / 34 MB / 1.06 GB (1024 based, one decimal below 10). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Relative day label used to group sidebar rows: today / yesterday / ISO date. `now` is injectable for tests. */
export function dayBucket(iso: string | undefined, now: Date = new Date()): 'today' | 'yesterday' | 'older' | 'unknown' {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'today';
  if (t >= start - 86_400_000) return 'yesterday';
  return 'older';
}

export interface PipelineSummary {
  done: number;
  total: number;
  /** the step being worked on or waiting for a human, else the first todo */
  current: StepState | null;
  /** 0..1 */
  progress: number;
  needsHuman: boolean;
}

/** The status-bar summary of `solocut status` steps. Skipped steps count as done. */
export function summarizePipeline(steps: readonly StepState[]): PipelineSummary {
  const total = steps.length;
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const current =
    steps.find((s) => s.state === 'running') ?? steps.find((s) => s.state === 'needs-human') ?? steps.find((s) => s.state === 'todo') ?? null;
  return {
    done,
    total,
    current,
    progress: total === 0 ? 0 : done / total,
    needsHuman: steps.some((s) => s.state === 'needs-human'),
  };
}

/** The tools Solocut needs before the first edit (docs/06 LIB-1). Order = display order. */
export const ESSENTIAL_TOOLS = ['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-model', 'fonts'] as const;

export interface ToolsSummary {
  installed: number;
  total: number;
  missing: string[];
  ok: boolean;
}

/**
 * Which essential tools are missing. A tool counts as installed when any ToolState whose name starts with the
 * essential name is installed (e.g. `whisper-model-small` satisfies `whisper-model`). Unknown lists (null) report nothing missing.
 */
export function summarizeTools(tools: readonly ToolState[] | null, essentials: readonly string[] = ESSENTIAL_TOOLS): ToolsSummary {
  if (!tools) return { installed: 0, total: essentials.length, missing: [], ok: true };
  const has = (name: string) => tools.some((t) => t.installed && (t.name === name || t.name.startsWith(`${name}-`) || t.name.startsWith(`${name}.`)));
  const present = (name: string) => tools.some((t) => t.name === name || t.name.startsWith(`${name}-`) || t.name.startsWith(`${name}.`));
  const relevant = essentials.filter(present);
  const missing = relevant.filter((n) => !has(n));
  return { installed: relevant.length - missing.length, total: relevant.length, missing, ok: missing.length === 0 };
}

/** One number for the analysis jobs (faces / OCR) running after a take: mean progress of the jobs, null when idle. */
export function analysisProgress(s: AnalysisStatus | null): number | null {
  if (!s || !s.running) return null;
  if (s.phase === 'models') return typeof s.modelProgress === 'number' ? Math.max(0, Math.min(1, s.modelProgress)) * 0.1 : 0;
  if (s.jobs.length === 0) return 0;
  const sum = s.jobs.reduce((a, j) => a + (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled' ? 1 : Math.max(0, Math.min(1, j.progress))), 0);
  return 0.1 + (sum / s.jobs.length) * 0.9;
}

/** The status-bar update pill: what to show for an UpdateState (null = nothing). */
export function updatePill(s: UpdateState | null): { kind: 'ready' | 'downloading' | 'available'; version: string; progress?: number } | null {
  if (!s) return null;
  if (s.status === 'ready') return { kind: 'ready', version: s.latest ?? '' };
  if (s.status === 'downloading') return { kind: 'downloading', version: s.latest ?? '', progress: Math.round((s.progress ?? 0) * 100) };
  if (s.status === 'available' || s.status === 'notify-only') return { kind: 'available', version: s.latest ?? '' };
  return null;
}

/** Initial letter for a project tile (first visible character, upper-cased; '?' for empty). */
export function initialOf(title: string): string {
  const ch = [...title.trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

/** Shorten an absolute path for display: home → ~, keep the last `keep` segments. */
export function shortPath(path: string, home?: string, keep = 3): string {
  let p = path;
  if (home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\'))) p = '~' + p.slice(home.length);
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const parts = p.split(sep).filter((x, i) => x !== '' || i === 0);
  if (parts.length <= keep + 1) return p;
  return ['…', ...parts.slice(-keep)].join(sep);
}
