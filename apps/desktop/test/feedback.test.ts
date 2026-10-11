import { describe, expect, it } from 'vitest';
import { boxFrom, contentRect, feedbackAgentMessage, frameAt, normalizePoint, parseFeedbackImport, renumber, simplifyStroke } from '../src/shared/feedback';
import { parseCandidates, parseImages } from '../src/main/services/thumbs';

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

describe('feedback import results', () => {
  it('parses items and defaults', () => {
    const r = parseFeedbackImport({
      ok: true,
      id: 'fb_1',
      items: [
        { n: 1, frame: 120, timecode: '00:00:04:00', image: 'feedback/fb_1/01.png', spoken: '字幕が顔に', request: '字幕を下げる', targets: [{ kind: 'caption', id: 'cap_3', label: 'x' }, 'seg_2', { bad: 1 }] },
        { frame: 3, text: 'from text' },
        null,
      ],
    });
    expect(r?.dir).toBe('feedback/fb_1');
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]?.targets).toEqual([{ kind: 'caption', id: 'cap_3', label: 'x' }, { kind: 'seg', id: 'seg_2' }]);
    expect(r?.items[1]).toMatchObject({ n: 2, request: 'from text', spoken: '', targets: [] });
    expect(parseFeedbackImport({ feedback: { id: 'x', dir: 'feedback/x', items: [] } })?.dir).toBe('feedback/x');
    expect(parseFeedbackImport({ ok: true })).toBeNull();
  });
  it('renumbers after deletion and builds the agent line', () => {
    expect(renumber([{ n: 3 } as never, { n: 7 } as never]).map((x) => x.n)).toEqual([1, 2]);
    expect(feedbackAgentMessage('feedback/fb_1/', 'en')).toBe('Read feedback/fb_1/feedback.md and fix each item. Then run solocut render --preview and solocut check.');
    expect(feedbackAgentMessage('feedback/fb_1', 'ja')).toContain('feedback/fb_1/feedback.md を読んで');
  });
});

describe('thumbnail CLI output', () => {
  it('parses candidates with project-relative paths', () => {
    const c = parseCandidates('/p', { candidates: [{ frame: 10, timecode: '00:00:00:10', image: 'renders/thumbnails/c1.png', score: 0.9 }, { frame: 'x' }, { image: '/abs/c2.png', frame: 20 }] });
    expect(c).toEqual([{ frame: 10, timecode: '00:00:00:10', image: '/p/renders/thumbnails/c1.png', score: 0.9 }, { frame: 20, timecode: '', image: '/abs/c2.png' }]);
    expect(parseCandidates('/p', null)).toEqual([]);
  });
  it('parses generated images (strings or objects)', () => {
    const imgs = parseImages('/nonexistent-project', { images: ['renders/thumbnails/a.png', { path: '/x/b.jpg', provider: 'codex' }, 5] });
    expect(imgs).toEqual([{ path: '/nonexistent-project/renders/thumbnails/a.png', favorite: false }, { path: '/x/b.jpg', favorite: false, provider: 'codex' }]);
  });
});
