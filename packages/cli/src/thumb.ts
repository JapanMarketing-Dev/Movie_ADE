import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { assDialogue, assEscape, assHeader, assStyleLine, assTagColor } from '@solocut/core';
import { spawnSpec, whichSync } from '@solocut/toolchain';

// Thumbnails (docs/10): candidate frames by simple image heuristics, base images from an image-generation provider,
// and the Japanese title typeset by Solocut itself (SVG layer, or the same layout as ASS when ffmpeg has no SVG decoder).

// ---------- candidate scoring ----------

export interface FrameScore { sharpness: number; exposure: number; contrast: number; score: number }

/** Heuristic quality of a grayscale frame (w×h, 8-bit): mean |Laplacian| for sharpness, mid-tone mean, spread. */
export function scoreGray(px: Uint8Array, w: number, h: number): FrameScore {
  if (px.length < w * h || w < 3 || h < 3) throw new RangeError('frame buffer too small');
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < w * h; i++) {
    sum += px[i]!;
    sum2 += px[i]! * px[i]!;
  }
  const n = w * h;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let lap = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      lap += Math.abs(4 * px[i]! - px[i - 1]! - px[i + 1]! - px[i - w]! - px[i + w]!);
    }
  }
  const sharpRaw = lap / ((w - 2) * (h - 2));
  const sharpness = Math.min(1, sharpRaw / 40);
  const exposure = Math.max(0, 1 - Math.abs(mean - 120) / 120);
  const contrast = Math.min(1, std / 64);
  const score = Math.round((0.55 * sharpness + 0.25 * exposure + 0.2 * contrast) * 1000) / 1000;
  return { sharpness: round3(sharpness), exposure: round3(exposure), contrast: round3(contrast), score };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Best `n` samples, at least `minGap` frames apart. */
export function pickCandidates<T extends { frame: number; score: number }>(samples: T[], n: number, minGap: number): T[] {
  const out: T[] = [];
  for (const s of [...samples].sort((a, b) => b.score - a.score || a.frame - b.frame)) {
    if (out.length >= n) break;
    if (out.every((o) => Math.abs(o.frame - s.frame) >= minGap)) out.push(s);
  }
  return out;
}

// ---------- title typesetting ----------

export type ThumbFormat = 'youtube' | 'shorts';
export const THUMB_SIZES: Record<ThumbFormat, { width: number; height: number }> = {
  youtube: { width: 1280, height: 720 },
  shorts: { width: 1080, height: 1920 },
};

export interface TitleStyle { font: string; color: string; accent: string; stroke: string; band: string }
export const DEFAULT_TITLE_STYLE: TitleStyle = { font: 'Noto Sans JP', color: '#FFFFFF', accent: '#FFE600', stroke: '#000000', band: '#000000A0' };

export interface TitleLayout { lines: string[]; fontSize: number; x: number; y: number; lineHeight: number; band: { x: number; y: number; w: number; h: number }; anchor: 'start' | 'middle' }

const visualLen = (s: string) => [...s].reduce((a, c) => a + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0);

/**
 * Lay out title lines: YouTube = bottom-left block, Shorts = centered block in the upper third (clear of the UI).
 * The font size shrinks so the longest line fits ~62 % (YouTube) / 86 % (Shorts) of the width.
 */
