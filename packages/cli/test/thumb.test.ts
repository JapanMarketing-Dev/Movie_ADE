import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  THUMB_SIZES, ThumbError, generateBases, generateCodex, generateGemini, generateOpenAI, layoutTitle, pickCandidates, scoreGray,
  titleAss, titleSvg, type GenRequest,
} from '../src/thumb.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solocut-thumb-'));
  writeFileSync(join(dir, 'frame.png'), Buffer.alloc(200, 7));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req = (o: Partial<GenRequest> = {}): GenRequest => ({ frame: join(dir, 'frame.png'), prompt: 'a thumbnail', n: 2, format: 'youtube', outDir: dir, ...o });
const PNG = Buffer.alloc(300, 1).toString('base64');

function gray(w: number, h: number, f: (x: number, y: number) => number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
  return a;
}

describe('scoreGray', () => {
  it('prefers sharp, well-exposed frames over flat, dark or blurry ones', () => {
    const sharp = scoreGray(gray(64, 36, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 200 : 60), 64, 36);
    const blurry = scoreGray(gray(64, 36, (x) => 60 + (140 * x) / 63), 64, 36);
    const dark = scoreGray(gray(64, 36, () => 5), 64, 36);
    expect(sharp.score).toBeGreaterThan(blurry.score);
    expect(blurry.score).toBeGreaterThan(dark.score);
    expect(dark.sharpness).toBe(0);
    for (const s of [sharp, blurry, dark]) for (const v of Object.values(s)) expect(v).toBeGreaterThanOrEqual(0);
  });
  it('rejects tiny or short buffers', () => {
    expect(() => scoreGray(new Uint8Array(4), 2, 2)).toThrow();
    expect(() => scoreGray(new Uint8Array(10), 4, 4)).toThrow();
  });
});

describe('pickCandidates', () => {
  it('takes the best ones at least minGap apart', () => {
    const s = [{ frame: 0, score: 0.9 }, { frame: 10, score: 0.95 }, { frame: 100, score: 0.5 }, { frame: 200, score: 0.8 }];
    expect(pickCandidates(s, 3, 50).map((x) => x.frame)).toEqual([10, 200, 100]);
    expect(pickCandidates(s, 10, 0)).toHaveLength(4);
    expect(pickCandidates([], 3, 10)).toEqual([]);
  });
});

describe('title layout', () => {
  it.each(['youtube', 'shorts'] as const)('%s: the text block and band stay inside the canvas', (fmt) => {
    for (const lines of [['設定は3つだけ'], ['Claude Code', '設定のコツ'], ['とても長いタイトルの一行目になる文章です', '二行目', '三行目'], ['a', 'b', 'c', 'd']]) {
      const l = layoutTitle(lines, fmt);
      const { width: W, height: H } = THUMB_SIZES[fmt];
      expect(l.lines.length).toBeLessThanOrEqual(3);
      expect(l.band.x).toBeGreaterThanOrEqual(0);
      expect(l.band.y).toBeGreaterThanOrEqual(0);
      expect(l.band.x + l.band.w).toBeLessThanOrEqual(W);
      expect(l.band.y + l.band.h).toBeLessThanOrEqual(H);
      expect(l.fontSize).toBeGreaterThan(20);
    }
  });

  it('youtube is bottom-left, shorts is centered in the upper third', () => {
    const y = layoutTitle(['見出し'], 'youtube');
    expect(y.anchor).toBe('start');
    expect(y.y).toBeGreaterThan(360);
    const s = layoutTitle(['見出し'], 'shorts');
    expect(s.anchor).toBe('middle');
    expect(s.y).toBeLessThan(1920 / 3);
  });

  it('SVG escapes text and puts the accent on the first line', () => {
    const svg = titleSvg(layoutTitle(['<A&B>', '二行目'], 'youtube'), 'youtube');
    expect(svg).toContain('&lt;A&amp;B&gt;');
    expect(svg).not.toContain('<A&B>');
    expect(svg).toMatch(/fill="#FFE600"[^>]*>&lt;A/);
    expect(svg).toContain('width="1280" height="720"');
    expect(svg).toContain('paint-order="stroke"');
  });

  it('ASS has the band drawing, both lines and escapes braces', () => {
    const ass = titleAss(layoutTitle(['{x}', '二行目'], 'shorts'), 'shorts');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toMatch(/\\p1\}m \d+ \d+ l/);
    expect(ass).toContain('\\{x\\}');
    expect(ass).toContain('二行目');
    expect(ass).toContain('\\1c&H00E6FF&');
  });
});

