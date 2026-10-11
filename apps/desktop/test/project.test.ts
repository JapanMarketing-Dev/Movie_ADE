import { describe, expect, it } from 'vitest';
import { formatFrames, isUnknownOpError, isVariant, previewCandidates, stepsForVariant, variantArgs, variantTarget, variantTimelinePath, parseCliJson, parseNext, parseSteps, progressOf, reviewOps, stepMark, timelineOverview } from '../src/shared/project';

const decidedReview = { by: 'decision-model', reason: 'mid-word cut', confidence: 0.55, needsReview: true };

const timeline = {
  schema: 1,
  meta: { title: 'Demo' },
  canvas: { width: 1920, height: 1080, fps: { num: 30000, den: 1001 } },
  segments: [
    { id: 'seg_1', range: { start: 0, end: 90 }, text: 'hello world', role: 'hook', decided: { by: 'agent', reason: 'keep' } },
    { id: 'seg_2', range: { start: 90, end: 300 }, text: 'x'.repeat(100), role: 'explain', decided: decidedReview },
  ],
  captions: [
    { id: 'cap_1', range: { start: 0, end: 45 }, text: 'こんにちは', decided: { by: 'rule', reason: 'r' } },
    { id: 'cap_2', range: { start: 45, end: 90 }, text: '世界', decided: { ...decidedReview } },
  ],
  scenes: [{ id: 'scn_1', pattern: { id: 'title-card', version: '1' }, range: { start: 0, end: 60 }, slots: {}, decided: decidedReview }],
  audio: { sfx: [{ id: 'sfx_1', at: 100, trigger: 'emphasis', asset: 'a', decided: decidedReview }] },
  markers: [{ kind: 'chapter', at: 0, label: 'Intro' }, { kind: 'ng', at: 400 }],
  review: {
    openItems: [
      { ref: 'seg_2', kind: 'decision', summary: 'dup' },
      { ref: 'chk_1', kind: 'check', summary: 'loudness -16 LUFS' },
    ],
    lastCheck: { run: 'chk_1', passed: 9, failed: 1, needsHuman: 2, at: '2026-10-11T00:00:00Z' },
  },
};

describe('parseSteps / parseNext', () => {
  it('accepts arrays and wrapped forms; drops junk; normalizes unknown states', () => {
    const arr = [{ step: 'ingest', state: 'done', at: 't' }, { step: 'sync', state: 'weird' }, { nope: 1 }, null, { id: 'captions', state: 'running', note: 'n' }];
    const s = parseSteps(arr);
    expect(s.map((x) => x.step)).toEqual(['ingest', 'sync', 'captions']);
    expect(s[1]!.state).toBe('todo');
    expect(s[2]!.note).toBe('n');
    expect(parseSteps({ steps: arr })).toHaveLength(3);
    expect(parseSteps({ status: arr })).toHaveLength(3);
    expect(parseSteps('x')).toEqual([]);
    expect(parseSteps(undefined)).toEqual([]);
  });
  it('parseNext handles direct and wrapped shapes', () => {
    const n = parseNext({ step: 'captions', state: 'needs-human', why: 'w', do: 'd', commands: ['solocut captions build', 3], blocking: ['sync'] });
    expect(n).toEqual({ step: 'captions', state: 'needs-human', why: 'w', do: 'd', commands: ['solocut captions build'], blocking: ['sync'] });
    expect(parseNext({ next: { step: 'done', state: 'done' } })?.state).toBe('done');
    expect(parseNext({ step: 'x', state: '??' })?.state).toBe('ready');
    expect(parseNext({})).toBeUndefined();
    expect(parseNext(null)).toBeUndefined();
  });
  it('stepMark and progressOf', () => {
    expect(['done', 'running', 'needs-human', 'skipped', 'todo'].map((state) => stepMark({ step: 's', state } as never))).toEqual(['✓', '●', '!', '–', '·']);
    expect(progressOf([])).toBe(0);
    expect(progressOf(parseSteps([{ step: 'a', state: 'done' }, { step: 'b', state: 'skipped' }, { step: 'c', state: 'todo' }, { step: 'd', state: 'running' }]))).toBe(0.5);
  });
});

describe('parseCliJson', () => {
  it('parses whole output or the last JSON line', () => {
    expect(parseCliJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseCliJson('progress 10%\nprogress 90%\n{"ok":true}\n')).toEqual({ ok: true });
    expect(parseCliJson('[1,2]')).toEqual([1, 2]);
    expect(parseCliJson('')).toBeUndefined();
    expect(parseCliJson('no json here\n{broken')).toBeUndefined();
  });
});

