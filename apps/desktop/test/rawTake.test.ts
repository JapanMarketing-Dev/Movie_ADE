import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOCK_SANITY_MS, filesFromNames, filesFromSources, filesFromTakeJson, newestTake, pickCamera, pickRawTake, rawTake, trackStartMs,
  type TakeFile,
} from '../src/main/services/rawTake';
import { finishPrompt, followerAction, playerSource, SYNC_TOLERANCE } from '../src/renderer/src/screens/parts/workspaceModel';
import { pathFromMediaUrl } from '../src/shared/ipc';

const f = (id: string, kind: TakeFile['kind'], start = 0, role?: string): TakeFile => ({ id, kind, path: `/p/${id}`, start, ...(role ? { role } : {}) });

describe('pickCamera', () => {
  it('none → undefined', () => expect(pickCamera([])).toBeUndefined());
  it("role 'main' wins over front and order", () => {
    expect(pickCamera([f('a', 'camera', 0, 'front'), f('b', 'camera', 0, 'main')])!.id).toBe('b');
  });
  it("'front' wins when no main", () => {
    expect(pickCamera([f('a', 'camera', 0, 'other'), f('b', 'camera', 0, 'front')])!.id).toBe('b');
  });
  it('otherwise the first by id, whatever the input order', () => {
    expect(pickCamera([f('camera-2', 'camera'), f('camera-1', 'camera')])!.id).toBe('camera-1');
  });
});

describe('pickRawTake', () => {
  it('nothing playable → null (empty, mic only)', () => {
    expect(pickRawTake([])).toBeNull();
    expect(pickRawTake([f('mic-1', 'mic')])).toBeNull();
  });
  it('screen only: main is the screen, no pip', () => {
    const r = pickRawTake([f('screen', 'screen')])!;
    expect(r.main.id).toBe('screen');
    expect(r.pip).toBeUndefined();
    expect(r.audio).toBeUndefined();
  });
  it('camera only: the camera is main, no pip', () => {
    const r = pickRawTake([f('camera-2', 'camera'), f('camera-1', 'camera'), f('mic-1', 'mic')])!;
    expect(r.main.id).toBe('camera-1');
    expect(r.pip).toBeUndefined();
    expect(r.audio!.id).toBe('mic-1');
  });
  it('screen + several cameras + mic: main camera as pip', () => {
    const r = pickRawTake([f('camera-1', 'camera'), f('camera-2', 'camera', 0, 'main'), f('screen', 'screen'), f('mic-1', 'mic')])!;
    expect(r.main.id).toBe('screen');
    expect(r.pip!.id).toBe('camera-2');
    expect(r.audio!.id).toBe('mic-1');
  });
  it('first mic by id when there are several', () => {
    expect(pickRawTake([f('screen', 'screen'), f('mic-2', 'mic'), f('mic-1', 'mic')])!.audio!.id).toBe('mic-1');
  });
  it('starts are relative to main (positive and negative)', () => {
    const r = pickRawTake([f('screen', 'screen', 0.5), f('cam', 'camera', 0.2), f('mic', 'mic', 1.5)])!;
    expect(r.main.start).toBe(0);
    expect(r.pip!.start).toBeCloseTo(-0.3);
    expect(r.audio!.start).toBeCloseTo(1);
  });
  it('does not mutate the input', () => {
    const input = [f('screen', 'screen', 2), f('cam', 'camera', 1)];
    pickRawTake(input);
    expect(input[0]!.start).toBe(2);
  });
});

