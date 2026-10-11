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

/** One CLI items.json entry -> app item. `timecode` comes from the caller (it knows the fps). */
export function parseFeedbackItem(raw: unknown, i: number, dir: string, timecode: (frame: number) => string = String): FeedbackItem | null {
  if (!isObj(raw)) return null;
  const n = typeof raw.index === 'number' ? raw.index : typeof raw.n === 'number' ? raw.n : i + 1;
  const frame = typeof raw.frame === 'number' ? raw.frame : 0;
  const item: FeedbackItem = {
    n,
    frame,
    timecode: typeof raw.timecode === 'string' && raw.timecode ? raw.timecode : timecode(frame),
    spoken: typeof raw.speech === 'string' ? raw.speech : typeof raw.spoken === 'string' ? raw.spoken : '',
    request: typeof raw.request === 'string' ? raw.request : typeof raw.title === 'string' ? raw.title : '',
    notes: Array.isArray(raw.notes) ? raw.notes.filter((x): x is string => typeof x === 'string') : [],
    targets: Array.isArray(raw.targets) ? raw.targets.map(parseTarget).filter((x): x is FeedbackTarget => x !== null) : [],
    image: typeof raw.image === 'string' ? raw.image : `${dir}/${String(n).padStart(2, '0')}.png`,
  };
  if (typeof raw.title === 'string') item.title = raw.title;
  return item;
}

/** `feedback show <id> --json` ({ id, markdown, items }) -> FeedbackImport (null if unusable). */
export function parseFeedbackShow(input: unknown, timecode?: (frame: number) => string): FeedbackImport | null {
  const o = isObj(input) && isObj(input.feedback) ? input.feedback : input;
  if (!isObj(o) || typeof o.id !== 'string') return null;
  const dir = typeof o.dir === 'string' ? o.dir : `feedback/${o.id}`;
  const items = Array.isArray(o.items)
    ? o.items.map((x, i) => parseFeedbackItem(x, i, dir, timecode)).filter((x): x is FeedbackItem => x !== null)
    : [];
  return { id: o.id, dir, items };
}

/**
 * Applies the user's edits to the raw items.json entries: keeps only the given items (by index), sets their
 * request, and renumbers. Unknown fields of the CLI entries are preserved.
 */
export function applyItemEdits(raw: unknown[], edited: FeedbackItem[]): Record<string, unknown>[] {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const r of raw) if (isObj(r) && typeof r.index === 'number') byIndex.set(r.index, r);
  return edited.flatMap((e) => {
    const r = byIndex.get(e.n);
    return r ? [{ ...r, request: e.request }] : [];
  }).map((r, i) => ({ ...r, index: i + 1 }));
}

/** Minimal feedback.md (docs/04 format), used only when the CLI cannot rewrite it. */
export function feedbackMarkdown(id: string, items: FeedbackItem[], lang: 'ja' | 'en'): string {
  const L = lang === 'ja' ? { req: '要望', said: '発話（原文）', note: 'メモ', img: '画像', tgt: '対象' } : { req: 'Request', said: 'Said', note: 'Note', img: 'Image', tgt: 'Targets' };
  const out = [`# Feedback ${id}`, ''];
  for (const it of items) {
    out.push(`## ${it.n}. [${it.timecode}] ${it.title ?? it.request.slice(0, 30)}`);
    if (it.request) out.push(`- ${L.req}: ${it.request}`);
    if (it.spoken) out.push(`- ${L.said}: 「${it.spoken}」`);
    for (const n of it.notes) out.push(`- ${L.note}: ${n}`);
    out.push(`- ${L.img}: ./${String(it.n).padStart(2, '0')}.png`);
    if (it.targets.length) out.push(`- ${L.tgt}: ${it.targets.map((t) => `${t.kind} ${t.id}${t.label ? `（${t.label}）` : ''}`).join('、')}`);
    out.push('');
  }
  return out.join('\n');
}

/** Rectangle outline as a closed stroke (the CLI only knows strokes). */
export function boxPoints(b: { x: number; y: number; w: number; h: number }): [number, number][] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
    [b.x, b.y],
  ];
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
