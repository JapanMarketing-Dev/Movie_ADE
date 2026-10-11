import type { Op } from './ops.js';
import type { CheckFinding, Segment, Timeline } from './schema.js';
import { fpsValue, frameToSeconds } from './time.js';
import { allIds, freshId, sourceLocalSeconds, takeFrameToSeconds, videoSources } from './timeline.js';
import type { Tracks } from './tracks.js';

/** A transcribed word in take seconds (same shape as @solocut/captions Word). */
export interface TakeWord { w: string; start: number; end: number }
export type WordsInput = TakeWord[] | Record<string, TakeWord[]>;

const wordsOf = (words: WordsInput | undefined, take: string): TakeWord[] => (!words ? [] : Array.isArray(words) ? words : words[take] ?? []);

export interface CameraInfo {
  id: string;
  role: string;
  /** Share of sampled frames with a face (null without a face track). */
  faceVisible: number | null;
  /** Mean gaze-at-lens score when the detector provides it. */
  lookingAtCamera?: number;
  /** Mean sharpness/exposure score when the detector provides it. */
  sharp?: number;
}

export interface SegmentMaterial {
  segment: string;
  take: string;
  durationSec: number;
  /** Camera currently shown (camera-full / wipe / split-v camera), if any. */
  current: string | null;
  speaking: boolean;
  /** Share of the segment covered by words. */
  speechRatio: number;
  words: number;
  /** Emphasized caption words inside the segment. */
  emphasisWords: string[];
  cameras: CameraInfo[];
}

function shownCamera(t: Timeline, seg: Segment): string | null {
  return videoSources(seg.video).find((id) => t.sources[id]?.kind === 'camera') ?? null;
}

/**
 * Material for prompt-controlled camera switching (docs/04): per segment, which cameras could show it (cameras of the
 * take, plus imported cameras without a take), face visibility / gaze / sharpness from face tracks over the
 * segment, whether someone is speaking and which words are emphasized. The agent decides; this only measures.
 */