describe('timelineOverview', () => {
  const ov = timelineOverview(timeline);
  it('builds lanes with frame ranges and labels', () => {
    expect(ov.title).toBe('Demo');
    expect(ov.fpsNum).toBe(30000);
    expect(ov.fpsDen).toBe(1001);
    expect(ov.lanes.segments.map((s) => [s.id, s.start, s.end])).toEqual([['seg_1', 0, 90], ['seg_2', 90, 300]]);
    expect(ov.lanes.segments[1]!.label.length).toBeLessThanOrEqual(40);
    expect(ov.lanes.scenes[0]!.label).toBe('title-card');
    expect(ov.lanes.sfx[0]).toMatchObject({ start: 100, end: 101 });
    expect(ov.lanes.markers).toHaveLength(2);
    expect(ov.durationFrames).toBe(401);
  });
  it('collects needs-review items and open items without duplicates', () => {
    expect(ov.review.map((r) => `${r.lane}:${r.id}`)).toEqual(['segments:seg_2', 'captions:cap_2', 'scenes:scn_1', 'sfx:sfx_1', 'open:chk_1']);
    expect(ov.review[0]).toMatchObject({ confidence: 0.55, by: 'decision-model', reason: 'mid-word cut' });
    expect(ov.lastCheck).toEqual({ passed: 9, failed: 1, needsHuman: 2, at: '2026-10-11T00:00:00Z' });
  });
  it('survives empty or garbage input', () => {
    for (const bad of [null, undefined, 1, 'x', [], { segments: 'no', captions: [1, null, { range: {} }], audio: null }]) {
      const o = timelineOverview(bad);
      expect(o.durationFrames).toBe(0);
      expect(o.review).toEqual([]);
      expect(o.fpsNum).toBe(30);
    }
  });
});

describe('reviewOps (setDecided)', () => {
  const item = (lane: string, id: string) => ({ id, lane, label: '' }) as never;
  it('accept is a single setDecided keeping earlier decided fields', () => {
    const a = reviewOps(timeline, item('captions', 'cap_2'), 'accept');
    expect(a).toEqual([{ op: 'setDecided', target: 'cap_2', decided: { ...decidedReview, by: 'human', reason: 'accepted in review', needsReview: false } }]);
    const s = reviewOps(timeline, item('segments', 'seg_2'), 'accept');
    expect(s.map((o) => o.op)).toEqual(['setDecided', 'setReview']);
  });
  it('reject still removes', () => {
    expect(reviewOps(timeline, item('sfx', 'sfx_1'), 'reject').map((o) => o.op)).toEqual(['removeSfx']);
    expect(reviewOps(timeline, item('segments', 'seg_2'), 'reject')[0]).toMatchObject({ op: 'removeSegment', id: 'seg_2' });
  });
  it('detects unknown-op errors for the legacy fallback', () => {
    expect(isUnknownOpError({ code: 'invalid-op', message: 'unknown op setDecided' })).toBe(true);
    expect(isUnknownOpError('ops[0].op: Invalid input (setDecided)')).toBe(true);
    expect(isUnknownOpError({ code: 'not-found', message: 'seg_9 not found' })).toBe(false);
  });
});