describe('providers', () => {
  it('openai: multipart edits request with the frame, key from SOLOCUT_OPENAI_API_KEY', async () => {
    let seen: { url: string; auth: string; form: FormData } | null = null;
    const fetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: String((init.headers as Record<string, string>).authorization), form: init.body as FormData };
      return new Response(JSON.stringify({ data: [{ b64_json: PNG }, { b64_json: PNG }] }));
    }) as unknown as typeof globalThis.fetch;
    const out = await generateOpenAI(req({ references: [join(dir, 'frame.png')] }), { env: { SOLOCUT_OPENAI_API_KEY: 'sk-x' }, fetch });
    expect(out).toHaveLength(2);
    expect(readFileSync(out[0]!).length).toBe(300);
    expect(seen!.url).toBe('https://api.openai.com/v1/images/edits');
    expect(seen!.auth).toBe('Bearer sk-x');
    expect(seen!.form.get('model')).toBe('gpt-image-2');
    expect(seen!.form.get('size')).toBe('1536x1024');
    expect(seen!.form.getAll('image[]')).toHaveLength(2);
  });

  it('openai: missing key, HTTP error, empty or tiny data', async () => {
    await expect(generateOpenAI(req(), { env: {} })).rejects.toThrow(/no API key/);
    const err = (async () => new Response('{"error":"bad"}', { status: 400 })) as unknown as typeof fetch;
    await expect(generateOpenAI(req(), { env: { OPENAI_API_KEY: 'k' }, fetch: err })).rejects.toThrow(/HTTP 400/);
    const empty = (async () => new Response('{"data":[]}')) as unknown as typeof fetch;
    await expect(generateOpenAI(req(), { env: { OPENAI_API_KEY: 'k' }, fetch: empty })).rejects.toThrow(/no data/);
    const tiny = (async () => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))) as unknown as typeof fetch;
    await expect(generateOpenAI(req(), { env: { OPENAI_API_KEY: 'k' }, fetch: tiny })).rejects.toThrow(/too small/);
  });

  it('gemini: one generateContent per image with the frame inline', async () => {
    const calls: { url: string; body: { contents: { parts: unknown[] }[]; generationConfig: { imageConfig: { aspectRatio: string } } }; key: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), key: String((init.headers as Record<string, string>)['x-goog-api-key']) });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: PNG } }] } }] }));
    }) as unknown as typeof globalThis.fetch;
    const out = await generateGemini(req({ format: 'shorts' }), { env: { SOLOCUT_GEMINI_API_KEY: 'g' }, fetch, model: 'nano-banana-x' });
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/models/nano-banana-x:generateContent');
    expect(calls[0]!.key).toBe('g');
    expect(calls[0]!.body.generationConfig.imageConfig.aspectRatio).toBe('9:16');
    expect(calls[0]!.body.contents[0]!.parts).toHaveLength(2);
    const noImage = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }))) as unknown as typeof globalThis.fetch;
    await expect(generateGemini(req(), { env: { GEMINI_API_KEY: 'g' }, fetch: noImage })).rejects.toThrow(/no image data/);
    await expect(generateGemini(req(), { env: {} })).rejects.toThrow(/no API key/);
  });

  it('codex: runs codex exec with the frame and picks up new files from $CODEX_HOME/generated_images', async () => {
    const home = join(dir, 'codexhome');
    const imgs = join(home, 'generated_images', 'session');
    mkdirSync(imgs, { recursive: true });
    const old = join(imgs, 'old.png');
    writeFileSync(old, 'old');
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const calls: string[][] = [];
    let k = 0;
    const inputs: string[] = [];
    const run = async (cmd: string, args: string[], o: { input?: string }) => {
      calls.push([cmd, ...args]);
      inputs.push(o.input ?? '');
      writeFileSync(join(imgs, `gen-${k++}.png`), `img${k}`);
      return { code: 0, stdout: '', stderr: '' };
    };
    const out = await generateCodex(req(), { env: { CODEX_HOME: home }, run });
    expect(out).toHaveLength(2);
    expect(readFileSync(out[0]!, 'utf8')).toBe('img1');
    expect(readFileSync(out[1]!, 'utf8')).toBe('img2');
    expect(calls[0]).toEqual(['codex', 'exec', '--skip-git-repo-check', '-', '-i', join(dir, 'frame.png')]);
    expect(inputs[0]).toMatch(/^\$imagegen /);
    expect(inputs[0]).toContain('Do not draw any text');
  });

  it('codex: failure, rate limit and no new image', async () => {
    const home = join(dir, 'h');
    const fail = async () => ({ code: 1, stdout: '', stderr: 'ERROR: 429 Too Many Requests' });
    await expect(generateCodex(req(), { env: { CODEX_HOME: home }, run: fail })).rejects.toThrow(/rate limited/);
    const nothing = async () => ({ code: 0, stdout: 'done', stderr: '' });
    await expect(generateCodex(req(), { env: { CODEX_HOME: home }, run: nothing })).rejects.toThrow(/no image appeared/);
  });

  it('generateBases fails over in order and falls back to the frame', async () => {
    const fail = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    const r = await generateBases(['codex', 'openai', 'gemini'], req(), { env: { CODEX_HOME: join(dir, 'h') }, run: fail });
    expect(r.provider).toBe('frame');
    expect(r.images).toEqual([join(dir, 'frame.png'), join(dir, 'frame.png')]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[1]).toMatch(/openai: no API key/);
    const fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: PNG }, { b64_json: PNG }, { b64_json: PNG }] }))) as unknown as typeof globalThis.fetch;
    const r2 = await generateBases(['codex', 'openai'], req(), { env: { CODEX_HOME: join(dir, 'h'), OPENAI_API_KEY: 'k' }, run: fail, fetch });
    expect(r2.provider).toBe('openai');
    expect(r2.images).toHaveLength(2);
    expect((await generateBases(['frame'], req(), { env: {} })).errors).toEqual([]);
    expect(new ThumbError('codex', 'x').message).toBe('codex: x');
  });
});
