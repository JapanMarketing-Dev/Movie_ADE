import { describe, expect, it } from 'vitest';
import { fractionToFrame, frameToFraction, itemAt, itemWidthPct, laneStats, rulerTicks, secondsToFrame } from '../src/renderer/src/screens/parts/timelineModel';
import { findingTitle, itemImagePath, parseFindings, shortTimecode } from '../src/renderer/src/screens/parts/findingsModel';
import { DEFAULT_LAYOUT, layoutFromObject, layoutToSettings, sameLayout, SIDEBAR_MAX } from '../src/renderer/src/shell/layout';
import type { FeedbackItem, LaneItem, TimelineOverview } from '../src/shared/types';

const li = (id: string, start: number, end: number, needsReview = false): LaneItem => ({ id, start, end, label: id, needsReview });

describe('timeline model', () => {
  it('makes round ruler ticks that fit', () => {
    expect(rulerTicks(0, 30)).toEqual([]);
    expect(rulerTicks(300, 0)).toEqual([]);
    expect(rulerTicks(300, 30, 0)).toEqual([]);
    const ten = rulerTicks(300, 30); // 10 s
    expect(ten.map((t) => t.label)).toEqual(['0:00', '0:02', '0:04', '0:06', '0:08']);
    expect(ten[1]!.frame).toBe(60);
    const long = rulerTicks(2 * 3600 * 30, 30);
    expect(long.length).toBeLessThanOrEqual(8);
    expect(long[1]!.label).toBe('15:00');
    const huge = rulerTicks(100 * 3600 * 30, 30);
    expect(huge.length).toBeLessThanOrEqual(9);
    expect(rulerTicks(300, 29.97).length).toBeGreaterThan(0);
  });
  it('converts between frames, fractions and seconds with clamping', () => {
    expect(frameToFraction(50, 100)).toBe(0.5);
    expect(frameToFraction(-5, 100)).toBe(0);
    expect(frameToFraction(500, 100)).toBe(1);
    expect(frameToFraction(5, 0)).toBe(0);
    expect(frameToFraction(Number.NaN, 100)).toBe(0);
    expect(fractionToFrame(0.333, 300)).toBe(100);
    expect(fractionToFrame(2, 300)).toBe(300);
    expect(fractionToFrame(-1, 300)).toBe(0);
    expect(fractionToFrame(0.5, 0)).toBe(0);
    expect(secondsToFrame(1, 30000, 1001)).toBe(30);
    expect(secondsToFrame(-1, 30, 1)).toBe(0);
    expect(secondsToFrame(Number.NaN, 30, 1)).toBe(0);
    expect(secondsToFrame(2, 30, 0)).toBe(60);
  });
  it('finds the item under a frame', () => {
    const items = [li('a', 0, 10), li('b', 8, 20), li('m', 30, 30)];
    expect(itemAt(items, 5)?.id).toBe('a');
    expect(itemAt(items, 9)?.id).toBe('b'); // later wins on overlap
    expect(itemAt(items, 25)).toBeNull();
    expect(itemAt(items, 31)).toBeNull();
    expect(itemAt(items, 31, 2)?.id).toBe('m');
    expect(itemAt([], 0)).toBeNull();
  });
  it('sizes items and counts lanes', () => {
    expect(itemWidthPct(li('a', 0, 50), 100, 'segments')).toBe('max(2px, 50.0000%)');
    expect(itemWidthPct(li('a', 50, 40), 100, 'captions')).toBe('max(2px, 0.0000%)');
    expect(itemWidthPct(li('a', 0, 50), 100, 'markers')).toBeUndefined();
    expect(itemWidthPct(li('a', 0, 50), 0, 'sfx')).toBe('max(2px, 0.0000%)');
    const ov: TimelineOverview = {
      title: 't',
      fpsNum: 30,
      fpsDen: 1,
      durationFrames: 100,
      lanes: { segments: [li('s', 0, 10, true), li('s2', 10, 20)], captions: [], scenes: [], sfx: [li('x', 0, 1)], markers: [] },
      review: [],
    };
    expect(laneStats(ov).map((s) => [s.lane, s.count, s.review])).toEqual([
      ['segments', 2, 1],
      ['captions', 0, 0],
      ['scenes', 0, 0],
      ['sfx', 1, 0],
      ['markers', 0, 0],
    ]);
  });
});

