// When a ready update restarts the app (src/main/update/policy.ts): never mid-take, never while an agent works,
// by itself only when the user is away, otherwise offered; the user's request waits for idle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_RESTART_MS, RESTART_POLL_MS, RestartWatch, agentBlocksRestart, restartDecision, type UpdateActivity } from '../src/main/update/policy';

const idle: UpdateActivity = { recording: false, agentsBusy: 0, userIdleMs: 0 };
const away: UpdateActivity = { ...idle, userIdleMs: AWAY_RESTART_MS };

describe('restartDecision', () => {
  it('nothing ready → none, whatever else', () => {
    expect(restartDecision({ ready: false, auto: true, requested: true, activity: away })).toEqual({ kind: 'none' });
  });
  it('recording always waits, even when requested or away', () => {
    expect(restartDecision({ ready: true, auto: true, requested: true, activity: { ...away, recording: true } })).toEqual({ kind: 'wait', reason: 'recording' });
  });
  it('recording wins over a working agent', () => {
    expect(restartDecision({ ready: true, auto: true, requested: false, activity: { ...idle, recording: true, agentsBusy: 2 } })).toEqual({ kind: 'wait', reason: 'recording' });
  });
  it('a working agent waits, even when requested', () => {
    expect(restartDecision({ ready: true, auto: true, requested: true, activity: { ...idle, agentsBusy: 1 } })).toEqual({ kind: 'wait', reason: 'agent' });
  });
  it('requested and idle → restart (also with background updates off)', () => {
    expect(restartDecision({ ready: true, auto: false, requested: true, activity: idle })).toEqual({ kind: 'restart' });
  });
  it('user at the computer → offer only', () => {
    expect(restartDecision({ ready: true, auto: true, requested: false, activity: { ...idle, userIdleMs: AWAY_RESTART_MS - 1 } })).toEqual({ kind: 'offer' });
  });
  it('user away exactly the threshold → restart by itself', () => {
    expect(restartDecision({ ready: true, auto: true, requested: false, activity: away })).toEqual({ kind: 'restart' });
  });
  it('away but background updates off → offer only', () => {
    expect(restartDecision({ ready: true, auto: false, requested: false, activity: away })).toEqual({ kind: 'offer' });
  });
  it('broken idle time is not "away"', () => {
    for (const userIdleMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(restartDecision({ ready: true, auto: true, requested: false, activity: { ...idle, userIdleMs } })).toEqual({ kind: 'offer' });
    }
  });
});

describe('agentBlocksRestart', () => {
  it('working and blocked (waiting for an answer) block; done / idle / unknown do not', () => {
    expect(agentBlocksRestart('working')).toBe(true);
    expect(agentBlocksRestart('blocked')).toBe(true);
    expect(agentBlocksRestart('done')).toBe(false);
    expect(agentBlocksRestart('idle')).toBe(false);
    expect(agentBlocksRestart('')).toBe(false);
  });
});

describe('RestartWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(o: { ready?: boolean; auto?: boolean; activity?: () => UpdateActivity } = {}) {
    const state = { ready: o.ready ?? true, activity: o.activity ?? (() => idle) };
    const restart = vi.fn();
    const waiting: Array<string | undefined> = [];
    const w = new RestartWatch({
      ready: () => state.ready,
      auto: () => o.auto ?? true,
      activity: () => state.activity(),
      onWaiting: (r) => waiting.push(r),
      restart,
    });
    return { w, restart, waiting, state };
  }

  it('offers while the user is here; restarts on the next look once the user is away', async () => {
    let a = idle;
    const { w, restart } = make({ activity: () => a });
    w.start();
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS);
    expect(restart).not.toHaveBeenCalled();
    a = away;
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS - 1);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('restarts only once, and stops looking', async () => {
    const { w, restart } = make({ activity: () => away });
    w.start();
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS * 5);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(w.evaluate()).toEqual({ kind: 'none' });
  });

  it('a request while recording waits, reports why, and restarts when the take ends', async () => {
    let a: UpdateActivity = { ...idle, recording: true };
    const { w, restart, waiting } = make({ activity: () => a, auto: false });
    w.start();
    expect(w.request()).toEqual({ kind: 'wait', reason: 'recording' });
    expect(w.isRequested()).toBe(true);
    expect(waiting.at(-1)).toBe('recording');
    a = { ...idle, agentsBusy: 1 };
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS);
    expect(waiting.at(-1)).toBe('agent');
    expect(restart).not.toHaveBeenCalled();
    a = idle;
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS);
    expect(waiting.at(-1)).toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('a request with idle app restarts at once', () => {
    const { w, restart } = make();
    expect(w.request()).toEqual({ kind: 'restart' });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('nothing ready: never restarts, even requested and away', async () => {
    const { w, restart } = make({ ready: false, activity: () => away });
    w.start();
    w.request();
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS * 3);
    expect(restart).not.toHaveBeenCalled();
  });

  it('activity that throws counts as busy', () => {
    const { w, restart, waiting } = make({
      activity: () => {
        throw new Error('no power monitor yet');
      },
    });
    expect(w.request().kind).toBe('wait');
    expect(waiting.at(-1)).toBe('recording');
    expect(restart).not.toHaveBeenCalled();
  });

  it('stop cancels the looks; start twice keeps one timer', async () => {
    const { w, restart, state } = make({ ready: false, activity: () => away });
    w.start();
    w.start();
    w.stop();
    state.ready = true;
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS * 3);
    expect(restart).not.toHaveBeenCalled();
  });
});
