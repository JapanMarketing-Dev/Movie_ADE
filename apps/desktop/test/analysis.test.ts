import { describe, expect, it } from 'vitest';
import {
  displayIdOf,
  findPii,
  frameDiff,
  normalizeCursor,
  normalizeOcr,
  padBox,
  piiMaskOps,
  redact,
  sampleTimes,
  toGray,
  trackHits,
  unionBox,
  type OcrWord,
  type PiiFile,
} from '../src/shared/analysis';

const w = (text: string, x: number, y = 0.5, wd = 0.1, conf = 90): OcrWord => ({ text, box: { x, y, w: wd, h: 0.02 }, confidence: conf });

describe('cursor', () => {
  it('normalizes to the captured display, including secondary displays with offsets', () => {
    expect(normalizeCursor({ x: 960, y: 540 }, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeCursor({ x: -100, y: 0 }, { x: -1440, y: 0, width: 1440, height: 900 })).toEqual({ x: 0.9306, y: 0 });
    expect(normalizeCursor({ x: 2000, y: 10 }, { x: 0, y: 0, width: 1920, height: 1080 }).x).toBeGreaterThan(1);
  });
  it('display id from capturer source ids', () => {
    expect(displayIdOf('screen:69734272:0')).toBe('69734272');
    expect(displayIdOf('window:1234:0')).toBeNull();
    expect(displayIdOf(null)).toBeNull();
  });
});

describe('PII detection', () => {
  it('finds emails, tokens and keys in single words', () => {
    const hits = findPii([
      [w('contact:', 0), w('taro.yamada@example.co.jp', 0.1)],
      [w('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx123', 0, 0.6, 0.5)],
      [w('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 0, 0.7, 0.4)],
      [w('AKIAIOSFODNN7EXAMPLE', 0, 0.8)],
      [w('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 0, 0.9, 0.6)],
    ]);
    expect(hits.map((h) => `${h.kind}:${h.label}`)).toEqual(['email:email', 'token:openai', 'token:github', 'token:aws', 'token:jwt']);
    for (const h of hits) expect(h.text).toContain('•');
    expect(JSON.stringify(hits)).not.toContain('yamada@example');
  });
  it('finds phone numbers split across words and joined', () => {
    const hits = findPii([[w('TEL', 0), w('03-1234-5678', 0.1)], [w('090', 0, 0.6, 0.05), w('1234', 0.06, 0.6, 0.05), w('5678', 0.12, 0.6, 0.05)], [w('09012345678', 0, 0.7)]]);
    expect(hits.filter((h) => h.kind === 'phone')).toHaveLength(3);
    const split = hits.find((h) => h.box.y < 0.61 && h.box.y > 0.55)!;
    expect(split.box.w).toBeGreaterThan(0.15); // union of the three words (+ padding)
  });
  it('joins words OCR split, and reads "の" between ASCII as "@"', () => {
    const hits = findPii([
      [w('contact:', 0), w('taro.yamada', 0.1), w('の', 0.25, 0.5, 0.02), w('example.com', 0.28)],
      [w('KEY=sk-proj-abcdefghij', 0, 0.6, 0.3), w('klmnopqrstuvwx123', 0.31, 0.6, 0.3)],
      [w('ｍａｉｌ＠ｅｘａｍｐｌｅ．ｊｐ', 0, 0.8)],
    ]);
    expect(hits.map((h) => h.kind)).toEqual(['email', 'token', 'email']);
    expect(hits[0]!.box.x).toBeGreaterThan(0.09); // starts at taro.yamada, not at contact:
    expect(hits[0]!.box.x).toBeLessThan(0.11);
    expect(hits[0]!.box.x + hits[0]!.box.w).toBeGreaterThan(0.37);
    expect(normalizeOcr('a の b')).toBe('a@b');
    expect(normalizeOcr('これの話')).toBe('これの話');
  });
  it('ignores ordinary text, short numbers and low-confidence words', () => {
    expect(findPii([[w('version', 0), w('1.2.3', 0.1), w('2026-10-11', 0.2), w('sk-short', 0.3), w('12:30', 0.4)]])).toEqual([]);
    expect(findPii([[w('a@b.co', 0, 0.5, 0.1, 10)]])).toEqual([]); // below 15: OCR noise
  });
  it('redacts and boxes', () => {
    expect(redact('abc')).toBe('•••');
    expect(redact('sk-1234567890abcdef')).toMatch(/^sk-•+ef$/);
    expect(unionBox([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.3, y: 0.05, w: 0.1, h: 0.1 }])).toEqual({ x: 0.1, y: 0.05, w: expect.closeTo(0.3, 10), h: expect.closeTo(0.15, 10) });
    expect(padBox({ x: 0, y: 0.99, w: 0.1, h: 0.01 }, 0.01)).toEqual({ x: 0, y: 0.98, w: expect.closeTo(0.11, 10), h: expect.closeTo(0.02, 10) });
  });
});

describe('frames', () => {
  it('gray + diff', () => {
    const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
    expect([...g]).toEqual([255, 0]);
    expect(frameDiff(g, g)).toBe(0);
    expect(frameDiff(new Uint8Array([0, 0]), new Uint8Array([255, 255]))).toBe(1);
    expect(frameDiff(new Uint8Array([0]), new Uint8Array([0, 0]))).toBe(1);
  });
  it('sample times', () => {
    expect(sampleTimes(2.5, 1)).toEqual([0, 1, 2]);
    expect(sampleTimes(1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(sampleTimes(0, 5)).toEqual([]);
    expect(sampleTimes(Number.NaN, 5)).toEqual([]);
  });
});

describe('PII → mask ops', () => {
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.05 };
  const file: PiiFile = {
    schema: 1,
    source: 't1.screen',
    fps: 1,
    sourceFps: 30,
    width: 1920,
    height: 1080,
    frames: [
      { f: 0, t: 0, changed: true, boxes: [{ ...box, kind: 'email', label: 'email', text: 'x' }] },
      { f: 30, t: 1, changed: false, boxes: [{ ...box, x: 0.11, kind: 'email', label: 'email', text: 'x' }] },
      { f: 60, t: 2, changed: true, boxes: [] },
      { f: 300, t: 10, changed: true, boxes: [{ x: 0.5, y: 0.5, w: 0.3, h: 0.03, kind: 'token', label: 'openai', text: 'x' }] },
    ],
  };
  it('links hits into tracks', () => {
    const tr = trackHits(file.frames, 60);
    expect(tr.map((t) => [t.kind, t.points.map((p) => p.f)])).toEqual([['email', [0, 30]], ['token', [300]]]);
  });
  it('builds pixelate masks in source pixels with needsReview, held until the next sample', () => {
    const ops = piiMaskOps(file, 't1.screen', new Set());
    expect(ops).toHaveLength(2);
    const m = (ops[0] as { mask: Record<string, unknown> }).mask;
    expect(m).toMatchObject({ kind: 'pixelate', source: 't1.screen', reason: 'pii:email', decided: { by: 'rule', needsReview: true } });
    expect(m.track).toEqual([
      { frame: 0, box: { x: 192, y: 108, w: 384, h: 54 }, confidence: 0.8 },
      { frame: 30, box: { x: 211, y: 108, w: 384, h: 54 }, confidence: 0.8 },
      { frame: 59, box: { x: 211, y: 108, w: 384, h: 54 }, confidence: 0.8 },
    ]);
    expect((ops[1] as { mask: { reason: string } }).mask.reason).toBe('pii:token');
  });
  it('is idempotent: existing ids are skipped', () => {
    const ids = new Set(piiMaskOps(file, 't1.screen', new Set()).map((o) => (o as { mask: { id: string } }).mask.id));
    expect([...ids].every((id) => /^mask_pii_[a-z0-9]+$/.test(id))).toBe(true);
    expect(piiMaskOps(file, 't1.screen', ids)).toEqual([]);
  });
});