describe('findings model', () => {
  it('parses the view of feedback show, dropping malformed items', () => {
    const items = parseFindings({
      ok: true,
      view: [
        { n: 1, frame: 150, timecode: '00:00:05:00', image: 'feedback/fb_1/01.png', spoken: 'ここ暗い', request: '明るく', title: '明るさ', notes: ['n', 3], targets: [{ kind: 'segment', id: 'seg_1', label: 'intro' }, { kind: 1 }] },
        { n: 2, frame: 'x' },
        { frame: 3 },
        null,
        { n: 3, frame: 10 },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      n: 1,
      frame: 150,
      timecode: '00:00:05:00',
      image: 'feedback/fb_1/01.png',
      spoken: 'ここ暗い',
      request: '明るく',
      title: '明るさ',
      notes: ['n'],
      targets: [{ kind: 'segment', id: 'seg_1', label: 'intro' }],
    });
    expect(items[1]).toEqual({ n: 3, frame: 10, timecode: '', spoken: '', request: '', notes: [], targets: [] });
    expect(parseFindings(undefined)).toEqual([]);
    expect(parseFindings({ view: 'no' })).toEqual([]);
  });
  it('shortens timecodes', () => {
    expect(shortTimecode('00:00:05:12')).toBe('00:05');
    expect(shortTimecode('01:02:03:04')).toBe('01:02:03');
    expect(shortTimecode('02:03:04')).toBe('02:03');
    expect(shortTimecode('')).toBe('');
    expect(shortTimecode('weird')).toBe('weird');
  });
  it('resolves image paths and titles', () => {
    expect(itemImagePath('/p/demo/', 'feedback/fb/01.png')).toBe('/p/demo/feedback/fb/01.png');
    expect(itemImagePath('/p', '/abs/x.png')).toBe('/abs/x.png');
    expect(itemImagePath('C:\\p', 'C:\\abs\\x.png')).toBe('C:\\abs\\x.png');
    const base: FeedbackItem = { n: 1, frame: 0, timecode: '', spoken: '', request: '', notes: [], targets: [] };
    expect(findingTitle({ ...base, title: ' 見出し ' })).toBe('見出し');
    expect(findingTitle({ ...base, request: '一行目\n二行目' })).toBe('一行目');
    expect(findingTitle({ ...base, spoken: '話した' })).toBe('話した');
    expect(findingTitle(base)).toBe('');
  });
});

describe('layout ⇄ settings.json ui.layout', () => {
  it('reads settings objects defensively', () => {
    expect(layoutFromObject(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(layoutFromObject([])).toEqual(DEFAULT_LAYOUT);
    expect(layoutFromObject({ sidebar: false, sidebarWidth: 5000, terminalWidth: 400 })).toEqual({ ...DEFAULT_LAYOUT, sidebar: false, sidebarWidth: SIDEBAR_MAX });
    expect(layoutFromObject({ center: false, terminal: false })).toMatchObject({ center: true, terminal: false });
  });
  it('writes only schema keys and round-trips', () => {
    const s = { ...DEFAULT_LAYOUT, terminal: false, sidebarWidth: 300 };
    expect(layoutToSettings(s)).toEqual({ sidebar: true, center: true, terminal: false, sidebarWidth: 300 });
    expect(sameLayout(layoutFromObject(layoutToSettings(s)), s)).toBe(true);
    expect(sameLayout(s, { ...s, sidebar: false })).toBe(false);
  });
});
