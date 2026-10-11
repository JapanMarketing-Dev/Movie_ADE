import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  durationFrames, frameToSeconds, frameToTimecode, sourceLocalSeconds, takeFrameToSeconds, timecodeToFrame, timelineFrameToTake,
  type Output, type Target, type Timeline,
} from '@solocut/core';
import { band, decide } from '@solocut/decide';
import { loadSettings } from '@solocut/settings';
import { CliError, emit, info, intOpt, opts, t, type Ctx } from '../ctx.js';
import { applyEdit, openProject, paths, projectTemplate, readTimeline, setStep, writeAtomic, type Project } from '../project.js';
import {
  DEFAULT_TITLE_STYLE, THUMB_SIZES, generateBases, layoutTitle, pickCandidates, scoreGray, titleAss, titleSvg,
  type GenContext, type ThumbFormat, type ThumbProvider,
} from '../thumb.js';
import { allTimelines, captionsLib, freshPreview, media } from './media.js';
import { apiKeyFor } from '../keys.js';
import { ensureFonts } from '../fonts.js';
import { emptyOutput } from './meta.js';

const VERTICAL = new Set<Target>(['youtube-shorts', 'tiktok', 'instagram-reels']);
const MAX_BYTES = 2 * 1024 * 1024;

function parseFrame(ctx: Ctx, tl: Timeline, v: string): number {
  let f: number;
  try {
    f = /^\d+$/.test(v) ? Number(v) : timecodeToFrame(v, tl.canvas.fps);
  } catch (e) {
    throw new CliError('usage', (e as Error).message);
  }
  const total = durationFrames(tl);
  if (f < 0 || f >= total) throw new CliError('out-of-range', t(ctx, `フレーム ${f} は範囲外です（0〜${total - 1}）`, `frame ${f} is out of range (0–${total - 1})`));
  return f;
}

/** The original (full-resolution) source and local time shown at a timeline frame; prefers a camera (the face). */
export function sourceAt(tl: Timeline, frame: number): { id: string; path: string; sec: number } | null {
  const hit = timelineFrameToTake(tl, frame);
  if (!hit) return null;
  const v = hit.segment.video;
  const ids = v.layout === 'camera-full' ? [v.camera] : v.layout === 'screen-with-wipe' ? [v.camera, v.screen] : v.layout === 'split-v' ? [v.bottom, v.top] : v.layout === 'screen-full' ? [v.screen] : [];
  for (const id of ids) {
    const s = tl.sources[id];
    if (!s || (s.kind !== 'camera' && s.kind !== 'screen')) continue;
    const takeSec = takeFrameToSeconds(tl, hit.take, hit.frame);
    return { id, path: s.path, sec: Math.max(0, sourceLocalSeconds(tl, s, takeSec)) };
  }
  return null;
}

/** renders/thumbnails for the main video, renders/thumbnails/<variant> for a derived one. */
function thumbsDir(p: Project): string {
  return p.variant ? join(p.dir, 'renders', 'thumbnails', p.variant) : join(p.dir, 'renders', 'thumbnails');
}

const relp = (p: Project, abs: string) => abs.slice(p.dir.length + 1).split('\\').join('/');

/** Mark the thumbnail step done once every video (main + existing variants) has a thumbnail on its outputs. */
function updateThumbnailStep(p: Project): void {
  const all = allTimelines(p);
  const missing = all.filter((x) => {
    const tl = readTimeline(x);
    const targets = x.variant ? [x.variant] : tl.meta.targets;
    return targets.some((target) => !tl.outputs.find((o) => o.target === target)?.thumbnail);
  }).map((x) => x.variant ?? 'main');
  if (missing.length) setStep(p, 'thumbnail', 'running', `missing: ${missing.join(', ')}`);
  else setStep(p, 'thumbnail', 'done');
}

// ---------- candidates ----------

async function grayFrames(ffmpeg: string, input: string, times: number[], fps: number, out: string): Promise<Buffer> {
  const half = (0.5 / fps).toFixed(4);
  const expr = times.map((s) => `lt(abs(t-${s.toFixed(4)}),${half})`).join('+');
  await new Promise<void>((res, rej) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', input, '-vf', `select='${expr}',scale=160:90,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', out], { maxBuffer: 1 << 26 }, (err, _o, stderr) => {
      if (err) rej(new CliError('ffmpeg', String(stderr).trim().split('\n').slice(-2).join(' ')));
      else res();
    });
  });
  return readFileSync(out);
}

