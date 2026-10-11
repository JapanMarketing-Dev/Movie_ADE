// Pure helpers for the timeline overview (display only, docs/02: the timeline shows and lets you confirm decisions;
// it never edits). Unit-tested.
import type { LaneItem, LaneName, TimelineOverview } from '@shared/types';

export const LANE_ORDER: readonly LaneName[] = ['segments', 'captions', 'scenes', 'sfx', 'markers'];

/** Seconds between ruler ticks, chosen so that at most `maxTicks` fit. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export interface Tick {
  frame: number;
  /** m:ss or h:mm:ss */
  label: string;
}

function clock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Ticks from 0 up to (not including) the end, at a round interval. Empty for invalid input. */
export function rulerTicks(totalFrames: number, fps: number, maxTicks = 8): Tick[] {
  if (!(totalFrames > 0) || !(fps > 0) || maxTicks < 1) return [];
  const totalSec = totalFrames / fps;
  const step = STEPS.find((s) => totalSec / s <= maxTicks) ?? Math.ceil(totalSec / maxTicks / 3600) * 3600;
  const ticks: Tick[] = [];
  for (let sec = 0; sec < totalSec - 1e-9; sec += step) ticks.push({ frame: Math.round(sec * fps), label: clock(sec) });
  return ticks;
}

/** Position of a frame as a fraction of the timeline (clamped to 0..1). */
export function frameToFraction(frame: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(frame)) return 0;
  return Math.min(1, Math.max(0, frame / total));
}

/** The frame under a fraction of the track width (clamped, integer). */
export function fractionToFrame(fraction: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * total);
}

/** Video time (s) → timeline frame. */
export function secondsToFrame(sec: number, fpsNum: number, fpsDen: number): number {
  if (!Number.isFinite(sec) || sec < 0 || !(fpsNum > 0)) return 0;
  return Math.round((sec * fpsNum) / (fpsDen || 1));
}

/** The item covering `frame` in a lane (last one wins when they overlap; markers within ±tolerance frames). */
export function itemAt(items: readonly LaneItem[], frame: number, tolerance = 0): LaneItem | null {
  let hit: LaneItem | null = null;
  for (const it of items) if (frame >= it.start - tolerance && frame <= Math.max(it.end, it.start) + tolerance) hit = it;
  return hit;
}

export interface LaneStats {
  lane: LaneName;
  count: number;
  review: number;
}

export function laneStats(ov: TimelineOverview): LaneStats[] {
  return LANE_ORDER.map((lane) => {
    const items = ov.lanes[lane] ?? [];
    return { lane, count: items.length, review: items.filter((x) => x.needsReview).length };
  });
}

/** Width of an item as a CSS percentage string; markers are points. A minimum keeps 1-frame items visible. */
export function itemWidthPct(it: LaneItem, total: number, lane: LaneName): string | undefined {
  if (lane === 'markers') return undefined;
  const w = total > 0 ? (Math.max(0, it.end - it.start) / total) * 100 : 0;
  return `max(2px, ${w.toFixed(4)}%)`;
}