describe('filesFromSources', () => {
  const tl = (sources: unknown) => ({ sources });
  it('broken / missing timeline → empty', () => {
    expect(filesFromSources(undefined, '/p').size).toBe(0);
    expect(filesFromSources(null, '/p').size).toBe(0);
    expect(filesFromSources({}, '/p').size).toBe(0);
    expect(filesFromSources(tl([1, 2]), '/p').size).toBe(0);
    expect(filesFromSources(tl('x'), '/p').size).toBe(0);
  });
  it('groups by take, resolves paths, skips assets / takeless / pathless / junk', () => {
    const m = filesFromSources(
      tl({
        's': { kind: 'screen', take: 'take_1', path: 'media/takes/take_1/screen.mp4', fps: { num: 30, den: 1 }, offset: 0 },
        'c': { kind: 'camera', take: 'take_1', path: '/abs/cam.mp4', fps: { num: 30, den: 1 }, offset: -15, role: 'front' },
        'm2': { kind: 'mic', take: 'take_2', path: 'mic.wav', sampleRate: 48000, offset: 24000 },
        'a': { kind: 'asset', path: 'x.png' },
        'n': { kind: 'camera', path: 'y.mp4' },
        'e': { kind: 'camera', take: 'take_1', path: '' },
        'z': null,
      }),
      '/proj',
    );
    expect([...m.keys()].sort()).toEqual(['take_1', 'take_2']);
    const t1 = m.get('take_1')!;
    expect(t1.find((x) => x.id === 's')!.path).toBe('/proj/media/takes/take_1/screen.mp4');
    const cam = t1.find((x) => x.id === 'c')!;
    expect(cam.path).toBe('/abs/cam.mp4');
    expect(cam.role).toBe('front');
    // local = takeSec + offset/rate = 0 → takeSec = 0.5 (the camera started half a second later)
    expect(cam.start).toBeCloseTo(0.5);
    // positive offset: the mic's t=0 is before the take clock starts
    expect(m.get('take_2')![0]!.start).toBeCloseTo(-0.5);
  });
  it('drift scales the start; a missing or bad rate means 0', () => {
    const m = filesFromSources(
      tl({
        c: { kind: 'camera', take: 'take_1', path: 'c.mp4', fps: { num: 30, den: 1 }, offset: -30, drift: 2 },
        d: { kind: 'camera', take: 'take_1', path: 'd.mp4', offset: -30 },
        e: { kind: 'camera', take: 'take_1', path: 'e.mp4', fps: { num: 0, den: 1 }, offset: -30 },
        g: { kind: 'mic', take: 'take_1', path: 'g.wav', offset: 'x' },
      }),
      '/p',
    ).get('take_1')!;
    expect(m.find((x) => x.id === 'c')!.start).toBeCloseTo(0.5);
    expect(m.find((x) => x.id === 'd')!.start).toBe(0);
    expect(m.find((x) => x.id === 'e')!.start).toBe(0);
    expect(m.find((x) => x.id === 'g')!.start).toBe(0);
    expect(Object.is(m.find((x) => x.id === 'g')!.start, -0)).toBe(false);
  });
});

describe('trackStartMs', () => {
  it('first frame when it is near the recorder start', () => {
    expect(trackStartMs({ firstFrameMs: 1010, recorderStartMs: 1040 }, 1000)).toBe(1010);
  });
  it('first frame on another clock (AudioContext before output) falls back to the recorder start', () => {
    expect(trackStartMs({ firstFrameMs: -10.67, recorderStartMs: 134848.7 }, 134834.3)).toBe(134848.7);
  });
  it('the boundary is inclusive', () => {
    expect(trackStartMs({ firstFrameMs: 1000 + CLOCK_SANITY_MS, recorderStartMs: 1000 }, undefined)).toBe(1000 + CLOCK_SANITY_MS);
    expect(trackStartMs({ firstFrameMs: 1001 + CLOCK_SANITY_MS, recorderStartMs: 1000 }, undefined)).toBe(1000);
  });
  it('no recorder start: compares with the take start; nothing known → undefined', () => {
    expect(trackStartMs({ firstFrameMs: 5 }, 100000)).toBe(100000);
    expect(trackStartMs({ firstFrameMs: 5 }, undefined)).toBe(5);
    expect(trackStartMs({}, undefined)).toBeUndefined();
    expect(trackStartMs({ firstFrameMs: 'x', recorderStartMs: null }, 7)).toBe(7);
  });
});

