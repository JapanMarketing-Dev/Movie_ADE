// Types and small pure helpers shared by main's TerminalManager, the renderer's TerminalPane and the tests.
// Parts ported from Ferret src/shared/bracketedPaste.ts, src/shared/delay.ts, src/shared/sendTarget.ts and the
// Terminal* types of src/shared/types.ts (MIT).

/** Bracketed paste start / end. Newlines inside reach a TUI (Claude Code, …) as text, not as Enter. */
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** Wait ms milliseconds (main and renderer). */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, ms));
}

/** Prepends a directory to a PATH value without duplicating it. */
export function prependPath(dir: string, current: string | undefined, sep: string): string {
  const parts = (current ?? '').split(sep).filter((p) => p.length > 0 && p !== dir);
  return [dir, ...parts].join(sep);
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalCreateOptions {
  size: TerminalSize;
  /** Folder to start in; defaults to the open project. */
  cwd?: string | null;
  /** Agent id (catalog id or custom:<name>) to start at the shell's first prompt. */
  agent?: string | null;
  /** One command line to run at the first prompt ("Run in terminal", installers). */
  command?: string | null;
  /** With command: close the shell with the command's exit code (installers; the result arrives as terminal:exit). */
  exitWhenDone?: boolean;
  /** Tab title; defaults to the agent label or "<n>: <shell>". */
  title?: string | null;
  /** Start the agent continuing its previous conversation (Claude Code --continue, Codex resume --last). */
  resume?: boolean;
}

export interface TerminalTabInfo {
  id: string;
  title: string;
  agent: string | null;
  cwd: string;
  resumed?: boolean;
}

export interface TerminalSessionInfo {
  id: string;
  pid: number;
  cwd: string;
  title: string;
  agent: string | null;
}

/** Returned when the renderer re-attaches to a live terminal after a reload. */
export interface TerminalAttachInfo extends TerminalSessionInfo {
  /** Recent raw output to replay into xterm. */
  history: string;
  /** Current PTY size (the history is wrapped at this width). */
  size: TerminalSize;
}

/** Detected state of the agent in a terminal (terminal:agentState). */
export interface AgentStateInfo {
  kind: 'claude-code' | 'codex' | 'generic' | 'unknown';
  state: 'idle' | 'working' | 'blocked' | 'unknown';
  agent: string | null;
}

/** Display state: done = finished while the tab was not being looked at. */
export type AgentTabState = 'working' | 'blocked' | 'done' | 'idle';

/** One terminal tab with its agent state (agent:state events, agent:tabs). */
export interface AgentTabInfo {
  tabId: string;
  /** Agent running in the foreground; null for a plain shell. */
  agentId: string | null;
  state: AgentTabState;
  title: string;
  cwd: string;
}

export interface AgentSendRequest {
  text: string;
  /** Focused terminal (tried first). */
  tabId?: string | null;
  /** Prefer a terminal running this agent. */
  agent?: string | null;
  /** Only terminals opened in this folder (or below). */
  projectDir?: string | null;
  /** Keep looking for an agent terminal this long (ms, max 30 s): the renderer just opened one. */
  waitMs?: number;
}

export interface AgentSendResult {
  ok: boolean;
  message: string;
  /** Enter was sent (false: pasted only; the user presses Enter). */
  submitted?: boolean;
  /** Terminal the text went to. */
  tabId?: string;
  /** No agent terminal was found (the renderer may start one and retry). */
  noAgent?: boolean;
}

/** Whether a terminal opened in cwd belongs to the project folder dir. */
export function isInsideDir(cwd: string, dir: string): boolean {
  const base = dir.replace(/[\\/]+$/, '');
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
}

/**
 * Agents confirmed to submit a bracketed paste on a separate Enter. Others (custom ones included) only get the
 * paste: an Enter into an unknown input box may send half the text or trigger something else.
 */
const SUBMITS_PASTE: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'cursor', 'copilot', 'opencode']);

export function agentSubmitsPaste(agent: string | null): boolean {
  return agent !== null && SUBMITS_PASTE.has(agent);
}
