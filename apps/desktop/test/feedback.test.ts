import { describe, expect, it } from 'vitest';
import { applyItemEdits, boxFrom, boxPoints, contentRect, feedbackAgentMessage, feedbackMarkdown, frameAt, normalizePoint, parseFeedbackShow, renumber, simplifyStroke } from '../src/shared/feedback';

describe('feedback geometry and time', () => {
  it('frame at a preview time', () => {
    expect(frameAt(0, 30, 1)).toBe(0);
    expect(frameAt(1.5, 30, 1)).toBe(45);
    expect(frameAt(10, 30000, 1001)).toBe(300);
    expect(frameAt(-1, 30, 1)).toBe(0);
    expect(frameAt(Number.NaN, 30, 1)).toBe(0);
  });
  it('content rect for object-fit: contain (pillar and letter boxes)', () => {
    expect(contentRect(1000, 1000, 1920, 1080)).toEqual({ x: 0, y: 218.75, w: 1000, h: 562.5 });
    expect(contentRect(1600, 900, 1080, 1920)).toEqual({ x: 546.875, y: 0, w: 506.25, h: 900 });
    expect(contentRect(100, 100, 0, 0)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
  it('normalizes and clamps points; boxes from any corner order', () => {
    const r = { x: 0, y: 218.75, w: 1000, h: 562.5 };
    expect(normalizePoint(500, 500, r)).toEqual([0.5, 0.5]);
    expect(normalizePoint(-10, 0, r)).toEqual([0, 0]);
    expect(normalizePoint(2000, 2000, r)).toEqual([1, 1]);
    expect(boxFrom([0.6, 0.7], [0.2, 0.1])).toEqual({ x: 0.2, y: 0.1, w: expect.closeTo(0.4, 10), h: expect.closeTo(0.6, 10) });
  });
  it('simplifies strokes but keeps endpoints', () => {
    const pts: [number, number][] = [[0, 0], [0.0001, 0], [0.0002, 0], [0.1, 0.1], [0.1001, 0.1]];
    expect(simplifyStroke(pts)).toEqual([[0, 0], [0.1, 0.1], [0.1001, 0.1]]);
    expect(simplifyStroke([[0, 0]])).toEqual([[0, 0]]);
  });
});

describe('feedback show results (CLI items.json)', () => {
  const show = {
    ok: true,
    id: 'fb_1',
    markdown: '# …',
    items: [
      { index: 1, atMs: 2000, frame: 120, speech: '字幕が顔にかぶってる', strokes: [], notes: ['下げる'], targets: [{ kind: 'caption', id: 'cap_3', label: 'この設定' }, 'seg_2', { bad: 1 }], title: '字幕が顔に重なる', request: '字幕を下げる' },
      { index: 2, atMs: 9000, frame: 300, speech: 'ここ長い', strokes: [], notes: [], targets: [] },
      null,
    ],
  };
  it('maps index/speech/title/request and derives image paths', () => {
    const r = parseFeedbackShow(show, (f) => `tc${f}`);
    expect(r?.dir).toBe('feedback/fb_1');
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]).toMatchObject({ n: 1, frame: 120, timecode: 'tc120', spoken: '字幕が顔にかぶってる', title: '字幕が顔に重なる', request: '字幕を下げる', notes: ['下げる'], image: 'feedback/fb_1/01.png' });
    expect(r?.items[0]?.targets).toEqual([{ kind: 'caption', id: 'cap_3', label: 'この設定' }, { kind: 'seg', id: 'seg_2' }]);
    expect(r?.items[1]).toMatchObject({ n: 2, request: '', image: 'feedback/fb_1/02.png' });
    expect(parseFeedbackShow({ feedback: { id: 'x', items: [] } })?.dir).toBe('feedback/x');
    expect(parseFeedbackShow({ ok: true })).toBeNull();
  });
  it('applies edits to raw items: keeps unknown fields, drops deleted, renumbers', () => {
    const items = parseFeedbackShow(show)!.items;
    const edited = applyItemEdits(show.items as unknown[], [{ ...items[1]!, request: '詰める' }]);
    expect(edited).toEqual([{ ...show.items[1], index: 1, request: '詰める' }]);
    expect(applyItemEdits([], items)).toEqual([]);
  });
  it('fallback markdown lists request, speech, notes, image and targets', () => {
    const md = feedbackMarkdown('fb_1', parseFeedbackShow(show, () => '00:00:04:00')!.items, 'ja');
    expect(md).toContain('## 1. [00:00:04:00] 字幕が顔に重なる');
    expect(md).toContain('- 要望: 字幕を下げる');
    expect(md).toContain('- 発話（原文）: 「字幕が顔にかぶってる」');
    expect(md).toContain('- 画像: ./01.png');
    expect(md).toContain('caption cap_3（この設定）');
  });
  it('box outline is a closed stroke; renumber; agent line', () => {
    expect(boxPoints({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual([[0.1, 0.2], [0.4, 0.2], [0.4, expect.closeTo(0.6, 10)], [0.1, expect.closeTo(0.6, 10)], [0.1, 0.2]]);
    expect(renumber([{ n: 3 } as never, { n: 7 } as never]).map((x) => x.n)).toEqual([1, 2]);
    expect(feedbackAgentMessage('feedback/fb_1/', 'en')).toBe('Read feedback/fb_1/feedback.md and fix each item. Then run solocut render --preview and solocut check.');
    expect(feedbackAgentMessage('feedback/fb_1', 'ja')).toContain('feedback/fb_1/feedback.md を読んで');
  });
});