describe('filesFromTakeJson', () => {
  const all = () => true;
  it('broken take.json → null', () => {
    expect(filesFromTakeJson(undefined, '/t', all)).toBeNull();
    expect(filesFromTakeJson(null, '/t', all)).toBeNull();
    expect(filesFromTakeJson({ tracks: 'x' }, '/t', all)).toBeNull();
    expect(filesFromTakeJson('take', '/t', all)).toBeNull();
  });
  it('the real take that rendered black: audio firstFrameMs on another clock does not shift the videos', () => {
    const meta = {
      startedAtMs: 134834.3,
      tracks: [
        { file: 'screen.mp4', kind: 'screen', firstFrameMs: 134872.3, recorderStartMs: 134901.7 },
        { file: 'system.wav', kind: 'system', recorderStartMs: 134847, firstFrameMs: -10.67 },
        { file: 'camera-1.mp4', kind: 'camera', firstFrameMs: 134864.9, recorderStartMs: 134902.7 },
        { file: 'camera-2.mp4', kind: 'camera', firstFrameMs: 134877.7, recorderStartMs: 134907.1 },
        { file: 'mic-1.wav', kind: 'mic', recorderStartMs: 134848.7, firstFrameMs: -10.67 },
      ],
    };
    const files = filesFromTakeJson(meta, '/t', all)!;
    expect(files.map((x) => x.id)).toEqual(['screen', 'camera-1', 'camera-2', 'mic-1']); // system audio dropped
    for (const x of files) expect(Math.abs(x.start)).toBeLessThan(0.1);
    const pick = pickRawTake(files)!;
    expect(pick.main.id).toBe('screen');
    expect(pick.pip!.id).toBe('camera-1');
    expect(pick.pip!.start).toBeCloseTo((134864.9 - 134872.3) / 1000);
    expect(pick.audio!.start).toBeCloseTo((134848.7 - 134872.3) / 1000);
  });
  it('skips missing files, unsafe names and unknown kinds', () => {
    const files = filesFromTakeJson(
      { tracks: [{ file: 'screen.mp4', kind: 'screen' }, { file: 'gone.mp4', kind: 'camera' }, { file: '../x.mp4', kind: 'camera' }, { file: 'a/b.mp4', kind: 'camera' }, { file: 'k.mp4', kind: 'keys' }, null, { kind: 'mic' }] },
      '/t',
      (p) => p !== '/t/gone.mp4',
    )!;
    expect(files.map((x) => x.id)).toEqual(['screen']);
    expect(files[0]!.path).toBe('/t/screen.mp4');
    expect(files[0]!.start).toBe(0);
  });
  it('keeps a track role (main camera)', () => {
    const files = filesFromTakeJson({ tracks: [{ file: 'screen.mp4', kind: 'screen' }, { file: 'camera-1.mp4', kind: 'camera' }, { file: 'camera-2.mp4', kind: 'camera', role: 'main' }] }, '/t', all)!;
    expect(pickRawTake(files)!.pip!.id).toBe('camera-2');
  });
  it('positive and negative offsets from the earliest start', () => {
    const files = filesFromTakeJson({ tracks: [{ file: 'screen.mp4', kind: 'screen', recorderStartMs: 1500 }, { file: 'camera-1.mp4', kind: 'camera', recorderStartMs: 1000 }] }, '/t', all)!;
    expect(files.find((x) => x.kind === 'camera')!.start).toBe(0);
    expect(files.find((x) => x.kind === 'screen')!.start).toBe(0.5);
    const p = pickRawTake(files)!;
    expect(p.pip!.start).toBe(-0.5);
  });
});

describe('filesFromNames', () => {
  it('guesses kinds from names and ignores the rest', () => {
    const files = filesFromNames(['take.json', 'screen.webm', 'camera-1.mp4', 'cam2.mov', 'mic-1.wav', 'system.wav', 'cursor.jsonl', 'camera-3.mp4.part', 'mic.txt'], '/t');
    expect(files.map((x) => `${x.kind}:${x.id}`)).toEqual(['screen:screen', 'camera:camera-1', 'camera:cam2', 'mic:mic-1']);
    expect(files.every((x) => x.start === 0)).toBe(true);
  });
  it('empty folder → nothing', () => expect(filesFromNames([], '/t')).toEqual([]));
});

describe('newestTake', () => {
  it('newest valid take id', () => {
    expect(newestTake(['take_20261011-154310', 'take_20261012-090000', 'notes', '.DS_Store', 'take_20261011-100000'])).toBe('take_20261012-090000');
    expect(newestTake([])).toBeNull();
    expect(newestTake(['x', 'take_'])).toBeNull();
  });
});