describe('reviewOps (legacy)', () => {
  const item = (lane: string, id: string) => ({ id, lane, label: '' }) as never;
  const reviewOpsL = (t: unknown, i: never, d: 'accept' | 'reject') => reviewOps(t, i, d, 'legacy');
  it('segment accept keeps it and marks human decision; reject removes it; both clear the open item', () => {
    const a = reviewOpsL(timeline, item('segments', 'seg_2'), 'accept');
    expect(a[0]).toMatchObject({ op: 'trimSegment', id: 'seg_2', decided: { by: 'human', needsReview: false } });
    expect(a[1]).toEqual({ op: 'setReview', patch: { openItems: [{ ref: 'chk_1', kind: 'check', summary: 'loudness -16 LUFS' }] } });
    const r = reviewOpsL(timeline, item('segments', 'seg_2'), 'reject');
    expect(r[0]).toMatchObject({ op: 'removeSegment', id: 'seg_2', decided: { by: 'human' } });
  });
  it('caption accept patches decided; reject rewrites captions without it', () => {
    const a = reviewOpsL(timeline, item('captions', 'cap_2'), 'accept');
    expect(a).toEqual([{ op: 'updateCaption', id: 'cap_2', patch: { decided: { ...decidedReview, by: 'human', reason: 'accepted in review', needsReview: false } } }]);
    const r = reviewOpsL(timeline, item('captions', 'cap_2'), 'reject');
    expect(r[0]).toMatchObject({ op: 'setCaptions' });
    expect((r[0] as unknown as { captions: { id: string }[] }).captions.map((c) => c.id)).toEqual(['cap_1']);
  });
  it('scene and sfx accept re-add with human decision; reject only removes', () => {
    const a = reviewOpsL(timeline, item('scenes', 'scn_1'), 'accept');
    expect(a.map((o) => o.op)).toEqual(['removeScene', 'addScene']);
    expect((a[1] as unknown as { scene: { decided: { needsReview: boolean } } }).scene.decided.needsReview).toBe(false);
    expect(reviewOpsL(timeline, item('sfx', 'sfx_1'), 'reject').map((o) => o.op)).toEqual(['removeSfx']);
  });
  it('does nothing for unknown ids; open items are only dropped', () => {
    expect(reviewOpsL(timeline, item('segments', 'seg_x'), 'accept')).toEqual([]);
    expect(reviewOpsL({}, item('captions', 'cap_1'), 'reject')).toEqual([]);
    expect(reviewOpsL(timeline, item('open', 'chk_1'), 'accept')).toEqual([{ op: 'setReview', patch: { openItems: [{ ref: 'seg_2', kind: 'decision', summary: 'dup' }] } }]);
  });
  it('does not mutate the input timeline', () => {
    const before = JSON.stringify(timeline);
    reviewOpsL(timeline, item('captions', 'cap_2'), 'reject');
    reviewOpsL(timeline, item('scenes', 'scn_1'), 'accept');
    expect(JSON.stringify(timeline)).toBe(before);
  });
});

describe('formatFrames', () => {
  it('formats at integer and NTSC rates', () => {
    expect(formatFrames(0, 30, 1)).toBe('00:00:00');
    expect(formatFrames(29, 30, 1)).toBe('00:00:29');
    expect(formatFrames(30 * 61 + 5, 30, 1)).toBe('01:01:05');
    expect(formatFrames(30 * 3600, 30, 1)).toBe('01:00:00:00');
    expect(formatFrames(30000, 30000, 1001)).toBe('16:41:00'); // 30000 frames at 29.97 fps = 1001 s
  });
});

describe('variants (docs/18)', () => {
  const steps = parseSteps([
    { step: 'ingest', state: 'done' },
    { step: 'check', state: 'running' },
    { step: 'derive:tiktok', state: 'done' },
    { step: 'check:tiktok', state: 'needs-human' },
    { step: 'derive:youtube-shorts', state: 'todo' },
    { step: 'final:youtube-shorts', state: 'todo' },
    { step: 'publish', state: 'todo' },
  ]);
  it('main shows plain steps; a variant shows its own steps without the suffix', () => {
    expect(stepsForVariant(steps, 'main').map((s) => s.step)).toEqual(['ingest', 'check', 'publish']);
    expect(stepsForVariant(steps, 'tiktok')).toEqual([{ step: 'derive', state: 'done' }, { step: 'check', state: 'needs-human' }]);
    expect(stepsForVariant(steps, 'youtube-shorts').map((s) => s.step)).toEqual(['derive', 'final']);
  });
  it('paths and flags', () => {
    expect(variantTimelinePath('main')).toBe('timeline.json');
    expect(variantTimelinePath('tiktok')).toBe('variants/tiktok/timeline.json');
    expect(variantArgs('main')).toEqual([]);
    expect(variantArgs(undefined)).toEqual([]);
    expect(variantArgs('youtube-shorts')).toEqual(['--variant', 'youtube-shorts']);
    expect(previewCandidates('main')[0]).toBe('renders/preview.mp4');
    expect(previewCandidates('tiktok')[0]).toBe('renders/tiktok/preview.mp4');
    expect(variantTarget('main')).toBe('youtube');
    expect(variantTarget('tiktok')).toBe('tiktok');
    expect(['main', 'tiktok', 'youtube-shorts', 'shorts', '', null].map(isVariant)).toEqual([true, true, true, false, false, false]);
  });
});