export function layoutTitle(lines: string[], format: ThumbFormat): TitleLayout {
  const { width: W, height: H } = THUMB_SIZES[format];
  const clean = lines.map((l) => l.trim()).filter(Boolean).slice(0, 3);
  const longest = Math.max(1, ...clean.map(visualLen));
  const maxW = format === 'youtube' ? W * 0.62 : W * 0.86;
  const fontSize = Math.round(Math.min(format === 'youtube' ? H * 0.17 : W * 0.13, maxW / longest));
  const lineHeight = Math.round(fontSize * 1.18);
  const pad = Math.round(fontSize * 0.35);
  const blockH = lineHeight * clean.length;
  const blockW = Math.round(longest * fontSize);
  if (format === 'youtube') {
    const x = Math.round(W * 0.05);
    const y = Math.round(H - H * 0.07 - blockH);
    return { lines: clean, fontSize, x, y, lineHeight, anchor: 'start', band: { x: x - pad, y: y - pad, w: blockW + 2 * pad, h: blockH + 2 * pad } };
  }
  const x = Math.round(W / 2);
  const y = Math.round(H * 0.16);
  return { lines: clean, fontSize, x, y, lineHeight, anchor: 'middle', band: { x: Math.round(x - blockW / 2 - pad), y: y - pad, w: blockW + 2 * pad, h: blockH + 2 * pad } };
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function svgColor(hex: string): { color: string; opacity: number } {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new Error(`invalid color: ${hex}`);
  return { color: `#${m[1]}`, opacity: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) / 100 : 1 };
}

