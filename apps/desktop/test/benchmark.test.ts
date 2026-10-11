import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeReference, allowedInReferenceWindow, benchEntry, benchReducer, captureStep, DEFAULT_RANGE, formatClock, formatRange, initialCapture,
  isStyleProfile, MAX_RANGE_SEC, MIN_RANGE_SEC, NO_PLAYER_GRACE_MS, normalizeRange, parseBenchProgress, parseClock, parsePlayerSample,
  parseReferenceUrl, profileTitle, summarizeProfile, type BenchEntry, type BenchFlow, type CaptureState, type PlayerSample,
} from '../src/shared/benchmark';
import {
  analyze, analyzeArgs, apply, benchState, captureAppend, captureBegin, captureDiscard, captureEnd, captureFile, entryFromAnalyze, listProfiles,
  clearApplied, cliErrorCode, parseApplied, readApplied, unapply, writeApplied, type RunCli,
} from '../src/main/services/benchmark';
import { BENCH_EVENT_CHANNELS, BENCH_INVOKE_CHANNELS } from '../src/shared/ipc-bench';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../src/shared/ipc';

const PROFILE = {
  source: { url: 'https://www.youtube.com/watch?v=abc123', platform: 'youtube', analyzed: '00:00-03:00' },
  durationSec: 180,
  captions: { present: true, anchorY: 0.78, heightRatio: 0.055, charsPerLine: { p50: 14, p90: 18 }, lines: 1, box: false, reveal: 'word-highlight', emphasis: { rate: 0.18 } },
  cuts: { avgShotSec: 2.4, jumpCutsPerMin: 14, punchIn: { perMin: 3.1, scale: 1.12 } },
  audio: { speechLufs: -15.2, bgm: { present: true, relDb: -21, ducking: true, mood: 'lofi', bpm: 88 } },
  sfx: { perMin: 9, on: { cut: 0.2, captionIn: 0.1, emphasis: 0.55, section: 1 }, kinds: { pop: 0.5 } },
  speech: { charsPerMin: 380 },
};

describe('parseReferenceUrl', () => {
  it('accepts YouTube / TikTok links, upgrading http and bare hosts', () => {
    expect(parseReferenceUrl(' https://www.youtube.com/watch?v=x ')).toEqual({ ok: true, url: 'https://www.youtube.com/watch?v=x', platform: 'youtube' });
    expect(parseReferenceUrl('youtu.be/x')).toMatchObject({ ok: true, platform: 'youtube', url: 'https://youtu.be/x' });
    expect(parseReferenceUrl('http://m.youtube.com/shorts/x')).toMatchObject({ ok: true, url: 'https://m.youtube.com/shorts/x' });
    expect(parseReferenceUrl('https://www.tiktok.com/@a/video/1')).toMatchObject({ ok: true, platform: 'tiktok' });
    expect(parseReferenceUrl('https://vm.tiktok.com/ZM1/')).toMatchObject({ ok: true, platform: 'tiktok' });
    expect(parseReferenceUrl('HTTPS://WWW.YOUTUBE.COM/watch?v=x')).toMatchObject({ ok: true });
  });
  it('rejects empty, junk, other schemes, credentials and other sites', () => {
    expect(parseReferenceUrl('   ')).toEqual({ ok: false, error: 'empty' });
    expect(parseReferenceUrl('https://')).toEqual({ ok: false, error: 'invalid' });
    expect(parseReferenceUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'invalid' });
    expect(parseReferenceUrl('javascript:alert(1)')).toEqual({ ok: false, error: 'invalid' });
    expect(parseReferenceUrl('https://user:pw@youtube.com/x')).toEqual({ ok: false, error: 'invalid' });
    expect(parseReferenceUrl('https://vimeo.com/1')).toEqual({ ok: false, error: 'unsupported' });
    expect(parseReferenceUrl('https://youtube.com.evil.example/x')).toEqual({ ok: false, error: 'unsupported' });
  });
});

