import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Decided, Segment, Timeline } from '@solocut/core';
import { applyOp, applyOps, compile, emptyTimeline } from '@solocut/core';
import { executeRenderPlan, measureLoudness, MediaError, probe } from '../src/index.js';
import { countFrames, ff, frameLuma, gatedNoiseExpr, HAVE_FFMPEG, HAVE_LIBASS, regionLuma, tempDir } from './helpers.js';

const D: Decided = { by: 'agent', reason: 'test' };

function seg(id: string, from: number, to: number, video: Segment['video'], extra: Partial<Segment> = {}): Segment {
  return { id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video, decided: D, ...extra };
}

describe.skipIf(!HAVE_FFMPEG)('executeRenderPlan', () => {
  const { dir, cleanup } = tempDir('render');
  const p = (n: string) => join(dir, n);
  let base: Timeline;

  beforeAll(() => {
    // camera: flat gray whose luma encodes the frame number (16 + 6·(N mod 37)), 4 s @30, with a tone
    ff(['-f', 'lavfi', '-i', "color=black:s=320x240:r=30:d=4,format=yuv420p,geq=lum='16+6*mod(N,37)':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('cam.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('scr.mp4')]);
    ff(['-f', 'lavfi', '-i', `aevalsrc='0.5*${gatedNoiseExpr(1)}':s=48000:d=4.5`, p('mic.wav')]);
    ff(['-f', 'lavfi', '-i', 'color=red:s=64x64:d=1', '-frames:v', '1', p('logo.png')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)':s=48000:d=1.5", p('bgm.wav')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1200*t)':s=48000:d=0.2", p('pop.wav')]);
    const e = emptyTimeline({ title: 'r', kind: 'talk', template: { id: 't', version: '1' }, canvas: { width: 320, height: 240, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube'] });
    base = applyOps({
      ...e,
      sources: {
        cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, durationFrames: 120 },
        scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'main', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, audio: false },
        mic: { kind: 'mic', path: 'mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
        logo: { kind: 'asset', path: 'logo.png', assetId: 'logo', license: { id: 'CC0-1.0' } },
        music: { kind: 'asset', path: 'bgm.wav', assetId: 'bgm', license: { id: 'CC0-1.0' } },
        pop: { kind: 'asset', path: 'pop.wav', assetId: 'pop', license: { id: 'CC0-1.0' } },
      },
      outline: [{ id: 'ch_1', title: 'c', start: 0, end: 60, points: [], importance: 'core' }],
    }, [
      { op: 'addSegment', segment: seg('seg_a', 30, 60, { layout: 'camera-full', camera: 'cam' }) },
      { op: 'addSegment', segment: seg('seg_b', 75, 105, { layout: 'screen-full', screen: 'scr' }) },
    ]).timeline;
  });
  afterAll(cleanup);

  const render = (t: Timeline, out: string, extra: Partial<Parameters<typeof compile>[1]> = {}, conc?: number) => {
    const plan = compile(t, { quality: 'preview', projectDir: dir, ...extra });
    return executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: out, ...(conc ? { concurrency: conc } : {}) });
  };

  it('renders a 2-segment timeline with the right duration, size, streams and exact source frames', async () => {
    const progress: number[] = [];
    const plan = compile(base, { quality: 'preview', projectDir: dir });
    const r = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: 'out/a.mp4', onProgress: (x) => progress.push(x.done) });
    expect(r).toEqual({ output: p('out/a.mp4'), reused: 0, rendered: 2 });
    expect(progress.at(-1)).toBe(2);
    const pr = await probe(r.output);
    expect(pr.durationSec).toBeCloseTo(2, 1);
    expect(pr.streams.find((s) => s.type === 'video')).toMatchObject({ codec: 'h264', width: 320, height: 240, fps: { num: 30, den: 1 }, pixFmt: 'yuv420p' });
    expect(pr.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(countFrames(r.output)).toBe(60);
    // frame-accurate cuts: output frame 0 is source frame 30, frame 29 is source frame 59
    const nearest = (lum: number, around: number) => {
      let best = -1;
      let bd = Infinity;
      for (let k = around - 3; k <= around + 3; k++) {
        const d = Math.abs(frameLuma(p('cam.mp4'), k) - lum);
        if (d < bd) [bd, best] = [d, k];
      }
      return best;
    };
    expect(nearest(frameLuma(r.output, 0), 30)).toBe(30);
    expect(nearest(frameLuma(r.output, 29), 59)).toBe(59);
    expect(readdirSync(p('out')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('reuses cached chunks; re-renders only what changed', async () => {
    const again = await render(base, 'out/b.mp4');
    expect(again.reused).toBe(2);
    expect(again.rendered).toBe(0);
    expect(countFrames(again.output)).toBe(60);
    const t = applyOp(base, { op: 'trimSegment', id: 'seg_b', to: 90, decided: D }).timeline;
    const r = await render(t, 'out/c.mp4');
    expect([r.reused, r.rendered]).toEqual([1, 1]);
    expect(countFrames(r.output)).toBe(45);
    // touching an input file invalidates the chunks that read it
    const later = new Date(Date.now() + 5000);
    const { utimesSync } = await import('node:fs');
    utimesSync(p('scr.mp4'), later, later);
    const r2 = await render(base, 'out/d.mp4');
    expect([r2.reused, r2.rendered]).toEqual([1, 1]);
  });

  it('renders layouts, zoom, transitions, masks, overlays, bgm ducking, sfx and chunk splitting', async () => {
    let t = applyOps(base, [
      { op: 'setSegments', segments: [
        seg('seg_w', 0, 30, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'default' } },
          { transitionIn: { kind: 'fade', frames: 5 } }),
        seg('seg_r', 30, 50, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'rounded', corner: 'tl', style: 'default' } },
          { zoom: [{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 15, value: { scale: 1.6, focus: { x: 100, y: 100 } } }] }),
        seg('seg_s', 50, 80, { layout: 'split-v', top: 'scr', bottom: 'cam' }, { transitionIn: { kind: 'jump-zoom', frames: 4 } }),
        seg('seg_z', 80, 110, { layout: 'camera-full', camera: 'cam' }, { zoom: [{ at: 0, value: { scale: 1.5, focus: 'face' } }] }),
      ] },
      { op: 'addMask', mask: { id: 'mask_1', kind: 'pixelate', source: 'scr', reason: 'pii:email', decided: D, track: [
        { frame: 0, box: { x: 10, y: 10, w: 120, h: 40 }, confidence: 0.9 }, { frame: 60, box: { x: 100, y: 60, w: 120, h: 40 }, confidence: 0.9 }] } },
      { op: 'addMask', mask: { id: 'mask_2', kind: 'blur', source: 'scr', reason: 'notification', decided: D, track: [{ frame: 40, box: { x: 200, y: 0, w: 100, h: 60 }, confidence: 1 }, { frame: 70, box: { x: 200, y: 0, w: 100, h: 60 }, confidence: 1 }] } },
      { op: 'addOverlay', overlay: { kind: 'image', id: 'ov_1', range: { start: 10, end: 40 }, asset: 'logo', position: { x: 20, y: 20, w: 64, h: 64 }, decided: D } },
      { op: 'addOverlay', overlay: { kind: 'logo', id: 'ov_2', range: { start: 0, end: 110 }, asset: 'logo', corner: 'tr' } },
      { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 15, end: 110 }, gainDb: -12, duckDb: -10, fadeIn: 10, fadeOut: 15, decided: D }] },
      { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 50, gainDb: -6, trigger: 'cut', decided: D } },
      { op: 'setVoice', patch: { denoise: 'strong', eq: 'voice-bright' } },
    ]).timeline;
    const c = structuredClone(t.sources.cam) as Extract<Timeline['sources'][string], { kind: 'camera' }>;
    c.offset = -10; // camera starts 10 frames after the take: leading black padding in seg_w
    t = applyOp(t, { op: 'addSource', id: 'cam', source: c }).timeline;
    const r = await render(t, 'out/sink.mp4', { maxChunkFrames: 20 }, 3);
    expect(r.rendered).toBe(7); // 30→2, 20→1, 30→2, 30→2
    expect(countFrames(r.output)).toBe(110);
    const pr = await probe(r.output);
    expect(pr.durationSec).toBeCloseTo(110 / 30, 1);
  });

  it('fill mask lands where the source coordinates say', async () => {
    const t = applyOp(base, { op: 'addMask', mask: { id: 'mask_f', kind: 'fill', source: 'cam', reason: 'face', decided: D, track: [
      { frame: 0, box: { x: 0, y: 0, w: 160, h: 120 }, confidence: 1 }, { frame: 120, box: { x: 0, y: 0, w: 160, h: 120 }, confidence: 1 }] } }).timeline;
    const r = await render(t, 'out/mask.mp4');
    const inside = regionLuma(r.output, 25, 10, 10, 100, 80);
    const outside = regionLuma(r.output, 25, 200, 150, 100, 80);
    expect(inside).toBeLessThan(5);
    expect(outside).toBeGreaterThan(inside + 40);
  });

  it('final quality hits the loudness target with 2-pass loudnorm', async () => {
    const t = applyOp(base, { op: 'setSegments', segments: [seg('seg_l', 0, 120, { layout: 'camera-full', camera: 'cam' })] }).timeline;
    const r = await render(t, 'out/final.mp4', { quality: 'final', target: 'youtube' });
    const l = await measureLoudness(r.output);
    expect(Math.abs(l.integrated - -14)).toBeLessThan(1);
    expect(l.truePeak).toBeLessThan(-0.3);
    const pr = await probe(r.output);
    expect(pr.streams.find((s) => s.type === 'video')!.profile).toBe('High');
  });

  it('fails clearly on a missing input', async () => {
    const t = applyOp(base, { op: 'addSource', id: 'cam', source: { ...(base.sources.cam as Extract<Timeline['sources'][string], { kind: 'camera' }>), path: 'missing.mp4' } }).timeline;
    await expect(render(t, 'out/x.mp4')).rejects.toBeInstanceOf(MediaError);
    await expect(render(t, 'out/x.mp4')).rejects.toThrow(/input not found: missing\.mp4/);
    expect(existsSync(p('out/x.mp4'))).toBe(false);
  });

  it.skipIf(!HAVE_LIBASS)('burns captions and telops with libass', async () => {
    writeFileSync(p('captions.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,HELLO\n');
    let t = applyOp(base, { op: 'setCaptions', captions: [{ id: 'cap_1', range: { start: 0, end: 60 }, text: 'HELLO', spoken: 'hello', words: [], lines: ['HELLO'], emphasis: [], style: 'x', position: { anchor: 'bottom', y: 0.9 }, decided: D }] }).timeline;
    t = applyOp(t, { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_t', range: { start: 35, end: 55 }, text: 'テロップ', style: 'big', position: { x: 160, y: 60 }, decided: D } }).timeline;
    const r = await render(t, 'out/subs.mp4', { assPath: 'captions.ass' });
    expect(countFrames(r.output)).toBe(60);
  });
});
