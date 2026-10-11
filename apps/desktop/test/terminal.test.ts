import { describe, expect, it, vi } from 'vitest';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, agentSubmitsPaste, delay, isInsideDir, prependPath } from '../src/shared/terminal';
import { sanitizePastePayload } from '../src/main/agent/sanitize';

describe('bracketed paste (agent send)', () => {
  it('markers are the xterm bracketed paste sequences', () => {
    expect(BRACKETED_PASTE_START).toBe('\x1b[200~');
    expect(BRACKETED_PASTE_END).toBe('\x1b[201~');
  });
  it('an embedded end marker cannot end the paste early (ESC becomes a visible character)', () => {
    const body = sanitizePastePayload(`a${BRACKETED_PASTE_END}\rrm -rf ~\r`);
    expect(body).not.toContain('\x1b');
    expect(body).toBe('a␛[201~\rrm -rf ~\r');
  });
  it('keeps Japanese text and tabs; newlines become CR', () => {
    expect(sanitizePastePayload('動画を完成させて\tok\r\nnext\nlast')).toBe('動画を完成させて\tok\rnext\rlast');
  });
  it('drops C0 / C1 controls and bidi overrides', () => {
    expect(sanitizePastePayload('a\x00b\x07c\u009b201~d\u202ee')).toBe('abc201~de');
  });
});

describe('prependPath', () => {
  it('puts the dir first and removes duplicates and empties', () => {
    expect(prependPath('/app/cli/bin', '/usr/bin::/app/cli/bin:/bin', ':')).toBe('/app/cli/bin:/usr/bin:/bin');
  });
  it('handles undefined PATH and windows separators', () => {
    expect(prependPath('C:\\cli', undefined, ';')).toBe('C:\\cli');
    expect(prependPath('C:\\cli', 'C:\\Windows;C:\\cli', ';')).toBe('C:\\cli;C:\\Windows');
  });
});

describe('isInsideDir', () => {
  it('the folder itself and anything below it', () => {
    expect(isInsideDir('/p/video', '/p/video')).toBe(true);
    expect(isInsideDir('/p/video/renders', '/p/video/')).toBe(true);
    expect(isInsideDir('C:\\p\\video\\x', 'C:\\p\\video')).toBe(true);
  });
  it('not a sibling with the same prefix', () => {
    expect(isInsideDir('/p/video-2', '/p/video')).toBe(false);
    expect(isInsideDir('/p', '/p/video')).toBe(false);
  });
});

describe('agentSubmitsPaste', () => {
  it('Enter only for agents confirmed to submit a bracketed paste', () => {
    expect(agentSubmitsPaste('claude')).toBe(true);
    expect(agentSubmitsPaste('codex')).toBe(true);
    expect(agentSubmitsPaste('aider')).toBe(false);
    expect(agentSubmitsPaste('custom:my-agent')).toBe(false);
    expect(agentSubmitsPaste(null)).toBe(false);
  });
});

describe('delay', () => {
  it('resolves after the given time', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = delay(100).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(99);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