export function cameraMaterial(t: Timeline, tracks: Tracks, words?: WordsInput): SegmentMaterial[] {
  const cams = Object.entries(t.sources).filter(([, s]) => s.kind === 'camera').sort(([a], [b]) => a.localeCompare(b));
  return t.segments.map((seg) => {
    const a = takeFrameToSeconds(t, seg.src.take, seg.src.from);
    const b = takeFrameToSeconds(t, seg.src.take, seg.src.to);
    const ws = wordsOf(words, seg.src.take).filter((w) => w.end > a && w.start < b);
    const covered = ws.reduce((n, w) => n + Math.max(0, Math.min(b, w.end) - Math.max(a, w.start)), 0);
    const emphasisWords = t.captions
      .filter((c) => c.range.start < seg.range.end && c.range.end > seg.range.start)
      .flatMap((c) => c.emphasis.map((e) => e.word));
    const cameras: CameraInfo[] = [];
    for (const [id, s] of cams) {
      if (s.kind !== 'camera' || (s.take && s.take !== seg.src.take)) continue;
      const info: CameraInfo = { id, role: s.role, faceVisible: null };
      const track = tracks.faces?.[id];
      if (track) {
        const la = sourceLocalSeconds(t, s, a);
        const lb = sourceLocalSeconds(t, s, b);
        const fps = track.fps > 0 ? track.fps : 30;
        const frames = track.frames.filter((f) => f.f / fps >= la && f.f / fps < lb);
        if (frames.length) {
          info.faceVisible = round3(frames.filter((f) => f.faces.some((x) => x.score >= 0.3)).length / frames.length);
          const gaze = frames.flatMap((f) => f.faces.map((x) => x.gaze).filter((g): g is number => g !== undefined));
          if (gaze.length) info.lookingAtCamera = round3(gaze.reduce((p, q) => p + q, 0) / gaze.length);
          const sharp = frames.map((f) => f.sharp).filter((g): g is number => g !== undefined);
          if (sharp.length) info.sharp = round3(sharp.reduce((p, q) => p + q, 0) / sharp.length);
        } else {
          info.faceVisible = 0;
        }
      }
      cameras.push(info);
    }
    return {
      segment: seg.id,
      take: seg.src.take,
      durationSec: round3(frameToSeconds(seg.range.end - seg.range.start, t.canvas.fps)),
      current: shownCamera(t, seg),
      speaking: ws.length > 0,
      speechRatio: b > a ? round3(Math.min(1, covered / (b - a))) : 0,
      words: ws.length,
      emphasisWords: [...new Set(emphasisWords)],
      cameras,
    };
  });
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * splitSegment ops that cut a segment at the given source frames (strictly inside; duplicates ignored), so each
 * piece can get its own camera with setCamera. New ids `${id}_s1`, `${id}_s2`, … (unique against `taken`).
 */
export function splitForSwitch(segment: Segment, atSourceFrames: number[], o: { taken?: Set<string> } = {}): Op[] {
  const taken = new Set(o.taken ?? []);
  taken.add(segment.id);
  const points = [...new Set(atSourceFrames.map((f) => Math.round(f)))]
    .filter((f) => f > segment.src.from && f < segment.src.to)
    .sort((a, b) => a - b);
  const ops: Op[] = [];
  let current = segment.id;
  points.forEach((at, i) => {
    const base = `${segment.id}_s${i + 1}`;
    const newId = taken.has(base) ? freshId(`${base}_`, taken) : base;
    taken.add(newId);
    ops.push({ op: 'splitSegment', id: current, atSource: at, newId });
    current = newId;
  });
  return ops;
}

/** Ids already used in a timeline (pass to splitForSwitch). */
export function takenIds(t: Timeline): Set<string> {
  return allIds(t);
}

/** What a viewer sees as "the shot": layout + sources. */
function shotKey(seg: Segment): string {
  return `${seg.video.layout}:${videoSources(seg.video).join('+') || (seg.video.layout === 'scene' ? seg.video.scene : '')}`;
}

/**
 * Machine part of the `camera-switch` check: one shot held longer than `maxShotSec` (default 8), shots shorter than
 * `minShotSec` (default 1), and camera changes that fall inside a word (needs `words`, take seconds). Fails on
 * too-long and mid-word switches; very short shots are left to a human / the decision model.
 */
export function checkCameraSwitches(t: Timeline, o: { words?: WordsInput; maxShotSec?: number; minShotSec?: number } = {}): CheckFinding {
  const F = fpsValue(t.canvas.fps);
  const maxF = Math.round((o.maxShotSec ?? 8) * F);
  const minF = Math.round((o.minShotSec ?? 1) * F);
  const items: NonNullable<CheckFinding['items']> = [];
  let hard = 0;
  // runs of the same shot
  let runStart = 0;
  for (let i = 1; i <= t.segments.length; i++) {
    const prev = t.segments[i - 1]!;
    const cur = t.segments[i];
    if (cur && shotKey(cur) === shotKey(prev)) continue;
    const first = t.segments[runStart]!;
    const len = prev.range.end - first.range.start;
    const cams = videoSources(first.video).some((id) => t.sources[id]?.kind === 'camera');
    if (cams && len > maxF) {
      items.push({ frame: first.range.start, ref: first.id, note: `same shot for ${(len / F).toFixed(1)} s (max ${(maxF / F).toFixed(1)} s)` });
      hard++;
    } else if (cams && len < minF && runStart > 0 && cur) {
      items.push({ frame: first.range.start, ref: first.id, note: `very short shot (${(len / F).toFixed(2)} s)` });
    }
    runStart = i;
  }
  // switches inside a word
  for (let i = 1; i < t.segments.length; i++) {
    const a = t.segments[i - 1]!;
    const b = t.segments[i]!;
    if (shotKey(a) === shotKey(b) || a.src.take !== b.src.take || a.src.to !== b.src.from) continue;
    const at = takeFrameToSeconds(t, a.src.take, a.src.to);
    const eps = 0.02;
    const w = wordsOf(o.words, a.src.take).find((x) => x.start < at - eps && x.end > at + eps);
    if (w) {
      items.push({ frame: b.range.start, ref: b.id, note: `switch inside the word "${w.w}"` });
      hard++;
    }
  }
  items.sort((p, q) => p.frame - q.frame);
  return {
    check: 'camera-switch',
    status: hard ? 'fail' : items.length ? 'needs-human' : 'pass',
    note: items.length ? `${items.length} issue(s)` : 'shot lengths and switch points look fine',
    items,
  };
}

