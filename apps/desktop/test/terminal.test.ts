import { describe, expect, it } from 'vitest';
import {
  ECHO_WINDOW_MS,
  PASTE_END,
  PASTE_START,
  WORKING_WINDOW_MS,
  activityOf,
  bracketedPaste,
  newTracker,
  noteInput,
  noteOutput,
  prependPath,
  promptWrites,
  stripAnsi,
} from '../src/shared/terminal';

describe('bracketedPaste', () => {
  it('wraps text in paste markers and converts newlines to CR', () => {
    expect(bracketedPaste('a\nb\r\nc\rd')).toBe(`${PASTE_START}a\rb\rc\rd${PASTE_END}`);
  });
  it('keeps unicode and tabs', () => {
    expect(bracketedPaste('動画を完成させて\tok')).toBe(`${PASTE_START}動画を完成させて\tok${PASTE_END}`);
  });
  it('cannot be terminated early by an embedded end marker', () => {
    const out = bracketedPaste(`x${PASTE_END}rm -rf ~\ny`);
    expect(out.indexOf(PASTE_END)).toBe(out.length - PASTE_END.length);
    expect(out.startsWith(PASTE_START)).toBe(true);
  });
  it('strips escape and control characters', () => {
    const out = bracketedPaste('a\x1b[31mred\x07\x00\x9bz');
    expect(out).toBe(`${PASTE_START}a[31mredz${PASTE_END}`);
  });
  it('handles empty text', () => {
    expect(bracketedPaste('')).toBe(PASTE_START + PASTE_END);
  });
});

describe('promptWrites', () => {
  it('returns the paste (trailing whitespace trimmed) and a separate Enter', () => {
    const [paste, enter] = promptWrites('hello\n\n  ');
    expect(paste).toBe(`${PASTE_START}hello${PASTE_END}`);
    expect(enter).toBe('\r');
  });
});

describe('stripAnsi', () => {
  it('removes CSI, OSC and 2-byte escapes', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;title\x07done\x1b=')).toBe('ok done');
  });
});

describe('activity heuristic', () => {
  it('starts as starting, then working on output, then waiting when quiet', () => {
    const t = newTracker();
    expect(activityOf(t, 0)).toBe('starting');
    expect(noteOutput(t, 'Thinking…', 1000)).toBe(true);
    expect(activityOf(t, 1000 + WORKING_WINDOW_MS - 1)).toBe('working');
    expect(activityOf(t, 1000 + WORKING_WINDOW_MS)).toBe('waiting');
  });
  it('ignores pure whitespace and short echoes right after typing', () => {
    const t = newTracker();
    noteOutput(t, 'boot', 0);
    expect(noteOutput(t, '   \r\n', 5000)).toBe(false);
    noteInput(t, 10_000);
    expect(noteOutput(t, 'a', 10_000 + ECHO_WINDOW_MS - 1)).toBe(false);
    expect(activityOf(t, 10_100)).toBe('waiting');
    expect(noteOutput(t, 'a long answer from the agent that is clearly not an echo of a keystroke', 10_100)).toBe(true);
    expect(activityOf(t, 10_200)).toBe('working');
  });
  it('counts screen redraw sequences as activity (spinners)', () => {
    const t = newTracker();
    noteOutput(t, 'x', 0);
    expect(noteOutput(t, '\x1b[2K\x1b[1G', 5000)).toBe(true);
  });
  it('reports exited', () => {
    const t = newTracker();
    t.exited = true;
    expect(activityOf(t, 0)).toBe('exited');
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
