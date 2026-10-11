import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Decided, Timeline } from '@solocut/core';
import { applyOps, compile, emptyTimeline } from '@solocut/core';
import { executeRenderPlan } from '../src/index.js';
import { SAMPLE_SLOTS } from '../../core/test/pattern-samples.js';
import { countFrames, ff, frameLuma, HAVE_LIBASS, maxLuma, regionLuma, tempDir } from './helpers.js';

const D: Decided = { by: 'agent', reason: 'test' };
const IDS = Object.keys(SAMPLE_SLOTS);
const SCENE = 60; // frames per scene (2 s)

describe.skipIf(!HAVE_LIBASS)('scene patterns render with libass', () => {
  const { dir, cleanup } = tempDir('scenes');
  const p = (n: string) => join(dir, n);
  let out = '';
  beforeAll(async () => {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('scr.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=0x30C060:s=320x240:r=30:d=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('cam.mp4')]);
    ff(['-f', 'lavfi', '-i', "color=black:s=200x250,format=rgba,geq=r=255:g=255:b=255:a='255*lt(abs(hypot(X-100,Y-90)-50),4)'", '-frames:v', '1', p('ill.png')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*300*t)':s=48000:d=24", p('mic.wav')]);
    const e = emptyTimeline({ title: 's', kind: 'tech', template: { id: 't', version: '1' }, canvas: { width: 640, height: 360, fps: { num: 30, den: 1 } }, language: 'ja', targets: [] });
    const t: Timeline = applyOps({
      ...e,
      sources: {
        scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'm', fps: { num: 30, den: 1 }, size: { width: 640, height: 360 }, offset: 0, audio: false },
        cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, audio: false },
        mic: { kind: 'mic', path: 'mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
        ill: { kind: 'asset', path: 'ill.png', assetId: 'ill', license: { id: 'CC0-1.0' } },
      },
    }, [
      { op: 'addSegment', segment: { id: 'seg_1', range: { start: 0, end: 0 }, src: { from: 0, to: SCENE * IDS.length, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video: { layout: 'screen-full', screen: 'scr' }, decided: D } },
      ...IDS.map((id, i) => ({ op: 'addScene' as const, scene: { id: `scn_${i}`, pattern: { id, version: '1' }, range: { start: i * SCENE, end: (i + 1) * SCENE }, slots: SAMPLE_SLOTS[id]!, decided: D } })),
    ]).timeline;
    const plan = compile(t, { quality: 'preview', projectDir: dir, maxChunkFrames: SCENE });
    expect(plan.warnings).toEqual([]);
    out = (await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: 'scenes.mp4', concurrency: 4 })).output;
  }, 120_000);
  afterAll(cleanup);

  it('renders every pattern for its full range', () => {
    expect(countFrames(out)).toBe(SCENE * IDS.length);
  });
  for (const [i, id] of IDS.entries()) {
    it(`${id}: shows bright text/shapes`, () => {
      expect(maxLuma(out, i * SCENE + 40)).toBeGreaterThan(200);
    });
  }
  it('dark-background patterns cover the screen video', () => {
    for (const id of ['title-card', 'quote', 'code-focus']) {
      const i = IDS.indexOf(id);
      expect(frameLuma(out, i * SCENE + 40), id).toBeLessThan(45); // testsrc2 underneath averages far brighter
    }
    // cta-subscribe has no background: the screen video stays visible
    expect(frameLuma(out, IDS.indexOf('cta-subscribe') * SCENE + 40)).toBeGreaterThan(60);
  });
  it('explain-illust-bubbles: white bubble, camera in the round wipe, illustration in the centre', () => {
    const f = IDS.indexOf('explain-illust-bubbles') * SCENE + 40;
    // left bubble (centre 0.19W,0.33H; 0.27W × 0.22H): a strip near its top edge is white
    expect(regionLuma(out, f, 90, 88, 60, 6)).toBeGreaterThan(200);
    // wipe circle centre ≈ (99, 263): the green camera
    const wipe = regionLuma(out, f, 92, 256, 14, 14);
    expect(wipe).toBeGreaterThan(80);
    expect(wipe).toBeLessThan(200);
    // illustration ring (white line art) somewhere in the centre column
    expect(maxLuma(out, f)).toBeGreaterThan(230);
    // background between frame and bubbles stays dark
    expect(regionLuma(out, f, 300, 330, 40, 10)).toBeLessThan(60);
  });
});