async function cmdCandidates(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { n: { type: 'string' }, every: { type: 'string' } }, { max: 0 });
  const n = intOpt(values.n, 'n') ?? 6;
  const everySec = values.every ? Number(values.every) : 2;
  if (!(n >= 1 && n <= 50)) throw new CliError('usage', '--n must be 1..50');
  if (!(everySec >= 0.25)) throw new CliError('usage', '--every must be ≥ 0.25 (seconds)');
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const total = durationFrames(tl);
  if (!total) throw new CliError('no-segments', t(ctx, '区間がありません', 'no segments'));
  const m = await media();
  const preview = await freshPreview(ctx, p, tl);
  const pr = await m.probe(preview);
  const fps = pr.streams.find((s) => s.type === 'video')?.fps;
  const pfps = fps ? fps.num / fps.den : tl.canvas.fps.num / tl.canvas.fps.den;
  const cfps = tl.canvas.fps.num / tl.canvas.fps.den;
  const margin = Math.round(cfps * 0.5);
  const frames = new Set<number>();
  for (const s of tl.segments) frames.add(Math.round((s.range.start + s.range.end) / 2));
  for (let f = margin; f < total - margin; f += Math.max(1, Math.round(everySec * cfps))) frames.add(f);
  let list = [...frames].filter((f) => f >= 0 && f < total).sort((a, b) => a - b);
  if (list.length > 120) list = list.filter((_, i) => i % Math.ceil(list.length / 120) === 0);
  const dir = join(p.dir, 'checks', 'thumbs', ...(p.variant ? [p.variant] : []));
  mkdirSync(dir, { recursive: true });
  const ffmpeg = await m.toolPath('ffmpeg');
  const raw = await grayFrames(ffmpeg, preview, list.map((f) => f / cfps), pfps, join(dir, 'samples.gray'));
  rmSync(join(dir, 'samples.gray'), { force: true });
  const size = 160 * 90;
  const count = Math.min(list.length, Math.floor(raw.length / size));
  const samples = Array.from({ length: count }, (_, i) => ({ frame: list[i]!, ...scoreGray(raw.subarray(i * size, (i + 1) * size), 160, 90) }));
  // segments the template marks as the hook or summary make better thumbnails
  for (const s of samples) {
    const seg = tl.segments.find((x) => s.frame >= x.range.start && s.frame < x.range.end);
    if (seg && (seg.role === 'hook' || seg.role === 'summary')) s.score = Math.round(Math.min(1, s.score + 0.05) * 1000) / 1000;
  }
  const picked = pickCandidates(samples, Math.min(samples.length, n * 2), Math.round(cfps * 3));
  const out: { frame: number; timecode: string; score: number; heuristic: number; model?: number; image: string }[] = [];
  for (const c of picked) {
    const image = join(dir, `cand-${c.frame}.jpg`);
    await m.extractFrame(preview, frameToSeconds(c.frame, tl.canvas.fps), image, { width: 640 });
    out.push({ frame: c.frame, timecode: frameToTimecode(c.frame, tl.canvas.fps), score: c.score, heuristic: c.score, image });
  }
  // the decision model looks at eyes / blur / expression when configured
  const s = loadSettings();
  const warnings: string[] = [];
  if (s.decision.provider !== 'off') {
    for (const c of out) {
      try {
        const [a] = await decide({
          state: { purpose: 'video thumbnail', title: tl.meta.title },
          questions: [{ id: 'good', kind: 'yesno', text: t(ctx, '人物の目が開いていて、ブレておらず、表情が良いか（サムネイルに使えるか）', 'Are the eyes open, the image sharp and the expression good (usable as a thumbnail)?') }],
          images: [{ id: 'frame', path: c.image }],
        }, {
          provider: s.decision.provider, model: s.decision.model, ...(s.decision.endpoint ? { endpoint: s.decision.endpoint } : {}),
          ...(apiKeyFor(ctx.io.env, s.decision.apiKeyRef, s.decision.provider) ? { apiKey: apiKeyFor(ctx.io.env, s.decision.apiKeyRef, s.decision.provider)! } : {}), cacheDir: join(paths(p.dir).cache, 'decisions'),
        });
        if (a?.p !== undefined) {
          c.model = a.p;
          c.score = Math.round((0.5 * c.heuristic + 0.5 * a.p) * 1000) / 1000;
          if (band(a.p, { autoAbove: 1.01, autoBelow: 0.2 }) === 'no') c.score = 0;
        }
      } catch (e) {
        warnings.push(`decision model: ${(e as Error).message}`);
        break;
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  const best = out.slice(0, n);
  for (const c of out.slice(n)) rmSync(c.image, { force: true });
  const view = best.map((c) => ({ ...c, image: relp(p, c.image) }));
  writeAtomic(join(dir, 'candidates.json'), JSON.stringify({ at: new Date().toISOString(), candidates: view }, null, 2));
  emit(ctx, { variant: p.variant ?? 'main', candidates: view, warnings }, () => [
    ...best.map((c, i) => `${i + 1}. ${c.timecode} (frame ${c.frame}) score ${c.score}  ${c.image}`),
    t(ctx, '次: solocut thumb gen --frame <フレーム> --title "<見出し>"', 'next: solocut thumb gen --frame <frame> --title "<headline>"'),
    ...warnings.map((w) => `! ${w}`),
  ]);
}

// ---------- gen ----------

let svgSupport: Promise<{ svg: boolean; ass: boolean }> | null = null;
function ffmpegFeatures(ffmpeg: string): Promise<{ svg: boolean; ass: boolean }> {
  svgSupport ??= new Promise((res) => {
    execFile(ffmpeg, ['-hide_banner', '-decoders'], (e1, dec) => {
      execFile(ffmpeg, ['-hide_banner', '-filters'], (e2, fil) => {
        res({ svg: !e1 && /\s(svg|librsvg)\s/.test(String(dec)), ass: !e2 && /\sass\s/.test(String(fil)) });
      });
    });
  });
  return svgSupport;
}

function runFf(ffmpeg: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { cwd, maxBuffer: 1 << 24 }, (err, _o, stderr) => {
      if (err) rej(new CliError('ffmpeg', String(stderr).trim().split('\n').slice(-2).join(' ')));
      else res();
    });
  });
}

