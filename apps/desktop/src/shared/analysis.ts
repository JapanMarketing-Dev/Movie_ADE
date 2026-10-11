// Pure helpers for the analysis producers: cursor normalization, PII detection on OCR words, frame-change
// detection, and turning PII detections into mask ops (CONTRACTS.md `addMask`). No DOM, no Node APIs.

export interface NBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------- cursor ----------

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Cursor point (DIP screen coordinates) normalized to a display; values outside 0..1 mean "on another display". */
export function normalizeCursor(p: { x: number; y: number }, b: Bounds): { x: number; y: number } {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r((p.x - b.x) / (b.width || 1)), y: r((p.y - b.y) / (b.height || 1)) };
}

/** Display id from a desktopCapturer source id ("screen:<id>:0"); null for windows. */
export function displayIdOf(sourceId: string | null | undefined): string | null {
  const m = /^screen:(\d+):/.exec(sourceId ?? '');
  return m ? m[1]! : null;
}

// ---------- PII ----------

export type PiiKind = 'email' | 'phone' | 'token';

interface Pattern {
  kind: PiiKind;
  label: string;
  re: RegExp;
}

/** Patterns are anchored to a whole OCR word (or a joined line for phone numbers). */
export const PII_PATTERNS: Pattern[] = [
  { kind: 'email', label: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'token', label: 'openai', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'token', label: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { kind: 'token', label: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'token', label: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'token', label: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'token', label: 'stripe', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'token', label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // JP landline / mobile (03-1234-5678, 090-1234-5678, 0120-123-456) and international (+81 90 1234 5678)
  { kind: 'phone', label: 'phone', re: /(?:\+\d{1,3}[ -]?)?\(?0?\d{1,4}\)?[ -]\d{1,4}[ -]\d{3,4}\b|\b0[789]0\d{8}\b/ },
];

export interface OcrWord {
  text: string;
  box: NBox; // normalized to the frame
  confidence?: number; // 0..100 (tesseract)
}

export interface PiiHit {
  kind: PiiKind;
  label: string;
  /** Redacted: never store the secret itself in derived files. */
  text: string;
  box: NBox;
}

/** NFKC (full-width → ASCII) and "の" / "＠" between ASCII word characters read as "@". */
export function normalizeOcr(s: string): string {
  return s.normalize('NFKC').replace(/([A-Za-z0-9._%+-])\s*[の@]\s*([A-Za-z0-9-])/g, '$1@$2');
}

export function redact(s: string): string {
  if (s.length <= 6) return '•'.repeat(s.length);
  return `${s.slice(0, 3)}${'•'.repeat(Math.min(12, s.length - 5))}${s.slice(-2)}`;
}

export function unionBox(boxes: NBox[]): NBox {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Grows a box by `pad` (normalized) on each side, clamped to the frame. */
export function padBox(b: NBox, pad: number): NBox {
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, w: Math.min(1, b.x + b.w + pad) - x, h: Math.min(1, b.y + b.h + pad) - y };
}

/**
 * Finds PII in OCR output. Single words are tested against every pattern; consecutive words on a line are also
 * joined (with and without spaces) for phone numbers and tokens that OCR split up.
 */
export function findPii(lines: OcrWord[][], minConfidence = 15): PiiHit[] {
  const hits: PiiHit[] = [];
  const overlaps = (a: NBox, b: NBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const add = (kind: PiiKind, label: string, text: string, words: OcrWord[]) => {
    const box = padBox(unionBox(words.map((w) => w.box)), 0.004);
    // one hit per place: a word-window match that overlaps an earlier (narrower) match of the same kind is dropped
    if (hits.some((h) => h.kind === kind && overlaps(h.box, box))) return;
    hits.push({ kind, label, text: redact(text), box });
  };
  for (const line of lines) {
    const words = line.filter((w) => w.text.trim() && (w.confidence ?? 100) >= minConfidence);
    for (const w of words) {
      for (const p of PII_PATTERNS) {
        if (p.kind === 'phone') continue;
        const m = p.re.exec(normalizeOcr(w.text));
        if (m) {
          add(p.kind, p.label, m[0], [w]);
          break;
        }
      }
    }
    for (const w of words) {
      const m = PII_PATTERNS.find((p) => p.kind === 'phone')!.re.exec(w.text);
      if (m && m[0].replace(/\D/g, '').length >= 10) add('phone', 'phone', m[0], [w]);
    }
    // OCR splits long tokens and misreads "@" (jpn models read it as "の"): retry on 2..4 joined words
    // narrowest windows first, so the box covers only the words that make up the match
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const win = words.slice(i, i + n);
        const joined = normalizeOcr(win.map((w) => w.text).join(''));
        for (const p of PII_PATTERNS) {
          if (p.kind === 'phone') continue;
          const m = p.re.exec(joined);
          if (m) {
            add(p.kind, p.label, m[0], win);
            break;
          }
        }
      }
    }
    // windows of 2..4 words for phone numbers
    for (let i = 0; i < words.length; i++) {
      for (let n = 2; n <= 4 && i + n <= words.length; n++) {
        const win = words.slice(i, i + n);
        const spaced = win.map((w) => w.text).join(' ');
        const phone = PII_PATTERNS.find((p) => p.kind === 'phone')!.re.exec(spaced);
        if (phone && phone[0].replace(/\D/g, '').length >= 10) add('phone', 'phone', phone[0], win);
      }
    }
  }
  return hits;
}

// ---------- frame change ----------

/** Mean absolute difference (0..1) of two equally sized grayscale thumbnails. */
export function frameDiff(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / (a.length * 255);
}

/** RGBA pixels → grayscale (BT.601 luma). */
export function toGray(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = Math.round(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
  return out;
}

/** Sample times (seconds) for a video of `duration` at `fps` samples per second. */
export function sampleTimes(duration: number, fps: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || fps <= 0) return [];
  const step = 1 / fps;
  const n = Math.floor(duration / step + 1e-9);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.round(i * step * 1000) / 1000;
    if (t < duration) out.push(t);
  }
  return out;
}

