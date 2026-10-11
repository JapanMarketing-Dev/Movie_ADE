import { overlaysToAss } from './ass.js';
import { sha256Hex } from './hash.js';
import type { ExportPreset } from './presets.js';
import { PRESETS, presetBitrate } from './presets.js';
import type { Canvas, Frame, Mask, Overlay, Segment, Source, Target, Timeline, ZoomKeyframe } from './schema.js';
import { fpsValue, frameToSeconds } from './time.js';
import { durationFrames, sourceLocalSeconds, sourceRate, takeFrameToSeconds, videoSources } from './timeline.js';
import type { PatternDef } from './patterns/defs.js';
import type { MediaPlacement } from './patterns/render.js';
import { renderScenes } from './patterns/render.js';

/** Bump when the generated graphs change in a way that must invalidate cached chunks. */
export const COMPILER_VERSION = 1;

/**
 * A render plan: pure data. Arg arrays exclude the global flags (`-hide_banner -nostdin -y -progress …`), which the
 * executor adds. Input paths are relative to the project dir (ffmpeg runs with cwd = project dir).
 * Placeholders substituted by the executor:
 *   chunks[].args, audio.args: `{out}` (output file)
 *   final.args: `{concat}` (concat list file), `{audio}` (audio file), `{out}` (final output)
 */
export interface RenderPlan {
  canvas: Canvas;
  quality: 'preview' | 'final';
  target?: Target;
  preset: ExportPreset['id'];
  durationFrames: Frame;
  inputs: { id: string; path: string }[];
  chunks: { id: string; hash: string; range: [Frame, Frame]; args: string[] }[];
  concat: { listFile: string };
  /**
   * Audio mix. With `measure` (final quality), `args` contains the token `{LOUDNORM}` inside its filter graph: the
   * executor runs `measure.args` (loudnorm print_format=json), then substitutes a measured, linear loudnorm (2-pass).
   */
  audio: { hash: string; args: string[]; measure?: { args: string[]; target: { I: number; TP: number; LRA: number } } };
  subtitles?: { assPath: string };
  /** Files the executor writes (relative to the project dir) before running anything. */
  writes: { path: string; content: string }[];
  final: { args: string[] };
  warnings: string[];
}

