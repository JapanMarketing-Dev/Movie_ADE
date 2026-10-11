import { describe, expect, it } from 'vitest';
import { contextTimeToPerfMs } from '../src/shared/audioClock';

describe('contextTimeToPerfMs', () => {
  it('uses the output timestamp when the context is running', () => {
    expect(contextTimeToPerfMs(2, { contextTime: 2.5, performanceTime: 135_000 }, 135_100, 2.6)).toBe(134_500);
  });
  it('falls back to currentTime + performance.now() before the first output ({0, 0})', () => {
    // the bug: {0,0} gave -10.67 ms
    expect(contextTimeToPerfMs(0.010667, { contextTime: 0, performanceTime: 0 }, 134_848, 0.021333)).toBeCloseTo(134_837.33, 1);
  });
  it('falls back when the timestamp is missing or partial', () => {
    for (const ts of [undefined, null, {}, { contextTime: 1 }, { performanceTime: 5 }, { contextTime: Number.NaN, performanceTime: 1 }]) {
      expect(contextTimeToPerfMs(1, ts, 10_000, 1.5)).toBe(9_500);
    }
  });
  it('ignores a mapping in the future or before zero', () => {
    expect(contextTimeToPerfMs(1, { contextTime: 0.5, performanceTime: 20_000 }, 10_000, 1.2)).toBe(9_800);
    expect(contextTimeToPerfMs(0, { contextTime: 5, performanceTime: 100 }, 10_000, 0.1)).toBe(9_900);
  });
  it('clamps clock jitter (currentTime slightly behind t)', () => {
    expect(contextTimeToPerfMs(1.003, null, 10_000, 1)).toBe(10_000);
  });
  it('undefined when nothing usable', () => {
    expect(contextTimeToPerfMs(Number.NaN, null, 10_000, 1)).toBeUndefined();
    expect(contextTimeToPerfMs(1, null, Number.NaN, 1)).toBeUndefined();
    expect(contextTimeToPerfMs(0, null, 100, 5)).toBeUndefined(); // would be before the page existed
  });
  it('is on the same clock as video firstFrameMs (within a few ms in the reported take)', () => {
    const video = 134_864.9;
    const audio = contextTimeToPerfMs(0, { contextTime: 0, performanceTime: 0 }, 134_870, 0.008)!;
    expect(Math.abs(audio - video)).toBeLessThan(50);
  });
});