describe('allowedInReferenceWindow', () => {
  it('players and sign-in only, https only', () => {
    expect(allowedInReferenceWindow('https://www.youtube.com/watch?v=1')).toBe(true);
    expect(allowedInReferenceWindow('https://accounts.google.com/signin')).toBe(true);
    expect(allowedInReferenceWindow('https://www.tiktok.com/login')).toBe(true);
    expect(allowedInReferenceWindow('http://www.youtube.com/')).toBe(false);
    expect(allowedInReferenceWindow('https://evilyoutube.com/')).toBe(false);
    expect(allowedInReferenceWindow('https://example.com/')).toBe(false);
    expect(allowedInReferenceWindow('not a url')).toBe(false);
  });
});

describe('clock and range', () => {
  it('parseClock', () => {
    expect(parseClock('90')).toBe(90);
    expect(parseClock('90s')).toBe(90);
    expect(parseClock('1:30')).toBe(90);
    expect(parseClock('01:02:03')).toBe(3723);
    expect(parseClock('2.5')).toBe(2.5);
    expect(parseClock('')).toBeNull();
    expect(parseClock('1:75')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('-5')).toBeNull();
  });
  it('formatClock / formatRange', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(90.9)).toBe('01:30');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('00:00');
    expect(formatClock(Number.NaN)).toBe('00:00');
    expect(formatRange(DEFAULT_RANGE)).toBe('00:00-03:00');
  });
  it('normalizeRange: default, minimum, maximum, negative start', () => {
    expect(normalizeRange(undefined)).toEqual(DEFAULT_RANGE);
    expect(normalizeRange({ start: 30 })).toEqual({ start: 30, end: 210 });
    expect(normalizeRange({ start: 10, end: 12 })).toEqual({ start: 10, end: 10 + MIN_RANGE_SEC });
    expect(normalizeRange({ start: 50, end: 40 })).toEqual({ start: 50, end: 50 + MIN_RANGE_SEC });
    expect(normalizeRange({ start: 0, end: 5000 })).toEqual({ start: 0, end: MAX_RANGE_SEC });
    expect(normalizeRange({ start: -20, end: 60 })).toEqual({ start: 0, end: 60 });
    expect(normalizeRange({ start: Number.NaN, end: Number.POSITIVE_INFINITY })).toEqual(DEFAULT_RANGE);
  });
  it('normalizeRange: clamps to a known duration, keeping the length when possible', () => {
    expect(normalizeRange({ start: 0, end: 180 }, 100)).toEqual({ start: 0, end: 100 });
    expect(normalizeRange({ start: 90, end: 150 }, 120)).toEqual({ start: 60, end: 120 });
    expect(normalizeRange({ start: 0, end: 180 }, 0)).toEqual({ start: 0, end: 180 });
    expect(normalizeRange({ start: 0, end: 180 }, Number.NaN)).toEqual({ start: 0, end: 180 });
  });
});

describe('parsePlayerSample', () => {
  it('valid samples and junk', () => {
    expect(parsePlayerSample({ t: 1, paused: false, rate: 1, ended: false, duration: 300 })).toEqual({ t: 1, paused: false, rate: 1, ended: false, duration: 300 });
    expect(parsePlayerSample({ t: 1, rate: 1 })).toEqual({ t: 1, paused: false, rate: 1, ended: false });
    expect(parsePlayerSample({ t: 1, rate: 1, duration: Number.POSITIVE_INFINITY })).not.toHaveProperty('duration');
    expect(parsePlayerSample(null)).toBeNull();
    expect(parsePlayerSample({ t: '1', rate: 1 })).toBeNull();
    expect(parsePlayerSample({ t: Number.NaN, rate: 1 })).toBeNull();
    expect(parsePlayerSample({ t: 1 })).toBeNull();
  });
});