export interface CompileOptions {
  quality: 'preview' | 'final';
  target?: Target;
  projectDir: string;
  /** Captions ASS (relative to the project dir). Burned into chunks that overlap a caption. */
  assPath?: string;
  fontsDir?: string;
  maxChunkFrames?: number;
  /** Where generated files (overlay / scene ASS) are written, relative to the project dir. */
  generatedDir?: string;
  /** Custom scene patterns (patterns/<id>/pattern.json) by id. */
  patterns?: Record<string, PatternDef>;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const num = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Escape a value for use as a filter option inside a filtergraph (two levels: option, then graph). */
export function ffFilterValue(v: string): string {
  const lvl1 = v.replace(/[\\':]/g, (c) => `\\${c}`);
  return lvl1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** Make a relative path safe as an ffmpeg input/output argument (never starts with '-'). */
function argPath(p: string): string {
  return p.startsWith('-') ? `./${p}` : p;
}

function renderCanvas(t: Timeline, opts: CompileOptions, preset: ExportPreset, warnings: string[]): Canvas {
  const c = t.canvas;
  if (opts.quality === 'preview') {
    const max = preset.maxHeight ?? 540;
    const short = Math.min(c.width, c.height);
    if (short <= max) return { ...c };
    const k = max / short;
    return { ...c, width: even(c.width * k), height: even(c.height * k) };
  }
  if (preset.size) {
    const same = Math.abs(preset.size.width / preset.size.height - c.width / c.height) < 0.01;
    if (same) return { ...c, width: preset.size.width, height: preset.size.height };
    warnings.push(`canvas ${c.width}x${c.height} does not match the ${preset.id} aspect ${preset.size.width}x${preset.size.height}; rendering at the canvas size`);
  }
  return { ...c };
}

interface Ctx {
  t: Timeline;
  opts: CompileOptions;
  rc: Canvas;
  preset: ExportPreset;
  overlayAss?: string;
  fontsDir?: string;
  scenes?: { back: string | null; front: string | null; media: MediaPlacement[]; unknown: string[] };
}

class Graph {
  inputs: string[] = [];
  filters: string[] = [];
  private n = 0;
  label(prefix: string): string {
    return `${prefix}${this.n++}`;
  }
  addInput(args: string[]): number {
    const idx = this.inputs.filter((a) => a === '-i').length;
    this.inputs.push(...args);
    return idx;
  }
}

/** Piecewise-linear expression of `v(x)` over keyframes (x ascending); clamps outside. */
function piecewise(xVar: string, keys: { x: number; v: number; hold?: boolean }[]): string {
  if (keys.length === 0) return '0';
  if (keys.length === 1) return num(keys[0]!.v);
  let expr = num(keys[keys.length - 1]!.v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const seg = a.hold || a.v === b.v || b.x === a.x
      ? num(a.v)
      : `${num(a.v)}+(${num(b.v - a.v)})*(${xVar}-${num(a.x)})/${num(b.x - a.x)}`;
    expr = `if(lt(${xVar},${num(b.x)}),${seg},${expr})`;
  }
  return `if(lt(${xVar},${num(keys[0]!.x)}),${num(keys[0]!.v)},${expr})`;
}

/** Mask filters for one source stream; `t` in the stream is seconds from `localStart` of the source file. */
function maskFilters(g: Graph, inLabel: string, masks: Mask[], src: Source & { kind: 'screen' | 'camera' }, localStart: number, durLocal: number): string {
  let cur = inLabel;
  const fps = fpsValue(src.fps);
  for (const m of masks) {
    const keys = [...m.track].sort((a, b) => a.frame - b.frame);
    const first = keys[0]!.frame / fps - localStart;
    const last = keys[keys.length - 1]!.frame / fps - localStart + 1 / fps;
    if (last < 0 || first > durLocal) continue;
    const w = even(Math.min(src.size.width, Math.max(...keys.map((k) => k.box.w))));
    const h = even(Math.min(src.size.height, Math.max(...keys.map((k) => k.box.h))));
    const cx = piecewise('t', keys.map((k) => ({ x: k.frame / fps - localStart, v: k.box.x + k.box.w / 2 })));
    const cy = piecewise('t', keys.map((k) => ({ x: k.frame / fps - localStart, v: k.box.y + k.box.h / 2 })));
    const x = `clip((${cx})-${w / 2},0,${src.size.width - w})`;
    const y = `clip((${cy})-${h / 2},0,${src.size.height - h})`;
    const a = g.label('ma');
    const b = g.label('mb');
    const p = g.label('mp');
    const out = g.label('mo');
    let effect: string;
    if (m.kind === 'pixelate') {
      const block = Math.max(2, Math.round(Math.max(w, h) / 12));
      effect = `scale=${Math.max(1, Math.floor(w / block))}:${Math.max(1, Math.floor(h / block))},scale=${w}:${h}:flags=neighbor`;
    } else if (m.kind === 'blur') {
      effect = `boxblur=${Math.max(2, Math.min(Math.floor(Math.min(w, h) / 2) - 1, Math.round(Math.min(w, h) / 6)))}:2`;
    } else {
      effect = 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill';
    }
    g.filters.push(`[${cur}]split=2[${a}][${b}]`);
    g.filters.push(`[${b}]crop=w=${w}:h=${h}:x='${x}':y='${y}',${effect}[${p}]`);
    g.filters.push(`[${a}][${p}]overlay=x='${x}':y='${y}':enable='between(t,${num(first)},${num(last)})'[${out}]`);
    cur = out;
  }
  return cur;
}

type Fit = 'cover' | 'fit';
function sizeFilter(w: number, h: number, fit: Fit): string {
  return fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

/** Add one video source stream covering the piece; returns the label of an exactly n-frame stream of w x h. */
function sourceStream(g: Graph, ctx: Ctx, srcId: string, takeSec: number, n: number, w: number, h: number, fit: Fit): string {
  const { t, rc } = ctx;
  const src = t.sources[srcId];
  if (!src || (src.kind !== 'screen' && src.kind !== 'camera')) throw new Error(`video source not found: ${srcId}`);
  const F = fpsValue(rc.fps);
  const durSec = n / F;
  const drift = src.kind === 'camera' && src.drift ? src.drift : 1;
  const local = sourceLocalSeconds(t, src, takeSec);
  const lead = Math.max(0, -local);
  const ss = Math.max(0, local);
  const durLocal = durSec * drift + 0.5;
  const idx = g.addInput(['-ss', num(ss), '-t', num(durLocal), '-i', argPath(src.path)]);
  const chain: string[] = [];
  const masks = ctx.t.masks.filter((m) => m.source === srcId);
  let cur = `${idx}:v`;
  if (masks.length) {
    const norm = g.label('sn');
    g.filters.push(`[${cur}]scale=${src.size.width}:${src.size.height},setsar=1[${norm}]`);
    cur = maskFilters(g, norm, masks, src, ss, durLocal);
  }
  if (drift !== 1) chain.push(`setpts=(PTS-STARTPTS)/${num(drift)}`);
  if (lead > 0) chain.push(`tpad=start_mode=add:start_duration=${num(lead)}:color=black`);
  chain.push(`fps=${rc.fps.num}/${rc.fps.den}`, sizeFilter(w, h, fit), `tpad=stop_mode=clone:stop_duration=${num(durSec + 1)}`,
    `trim=end_frame=${n}`, 'setpts=PTS-STARTPTS');
  const out = g.label('s');
  g.filters.push(`[${cur}]${chain.join(',')}[${out}]`);
  return out;
}

function wipeAlpha(shape: 'circle' | 'rounded', d: number): string {
  if (shape === 'circle') return `if(lte(hypot(X-W/2,Y-H/2),W/2),255,0)`;
  const r = Math.round(d * 0.18);
  return `if(gt(hypot(max(0,abs(X-W/2)-(W/2-${r})),max(0,abs(Y-H/2)-(H/2-${r}))),${r}),0,255)`;
}

function focusPoint(f: ZoomKeyframe['value']['focus'], W: number, H: number, canvas: Canvas): { x: number; y: number } {
  if (f === 'face') return { x: W / 2, y: H * 0.4 };
  if (f === 'cursor') return { x: W / 2, y: H / 2 };
  // Points are in timeline canvas pixels; scale to the render canvas.
  return { x: (f.x * W) / canvas.width, y: (f.y * H) / canvas.height };
}

/** Video graph for one piece of a segment: frames [o, o+n) of the segment. Returns the output label. */
function pieceVideo(g: Graph, ctx: Ctx, seg: Segment, o: number, n: number): string {
  const { t, rc } = ctx;
  const W = rc.width;
  const H = rc.height;
  const F = fpsValue(rc.fps);
  const takeSec = takeFrameToSeconds(t, seg.src.take, seg.src.from) + o / F;
  const v = seg.video;
  let base: string;
  switch (v.layout) {
    case 'camera-full':
      base = sourceStream(g, ctx, v.camera, takeSec, n, W, H, 'cover');
      break;
    case 'screen-full':
      base = sourceStream(g, ctx, v.screen, takeSec, n, W, H, 'fit');
      break;
    case 'screen-with-wipe': {
      const scr = sourceStream(g, ctx, v.screen, takeSec, n, W, H, 'fit');
      const d = even(Math.min(W, H) * 0.3);
      const cam = sourceStream(g, ctx, v.camera, takeSec, n, d, d, 'cover');
      const shaped = g.label('w');
      g.filters.push(`[${cam}]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${wipeAlpha(v.wipe.shape, d)}'[${shaped}]`);
      const m = Math.round(Math.min(W, H) * 0.04);
      const x = v.wipe.corner.endsWith('l') ? `${m}` : `${W - d - m}`;
      const y = v.wipe.corner.startsWith('t') ? `${m}` : `${H - d - m}`;
      base = g.label('c');
      g.filters.push(`[${scr}][${shaped}]overlay=x=${x}:y=${y}:format=auto[${base}]`);
      break;
    }
    case 'split-v': {
      const th = even(H / 2);
      const top = sourceStream(g, ctx, v.top, takeSec, n, W, th, 'cover');
      const bottom = sourceStream(g, ctx, v.bottom, takeSec, n, W, H - th, 'cover');
      base = g.label('c');
      g.filters.push(`[${top}][${bottom}]vstack=inputs=2[${base}]`);
      break;
    }
    case 'scene': {
      // Pattern rendering (HTML → alpha clip) is not part of the compiler yet: a neutral placeholder background.
      base = g.label('c');
      g.filters.push(`color=c=0x15181d:s=${W}x${H}:r=${rc.fps.num}/${rc.fps.den}:d=${num(n / F + 1)},trim=end_frame=${n},setpts=PTS-STARTPTS,setsar=1[${base}]`);
      break;
    }
  }

  // Zoom (punch-in) and jump-zoom transition.
  const zoomKeys = [...(seg.zoom ?? [])].sort((a, b) => a.at - b.at);
  const jump = seg.transitionIn?.kind === 'jump-zoom' && o < seg.transitionIn.frames ? seg.transitionIn.frames : 0;
  const animated = zoomKeys.length > 1 && zoomKeys.some((k) => k.value.scale !== zoomKeys[0]!.value.scale
    || JSON.stringify(k.value.focus) !== JSON.stringify(zoomKeys[0]!.value.focus));
  if (jump > 0 || animated) {
    const keys = zoomKeys.length ? zoomKeys : [{ at: 0, value: { scale: 1, focus: 'face' as const } }];
    const pts = keys.map((k) => ({ ...focusPoint(k.value.focus, W, H, t.canvas), s: k.value.scale, at: k.at, hold: k.ease === 'hold' }));
    const fi = `(in+${o})`;
    let z = piecewise(fi, pts.map((p) => ({ x: p.at, v: p.s, hold: p.hold })));
    if (jump > 0) z = `(${z})*if(lt(${fi},${jump}),1.12,1)`;
    const fx = piecewise(fi, pts.map((p) => ({ x: p.at, v: p.x, hold: p.hold })));
    const fy = piecewise(fi, pts.map((p) => ({ x: p.at, v: p.y, hold: p.hold })));
    const out = g.label('z');
    g.filters.push(`[${base}]zoompan=z='${z}':x='clip((${fx})-iw/zoom/2,0,iw-iw/zoom)':y='clip((${fy})-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${W}x${H}:fps=${rc.fps.num}/${rc.fps.den},setsar=1[${out}]`);
    base = out;
  } else if (zoomKeys.length > 0 && zoomKeys[0]!.value.scale > 1) {
    const k = zoomKeys[0]!;
    const cw = even(W / k.value.scale);
    const ch = even(H / k.value.scale);
    const f = focusPoint(k.value.focus, W, H, t.canvas);
    const x = Math.round(Math.min(Math.max(0, f.x - cw / 2), W - cw));
    const y = Math.round(Math.min(Math.max(0, f.y - ch / 2), H - ch));
    const out = g.label('z');
    g.filters.push(`[${base}]crop=${cw}:${ch}:${x}:${y},scale=${W}:${H},setsar=1[${out}]`);
    base = out;
  }

  if (seg.transitionIn?.kind === 'fade' && o === 0 && seg.transitionIn.frames > 0) {
    const out = g.label('f');
    g.filters.push(`[${base}]fade=t=in:s=0:n=${Math.min(n, seg.transitionIn.frames)}[${out}]`);
    base = out;
  }
  return base;
}

function isImage(path: string): boolean {
  return IMAGE_EXT.test(path);
}

/** Image/logo overlays over [start, start+n) of the timeline. */
function imageOverlays(g: Graph, ctx: Ctx, base: string, start: Frame, n: number): string {
  const { t, rc } = ctx;
  const F = fpsValue(rc.fps);
  const sx = rc.width / t.canvas.width;
  const sy = rc.height / t.canvas.height;
  let cur = base;
  for (const ov of t.overlays) {
    if (ov.kind !== 'image' && ov.kind !== 'logo') continue;
    if (!(ov.range.start < start + n && ov.range.end > start)) continue;
    const asset = t.sources[ov.asset];
    if (!asset) throw new Error(`overlay ${ov.id}: asset not found: ${ov.asset}`);
    const a = (ov.range.start - start) / F;
    const b = (ov.range.end - start) / F;
    let idx: number;
    let prep: string;
    if (isImage(asset.path)) {
      idx = g.addInput(['-loop', '1', '-framerate', `${rc.fps.num}/${rc.fps.den}`, '-t', num(n / F + 1), '-i', argPath(asset.path)]);
      prep = '';
    } else {
      const skip = Math.max(0, start - ov.range.start) / F;
      idx = g.addInput(['-ss', num(skip), '-i', argPath(asset.path)]);
      prep = `setpts=PTS-STARTPTS+${num(Math.max(0, a))}/TB,`;
    }
    const lbl = g.label('ov');
    const out = g.label('o');
    if (ov.kind === 'image') {
      const w = even(ov.position.w * sx);
      const h = even(ov.position.h * sy);
      g.filters.push(`[${idx}:v]${prep}scale=${w}:${h},format=rgba[${lbl}]`);
      g.filters.push(`[${cur}][${lbl}]overlay=x=${Math.round(ov.position.x * sx)}:y=${Math.round(ov.position.y * sy)}:enable='between(t,${num(a)},${num(b)})':eof_action=pass[${out}]`);
    } else {
      const lw = even(Math.min(rc.width, rc.height) * 0.14);
      const m = Math.round(Math.min(rc.width, rc.height) * 0.04);
      const x = ov.corner.endsWith('l') ? `${m}` : `main_w-overlay_w-${m}`;
      const y = ov.corner.startsWith('t') ? `${m}` : `main_h-overlay_h-${m}`;
      g.filters.push(`[${idx}:v]${prep}scale=${lw}:-2,format=rgba[${lbl}]`);
      g.filters.push(`[${cur}][${lbl}]overlay=x=${x}:y=${y}:enable='between(t,${num(a)},${num(b)})':eof_action=pass[${out}]`);
    }
    cur = out;
  }
  return cur;
}

function overlapsAny(items: { start: number; end: number }[], start: number, end: number): boolean {
  return items.some((r) => r.start < end && r.end > start);
}

function textOverlayRanges(overlays: Overlay[], fps: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const o of overlays) {
    if (o.kind === 'telop' || o.kind === 'keystroke') out.push(o.range);
    else if (o.kind === 'click-ring') out.push({ start: o.at, end: o.at + Math.max(1, Math.round(fps * 0.4)) });
  }
  return out;
}

function encodeArgs(ctx: Ctx, n: number): string[] {
  const { rc, preset } = ctx;
  const F = fpsValue(rc.fps);
  const gop = Math.max(1, Math.round(F * preset.video.gopSec));
  const args = ['-frames:v', String(n), '-r', `${rc.fps.num}/${rc.fps.den}`, '-c:v', preset.video.codec, '-preset', preset.video.preset,
    '-profile:v', preset.video.profile, '-pix_fmt', preset.video.pixFmt];
  const br = presetBitrate(preset, rc.height, F);
  if (br !== undefined) args.push('-b:v', `${br}k`, '-maxrate', `${Math.round(br * 1.5)}k`, '-bufsize', `${br * 2}k`);
  else args.push('-crf', String(preset.video.crf ?? 23));
  args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', String(preset.video.bframes),
    '-flags', '+cgop', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-an', '-f', 'mp4', '{out}');
  return args;
}

/** Burn ASS files over `cur` with timestamps shifted to timeline time (so events line up), then back to 0. */
function assPass(g: Graph, ctx: Ctx, cur: string, files: string[], start: Frame): string {
  if (files.length === 0) return cur;
  const { t, rc } = ctx;
  const parts = [`setpts=PTS+${num(frameToSeconds(start, rc.fps))}/TB`];
  for (const s of files) {
    parts.push(`subtitles=filename=${ffFilterValue(s)}${ctx.fontsDir ? `:fontsdir=${ffFilterValue(ctx.fontsDir)}` : ''}:original_size=${t.canvas.width}x${t.canvas.height}`);
  }
  parts.push('setpts=PTS-STARTPTS');
  const out = g.label('t');
  g.filters.push(`[${cur}]${parts.join(',')}[${out}]`);
  return out;
}

/** geq alpha keeping the input alpha inside a shape of size w×h. */
function shapeAlpha(shape: MediaPlacement['shape'], w: number, h: number): string | null {
  if (shape === 'rect') return null;
  if (shape === 'circle') return `alpha(X,Y)*lte(hypot(X-W/2,Y-H/2),min(W,H)/2)`;
  const r = Math.round(Math.min(w, h) * 0.06);
  return `alpha(X,Y)*lte(hypot(max(0,abs(X-W/2)-(W/2-${r})),max(0,abs(Y-H/2)-(H/2-${r}))),${r})`;
}

/** Scene layers over [start, start+n): back ASS → scene media (images, video slots) → front ASS. */
function sceneLayers(g: Graph, ctx: Ctx, cur: string, seg: Segment, o: number, start: Frame, n: number): string {
  const sc = ctx.scenes;
  if (!sc) return cur;
  const { t, rc } = ctx;
  const end = start + n;
  const live = t.scenes.filter((s) => !sc.unknown.includes(s.id) && s.range.start < end && s.range.end > start);
  if (live.length === 0) return cur;
  if (sc.back) cur = assPass(g, ctx, cur, [sc.back], start);
  const F = fpsValue(rc.fps);
  const sx = rc.width / t.canvas.width;
  const sy = rc.height / t.canvas.height;
  for (const m of sc.media) {
    if (!(m.start < end && m.end > start)) continue;
    const src = t.sources[m.source];
    if (!src) throw new Error(`scene ${m.scene}: source not found: ${m.source}`);
    const a = Math.max(0, m.start - start) / F;
    const b = (m.end - start) / F;
    const w = even(m.rect.w * sx);
    const h = even(m.rect.h * sy);
    const x = Math.round(m.rect.x * sx);
    const y = Math.round(m.rect.y * sy);
    const chain: string[] = [];
    let idx: number;
    if (m.kind === 'image') {
      idx = g.addInput(['-loop', '1', '-framerate', `${rc.fps.num}/${rc.fps.den}`, '-t', num(n / F + 1), '-i', argPath(src.path)]);
    } else {
      let local: number;
      let delay = 0;
      if (m.from === 'sync') {
        const takeSec = takeFrameToSeconds(t, seg.src.take, seg.src.from) + o / F;
        local = sourceLocalSeconds(t, src, takeSec);
      } else {
        local = (m.from ?? 0) / fpsValue(sourceRate(t, src)) + Math.max(0, start - m.start) / F;
        delay = a;
      }
      idx = g.addInput(['-ss', num(Math.max(0, local)), '-t', num(n / F + 1), '-i', argPath(src.path)]);
      if (m.crop && (src.kind === 'screen' || src.kind === 'camera')) {
        chain.push(`scale=${src.size.width}:${src.size.height}`, `crop=${even(m.crop.w)}:${even(m.crop.h)}:${Math.round(m.crop.x)}:${Math.round(m.crop.y)}`);
      }
      chain.push(`fps=${rc.fps.num}/${rc.fps.den}`);
      if (local < 0) chain.push(`tpad=start_mode=add:start_duration=${num(-local)}:color=black`);
      chain.push(delay > 0 ? `setpts=PTS-STARTPTS+${num(delay)}/TB` : 'setpts=PTS-STARTPTS');
    }
    chain.push(m.fit === 'cover'
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuva420p,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
    chain.push('setsar=1', 'format=yuva420p');
    const alpha = shapeAlpha(m.shape, w, h);
    if (alpha) chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${alpha}'`);
    if (m.fadeInFrames > 0) chain.push(`fade=t=in:st=${num(a)}:d=${num(m.fadeInFrames / F)}:alpha=1`);
    const lbl = g.label('sm');
    const out = g.label('so');
    g.filters.push(`[${idx}:v]${chain.join(',')}[${lbl}]`);
    g.filters.push(`[${cur}][${lbl}]overlay=x=${x}:y=${y}:enable='between(t,${num(a)},${num(b)})':eof_action=pass:format=auto[${out}]`);
    cur = out;
  }
  if (sc.front) cur = assPass(g, ctx, cur, [sc.front], start);
  return cur;
}

function chunkArgs(ctx: Ctx, seg: Segment, o: number, n: number): string[] {
  const { t, rc, opts } = ctx;
  const F = fpsValue(rc.fps);
  const g = new Graph();
  const start = seg.range.start + o;
  let cur = pieceVideo(g, ctx, seg, o, n);
  cur = sceneLayers(g, ctx, cur, seg, o, start, n);
  cur = imageOverlays(g, ctx, cur, start, n);
  const subs: string[] = [];
  if (opts.assPath && overlapsAny(t.captions.map((c) => c.range), start, start + n)) subs.push(opts.assPath);
  if (ctx.overlayAss && overlapsAny(textOverlayRanges(t.overlays, F), start, start + n)) subs.push(ctx.overlayAss);
  cur = assPass(g, ctx, cur, subs, start);
  const outLabel = 'vout';
  g.filters.push(`[${cur}]format=yuv420p[${outLabel}]`);
  return [...g.inputs, '-filter_complex', g.filters.join(';'), '-map', `[${outLabel}]`, ...encodeArgs(ctx, n)];
}

/**
 * Which source gives the voice for a segment: the take's mic, else a camera (shown, then any of the take),
 * else the shown screen (screen audio is usually system sound, so it comes last). Sources with `audio: false` are skipped.
 */
export function voiceSource(t: Timeline, seg: Segment): string | null {
  const ids = Object.keys(t.sources).sort();
  const hasAudio = (id: string, kind: 'camera' | 'screen') => {
    const s = t.sources[id];
    return !!s && s.kind === kind && s.audio !== false;
  };
  for (const id of ids) {
    const s = t.sources[id]!;
    if (s.kind === 'mic' && s.take === seg.src.take) return id;
  }
  const vs = videoSources(seg.video);
  return vs.find((id) => hasAudio(id, 'camera'))
    ?? ids.find((id) => hasAudio(id, 'camera') && (t.sources[id] as { take?: string }).take === seg.src.take)
    ?? vs.find((id) => hasAudio(id, 'screen'))
    ?? null;
}

function eqFilter(eq: string): string[] {
  switch (eq) {
    case 'off':
    case 'none':
    case '':
      return [];
    case 'voice-bright':
      return ['highpass=f=90', 'equalizer=f=3500:t=q:w=1:g=3'];
    case 'voice-warm':
      return ['highpass=f=70', 'equalizer=f=200:t=q:w=1:g=2'];
    default:
      return ['highpass=f=80'];
  }
}

function audioArgs(ctx: Ctx, total: Frame): RenderPlan['audio'] {
  const { t, rc, preset } = ctx;
  const F = fpsValue(rc.fps);
  const totalSec = total / F;
  const g = new Graph();
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

  // Voice: one atrim per segment from its voice source, padded/trimmed to the exact segment length.
  const uses = new Map<string, number>();
  const plan = t.segments.map((seg) => ({ seg, src: voiceSource(t, seg) }));
  for (const p of plan) if (p.src) uses.set(p.src, (uses.get(p.src) ?? 0) + 1);
  const inputLabels = new Map<string, string[]>();
  for (const [id, count] of uses) {
    const idx = g.addInput(['-i', argPath(t.sources[id]!.path)]);
    if (count === 1) inputLabels.set(id, [`${idx}:a`]);
    else {
      const labels = Array.from({ length: count }, () => g.label('as'));
      g.filters.push(`[${idx}:a]asplit=${count}${labels.map((l) => `[${l}]`).join('')}`);
      inputLabels.set(id, labels);
    }
  }
  const pieces: string[] = [];
  for (const { seg, src } of plan) {
    const d = (seg.range.end - seg.range.start) / F;
    const out = g.label('v');
    if (!src) {
      g.filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${num(d)}[${out}]`);
    } else {
      const s = t.sources[src]!;
      const takeSec = takeFrameToSeconds(t, seg.src.take, seg.src.from);
      const takeEnd = takeFrameToSeconds(t, seg.src.take, seg.src.to);
      const a = sourceLocalSeconds(t, s, takeSec);
      const b = sourceLocalSeconds(t, s, takeEnd);
      const drift = s.kind === 'camera' && s.drift ? s.drift : 1;
      const chain = [`atrim=start=${num(Math.max(0, a))}:end=${num(Math.max(0, b))}`, 'asetpts=PTS-STARTPTS'];
      if (drift !== 1) chain.push(`atempo=${num(drift)}`);
      chain.push(fmt);
      if (a < 0) {
        const ms = Math.round(-a * 1000);
        chain.push(`adelay=${ms}|${ms}`);
      }
      const fadeD = Math.min(0.005, d / 4);
      chain.push(`apad=whole_dur=${num(d)}`, `atrim=duration=${num(d)}`, `afade=t=in:d=${num(fadeD)}`,
        `afade=t=out:st=${num(Math.max(0, d - fadeD))}:d=${num(fadeD)}`);
      const lbl = inputLabels.get(src)!.shift()!;
      g.filters.push(`[${lbl}]${chain.join(',')}[${out}]`);
    }
    pieces.push(out);
  }
  const voiceRaw = g.label('vc');
  g.filters.push(`${pieces.map((p) => `[${p}]`).join('')}concat=n=${pieces.length}:v=0:a=1[${voiceRaw}]`);
  const vchain: string[] = [];
  const v = t.audio.voice;
  if (v.denoise === 'light') vchain.push('afftdn=nr=10:nf=-45');
  if (v.denoise === 'strong') vchain.push('afftdn=nr=20:nf=-40');
  vchain.push(...eqFilter(v.eq));
  let voice = voiceRaw;
  if (vchain.length) {
    voice = g.label('vf');
    g.filters.push(`[${voiceRaw}]${vchain.join(',')}[${voice}]`);
  }

  const mix: string[] = [];
  const bgms = t.audio.bgm.filter((b) => b.range.start < total);
  if (bgms.length) {
    const vMain = g.label('vm');
    const vSc = g.label('vsc');
    g.filters.push(`[${voice}]asplit=2[${vMain}][${vSc}]`);
    mix.push(vMain);
    const bl: string[] = [];
    let maxDuck = 0;
    for (const b of bgms) {
      const asset = t.sources[b.asset];
      if (!asset) throw new Error(`bgm ${b.id}: asset not found: ${b.asset}`);
      const idx = g.addInput(['-stream_loop', '-1', '-i', argPath(asset.path)]);
      const len = (Math.min(b.range.end, total) - b.range.start) / F;
      const ms = Math.round((b.range.start / F) * 1000);
      const fi = b.fadeIn / F;
      const fo = b.fadeOut / F;
      const chain = [`atrim=duration=${num(len)}`, 'asetpts=PTS-STARTPTS', fmt, `volume=${num(b.gainDb)}dB`];
      if (fi > 0) chain.push(`afade=t=in:d=${num(fi)}`);
      if (fo > 0) chain.push(`afade=t=out:st=${num(Math.max(0, len - fo))}:d=${num(fo)}`);
      if (ms > 0) chain.push(`adelay=${ms}|${ms}`);
      const out = g.label('bg');
      g.filters.push(`[${idx}:a]${chain.join(',')}[${out}]`);
      bl.push(out);
      maxDuck = Math.max(maxDuck, -b.duckDb);
    }
    let bgm = bl[0]!;
    if (bl.length > 1) {
      bgm = g.label('bgm');
      g.filters.push(`${bl.map((l) => `[${l}]`).join('')}amix=inputs=${bl.length}:duration=longest:normalize=0[${bgm}]`);
    }
    if (maxDuck > 0) {
      // Sidechain ducking: the voice compresses the bgm. Ratio approximates the requested reduction.
      const ratio = Math.min(20, Math.max(2, maxDuck / 2));
      const ducked = g.label('dk');
      g.filters.push(`[${bgm}][${vSc}]sidechaincompress=threshold=0.02:ratio=${num(ratio)}:attack=15:release=350:makeup=1[${ducked}]`);
      mix.push(ducked);
    } else {
      g.filters.push(`[${vSc}]anullsink`);
      mix.push(bgm);
    }
  } else {
    mix.push(voice);
  }
  for (const s of t.audio.sfx) {
    if (s.at >= total) continue;
    const asset = t.sources[s.asset];
    if (!asset) throw new Error(`sfx ${s.id}: asset not found: ${s.asset}`);
    const idx = g.addInput(['-i', argPath(asset.path)]);
    const ms = Math.round((s.at / F) * 1000);
    const out = g.label('fx');
    g.filters.push(`[${idx}:a]${fmt},volume=${num(s.gainDb)}dB${ms > 0 ? `,adelay=${ms}|${ms}` : ''}[${out}]`);
    mix.push(out);
  }
  let master = mix[0]!;
  if (mix.length > 1) {
    master = g.label('mx');
    g.filters.push(`${mix.map((l) => `[${l}]`).join('')}amix=inputs=${mix.length}:duration=first:normalize=0[${master}]`);
  }
  const v2 = t.audio.voice;
  const target = { I: v2.loudness, TP: v2.truePeak, LRA: preset.loudness.lra };
  const single = `loudnorm=I=${num(target.I)}:TP=${num(target.TP)}:LRA=${num(target.LRA)}`;
  const twoPass = ctx.opts.quality === 'final';
  const tail = `${fmt},apad=whole_dur=${num(totalSec)},atrim=duration=${num(totalSec)}[aout]`;
  const graph = (loud: string) => [...g.filters, `[${master}]${loud},${tail}`].join(';');
  const args = [...g.inputs, '-filter_complex', graph(twoPass ? LOUDNORM_TOKEN : single), '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'wav', '{out}'];
  if (!twoPass) return { hash: '', args };
  return {
    hash: '',
    args,
    measure: { args: [...g.inputs, '-filter_complex', graph(`${single}:print_format=json`), '-map', '[aout]', '-f', 'null', '-'], target },
  };
}

/** Placeholder for the measured loudnorm filter in 2-pass audio args. */
export const LOUDNORM_TOKEN = '{LOUDNORM}';

/** Compile a timeline into a RenderPlan (pure; no I/O). Throws on an empty timeline or missing references. */
export function compile(t: Timeline, opts: CompileOptions): RenderPlan {
  const total = durationFrames(t);
  if (t.segments.length === 0 || total <= 0) throw new Error('nothing to render: the timeline has no segments');
  const warnings: string[] = [];
  const preset = opts.quality === 'preview' ? PRESETS.preview : PRESETS[opts.target ?? 'youtube'];
  const rc = renderCanvas(t, opts, preset, warnings);
  const F = fpsValue(rc.fps);
  const writes: RenderPlan['writes'] = [];
  const genDir = (opts.generatedDir ?? 'derived/cache/generated').replace(/\/+$/, '');
  const ctx: Ctx = { t, opts, rc, preset };
  if (opts.fontsDir) ctx.fontsDir = opts.fontsDir;
  const ovAss = overlaysToAss(t.overlays, t.canvas, t.canvas.fps);
  if (ovAss) {
    const path = `${genDir}/overlays-${sha256Hex(ovAss).slice(0, 16)}.ass`;
    writes.push({ path, content: ovAss });
    ctx.overlayAss = path;
  }
  if (t.scenes.length) {
    const sc = renderScenes(t, opts.patterns);
    const file = (kind: string, content: string | null) => {
      if (!content) return null;
      const path = `${genDir}/scenes-${kind}-${sha256Hex(content).slice(0, 16)}.ass`;
      writes.push({ path, content });
      return path;
    };
    ctx.scenes = { back: file('back', sc.back), front: file('front', sc.front), media: sc.media, unknown: sc.unknown };
    for (const id of sc.unknown) {
      const s = t.scenes.find((x) => x.id === id)!;
      warnings.push(`scene ${id}: unknown pattern "${s.pattern.id}"; it is not rendered`);
    }
  }

  const maxChunk = Math.max(1, Math.floor(opts.maxChunkFrames ?? Math.round(F * 30)));
  const chunks: RenderPlan['chunks'] = [];
  for (const seg of t.segments) {
    const len = seg.range.end - seg.range.start;
    for (let o = 0, k = 0; o < len; o += maxChunk, k++) {
      const n = Math.min(maxChunk, len - o);
      const args = chunkArgs(ctx, seg, o, n);
      chunks.push({
        id: `${seg.id}.${k}`,
        hash: sha256Hex(`v${COMPILER_VERSION}\0${args.join('\0')}`),
        range: [seg.range.start + o, seg.range.start + o + n],
        args,
      });
    }
  }
  const aArgs = audioArgs(ctx, total);
  const used = new Set<string>();
  for (const seg of t.segments) {
    for (const id of videoSources(seg.video)) used.add(id);
    const vs = voiceSource(t, seg);
    if (vs) used.add(vs);
  }
  for (const o of t.overlays) if (o.kind === 'image' || o.kind === 'logo') used.add(o.asset);
  for (const b of t.audio.bgm) used.add(b.asset);
  for (const s of t.audio.sfx) used.add(s.asset);
  const inputs = [...used].sort().map((id) => ({ id, path: t.sources[id]!.path }));

  const finalArgs = ['-f', 'concat', '-safe', '0', '-i', '{concat}', '-i', '{audio}', '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${preset.audio.bitrateKbps}k`, '-ar', String(preset.audio.sampleRate),
    '-ac', String(preset.audio.channels), '-movflags', '+faststart', '{out}'];
  const plan: RenderPlan = {
    canvas: rc,
    quality: opts.quality,
    preset: preset.id,
    durationFrames: total,
    inputs,
    chunks,
    concat: { listFile: 'concat.txt' },
    audio: { ...aArgs, hash: sha256Hex(`v${COMPILER_VERSION}\0${aArgs.args.join('\0')}`) },
    writes,
    final: { args: finalArgs },
    warnings,
  };
  if (opts.target) plan.target = opts.target;
  if (opts.assPath) plan.subtitles = { assPath: opts.assPath };
  return plan;
}