describe('rawTake (files on disk)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solocut-raw-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const takeDir = (id: string) => {
    const d = join(dir, 'media', 'takes', id);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const touch = (p: string) => writeFileSync(p, 'x');

  it('no takes → null', () => {
    expect(rawTake(dir)).toBeNull();
    mkdirSync(join(dir, 'media', 'takes'), { recursive: true });
    expect(rawTake(dir)).toBeNull();
  });
  it('take.json before ingest, with media urls', () => {
    const d = takeDir('take_20261011-154310');
    for (const n of ['screen.mp4', 'camera-1.mp4', 'mic-1.wav']) touch(join(d, n));
    writeFileSync(
      join(d, 'take.json'),
      JSON.stringify({ startedAtMs: 0, tracks: [{ file: 'screen.mp4', kind: 'screen', recorderStartMs: 100 }, { file: 'camera-1.mp4', kind: 'camera', recorderStartMs: 300 }, { file: 'mic-1.wav', kind: 'mic', recorderStartMs: 50 }] }),
    );
    const r = rawTake(dir)!;
    expect(r.take).toBe('take_20261011-154310');
    expect(r.main.kind).toBe('screen');
    expect(pathFromMediaUrl(r.main.url)).toBe(join(d, 'screen.mp4'));
    expect(r.main.url).toMatch(/\?v=\d+$/);
    expect(r.pip!.start).toBeCloseTo(0.2);
    expect(r.audio!.start).toBeCloseTo(-0.05);
  });
  it('broken take.json → file names', () => {
    const d = takeDir('take_1');
    touch(join(d, 'camera-1.mp4'));
    writeFileSync(join(d, 'take.json'), '{ broken');
    const r = rawTake(dir)!;
    expect(r.main.kind).toBe('camera');
    expect(r.pip).toBeUndefined();
    expect(r.audio).toBeUndefined();
  });
  it('take.json whose files are all missing → file names → null', () => {
    const d = takeDir('take_1');
    writeFileSync(join(d, 'take.json'), JSON.stringify({ tracks: [{ file: 'screen.mp4', kind: 'screen' }] }));
    expect(rawTake(dir)).toBeNull();
  });
  it('ingested sources win over take.json (re-synced offsets, proxy paths)', () => {
    const d = takeDir('take_1');
    touch(join(d, 'screen.webm'));
    touch(join(d, 'camera-1.mp4'));
    writeFileSync(join(d, 'take.json'), JSON.stringify({ tracks: [{ file: 'screen.webm', kind: 'screen' }, { file: 'camera-1.mp4', kind: 'camera' }] }));
    mkdirSync(join(dir, 'derived', 'proxies', 'take_1'), { recursive: true });
    touch(join(dir, 'derived', 'proxies', 'take_1', 'screen.mp4'));
    writeFileSync(
      join(dir, 'timeline.json'),
      JSON.stringify({
        sources: {
          'take_1.screen': { kind: 'screen', take: 'take_1', path: 'derived/proxies/take_1/screen.mp4', fps: { num: 30, den: 1 }, offset: 0 },
          'take_1.camera-1': { kind: 'camera', take: 'take_1', path: 'media/takes/take_1/camera-1.mp4', fps: { num: 30, den: 1 }, offset: -3, role: 'front' },
        },
      }),
    );
    const r = rawTake(dir)!;
    expect(pathFromMediaUrl(r.main.url)).toBe(join(dir, 'derived', 'proxies', 'take_1', 'screen.mp4'));
    expect(r.pip!.start).toBeCloseTo(0.1);
  });
  it('sources pointing at missing files fall back to take.json', () => {
    const d = takeDir('take_1');
    touch(join(d, 'camera-1.mp4'));
    writeFileSync(join(d, 'take.json'), JSON.stringify({ tracks: [{ file: 'camera-1.mp4', kind: 'camera' }] }));
    writeFileSync(join(dir, 'timeline.json'), JSON.stringify({ sources: { s: { kind: 'screen', take: 'take_1', path: 'gone.mp4' } } }));
    const r = rawTake(dir)!;
    expect(r.main.kind).toBe('camera');
    expect(pathFromMediaUrl(r.main.url)).toBe(join(d, 'camera-1.mp4'));
  });
  it('broken timeline.json is ignored', () => {
    const d = takeDir('take_1');
    touch(join(d, 'screen.mp4'));
    writeFileSync(join(dir, 'timeline.json'), 'nope');
    expect(rawTake(dir)!.main.kind).toBe('screen');
  });
  it('the newest take is shown; an imported take only in sources counts too', () => {
    touch(join(takeDir('take_20261010-120000'), 'screen.mp4'));
    touch(join(takeDir('take_20261011-120000'), 'camera-1.mp4'));
    expect(rawTake(dir)!.take).toBe('take_20261011-120000');
    mkdirSync(join(dir, 'media', 'imports', 'imp1'), { recursive: true });
    touch(join(dir, 'media', 'imports', 'imp1', 'clip.mp4'));
    writeFileSync(join(dir, 'timeline.json'), JSON.stringify({ sources: { imp1: { kind: 'camera', take: 'take_imp1', path: 'media/imports/imp1/clip.mp4', fps: { num: 30, den: 1 }, offset: 0 } } }));
    expect(rawTake(dir)!.take).toBe('take_imp1');
  });
});