describe('captureStep', () => {
  const range = { start: 10, end: 40 };
  const play = (t: number, o: Partial<PlayerSample> = {}): PlayerSample => ({ t, paused: false, rate: 1, ended: false, ...o });
  const run = (samples: (PlayerSample | null)[], stepMs = 1000, start = initialCapture(range, 0)) => {
    let s: CaptureState = start;
    const actions: string[] = [];
    samples.forEach((x, i) => {
      const r = captureStep(s, x, (i + 1) * stepMs);
      s = r.state;
      if (r.action) actions.push(r.action);
    });
    return { s, actions };
  };

  it('waits before the range, starts inside, stops at the end', () => {
    const { s, actions } = run([play(5), play(9), play(10), ...Array.from({ length: 31 }, (_, i) => play(11 + i))]);
    expect(actions).toEqual(['start', 'stop']);
    expect(s.phase).toBe('done');
    expect(s.recorded).toBeCloseTo(30, 0);
  });
  it('hints: before / after / play / rate', () => {
    expect(captureStep(initialCapture(range, 0), play(2), 1).state.hint).toBe('before');
    expect(captureStep(initialCapture(range, 0), play(50), 1).state.hint).toBe('after');
    expect(captureStep(initialCapture(range, 0), play(20, { paused: true }), 1).state.hint).toBe('play');
    expect(captureStep(initialCapture(range, 0), play(20, { rate: 2 }), 1).state.hint).toBe('rate');
    expect(captureStep(initialCapture(range, 0), play(20, { rate: 2 }), 1).action).toBeNull();
  });
  it('pauses on pause / speed change / seek out, resumes when back', () => {
    const { actions, s } = run([play(10), play(11), play(12, { paused: true }), play(12), play(13), play(14, { rate: 1.5 }), play(15), play(5), play(12)]);
    expect(actions).toEqual(['start', 'pause', 'resume', 'pause', 'resume', 'pause', 'resume']);
    expect(s.phase).toBe('recording');
  });
  it('a seek forward is not counted as recorded time', () => {
    const { s } = run([play(10), play(11), play(30), play(31)]);
    expect(s.recorded).toBeCloseTo(2, 5);
  });
  it('the video ending stops the recording', () => {
    const { actions, s } = run([play(10), play(11), play(12, { ended: true })]);
    expect(actions).toEqual(['start', 'stop']);
    expect(s.phase).toBe('done');
  });
  it('done is final', () => {
    const done: CaptureState = { ...initialCapture(range, 0), phase: 'done' };
    expect(captureStep(done, play(20), 5)).toEqual({ state: done, action: null });
  });
  it('no readable player: waits the grace period, then records the range length by the clock', () => {
    let s = initialCapture(range, 0);
    let r = captureStep(s, null, NO_PLAYER_GRACE_MS - 1);
    expect(r.action).toBeNull();
    r = captureStep(r.state, null, NO_PLAYER_GRACE_MS);
    expect(r.action).toBe('start');
    expect(r.state.mode).toBe('clock');
    expect(r.state.hint).toBe('noPlayer');
    s = r.state;
    r = captureStep(s, null, NO_PLAYER_GRACE_MS + 10_000);
    expect(r.action).toBeNull();
    expect(r.state.recorded).toBeCloseTo(10);
    // a player sample in clock mode does not switch back
    r = captureStep(r.state, play(0), NO_PLAYER_GRACE_MS + 29_999);
    expect(r.action).toBeNull();
    r = captureStep(r.state, null, NO_PLAYER_GRACE_MS + 30_000);
    expect(r.action).toBe('stop');
    expect(r.state.recorded).toBe(30);
  });
  it('a missing sample while recording keeps the state', () => {
    const { s } = run([play(10), play(11)]);
    const r = captureStep(s, null, 10_000);
    expect(r.action).toBeNull();
    expect(r.state.phase).toBe('recording');
  });
});

