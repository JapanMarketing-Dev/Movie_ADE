// When updates are checked (src/main/update/loop.ts). Scenarios ported from Ferret test/unit/auto-update.test.ts
// (MIT): first check / interval, wake from sleep (FERRET-1N), stale focus checks, one check at a time; plus Solocut's
// network backoff and busy postponing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_RETRY_MS, CHECK_DELAY_MS, CHECK_INTERVAL_MS, NETWORK_BACKOFF_MS, RESUME_DELAY_MS, networkBackoffMs } from '../src/main/update/logic';
import { UpdateLoop, type CheckOutcome } from '../src/main/update/loop';

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

function make(o: { enabled?: boolean; outcomes?: CheckOutcome[]; busy?: () => boolean } = {}) {
  const outcomes = [...(o.outcomes ?? [])];
  const run = vi.fn(async (): Promise<CheckOutcome> => outcomes.shift() ?? 'ok');
  const schedule: Array<number | null> = [];
  const loop = new UpdateLoop({
    enabled: o.enabled ?? true,
    run,
    isBusy: o.busy ?? (() => false),
    onSchedule: (at) => schedule.push(at),
    now: () => Date.now(),
  });
  return { loop, run, schedule };
}

describe('schedule', () => {
  it('first check a little after start, then every interval', async () => {
    const { loop, run, schedule } = make();
    loop.start();
    expect(schedule.at(-1)).toBe(Date.now() + CHECK_DELAY_MS);
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS - 1);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('does nothing in the background when disabled (dev build, updates.auto off)', async () => {
    const { loop, run } = make({ enabled: false });
    loop.start();
    loop.resumed();
    expect(loop.checkIfStale(0)).toBeNull();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
    // the user's own check still works
    await loop.checkNow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('stop cancels the timer and later wakes / focus do nothing', async () => {
    const { loop, run, schedule } = make();
    loop.start();
    loop.stop();
    expect(schedule.at(-1)).toBeNull();
    loop.resumed();
    expect(loop.checkIfStale(0)).toBeNull();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('wake from sleep (FERRET-1N)', () => {
  it('waits for the network before checking, then resumes the interval', async () => {
    const { loop, run } = make();
    loop.start();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    loop.resumed();
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('focus checks are skipped while waiting after a wake', async () => {
    const { loop, run } = make();
    loop.start();
    loop.resumed();
    expect(loop.checkIfStale(0)).toBeNull();
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('stale focus checks', () => {
  it('checks when never checked or older than maxAge, otherwise not', async () => {
    const { loop, run } = make();
    loop.start();
    await loop.checkIfStale(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.checkIfStale(60_000)).toBeNull();
    vi.setSystemTime(Date.now() + 60_000);
    await loop.checkIfStale(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(loop.lastCheckedAt()).toBe(Date.now());
  });
  it('not while recording / rendering', () => {
    const { loop, run } = make({ busy: () => true });
    loop.start();
    expect(loop.checkIfStale(0)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('one check at a time', () => {
  it('a second request joins the running check', async () => {
    let release!: (o: CheckOutcome) => void;
    const run = vi.fn(() => new Promise<CheckOutcome>((r) => (release = r)));
    const loop = new UpdateLoop({ enabled: true, run, isBusy: () => false });
    const a = loop.checkNow();
    const b = loop.checkNow();
    expect(a === b).toBe(true);
    release('ok');
    expect(await a).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    await loop.checkNow();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('a throwing run is an error outcome, not a rejection', async () => {
    const loop = new UpdateLoop({ enabled: true, run: () => Promise.reject(new Error('x')), isBusy: () => false });
    expect(await loop.checkNow()).toBe('error');
  });
});

describe('network backoff', () => {
  it('retries sooner after network failures (1 min, 5 min, 15 min, 1 h), back to the interval on success', async () => {
    const { loop, run } = make({ outcomes: ['network-error', 'network-error', 'network-error', 'network-error', 'network-error', 'ok'] });
    loop.start();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    const steps = [NETWORK_BACKOFF_MS[0], NETWORK_BACKOFF_MS[1], NETWORK_BACKOFF_MS[2], NETWORK_BACKOFF_MS[3], NETWORK_BACKOFF_MS[3]];
    for (const [i, ms] of steps.entries()) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(run).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(i + 2);
    }
    // the 6th check succeeded: next one waits the full interval
    await vi.advanceTimersByTimeAsync(NETWORK_BACKOFF_MS[0]);
    expect(run).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(7);
  });
  it('other errors wait the normal interval (retrying will not fix a bad signature)', async () => {
    const { loop, run } = make({ outcomes: ['error'] });
    loop.start();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    await vi.advanceTimersByTimeAsync(NETWORK_BACKOFF_MS[3]);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('networkBackoffMs clamps to the table and the interval', () => {
    expect(networkBackoffMs(0)).toBe(NETWORK_BACKOFF_MS[0]);
    expect(networkBackoffMs(1)).toBe(NETWORK_BACKOFF_MS[0]);
    expect(networkBackoffMs(99)).toBe(NETWORK_BACKOFF_MS[3]);
    expect(networkBackoffMs(99)).toBeLessThanOrEqual(CHECK_INTERVAL_MS);
  });
});

describe('busy (recording / rendering)', () => {
  it('a scheduled check is postponed until the take ends', async () => {
    let busy = true;
    const { loop, run } = make({ busy: () => busy });
    loop.start();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    expect(run).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("the user's own check is not postponed", async () => {
    const { loop, run } = make({ busy: () => true });
    await loop.checkNow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
