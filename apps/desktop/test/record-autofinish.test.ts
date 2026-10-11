import { describe, expect, it, vi } from 'vitest';
import { agentFor, agentLabel, autoStartEnabled, decideAutoFinish, runAutoFinish, type AutoFinishDeps } from '../src/renderer/src/lib/autoFinish';
import { keepAvailable, mainCamera, recordingOrder, toggleCamera } from '../src/renderer/src/lib/cameras';

describe('autoStartEnabled', () => {
  it.each([
    [null, true],
    [undefined, true],
    [{}, true],
    [{ autopilot: null }, true],
    [{ autopilot: [] }, true],
    [{ autopilot: {} }, true],
    [{ autopilot: { autoStart: 'no' } }, true],
    [{ autopilot: { autoStart: 0 } }, true],
    [{ autopilot: { autoStart: true } }, true],
    [{ autopilot: { autoStart: false } }, false],
  ])('%j → %s', (s, want) => {
    expect(autoStartEnabled(s as Record<string, unknown> | null)).toBe(want);
  });
});

describe('agentFor / agentLabel', () => {
  it('default, empty and missing go to claude', () => {
    for (const a of ['default', '', '  ', undefined, null]) expect(agentFor(a)).toBe('claude');
  });
  it('keeps a named agent', () => {
    expect(agentFor('codex')).toBe('codex');
    expect(agentFor(' gemini ')).toBe('gemini');
  });
  it('labels', () => {
    expect(agentLabel('claude')).toBe('Claude Code');
    expect(agentLabel('codex')).toBe('Codex');
    expect(agentLabel('custom:my-bot')).toBe('my-bot');
    expect(agentLabel('aider')).toBe('aider');
  });
});

describe('decideAutoFinish', () => {
  it('sends for a new take', () => {
    expect(decideAutoFinish({ settings: {}, takeId: 't1', sent: new Set() })).toEqual({ send: true });
  });
  it('skips without a take', () => {
    expect(decideAutoFinish({ settings: {}, takeId: null, sent: new Set() })).toEqual({ send: false, reason: 'no-take' });
    expect(decideAutoFinish({ settings: {}, takeId: '', sent: new Set() })).toEqual({ send: false, reason: 'no-take' });
  });
  it('skips when turned off', () => {
    expect(decideAutoFinish({ settings: { autopilot: { autoStart: false } }, takeId: 't1', sent: new Set() })).toEqual({ send: false, reason: 'disabled' });
  });
  it('skips a take that was already sent', () => {
    expect(decideAutoFinish({ settings: {}, takeId: 't1', sent: new Set(['t1']) })).toEqual({ send: false, reason: 'already-sent' });
  });
});

function deps(over: Partial<AutoFinishDeps> = {}): AutoFinishDeps & { toasts: string[] } {
  const toasts: string[] = [];
  return {
    toasts,
    settings: () => ({}),
    render: vi.fn(async () => ({ text: '動画を完成させて', agent: 'default' })),
    send: vi.fn(async () => ({ ok: true, message: 'sent' })),
    toast: (m) => toasts.push(m),
    sent: new Set(),
    messages: { started: (a) => `編集を始めました（${a}）`, failed: (e) => `失敗: ${e}` },
    ...over,
  };
}

describe('runAutoFinish', () => {
  it('renders finish, sends it to claude with launch, and toasts', async () => {
    const d = deps();
    expect(await runAutoFinish('/p', 't1', d)).toBe('sent');
    expect(d.render).toHaveBeenCalledWith('/p');
    expect(d.send).toHaveBeenCalledWith('動画を完成させて', 'claude', '/p');
    expect(d.toasts).toEqual(['編集を始めました（Claude Code）']);
  });
  it('uses the agent the prompt names', async () => {
    const d = deps({ render: async () => ({ text: 'x', agent: 'codex' }) });
    await runAutoFinish('/p', 't1', d);
    expect(d.send).toHaveBeenCalledWith('x', 'codex', '/p');
    expect(d.toasts[0]).toContain('Codex');
  });
  it('never sends twice for the same take, even concurrently', async () => {
    const d = deps();
    const [a, b] = await Promise.all([runAutoFinish('/p', 't1', d), runAutoFinish('/p', 't1', d)]);
    expect([a, b].sort()).toEqual(['sent', 'skipped']);
    expect(await runAutoFinish('/p', 't1', d)).toBe('skipped');
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(await runAutoFinish('/p', 't2', d)).toBe('sent');
  });
  it('does nothing when autoStart is off', async () => {
    const d = deps({ settings: () => ({ autopilot: { autoStart: false } }) });
    expect(await runAutoFinish('/p', 't1', d)).toBe('skipped');
    expect(d.render).not.toHaveBeenCalled();
    expect(d.toasts).toEqual([]);
  });
  it('reports a failed send', async () => {
    const d = deps({ send: async () => ({ ok: false, message: 'no agent terminal' }) });
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed');
    expect(d.toasts).toEqual(['失敗: no agent terminal']);
  });
  it('reports a render error without throwing', async () => {
    const d = deps({ render: async () => Promise.reject(new Error('unknown prompt')) });
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed');
    expect(d.toasts).toEqual(['失敗: unknown prompt']);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('an empty prompt is a failure, not an empty send', async () => {
    const d = deps({ render: async () => ({ text: '   ' }) });
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed');
    expect(d.send).not.toHaveBeenCalled();
  });
  it('a send that throws is reported', async () => {
    const d = deps({ send: async () => Promise.reject('boom') });
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed');
    expect(d.toasts).toEqual(['失敗: boom']);
  });
});

describe('cameras', () => {
  it('main camera is the chosen one while selected, else the first', () => {
    expect(mainCamera(['a', 'b'], 'b')).toBe('b');
    expect(mainCamera(['a', 'b'], 'c')).toBe('a');
    expect(mainCamera(['a', 'b'], null)).toBe('a');
    expect(mainCamera([], 'a')).toBeNull();
  });
  it('records the main camera first', () => {
    expect(recordingOrder(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(recordingOrder(['a', 'b'], undefined)).toEqual(['a', 'b']);
    expect(recordingOrder(['a', 'a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(recordingOrder([], 'x')).toEqual([]);
  });
  it('toggles and drops unplugged cameras', () => {
    expect(toggleCamera(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleCamera(['a', 'b'], 'a')).toEqual(['b']);
    expect(keepAvailable(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    expect(keepAvailable(['a'], [])).toEqual([]);
  });
});