describe('benchReducer', () => {
  const entry = { id: 'b', profilePath: '/x/b.json', title: 'b', mtimeMs: 0, profile: {} } as BenchEntry;
  it('the happy path: url → capture → analyze → result', () => {
    let s: BenchFlow = { step: 'idle' };
    s = benchReducer(s, { type: 'openUrl', url: 'https://youtu.be/x', platform: 'youtube' });
    expect(s.step).toBe('browsing');
    s = benchReducer(s, { type: 'startCapture' });
    expect(s.step).toBe('capturing');
    s = benchReducer(s, { type: 'openUrl', url: 'https://youtu.be/y', platform: 'youtube' });
    expect(s).toMatchObject({ step: 'capturing', url: 'https://youtu.be/x' });
    s = benchReducer(s, { type: 'analyze', label: 'a' });
    s = benchReducer(s, { type: 'progress', fraction: 0.5, label: 'b' });
    s = benchReducer(s, { type: 'progress', fraction: 0.3 });
    expect(s).toEqual({ step: 'analyzing', label: 'b', fraction: 0.5 });
    s = benchReducer(s, { type: 'progress', fraction: 7 });
    expect(s).toMatchObject({ fraction: 1 });
    s = benchReducer(s, { type: 'analyzed', entry });
    expect(s).toEqual({ step: 'result', entry });
  });
  it('ignores events out of place; fail and reset always apply', () => {
    expect(benchReducer({ step: 'idle' }, { type: 'startCapture' })).toEqual({ step: 'idle' });
    expect(benchReducer({ step: 'idle' }, { type: 'progress', fraction: 0.5 })).toEqual({ step: 'idle' });
    expect(benchReducer({ step: 'idle' }, { type: 'analyzed', entry })).toEqual({ step: 'idle' });
    const a: BenchFlow = { step: 'analyzing', label: '', fraction: 0.2 };
    expect(benchReducer(a, { type: 'analyze' })).toBe(a);
    expect(benchReducer(a, { type: 'progress', fraction: Number.NaN })).toMatchObject({ fraction: 0.2 });
    expect(benchReducer(a, { type: 'fail', message: 'x' })).toEqual({ step: 'error', message: 'x' });
    expect(benchReducer({ step: 'error', message: 'x' }, { type: 'reset' })).toEqual({ step: 'idle' });
    expect(benchReducer({ step: 'error', message: 'x' }, { type: 'openUrl', url: 'u', platform: 'tiktok' })).toMatchObject({ step: 'browsing' });
  });
});

describe('parseBenchProgress', () => {
  it('JSON progress lines only', () => {
    expect(parseBenchProgress('{"progress":{"task":"bench","fraction":0.25,"label":"字幕"}}')).toEqual({ fraction: 0.25, label: '字幕' });
    expect(parseBenchProgress('{"progress":{"fraction":2}}')).toEqual({ fraction: 1, label: '' });
    expect(parseBenchProgress('{"progress":{"task":"bench","fraction":0.4,"label":"効果音","stage":"sfx"}}')).toEqual({ fraction: 0.4, label: '効果音' });
    expect(parseBenchProgress('{"progress":{"fraction":"x"}}')).toBeNull();
    expect(parseBenchProgress('{"ok":true}')).toBeNull();
    expect(parseBenchProgress('{broken')).toBeNull();
    expect(parseBenchProgress('progress 50%')).toBeNull();
  });
});

describe('profiles: detection, titles, entries', () => {
  it('isStyleProfile', () => {
    expect(isStyleProfile(PROFILE)).toBe(true);
    expect(isStyleProfile({ cuts: {}, source: {} })).toBe(true);
    expect(isStyleProfile({ cuts: {} })).toBe(false);
    expect(isStyleProfile([])).toBe(false);
    expect(isStyleProfile(null)).toBe(false);
  });
  it('profileTitle: title, YouTube id, path, fallback', () => {
    expect(profileTitle({ title: ' My video ' }, 'f')).toBe('My video');
    expect(profileTitle({ source: { title: 'S' } }, 'f')).toBe('S');
    expect(profileTitle(PROFILE, 'f')).toBe('youtube.com abc123');
    expect(profileTitle({ source: { url: 'https://www.tiktok.com/@a/video/1/' } }, 'f')).toBe('tiktok.com/@a/video/1');
    expect(profileTitle({ source: { url: 'nope' } }, 'f')).toBe('f');
    expect(profileTitle(null, 'f')).toBe('f');
  });
  it('benchEntry', () => {
    const e = benchEntry(PROFILE, join('/h', 'benchmarks', 'bench_1.json'), 5)!;
    expect(e).toMatchObject({ id: 'bench_1', title: 'youtube.com abc123', url: PROFILE.source.url, platform: 'youtube', analyzed: '00:00-03:00', mtimeMs: 5 });
    expect(benchEntry({ x: 1 }, '/h/a.json', 0)).toBeNull();
    expect(benchEntry({ ...PROFILE, source: { analyzed: '2026-10-11T08:00:00.000Z' } }, '/h/a.json', 0)).not.toHaveProperty('analyzed');
  });
});