// ---------- analysis files ----------

export interface FacesFile {
  schema: 1;
  source: string;
  fps: number; // samples per second
  sourceFps: number;
  width: number;
  height: number;
  frames: { f: number; t: number; faces: (NBox & { score: number })[] }[];
}

/** One PII box at a source frame: the hit flattened (the format engine's masksFromPii reads). */
export type PiiBox = NBox & { kind: PiiKind; label: string; text: string };

export interface PiiFile {
  schema: 1;
  source: string;
  fps: number;
  sourceFps: number;
  width: number;
  height: number;
  frames: { f: number; t: number; changed: boolean; boxes: PiiBox[] }[];
}

export function toPiiBoxes(hits: PiiHit[]): PiiBox[] {
  return hits.map((h) => ({ ...h.box, kind: h.kind, label: h.label, text: h.text }));
}

// ---------- masks ----------

const MASK_REASON: Record<PiiKind, 'pii:email' | 'pii:phone' | 'pii:token'> = { email: 'pii:email', phone: 'pii:phone', token: 'pii:token' };

function iou(a: NBox, b: NBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

export interface MaskTrack {
  kind: PiiKind;
  label: string;
  points: { f: number; box: NBox }[];
}

/**
 * Links per-frame hits into tracks: a hit continues a track of the same kind whose last box overlaps it
 * (IoU ≥ 0.3) and that was seen within `maxGapFrames`.
 */
export function trackHits(frames: PiiFile['frames'], maxGapFrames: number): MaskTrack[] {
  const tracks: MaskTrack[] = [];
  for (const fr of frames) {
    for (const b of fr.boxes) {
      const box = { x: b.x, y: b.y, w: b.w, h: b.h };
      const t = tracks.find((tr) => {
        const last = tr.points[tr.points.length - 1]!;
        return tr.kind === b.kind && fr.f - last.f <= maxGapFrames && fr.f > last.f && iou(last.box, box) >= 0.3;
      });
      if (t) t.points.push({ f: fr.f, box });
      else tracks.push({ kind: b.kind, label: b.label, points: [{ f: fr.f, box }] });
    }
  }
  return tracks;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * addMask ops for PII tracks (source pixels at source frames, pixelate, needsReview). A track that ends is held
 * until the next sample (1 / fps) so the mask covers the time between samples. Ids are stable per source/kind/start,
 * so ops whose id already exists in the timeline are skipped (re-running the analysis does not duplicate masks).
 */
export function piiMaskOps(file: PiiFile, sourceId: string, existingIds: Set<string>): Record<string, unknown>[] {
  const step = Math.max(1, Math.round(file.sourceFps / Math.max(0.1, file.fps)));
  const tracks = trackHits(file.frames, step * 2);
  const ops: Record<string, unknown>[] = [];
  for (const tr of tracks) {
    const first = tr.points[0]!;
    const id = `mask_pii_${hash(`${sourceId}:${tr.kind}:${first.f}:${Math.round(first.box.x * 100)}:${Math.round(first.box.y * 100)}`)}`;
    if (existingIds.has(id)) continue;
    const px = (b: NBox) => ({
      x: Math.round(b.x * file.width),
      y: Math.round(b.y * file.height),
      w: Math.max(1, Math.round(b.w * file.width)),
      h: Math.max(1, Math.round(b.h * file.height)),
    });
    const pts = [...tr.points];
    const last = pts[pts.length - 1]!;
    pts.push({ f: last.f + step - 1, box: last.box });
    ops.push({
      op: 'addMask',
      mask: {
        id,
        kind: 'pixelate',
        source: sourceId,
        reason: MASK_REASON[tr.kind],
        track: pts.map((p) => ({ frame: p.f, box: px(p.box), confidence: 0.8 })),
        decided: { by: 'rule', reason: `OCR found ${tr.label} on screen`, confidence: 0.8, needsReview: true },
      },
    });
  }
  return ops;
}
