import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cursor = { x: 1640 + 400, y: -100 + 200 };
vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
      { id: 2, bounds: { x: 1440, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 },
    ],
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }),
    getCursorScreenPoint: () => cursor,
  },
}));

const { startCursorLog, stopCursorLog } = await import('../src/main/services/cursor');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solocut-cursor-'));
});
afterEach(() => {
  stopCursorLog('t');
  rmSync(dir, { recursive: true, force: true });
});

const lines = () =>
  readFileSync(join(dir, 'cursor.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { x: number; y: number });

describe('cursor log with a recording region', () => {
  it('normalizes to the region and records it in the info', async () => {
    const region = { displayId: '2', x: 200, y: 100, width: 800, height: 400 };
    const info = startCursorLog('t', dir, 'screen:2:0', Date.now(), region);
    expect(info.region).toEqual(region);
    expect(info.bounds).toEqual({ x: 1640, y: -100, width: 800, height: 400 });
    expect(info.displayId).toBe('2');
    await new Promise((r) => setTimeout(r, 120));
    stopCursorLog('t');
    expect(lines()[0]).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it('whole display without a region', () => {
    const info = startCursorLog('t', dir, 'screen:2:0', Date.now(), null);
    expect(info.region).toBeUndefined();
    expect(info.bounds).toEqual({ x: 1440, y: -200, width: 1920, height: 1080 });
  });

  it('ignores a region of another display or a malformed one', () => {
    expect(startCursorLog('t', dir, 'screen:2:0', Date.now(), { displayId: '1', x: 0, y: 0, width: 100, height: 100 }).region).toBeUndefined();
    expect(startCursorLog('t', dir, 'screen:2:0', Date.now(), { displayId: '2', x: 'a' }).region).toBeUndefined();
    expect(startCursorLog('t', dir, 'screen:2:0', Date.now(), 'all').bounds.width).toBe(1920);
  });

  it('ignores the region when a window (not a display) is captured', () => {
    const info = startCursorLog('t', dir, 'window:123:0', Date.now(), { displayId: '1', x: 0, y: 0, width: 200, height: 200 });
    expect(info.region).toBeUndefined();
    expect(info.window).toBe(true);
  });

  it('clips a region larger than the display', () => {
    const info = startCursorLog('t', dir, 'screen:1:0', Date.now(), { displayId: '1', x: 0, y: 100, width: 5000, height: 5000 });
    expect(info.region).toEqual({ displayId: '1', x: 0, y: 100, width: 2880, height: 1700 });
    expect(info.bounds).toEqual({ x: 0, y: 50, width: 1440, height: 850 });
  });
});