describe('summarizeProfile', () => {
  it('all rows in Japanese', () => {
    const rows = summarizeProfile(PROFILE, 'ja');
    expect(rows.map((r) => r.id)).toEqual(['cuts', 'captions', 'sfx', 'bgm', 'speech']);
    expect(rows[0]!.value).toBe('平均 2.4 秒、ジャンプカット 14 回/分');
    expect(rows[1]!.value).toBe('単語ごとに強調、1行 14 文字、上から 78%');
    expect(rows[2]!.value).toBe('9 回/分');
    expect(rows[3]!.value).toBe('あり（声より -21 dB、話す間は下げる、lofi、88 BPM）');
    expect(rows[4]!.value).toBe('380 文字/分');
  });
  it('English, and "none" for captions / BGM', () => {
    const rows = summarizeProfile({ captions: { present: false }, audio: { bgm: { present: false } }, cuts: { avgShotSec: 3 } }, 'en');
    expect(rows).toEqual([
      { id: 'cuts', label: 'Cut pace', value: '3 s per shot' },
      { id: 'captions', label: 'Captions', value: 'none' },
      { id: 'bgm', label: 'BGM', value: 'none' },
    ]);
  });
  it('missing / broken values are left out', () => {
    expect(summarizeProfile(null, 'ja')).toEqual([]);
    expect(summarizeProfile({ cuts: { avgShotSec: 0 }, sfx: { perMin: 'x' }, speech: { charsPerMin: -1 }, captions: {} }, 'ja')).toEqual([]);
    expect(summarizeProfile({ audio: { bgm: { present: true } } }, 'ja')).toEqual([{ id: 'bgm', label: 'BGM', value: 'あり' }]);
  });
});

describe('activeReference', () => {
  const g = { id: 'g', title: 'G', at: '' };
  const p = { id: 'p', title: 'P', at: '' };
  it('project wins over global', () => {
    expect(activeReference({ global: g, project: p })).toEqual({ ref: p, scope: 'project' });
    expect(activeReference({ global: g, project: null })).toEqual({ ref: g, scope: 'global' });
    expect(activeReference({ global: null, project: null })).toBeNull();
    expect(activeReference(undefined)).toBeNull();
  });
});

describe('IPC registry', () => {
  it('every bench channel is in the main registry', () => {
    for (const c of BENCH_INVOKE_CHANNELS) expect(INVOKE_CHANNELS).toContain(c);
    for (const c of BENCH_EVENT_CHANNELS) expect(EVENT_CHANNELS).toContain(c);
  });
});

// ---------- main side ----------

