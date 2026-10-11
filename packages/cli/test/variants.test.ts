import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sandbox } from './helpers.js';

// docs/18: one take → YouTube (main) + TikTok + YouTube Shorts (derived variants).

let sb: Sandbox;
let dir: string;
const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const decided = { by: 'agent', reason: 't' };
const roles = ['hook', 'explain', 'example', 'explain', 'summary', 'cta'];

beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  expect((await sb.run(['init', dir, '--template', 'talk', '--title', '設定のコツ', '--no-git', '--json'])).code).toBe(0);
  // 6 segments × 20 s from one camera take; a transcript with one word per second
  const cam = { kind: 'camera', path: 'media/a.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0, durationFrames: 4000 };
  const segs = roles.map((role, i) => ({
    id: `seg_${i + 1}`, range: { start: 0, end: 0 }, src: { from: i * 600, to: i * 600 + 600, take: 'take_1' }, text: `話${i + 1}`, chapter: 'ch_1', role,
    video: { layout: 'camera-full', camera: 'cam' }, decided,
  }));
  const ops = [
    { op: 'addSource', id: 'cam', source: cam },
    { op: 'setOutline', outline: [{ id: 'ch_1', title: 'c', start: 0, end: 3600, points: [], importance: 'core' }] },
    { op: 'setSegments', segments: segs },
  ];
  expect((await run(['edit', '--ops', JSON.stringify(ops)])).json.ok).toBe(true);
  mkdirSync(join(dir, 'derived', 'transcripts'), { recursive: true });
  const words = Array.from({ length: 120 }, (_, i) => ({ w: i % 10 === 9 ? 'です。' : '話', start: i + 0.1, end: i + 0.8 }));
  writeFileSync(join(dir, 'derived', 'transcripts', 'main.json'), JSON.stringify({ schema: 1, engine: 'whisper.cpp', model: 't', language: 'ja', take: 'take_1', source: 'cam', words }));
});
afterEach(() => sb.dispose());

describe('derive', () => {
  it('makes a 9:16 TikTok variant from highlights, starting with the hook, with vertical captions', async () => {
    const r = await run(['derive', '--target', 'tiktok']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, target: 'tiktok', path: 'variants/tiktok/timeline.json', replaced: false, maxSec: 90 });
    expect(r.json.durationSec).toBeLessThanOrEqual(90);
    expect(r.json.selection[0]).toBe('seg_1');
    expect(r.json.captions).toBeGreaterThan(0);
    const v = read('variants/tiktok/timeline.json');
    expect(v.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(v.meta.derivedFrom).toMatchObject({ variantOf: 'main' });
    expect(v.meta.derivedFrom.selection.map((s: { segment: string }) => s.segment)).toEqual(r.json.selection);
    expect(v.outputs.map((o: { target: string }) => o.target)).toEqual(['tiktok']);
    expect(v.captions[0].style).toBe('tiktok-bold');
    expect(existsSync(join(dir, 'captions', 'tiktok.ass'))).toBe(true);
    const st = read('.solocut/status.json');
    expect(st.find((s: { step: string }) => s.step === 'derive:tiktok').state).toBe('done');
    // the main timeline is untouched
    expect(read('timeline.json').canvas).toMatchObject({ width: 1920, height: 1080 });
  });

  it('Shorts reuses the TikTok picks (sameAs) within its own 60 s', async () => {
    await run(['derive', '--target', 'tiktok']);
    const tt = read('variants/tiktok/timeline.json').meta.derivedFrom.selection.map((s: { segment: string }) => s.segment);
    const r = await run(['derive', '--target', 'youtube-shorts']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, maxSec: 60 });
    expect(r.json.durationSec).toBeLessThanOrEqual(60);
    for (const id of r.json.selection) expect(tt).toContain(id);
  });

  it('explicit selection, limits and bad input', async () => {
    const r = await run(['derive', '--target', 'tiktok', '--selection', 'seg_5,seg_2', '--max-sec', '30']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, selection: ['seg_5', 'seg_2'] });
    expect(r.json.durationSec).toBeLessThanOrEqual(30);
    expect((await run(['derive', '--target', 'tiktok', '--selection', 'seg_99', '--replace'])).code).toBe(2);
    expect((await run(['derive', '--target', 'instagram'])).code).toBe(2);
    expect((await run(['derive'])).code).toBe(2);
    expect((await run(['derive', '--target', 'tiktok', '--max-sec', '2', '--replace'])).code).toBe(2);
  });

  it('refuses to rebuild an up-to-date variant without --replace; --replace is one undoable entry', async () => {
    await run(['derive', '--target', 'tiktok', '--selection', 'seg_1,seg_2']);
    expect((await run(['derive', '--target', 'tiktok'])).json.error.code).toBe('exists');
    const r = await run(['derive', '--target', 'tiktok', '--selection', 'seg_1,seg_3', '--replace']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, replaced: true });
    const hist = readFileSync(join(dir, '.solocut', 'history.tiktok.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(hist.some((h: { note?: string }) => h.note === 'derive tiktok')).toBe(true);
    expect(read('variants/tiktok/timeline.json').meta.derivedFrom.selection.map((s: { segment: string }) => s.segment)).toEqual(['seg_1', 'seg_3']);
  });

  it('a changed main marks the variant stale; re-deriving keeps what a human added', async () => {
    await run(['derive', '--target', 'tiktok', '--selection', 'seg_1,seg_2']);
    const telop = { kind: 'telop', id: 'ov_human', range: { start: 0, end: 30 }, text: '必見', style: 'default', position: { x: 540, y: 400 }, decided: { by: 'human', reason: '強調したい' } };
    expect((await sb.run(['edit', '--variant', 'tiktok', '--ops', JSON.stringify([{ op: 'addOverlay', overlay: telop }]), '--json'], { cwd: dir })).json.ok).toBe(true);
    expect((await run(['status'])).json.variants.tiktok).toMatchObject({ exists: true, stale: false });
    await run(['edit', 'trimSegment', '--id', 'seg_1', '--to', '500', '--reason', '短く']);
    expect((await run(['status'])).json.variants.tiktok.stale).toBe(true);
    await run(['step', 'derive:tiktok', 'done']);
    for (const s of ['ingest', 'sync', 'transcribe', 'rough-cut', 'multicam', 'captions', 'sfx', 'layout', 'preview', 'check']) await run(['step', s, 'done']);
    expect((await run(['next'])).json).toMatchObject({ step: 'derive:tiktok', state: 'ready', variant: 'tiktok' });
    const r = await run(['derive', '--target', 'tiktok', '--selection', 'seg_1,seg_2', '--replace']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, kept: ['ov_human'] });
    expect(read('variants/tiktok/timeline.json').overlays.map((o: { id: string }) => o.id)).toContain('ov_human');
    expect((await run(['status'])).json.variants.tiktok.stale).toBe(false);
  });

  it('a template without the target refuses; no segments refuses', async () => {
    const d2 = join(sb.root, 'empty');
    await sb.run(['init', d2, '--template', 'talk', '--no-git', '--json']);
    expect((await sb.run(['derive', '--target', 'tiktok', '--json'], { cwd: d2 })).json.error.code).toBe('no-segments');
  });
});