/** Compose one thumbnail: cover-crop the base to the format and put the title layer on top; JPEG ≤ 2 MB. */
async function compose(ffmpeg: string, dir: string, base: string, format: ThumbFormat, title: { svg?: string; ass?: string } | null, out: string, fontsDir?: string): Promise<void> {
  const { width: W, height: H } = THUMB_SIZES[format];
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  for (const q of [2, 4, 6, 9, 13, 18]) {
    let args: string[];
    if (title?.svg) args = ['-i', base, '-i', title.svg, '-filter_complex', `[0:v]${fit}[b];[1:v]scale=${W}:${H}[t];[b][t]overlay=0:0`, '-frames:v', '1', '-q:v', String(q), out];
    else if (title?.ass) args = ['-i', base, '-vf', `${fit},ass=${title.ass}${fontsDir ? `:fontsdir=${fontsDir.replace(/[\\:']/g, (c) => `\\${c}`)}` : ''}`, '-frames:v', '1', '-q:v', String(q), out];
    else args = ['-i', base, '-vf', fit, '-frames:v', '1', '-q:v', String(q), out];
    await runFf(ffmpeg, args, dir);
    if (statSync(out).size <= MAX_BYTES) return;
  }
}

function formatsFor(tl: Timeline, want?: string, variant?: string | null): ThumbFormat[] {
  if (variant && !want) return ['shorts'];
  if (want) {
    const list = want.split(',').map((x) => x.trim()).filter(Boolean);
    for (const f of list) if (f !== 'youtube' && f !== 'shorts') throw new CliError('usage', `--formats takes youtube,shorts (got ${f})`);
    return list as ThumbFormat[];
  }
  const out: ThumbFormat[] = [];
  if (tl.meta.targets.includes('youtube')) out.push('youtube');
  if (tl.meta.targets.some((x) => VERTICAL.has(x))) out.push('shorts');
  return out.length ? out : ['youtube'];
}

async function cmdGen(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, {
    frame: { type: 'string' }, n: { type: 'string' }, provider: { type: 'string', multiple: true }, title: { type: 'string' }, 'no-title': { type: 'boolean' },
    prompt: { type: 'string' }, formats: { type: 'string' }, reference: { type: 'string' },
  }, { max: 0, usage: 'solocut thumb gen [--frame <frame|timecode>] [--n 3] [--provider codex|openai|gemini|frame] [--title "見出し"] [--formats youtube,shorts]' });
  const n = intOpt(values.n, 'n') ?? 3;
  if (!(n >= 1 && n <= 6)) throw new CliError('usage', '--n must be 1..6');
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const settings = loadSettings();
  let frame: number;
  if (values.frame) frame = parseFrame(ctx, tl, values.frame);
  else {
    const f = join(p.dir, 'checks', 'thumbs', ...(p.variant ? [p.variant] : []), 'candidates.json');
    const best = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { candidates: { frame: number }[] }).candidates[0] : undefined;
    if (!best) throw new CliError('usage', t(ctx, '--frame を指定するか、先に solocut thumb candidates', 'pass --frame or run solocut thumb candidates first'));
    frame = parseFrame(ctx, tl, String(best.frame));
  }
  const m = await media();
  const ffmpeg = await m.toolPath('ffmpeg');
  const dir = thumbsDir(p);
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  // 1. the reference frame at full resolution from the original source (falls back to the preview)
  const refFrame = join(work, `frame-${frame}.png`);
  const src = sourceAt(tl, frame);
  if (src) await m.extractFrame(resolve(p.dir, src.path), src.sec, refFrame);
  else await m.extractFrame(await freshPreview(ctx, p, tl), frameToSeconds(frame, tl.canvas.fps), refFrame);
  // 2. base images
  const tpl = projectTemplate(p);
  const title = values['no-title'] ? '' : (values.title ?? tl.outputs.find((o) => o.target === 'youtube')?.metadata.title ?? tl.meta.title).trim();
  const direction = (tpl.prompts.thumbnail ?? '').slice(0, 1200);
  const prompt = [
    `A YouTube thumbnail image (background, the person and effects only) for a video titled "${tl.meta.title}".`,
    tl.meta.goal ? `Goal of the video: ${tl.meta.goal}.` : '',
    values.prompt ?? '',
    direction ? `Direction from the template:\n${direction}` : '',
    'Leave clear space for a large title that will be added later.',
  ].filter(Boolean).join('\n');
  const order = (values.provider ?? settings.imageGen.order) as ThumbProvider[];
  for (const pr of order) if (!['codex', 'openai', 'gemini', 'frame'].includes(pr)) throw new CliError('usage', `unknown provider: ${pr}`);
  const formats = formatsFor(tl, values.formats, p.variant);
  // image providers read SOLOCUT_OPENAI_API_KEY / SOLOCUT_GEMINI_API_KEY; an apiKeyRef in settings maps to its own env
  const keyEnv: NodeJS.ProcessEnv = { ...ctx.io.env };
  for (const prov of ['openai', 'gemini'] as const) {
    const k = apiKeyFor(ctx.io.env, settings.imageGen.providers[prov]?.apiKeyRef, prov, { decision: false });
    if (k) keyEnv[`SOLOCUT_${prov.toUpperCase()}_API_KEY`] = k;
  }
  const gctx: GenContext = { env: keyEnv };
  const model = (prov: string) => settings.imageGen.providers[prov]?.model;
  const results: { format: ThumbFormat; file: string; base: string; provider: ThumbProvider }[] = [];
  const errors: string[] = [];
  const style = DEFAULT_TITLE_STYLE;
  const fontsDir = title ? (await ensureFonts(ctx, errors)) ?? undefined : undefined;
  const features = await ffmpegFeatures(ffmpeg);
  if (title && !features.svg && !features.ass) {
    throw new CliError('ffmpeg-features', t(ctx, 'タイトルの合成には libass か librsvg 入りの ffmpeg が必要です: `solocut lib install ffmpeg`', 'typesetting needs an ffmpeg with libass or librsvg: `solocut lib install ffmpeg`'));
  }
  let lines: string[] = [];
  if (title) {
    lines = title.includes('\n') ? title.split('\n') : (await captionsLib()).layoutLines(title, p.file.language === 'ja' ? 9 : 18, p.file.language);
  }
  for (const format of formats) {
    const references = values.reference ? [resolve(ctx.io.cwd, values.reference.replace(/^~(?=\/)/, ctx.io.env.HOME ?? '~'))] : [];
    for (const r of references) if (!existsSync(r)) throw new CliError('not-found', `reference image not found: ${r}`);
    const req = { frame: refFrame, prompt: references.length ? `${prompt}\nMatch the style of the extra reference image (layout, colors, mood), not its content.` : prompt, n, format, outDir: work, references };
    info(ctx, t(ctx, `${format}: 画像を作っています…`, `${format}: generating…`));
    const gen = await generateBases(order, req, { ...gctx, ...(model(order[0]!) ? { model: model(order[0]!)! } : {}) });
    errors.push(...gen.errors);
    let layer: { svg?: string; ass?: string } | null = null;
    if (title) {
      const layout = layoutTitle(lines, format);
      writeFileSync(join(dir, `title-${format}.svg`), titleSvg(layout, format, style));
      if (features.svg) layer = { svg: `title-${format}.svg` };
      else {
        writeFileSync(join(dir, `title-${format}.ass`), titleAss(layout, format, style));
        layer = { ass: `title-${format}.ass` };
      }
    }
    for (let i = 0; i < gen.images.length; i++) {
      const base = join(dir, `base-${format}-${i + 1}${extname(gen.images[i]!) || '.png'}`);
      if (gen.images[i] !== base) copyFileSync(gen.images[i]!, base);
      const file = join(dir, `${format}-${i + 1}.jpg`);
      await compose(ffmpeg, dir, base, format, layer, file, fontsDir);
      results.push({ format, file: relp(p, file), base: relp(p, base), provider: gen.provider });
    }
  }
  rmSync(work, { recursive: true, force: true });
  // 3. record the first of each format on the outputs
  const targets = p.variant ? [p.variant as Target] : tl.meta.targets;
  const ops = targets.flatMap((target) => {
    const fmt: ThumbFormat = VERTICAL.has(target) ? 'shorts' : 'youtube';
    const r = results.find((x) => x.format === fmt);
    if (!r) return [];
    const base: Output = tl.outputs.find((o) => o.target === target) ?? emptyOutput(tl, target);
    return [{ op: 'setOutput' as const, output: { ...base, thumbnail: { path: r.file, frame, generatedBy: r.provider } } }];
  });
  if (ops.length) await applyEdit(p, ops, { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), note: 'thumb gen' });
  updateThumbnailStep(p);
  const images = results.map((r) => ({ path: r.file, provider: r.provider, format: r.format, size: `${THUMB_SIZES[r.format].width}x${THUMB_SIZES[r.format].height}` }));
  emit(ctx, { variant: p.variant ?? 'main', frame, timecode: frameToTimecode(frame, tl.canvas.fps), title, typeset: title ? (features.svg ? 'svg' : 'ass') : 'none', images, thumbnails: results, errors }, () => [
    ...results.map((r) => `✓ ${r.file} (${r.provider})`),
    ...errors.map((e) => `! ${e}`),
    ...(results.every((r) => r.provider === 'frame') && order[0] !== 'frame' ? [t(ctx, '画像生成が使えなかったため、元のフレームに文字だけを入れました', 'image generation was unavailable; used the frame itself')] : []),
  ]);
}

/** `thumb pick <path>`: use this image as the video's thumbnail (outputs[].thumbnail). */
async function cmdPick(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { target: { type: 'string' }, frame: { type: 'string' } }, { min: 1, max: 1, usage: 'solocut thumb pick <image> [--variant v] [--target t]' });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const abs = resolve(ctx.io.cwd, positionals[0]!);
  if (!existsSync(abs)) throw new CliError('not-found', t(ctx, `画像がありません: ${positionals[0]}`, `image not found: ${positionals[0]}`));
  if (!abs.startsWith(p.dir)) throw new CliError('usage', t(ctx, 'プロジェクトの中の画像を指定してください', 'the image must be inside the project'));
  const target = (values.target ?? p.variant ?? tl.meta.targets[0] ?? 'youtube') as Target;
  if (p.variant && target !== p.variant) throw new CliError('usage', `variant ${p.variant} only has the ${p.variant} output`);
  const frame = values.frame !== undefined ? parseFrame(ctx, tl, values.frame) : tl.outputs.find((o) => o.target === target)?.thumbnail?.frame ?? 0;
  const base: Output = tl.outputs.find((o) => o.target === target) ?? emptyOutput(tl, target);
  const path = relp(p, abs);
  await applyEdit(p, [{ op: 'setOutput', output: { ...base, thumbnail: { path, frame, generatedBy: base.thumbnail?.generatedBy ?? 'human' } } }], { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), note: 'thumb pick' });
  updateThumbnailStep(p);
  emit(ctx, { variant: p.variant ?? 'main', target, thumbnail: { path, frame } }, () => t(ctx, `${target} のサムネイルを ${path} にしました`, `${target} thumbnail: ${path}`));
}

export async function cmdThumb(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'candidates') return cmdCandidates(ctx, rest);
  if (sub === 'gen') return cmdGen(ctx, rest);
  if (sub === 'pick') return cmdPick(ctx, rest);
  throw new CliError('usage', 'usage: solocut thumb candidates [--n 6] | gen [--frame <tc>] [--n 3] [--provider …] [--title …] | pick <image> [--variant v]');
}