/** The title as its own SVG layer (transparent background). First line in the accent color. */
export function titleSvg(layout: TitleLayout, format: ThumbFormat, style: TitleStyle = DEFAULT_TITLE_STYLE): string {
  const { width: W, height: H } = THUMB_SIZES[format];
  const band = svgColor(style.band);
  const strokeW = Math.max(2, Math.round(layout.fontSize * 0.12));
  const texts = layout.lines.map((line, i) => {
    const fill = i === 0 ? style.accent : style.color;
    const y = layout.y + layout.lineHeight * i + Math.round(layout.fontSize * 0.88);
    return `<text x="${layout.x}" y="${y}" text-anchor="${layout.anchor}" font-family="${xmlEscape(style.font)}, sans-serif" font-weight="900" font-size="${layout.fontSize}" fill="${fill}" stroke="${style.stroke}" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke">${xmlEscape(line)}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect x="${layout.band.x}" y="${layout.band.y}" width="${layout.band.w}" height="${layout.band.h}" rx="${Math.round(layout.fontSize * 0.15)}" fill="${band.color}" fill-opacity="${band.opacity}"/>`,
    ...texts,
    '</svg>',
    '',
  ].join('\n');
}

/** The same layout as ASS (libass), for ffmpeg builds without an SVG decoder. */
export function titleAss(layout: TitleLayout, format: ThumbFormat, style: TitleStyle = DEFAULT_TITLE_STYLE): string {
  const size = THUMB_SIZES[format];
  const fps = { num: 1, den: 1 };
  const strokeW = Math.max(2, layout.fontSize * 0.12);
  const header = assHeader(size, [
    assStyleLine({ name: 'Band', font: style.font, size: 10, primary: style.band, outline: '#00000000', outlineWidth: 0, alignment: 7 }),
    assStyleLine({ name: 'Title', font: style.font, size: layout.fontSize, primary: style.color, outline: style.stroke, bold: true, outlineWidth: strokeW, shadow: 0, alignment: 7 }),
  ]);
  const b = layout.band;
  const events = [assDialogue(0, 0, 3600, fps, 'Band', `{\\pos(0,0)\\p1}m ${b.x} ${b.y} l ${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + b.h} ${b.x} ${b.y + b.h}{\\p0}`)];
  layout.lines.forEach((line, i) => {
    const y = layout.y + layout.lineHeight * i;
    const color = i === 0 ? `\\1c${assTagColor(style.accent)}` : '';
    const an = layout.anchor === 'middle' ? 8 : 7;
    events.push(assDialogue(1, 0, 3600, fps, 'Title', `{\\an${an}\\pos(${layout.x},${y})${color}}${assEscape(line)}`));
  });
  return `${header}\n${events.join('\n')}\n`;
}

// ---------- image generation providers ----------

export type ThumbProvider = 'codex' | 'openai' | 'gemini' | 'frame';

export interface GenRequest { frame: string; prompt: string; n: number; format: ThumbFormat; outDir: string; /** Style references (e.g. a past thumbnail). */ references?: string[] }
export interface GenContext {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Runs a command (tests inject a fake). `input` is written to stdin. */
  run?: RunFn;
  model?: string;
}

export class ThumbError extends Error {
  constructor(public readonly provider: ThumbProvider, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ThumbError';
  }
}

export type RunFn = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Run an agent CLI: resolved on PATH (on Windows npm installs .cmd shims, which need cmd.exe), long prompts on stdin
 * so no shell ever sees them.
 */
export const defaultRun: RunFn = (cmd, args, o) => {
  const file = whichSync(cmd, o.env) ?? cmd;
  const sp = spawnSpec(file, args, process.platform, o.env);
  return new Promise((res) => {
    const c = spawn(sp.command, sp.args, { cwd: o.cwd, env: o.env, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, ...(sp.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    if (o.input !== undefined) {
      c.stdin!.on('error', () => undefined);
      c.stdin!.end(o.input);
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => c.kill(), o.timeoutMs);
    c.stdout!.on('data', (d) => (stdout += String(d)));
    c.stderr!.on('data', (d) => (stderr += String(d)));
    c.on('error', (e) => {
      clearTimeout(timer);
      res({ code: null, stdout, stderr: stderr + e.message });
    });
    c.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
};

const IMG = /\.(png|jpe?g|webp)$/i;
const mimeOf = (p: string) => (/\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg');

function newestImages(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  const out: { p: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && IMG.test(e.name)) {
        const m = statSync(p).mtimeMs;
        if (m >= since) out.push({ p, m });
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

/** Codex: `codex exec -i <frame> '$imagegen …'` per image; images are picked up from $CODEX_HOME/generated_images. */
export async function generateCodex(req: GenRequest, ctx: GenContext): Promise<string[]> {
  const run = ctx.run ?? defaultRun;
  const home = ctx.env.CODEX_HOME ?? join(ctx.env.HOME ?? homedir(), '.codex');
  const imagesDir = join(home, 'generated_images');
  const aspect = req.format === 'youtube' ? '16:9 (1536x1024)' : '9:16 (1024x1536)';
  const out: string[] = [];
  for (let i = 0; i < req.n; i++) {
    const since = Date.now() - 1000;
    const prompt = `$imagegen ${req.prompt}\nAspect ratio ${aspect}. Use the attached frame as the reference for the person; keep their face unchanged. Do not draw any text or letters.`;
    // prompt on stdin ("-") and before the images: -i takes several values and would swallow a trailing prompt
    const r = await run('codex', ['exec', '--skip-git-repo-check', '-', '-i', req.frame, ...(req.references ?? []).flatMap((x) => ['-i', x])], { cwd: req.outDir, env: ctx.env, timeoutMs: 10 * 60_000, input: prompt });
    if (r.code !== 0) {
      const msg = `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-2).join(' ');
      throw new ThumbError('codex', /429|usage limit|rate limit/i.test(msg) ? `rate limited: ${msg}` : `codex exec failed (${r.code}): ${msg}`);
    }
    const found = newestImages(imagesDir, since).filter((p) => !out.includes(p))[0];
    if (!found) throw new ThumbError('codex', `no image appeared in ${imagesDir}`);
    const dest = join(req.outDir, `codex-${Date.now()}-${i}${extname(found)}`);
    copyFileSync(found, dest);
    out.push(dest);
  }
  return out;
}

async function readJson(res: Response, provider: ThumbProvider): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new ThumbError(provider, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ThumbError(provider, 'response is not JSON');
  }
}

function writeB64(dir: string, name: string, b64: string, provider: ThumbProvider): string {
  if (typeof b64 !== 'string' || !b64) throw new ThumbError(provider, 'response has no image data');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 64) throw new ThumbError(provider, 'image data is too small');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

/** OpenAI Images API edits (gpt-image-2) with the frame as the reference image. */
export async function generateOpenAI(req: GenRequest, ctx: GenContext): Promise<string[]> {
  const key = ctx.env.SOLOCUT_OPENAI_API_KEY ?? ctx.env.OPENAI_API_KEY;
  if (!key) throw new ThumbError('openai', 'no API key (SOLOCUT_OPENAI_API_KEY)');
  const f = ctx.fetch ?? fetch;
  const form = new FormData();
  form.append('model', ctx.model ?? 'gpt-image-2');
  form.append('prompt', `${req.prompt}\nKeep the person's face from the reference unchanged. Do not draw any text or letters.`);
  form.append('n', String(req.n));
  form.append('size', req.format === 'youtube' ? '1536x1024' : '1024x1536');
  form.append('quality', 'high');
  for (const [i, img] of [req.frame, ...(req.references ?? [])].entries()) {
    form.append('image[]', new Blob([readFileSync(img)], { type: mimeOf(img) }), `image-${i}${extname(img)}`);
  }
  let res: Response;
  try {
    res = await f('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
  } catch (e) {
    throw new ThumbError('openai', (e as Error).message);
  }
  const j = (await readJson(res, 'openai')) as { data?: { b64_json?: string }[] };
  if (!Array.isArray(j.data) || !j.data.length) throw new ThumbError('openai', 'response has no data');
  return j.data.map((d, i) => writeB64(req.outDir, `openai-${Date.now()}-${i}.png`, d.b64_json ?? '', 'openai'));
}

/** Gemini API (Nano Banana) generateContent with the frame inline; one request per image. */
export async function generateGemini(req: GenRequest, ctx: GenContext): Promise<string[]> {
  const key = ctx.env.SOLOCUT_GEMINI_API_KEY ?? ctx.env.GEMINI_API_KEY;
  if (!key) throw new ThumbError('gemini', 'no API key (SOLOCUT_GEMINI_API_KEY)');
  const f = ctx.fetch ?? fetch;
  const model = ctx.model ?? 'gemini-3-pro-image-preview';
  const data = readFileSync(req.frame).toString('base64');
  const out: string[] = [];
  for (let i = 0; i < req.n; i++) {
    let res: Response;
    try {
      res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: `${req.prompt}\nAspect ratio ${req.format === 'youtube' ? '16:9' : '9:16'}. Keep the person's face unchanged. No text or letters.` },
            { inline_data: { mime_type: mimeOf(req.frame), data } },
            ...(req.references ?? []).map((r) => ({ inline_data: { mime_type: mimeOf(r), data: readFileSync(r).toString('base64') } })),
          ] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: req.format === 'youtube' ? '16:9' : '9:16' } },
        }),
      });
    } catch (e) {
      throw new ThumbError('gemini', (e as Error).message);
    }
    const j = (await readJson(res, 'gemini')) as { candidates?: { content?: { parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[] } }[] };
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
    out.push(writeB64(req.outDir, `gemini-${Date.now()}-${i}.png`, part?.inlineData?.data ?? part?.inline_data?.data ?? '', 'gemini'));
  }
  return out;
}

export const PROVIDERS: Record<Exclude<ThumbProvider, 'frame'>, (req: GenRequest, ctx: GenContext) => Promise<string[]>> = {
  codex: generateCodex,
  openai: generateOpenAI,
  gemini: generateGemini,
};

/** Try providers in order; the first one that returns images wins. 'frame' (no generation) always succeeds. */
export async function generateBases(order: ThumbProvider[], req: GenRequest, ctx: GenContext): Promise<{ provider: ThumbProvider; images: string[]; errors: string[] }> {
  const errors: string[] = [];
  for (const p of order) {
    if (p === 'frame') return { provider: 'frame', images: Array.from({ length: req.n }, () => req.frame), errors };
    const gen = PROVIDERS[p];
    if (!gen) {
      errors.push(`${p}: unknown provider`);
      continue;
    }
    try {
      const images = await gen(req, ctx);
      if (images.length) return { provider: p, images: images.slice(0, req.n), errors };
      errors.push(`${p}: no images`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { provider: 'frame', images: Array.from({ length: req.n }, () => req.frame), errors };
}
