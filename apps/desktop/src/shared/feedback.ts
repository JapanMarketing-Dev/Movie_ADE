// Pure helpers for video feedback recording (renderer) and import results (main).
import type { FeedbackImport, FeedbackItem, FeedbackTarget } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Timeline frame shown at a preview time (the preview starts at frame 0). */
export function frameAt(videoTime: number, fpsNum: number, fpsDen: number): number {
  if (!Number.isFinite(videoTime) || videoTime < 0) return 0;
  return Math.round((videoTime * fpsNum) / (fpsDen || 1));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the video content sits inside its element with object-fit: contain. */
export function contentRect(elW: number, elH: number, vidW: number, vidH: number): Rect {
  if (elW <= 0 || elH <= 0 || vidW <= 0 || vidH <= 0) return { x: 0, y: 0, w: Math.max(0, elW), h: Math.max(0, elH) };
  // compare aspect ratios with a cross product to avoid rounding drift on the fitted side
  if (elW * vidH <= elH * vidW) {
    const h = (vidH * elW) / vidW;
    return { x: 0, y: (elH - h) / 2, w: elW, h };
  }
  const w = (vidW * elH) / vidH;
  return { x: (elW - w) / 2, y: 0, w, h: elH };
}

/** Element coordinates -> normalized video coordinates (0..1, clamped). */
export function normalizePoint(px: number, py: number, r: Rect): [number, number] {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  return [c((px - r.x) / (r.w || 1)), c((py - r.y) / (r.h || 1))];
}

/** Normalized box from two corners in any order. */
export function boxFrom(a: [number, number], b: [number, number]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** Drops points closer than `minDist` (normalized) to the previous kept point; keeps the last point. */
export function simplifyStroke(points: [number, number][], minDist = 0.003): [number, number][] {
  if (points.length <= 2) return points.slice();
  const out: [number, number][] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const q = out[out.length - 1]!;
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p);
  }
  out.push(points[points.length - 1]!);
  return out;
}

function parseTarget(t: unknown): FeedbackTarget | null {
  if (typeof t === 'string') return { kind: t.split('_')[0] ?? 'el', id: t };
  if (!isObj(t) || typeof t.id !== 'string') return null;
  const out: FeedbackTarget = { kind: typeof t.kind === 'string' ? t.kind : 'el', id: t.id };
  if (typeof t.label === 'string') out.label = t.label;
  return out;
}

export function parseFeedbackItem(raw: unknown, i: number): FeedbackItem | null {
  if (!isObj(raw)) return null;
  const frame = typeof raw.frame === 'number' ? raw.frame : 0;
  const item: FeedbackItem = {
    n: typeof raw.n === 'number' ? raw.n : i + 1,
    frame,
    timecode: typeof raw.timecode === 'string' ? raw.timecode : '',
    spoken: typeof raw.spoken === 'string' ? raw.spoken : '',
    request: typeof raw.request === 'string' ? raw.request : typeof raw.text === 'string' ? raw.text : '',
    targets: Array.isArray(raw.targets) ? raw.targets.map(parseTarget).filter((x): x is FeedbackTarget => x !== null) : [],
  };
  if (typeof raw.image === 'string') item.image = raw.image;
  return item;
}

/** `feedback import --json` / `feedback update --json` output -> FeedbackImport (null if unusable). */
export function parseFeedbackImport(input: unknown): FeedbackImport | null {
  const o = isObj(input) && isObj(input.feedback) ? input.feedback : input;
  if (!isObj(o) || typeof o.id !== 'string') return null;
  const items = Array.isArray(o.items) ? o.items.map(parseFeedbackItem).filter((x): x is FeedbackItem => x !== null) : [];
  return { id: o.id, dir: typeof o.dir === 'string' ? o.dir : `feedback/${o.id}`, items };
}

/** Renumbers items 1..n after deletions. */
export function renumber(items: FeedbackItem[]): FeedbackItem[] {
  return items.map((it, i) => ({ ...it, n: i + 1 }));
}

/** The one line sent to the agent terminal (docs/04). */
export function feedbackAgentMessage(dir: string, lang: 'ja' | 'en'): string {
  const md = `${dir.replace(/\/+$/, '')}/feedback.md`;
  return lang === 'ja'
    ? `${md} を読んで、指摘を1つずつ直してください。終わったら solocut render --preview と solocut check を実行してください。`
    : `Read ${md} and fix each item. Then run solocut render --preview and solocut check.`;
}