describe('followerAction', () => {
  const playing = { paused: false };
  it('before the follower starts or after it ends → out', () => {
    expect(followerAction(0.1, playing, { start: 0.5, currentTime: 0 })).toEqual({ kind: 'out' });
    expect(followerAction(10, playing, { start: 0, currentTime: 0, duration: 10 })).toEqual({ kind: 'out' });
    expect(followerAction(Number.NaN, playing, { start: 0, currentTime: 0 })).toEqual({ kind: 'out' });
  });
  it('exactly at its start → in, at time 0', () => {
    expect(followerAction(0.5, playing, { start: 0.5, currentTime: 0 })).toEqual({ kind: 'sync', time: 0, seek: false, play: true });
  });
  it('negative start: the follower is ahead', () => {
    const a = followerAction(1, playing, { start: -0.3, currentTime: 0 });
    expect(a.kind).toBe('sync');
    if (a.kind === 'sync') {
      expect(a.time).toBeCloseTo(1.3);
      expect(a.seek).toBe(true);
    }
  });
  it('seeks only beyond the tolerance, or always while the main video seeks', () => {
    expect(followerAction(5, playing, { start: 0, currentTime: 5 - SYNC_TOLERANCE + 0.01 })).toMatchObject({ seek: false });
    expect(followerAction(5, playing, { start: 0, currentTime: 5 - SYNC_TOLERANCE - 0.01 })).toMatchObject({ seek: true });
    expect(followerAction(5, { paused: true, seeking: true }, { start: 0, currentTime: 5 })).toMatchObject({ seek: true, play: false });
  });
  it('unknown / zero duration does not cut the follower off', () => {
    expect(followerAction(100, playing, { start: 0, currentTime: 100, duration: Number.NaN }).kind).toBe('sync');
    expect(followerAction(100, playing, { start: 0, currentTime: 100, duration: 0 }).kind).toBe('sync');
  });
});

describe('playerSource', () => {
  it('rendered preview first, then the raw take, else none', () => {
    expect(playerSource({ preview: 1, raw: 2 })).toBe('edited');
    expect(playerSource({ raw: 2 })).toBe('raw');
    expect(playerSource({})).toBe('none');
    expect(playerSource(null)).toBe('none');
  });
});

describe('finishPrompt', () => {
  it('uses the finish prompt from the list, ignoring every other prompt', () => {
    expect(finishPrompt([{ id: 'render', label: 'R' }, { id: 'finish', label: '完成させて', agent: 'codex' }], 'fb')).toEqual({ id: 'finish', label: '完成させて', agent: 'codex', autopilot: true });
  });
  it('falls back to the built-in label when finish is missing or blank', () => {
    expect(finishPrompt([], '動画を完成させて')).toEqual({ id: 'finish', label: '動画を完成させて', autopilot: true });
    expect(finishPrompt([{ id: 'finish', label: '  ' }], '動画を完成させて').label).toBe('動画を完成させて');
  });
});