describe('benchmark service (files)', () => {
  let home: string;
  let dir: string;
  let proj: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'solocut-bench-test-'));
    dir = join(home, 'benchmarks');
    mkdirSync(dir, { recursive: true });
    proj = join(home, 'proj');
    mkdirSync(proj);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const save = (name: string, v: unknown) => writeFileSync(join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));

  it('lists flat and folder profiles newest first, skipping junk and applied.json', async () => {
    save('bench_1.json', PROFILE);
    save('broken.json', '{');
    save('other.json', { hello: 1 });
    save('applied.json', { global: { id: 'bench_1' } });
    save('notes.txt', 'x');
    save('bench_1.samples.json', { source: {}, samples: [], cuts: {} });
    mkdirSync(join(dir, 'ref_a'));
    writeFileSync(join(dir, 'ref_a', 'profile.json'), JSON.stringify({ ...PROFILE, title: 'A' }));
    const later = new Date(Date.now() + 5000);
    const { utimesSync } = await import('node:fs');
    utimesSync(join(dir, 'ref_a', 'profile.json'), later, later);
    const list = listProfiles(dir);
    expect(list.map((e) => e.id)).toEqual(['ref_a', 'bench_1']);
    expect(list[0]!.title).toBe('A');
    expect(listProfiles(join(home, 'nope'))).toEqual([]);
  });

  it('applied records: global and per project, broken files read as none', () => {
    expect(readApplied('global', undefined, dir)).toBeNull();
    expect(readApplied('project', proj, dir)).toBeNull();
    expect(readApplied('project', undefined, dir)).toBeNull();
    writeApplied('global', { id: 'g', title: 'G', at: 't' }, undefined, dir);
    writeApplied('project', { id: 'p', title: 'P', at: 't' }, proj, dir);
    expect(readApplied('global', undefined, dir)).toEqual({ id: 'g', title: 'G', at: 't' });
    expect(readApplied('project', proj, dir)).toEqual({ id: 'p', title: 'P', at: 't' });
    expect(JSON.parse(readFileSync(join(proj, '.solocut', 'benchmark.json'), 'utf8')).id).toBe('p');
    writeFileSync(join(dir, 'applied.json'), 'nope');
    expect(readApplied('global', undefined, dir)).toBeNull();
    expect(() => writeApplied('project', { id: 'p', title: 'P', at: '' }, undefined, dir)).toThrow();
    expect(benchState(proj, dir).applied.project?.id).toBe('p');
    expect(benchState(undefined, dir).applied.project).toBeNull();
  });

  it('parseApplied', () => {
    expect(parseApplied({ id: 'x' })).toEqual({ id: 'x', title: 'x', at: '' });
    expect(parseApplied({ id: '' })).toBeNull();
    expect(parseApplied('x')).toBeNull();
    expect(parseApplied(null)).toBeNull();
  });

  it('temp recordings: private folder, append, end, discard', async () => {
    const { id } = captureBegin(home);
    const f = captureFile(id);
    expect(f.startsWith(home)).toBe(true);
    expect(await captureAppend(id, new Uint8Array([1, 2, 3]))).toBe(3);
    expect(await captureAppend(id, new Uint8Array([4]))).toBe(4);
    expect(captureEnd(id)).toEqual({ bytes: 4 });
    expect(readFileSync(f)).toEqual(Buffer.from([1, 2, 3, 4]));
    captureDiscard(id);
    expect(existsSync(f)).toBe(false);
    expect(() => captureFile(id)).toThrow();
    await expect(captureAppend(id, new Uint8Array([1]))).rejects.toThrow();
    expect(() => captureDiscard('unknown')).not.toThrow();
  });

  it('analyzeArgs', () => {
    expect(analyzeArgs('/t/r.webm', {})).toEqual(['bench', 'analyze', '/t/r.webm']);
    expect(analyzeArgs('/t/r.webm', { url: 'https://youtu.be/x', range: { start: 30, end: 5000 } })).toEqual([
      'bench', 'analyze', '/t/r.webm', '--url', 'https://youtu.be/x', '--from', '30', '--to', '630',
    ]);
  });

  it('entryFromAnalyze: inline profile, profile from the file, bad output', () => {
    const path = join(dir, 'bench_9.json');
    expect(entryFromAnalyze({ id: 'bench_9', profilePath: path, profile: PROFILE })).toMatchObject({ id: 'bench_9', title: 'youtube.com abc123' });
    expect(entryFromAnalyze({ path }, () => PROFILE)).toMatchObject({ id: 'bench_9' });
    expect(entryFromAnalyze({ path: 'relative.json', profile: PROFILE })).toBeNull();
    expect(entryFromAnalyze({ path }, () => undefined)).toBeNull();
    expect(entryFromAnalyze(undefined)).toBeNull();
  });

  it('analyze: deletes the recording whether the CLI succeeds or fails, forwards progress', async () => {
    const out = join(dir, 'bench_x.json');
    const calls: string[][] = [];
    const ok: RunCli = async (args, o) => {
      calls.push(args);
      o.onLine?.('{"progress":{"task":"bench","fraction":0.5,"label":"cuts"}}', 'stderr');
      o.onLine?.('{"progress":{"fraction":0.9}}', 'stdout');
      return { ok: true, code: 0, stdout: '', stderr: '', data: { profilePath: out, profile: PROFILE } };
    };
    const progress: number[] = [];
    const { id } = captureBegin(home);
    const file = captureFile(id);
    await captureAppend(id, new Uint8Array([1]));
    const r = await analyze({ captureId: id, url: 'https://youtu.be/x', range: { start: 0, end: 60 } }, ok, (f) => progress.push(f));
    expect(r.ok).toBe(true);
    expect(r.entry!.profilePath).toBe(out);
    expect(calls[0]).toEqual(['bench', 'analyze', file, '--url', 'https://youtu.be/x', '--from', '0', '--to', '60']);
    expect(progress).toEqual([0.5]);
    expect(existsSync(file)).toBe(false);

    const fail: RunCli = async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: 'boom' });
    const c2 = captureBegin(home);
    const f2 = captureFile(c2.id);
    await captureAppend(c2.id, new Uint8Array([1]));
    expect(await analyze({ captureId: c2.id }, fail, () => undefined)).toEqual({ ok: false, error: 'boom' });
    expect(existsSync(f2)).toBe(false);

    const throws: RunCli = async () => {
      throw new Error('spawn');
    };
    const c3 = captureBegin(home);
    const f3 = captureFile(c3.id);
    await captureAppend(c3.id, new Uint8Array([1]));
    await expect(analyze({ captureId: c3.id }, throws, () => undefined)).rejects.toThrow('spawn');
    expect(existsSync(f3)).toBe(false);
  });

  it('analyze: a local file must exist and be absolute; a picked file is never deleted; no profile → error', async () => {
    const ok: RunCli = async () => ({ ok: true, code: 0, stdout: '', stderr: '', data: { nothing: true } });
    expect(await analyze({ file: 'rel.mp4' }, ok, () => undefined)).toEqual({ ok: false, error: 'file not found' });
    expect(await analyze({ file: join(home, 'missing.mp4') }, ok, () => undefined)).toEqual({ ok: false, error: 'file not found' });
    expect(await analyze({ file: home }, ok, () => undefined)).toEqual({ ok: false, error: 'file not found' });
    expect(await analyze({}, ok, () => undefined)).toEqual({ ok: false, error: 'file not found' });
    expect((await analyze({ captureId: 'nope' }, ok, () => undefined)).ok).toBe(false);
    const video = join(home, 'ref.mp4');
    writeFileSync(video, 'x');
    expect(await analyze({ file: video }, ok, () => undefined)).toEqual({ ok: false, error: 'bench analyze did not return a profile' });
    expect(existsSync(video)).toBe(true);
  });

  it('apply: scope decides the cwd, records the choice, validates input', async () => {
    save('bench_1.json', PROFILE);
    const seen: { args: string[]; cwd?: string }[] = [];
    const ok: RunCli = async (args, o) => {
      seen.push({ args, ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    const r1 = await apply({ id: 'bench_1', scope: 'project', projectDir: proj, template: 'tech' }, ok, dir);
    expect(r1.ok).toBe(true);
    expect(seen[0]).toEqual({ args: ['bench', 'apply', join(dir, 'bench_1.json'), '--template', 'tech'], cwd: proj });
    expect(r1.state!.applied.project!.id).toBe('bench_1');
    const r2 = await apply({ id: 'bench_1', scope: 'global', template: 'tech' }, ok, dir);
    expect(r2.ok).toBe(true);
    expect(seen[1]!.cwd).not.toBe(proj);
    expect(seen[1]!.args).toEqual(['bench', 'apply', join(dir, 'bench_1.json'), '--template', 'tech', '--global']);
    expect(readApplied('global', undefined, dir)!.id).toBe('bench_1');

    expect(await apply({ id: 'nope', scope: 'global', template: 'tech' }, ok, dir)).toMatchObject({ ok: false });
    expect(await apply({ id: 'bench_1', scope: 'project', template: 'tech' }, ok, dir)).toMatchObject({ ok: false });
    expect(await apply({ id: 'bench_1', scope: 'global', template: '../x' }, ok, dir)).toMatchObject({ ok: false });
    expect(seen).toHaveLength(2);

    const fail: RunCli = async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: 'nope' });
    rmSync(join(proj, '.solocut'), { recursive: true, force: true });
    expect(await apply({ id: 'bench_1', scope: 'project', projectDir: proj, template: 'tech' }, fail, dir)).toEqual({ ok: false, error: 'nope' });
    expect(readApplied('project', proj, dir)).toBeNull();
  });
  it('clearApplied: project file removed, global entry dropped (other keys kept), missing is fine', () => {
    expect(() => clearApplied('global', undefined, dir)).not.toThrow();
    expect(() => clearApplied('project', proj, dir)).not.toThrow();
    expect(() => clearApplied('project', undefined, dir)).not.toThrow();
    writeApplied('project', { id: 'p', title: 'P', at: '' }, proj, dir);
    clearApplied('project', proj, dir);
    expect(existsSync(join(proj, '.solocut', 'benchmark.json'))).toBe(false);
    writeApplied('global', { id: 'g', title: 'G', at: '' }, undefined, dir);
    clearApplied('global', undefined, dir);
    expect(existsSync(join(dir, 'applied.json'))).toBe(false);
    writeFileSync(join(dir, 'applied.json'), JSON.stringify({ global: { id: 'g' }, other: 1 }));
    clearApplied('global', undefined, dir);
    expect(JSON.parse(readFileSync(join(dir, 'applied.json'), 'utf8'))).toEqual({ other: 1 });
  });

  it('unapply: CLI args per scope, clears the record only on success, validates input', async () => {
    const seen: { args: string[]; cwd?: string }[] = [];
    const ok: RunCli = async (args, o) => {
      seen.push({ args, ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    writeApplied('project', { id: 'p', title: 'P', at: '' }, proj, dir);
    writeApplied('global', { id: 'g', title: 'G', at: '' }, undefined, dir);
    const r1 = await unapply({ scope: 'project', projectDir: proj, template: 'tech' }, ok, dir);
    expect(r1.ok).toBe(true);
    expect(seen[0]).toEqual({ args: ['bench', 'unapply', '--template', 'tech'], cwd: proj });
    expect(r1.state!.applied).toEqual({ project: null, global: { id: 'g', title: 'G', at: '' } });
    const r2 = await unapply({ scope: 'global', template: 'tech' }, ok, dir);
    expect(seen[1]!.args).toEqual(['bench', 'unapply', '--template', 'tech', '--global']);
    expect(r2.state!.applied.global).toBeNull();

    expect(await unapply({ scope: 'project', template: 'tech' }, ok, dir)).toMatchObject({ ok: false });
    expect(await unapply({ scope: 'global', template: 'Bad!' }, ok, dir)).toMatchObject({ ok: false });
    expect(seen).toHaveLength(2);

    writeApplied('global', { id: 'g', title: 'G', at: '' }, undefined, dir);
    const fail: RunCli = async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: 'unknown command' });
    expect(await unapply({ scope: 'global', template: 'tech' }, fail, dir)).toEqual({ ok: false, error: 'unknown command' });
    expect(readApplied('global', undefined, dir)!.id).toBe('g');

    // nothing applied in the CLI's eyes: the app's stale record is dropped and the call succeeds
    const notApplied: RunCli = async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: 'nothing applied', data: { ok: false, error: { code: 'not-applied', message: 'x' } } });
    expect((await unapply({ scope: 'global', template: 'tech' }, notApplied, dir)).ok).toBe(true);
    expect(readApplied('global', undefined, dir)).toBeNull();
  });

  it('cliErrorCode', () => {
    expect(cliErrorCode({ ok: false, error: { code: 'not-applied', message: 'm' } })).toBe('not-applied');
    expect(cliErrorCode({ error: 'string' })).toBeUndefined();
    expect(cliErrorCode(undefined)).toBeUndefined();
    expect(cliErrorCode({ error: { code: 2 } })).toBeUndefined();
  });
});
