// Pure helpers for the agent terminals: prompt paste formatting and the working/waiting heuristic.
import type { AgentActivity } from './types';

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
/** Delay between the bracketed paste and the Enter that submits it. */
export const SUBMIT_DELAY_MS = 50;

/**
 * Wraps text in a bracketed paste. Newlines become CR (what a terminal sends when pasting), and any paste
 * markers or other escape sequences inside the text are removed so the paste cannot end early or inject keys.
 */
export function bracketedPaste(text: string): string {
  const clean = text
    .replace(/\r\n?/g, '\n')
    // strip ESC and C1 control introducers; keep tabs and newlines
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '')
    .replace(/\n/g, '\r');
  return PASTE_START + clean + PASTE_END;
}

/** The two writes that paste a prompt and submit it: [paste, enter]. Enter is sent SUBMIT_DELAY_MS later. */
export function promptWrites(text: string): [string, string] {
  return [bracketedPaste(text.replace(/\s+$/, '')), '\r'];
}

/** Strips ANSI escape sequences so heuristics can look at visible text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[0-Z\\-_]/g, ''); // other 2-byte escapes (Fp, Fe)
}

export interface ActivityTracker {
  lastOutputAt: number;
  lastInputAt: number;
  started: boolean;
  exited: boolean;
}

export const WORKING_WINDOW_MS = 1500;
/** Output right after the user typed is usually just echo; ignore it for "working". */
export const ECHO_WINDOW_MS = 250;

export function newTracker(): ActivityTracker {
  return { lastOutputAt: 0, lastInputAt: 0, started: false, exited: false };
}

/** Records output; returns true when the output counts as agent activity (not just echo of keystrokes). */
export function noteOutput(t: ActivityTracker, data: string, now: number): boolean {
  if (stripAnsi(data).trim().length === 0 && !/\x1b\[\?2026[hl]|\x1b\[[0-9;]*[HJK]/.test(data)) return false;
  t.started = true;
  if (now - t.lastInputAt < ECHO_WINDOW_MS && data.length < 64) return false;
  t.lastOutputAt = now;
  return true;
}

export function noteInput(t: ActivityTracker, now: number): void {
  t.lastInputAt = now;
}

/** working = produced output recently; waiting = quiet (most agents are then showing a prompt). */
export function activityOf(t: ActivityTracker, now: number): AgentActivity {
  if (t.exited) return 'exited';
  if (!t.started) return 'starting';
  return now - t.lastOutputAt < WORKING_WINDOW_MS ? 'working' : 'waiting';
}

/** Prepends a directory to a PATH value without duplicating it. */
export function prependPath(dir: string, current: string | undefined, sep: string): string {
  const parts = (current ?? '').split(sep).filter((p) => p.length > 0 && p !== dir);
  return [dir, ...parts].join(sep);
}