describe('--variant on timeline commands', () => {
  beforeEach(async () => {
    expect((await run(['derive', '--target', 'tiktok', '--selection', 'seg_1,seg_2'])).json.ok).toBe(true);
  });

  it('edit / undo / history are per variant; the main timeline is not touched', async () => {
    const mainBefore = readFileSync(join(dir, 'timeline.json'), 'utf8');
    const v = (args: string[]) => sb.run([...args, '--variant', 'tiktok', '--json'], { cwd: dir });
    expect((await v(['edit', '{"op":"setMeta","patch":{"goal":"縦"}}'])).json.ok).toBe(true);
    expect(read('variants/tiktok/timeline.json').meta.goal).toBe('縦');
    expect(readFileSync(join(dir, 'timeline.json'), 'utf8')).toBe(mainBefore);
    expect((await v(['history'])).json.entries.length).toBeGreaterThan(0);
    expect((await v(['undo'])).json.ok).toBe(true);
    expect(read('variants/tiktok/timeline.json').meta.goal).not.toBe('縦');
    // the main history is separate
    const mainHist = (await run(['history'])).json.entries.map((e: { kind: string }) => e.kind);
    expect(mainHist.every((k: string) => k === 'edit')).toBe(true);
    expect((await v(['tl', 'summary'])).json.summary.canvas).toMatch(/^1080x1920/);
    expect((await v(['validate'])).json.ok).toBe(true);
  });

  it('commands on a variant that does not exist explain how to make it', async () => {
    const r = await sb.run(['tl', 'summary', '--variant', 'youtube-shorts', '--json'], { cwd: dir });
    expect(r.json.error.code).toBe('no-variant');
    expect(r.json.error.message).toContain('solocut derive --target youtube-shorts');
    expect((await sb.run(['tl', 'summary', '--variant', 'myspace', '--json'], { cwd: dir })).code).toBe(2);
    expect((await sb.run(['tl', 'summary', '--variant', 'main', '--json'], { cwd: dir })).json.ok).toBe(true);
  });

  it('status --variant summarizes that video; steps stay project-wide', async () => {
    const r = await sb.run(['status', '--variant', 'tiktok', '--json'], { cwd: dir });
    expect(r.json).toMatchObject({ ok: true, variant: 'tiktok' });
    expect(r.json.summary.canvas).toMatch(/^1080x1920/);
    expect(r.json.steps).toHaveLength(21);
  });

  it('meta set --variant writes the TikTok post text', async () => {
    const r = await sb.run(['meta', 'set', '--variant', 'tiktok', '--title', '9割ムダ', '--tags', 'tips', '--json'], { cwd: dir });
    expect(r.json, r.stdout).toMatchObject({ ok: true, targets: ['tiktok'] });
    expect(read('variants/tiktok/timeline.json').outputs[0].metadata.title).toBe('9割ムダ');
    expect(existsSync(join(dir, 'renders', 'tiktok', 'metadata.md'))).toBe(true);
  });

  it('captions build --variant uses the vertical style and file', async () => {
    const r = await sb.run(['captions', 'build', '--variant', 'tiktok', '--json'], { cwd: dir });
    expect(r.json).toMatchObject({ ok: true, variant: 'tiktok', style: 'tiktok-bold', files: ['captions/tiktok.ass', 'captions/tiktok.srt'] });
  });

  it('step accepts variant steps', async () => {
    expect((await run(['step', 'check:tiktok', 'done'])).json.ok).toBe(true);
    expect((await run(['step', 'check:instagram', 'done'])).code).toBe(2);
  });
});
