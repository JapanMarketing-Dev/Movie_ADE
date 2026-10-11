// The handoff file (<project>/.solocut/handoff.md, docs/04 「切り替えと引き継ぎ」) and its sentences. Pure part
// plus a contained append.
//
// Ported from Ferret src/main/failover/handoff.ts (MIT).
//
// The handoff does not depend on the agent kind (conversation logs are per CLI / account and are not copied):
// - the agent itself writes the file; right before a switch an agent that can still respond is asked to update it
//   (updateRequest)
// - when it does not respond (stopped at its limit), Solocut appends what it knows: last request, feedback.md path,
//   changed files from git status
// - the next agent gets one line: why it took over + @solocut/agents handoffMessage(lang)
//   ("read .solocut/handoff.md and `solocut next --json`, then continue")
// Sentences follow the app language. Credentials are never included.
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { handoffMessage } from '@solocut/agents';
import type { Lang } from '../../shared/types';
import { msg } from '../accounts/messages';

/** relative to the project; matches handoffMessage() */
export const HANDOFF_RELATIVE_PATH = '.solocut/handoff.md';

export function handoffFilePath(projectDir: string): string {
  return join(projectDir, '.solocut', 'handoff.md');
}

/** longest last request kept */
const REQUEST_MAX_CHARS = 4000;
/** longest changed-file list */
const CHANGED_MAX = 200;

/** Sent to the current agent right before a switch: "update the handoff file". */
export function updateRequest(lang: Lang, path: string = HANDOFF_RELATIVE_PATH): string {
  return msg(lang, 'failover.handoff.updateRequest', { path });
}

export type HandoffReason = 'limit' | 'return' | 'switch';

/** Sent to the next agent: why it took over + "read the handoff file and `solocut next --json`, then continue". */
export function nextAgentPrompt(input: { lang: Lang; reason: HandoffReason; from: string; to: string }): string {
  const { lang } = input;
  const why =
    input.reason === 'switch'
      ? msg(lang, 'failover.handoff.readSwitch', { to: input.to })
      : input.reason === 'return'
        ? msg(lang, 'failover.handoff.readReturn', { from: input.from, to: input.to })
        : msg(lang, 'failover.handoff.readLimit', { from: input.from, to: input.to });
  return `${why}${lang === 'ja' ? '' : ' '}${handoffMessage(lang)}`;
}

/** feedback.md path inside an instruction (Solocut's feedback instructions name it). */
export function findFeedbackPath(text: string | null): string | null {
  if (!text) return null;
  const match = /(?:^|[\s"'`(])((?:[A-Za-z]:)?[^\s"'`()]*feedback\.md)\b/.exec(text);
  return match?.[1] ?? null;
}

/** Changed-file lines from `git status --porcelain`. */
export function changedFilesFrom(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim())
    .slice(0, CHANGED_MAX);
}

/**
 * The section Solocut appends when the agent could not update the file. fileExists false → starts with the title.
 * changedFiles null → git state unknown (not a git repository).
 */
export function solocutNote(input: {
  lang: Lang;
  time: string;
  agent: string;
  lastRequest: string | null;
  changedFiles: string[] | null;
  fileExists: boolean;
}): string {
  const { lang } = input;
  const lines: string[] = [];
  if (!input.fileExists) lines.push(`# ${msg(lang, 'failover.note.fileTitle')}`, '');
  lines.push(`## ${msg(lang, 'failover.note.title', { time: input.time })}`, '', msg(lang, 'failover.note.intro', { agent: input.agent }), '');
  const request = input.lastRequest?.trim().slice(0, REQUEST_MAX_CHARS);
  if (request) lines.push(msg(lang, 'failover.note.lastRequest'), '', ...request.split('\n').map((line) => `> ${line}`), '');
  const feedback = findFeedbackPath(input.lastRequest);
  if (feedback) lines.push(msg(lang, 'failover.note.feedback', { path: feedback }), '');
  if (input.changedFiles) {
    if (input.changedFiles.length === 0) lines.push(msg(lang, 'failover.note.noChanges'), '');
    else lines.push(msg(lang, 'failover.note.changed'), '', '```', ...input.changedFiles, '```', '');
  }
  return `${input.fileExists ? '\n' : ''}${lines.join('\n')}`;
}

/**
 * Appends to <project>/.solocut/handoff.md without following links: .solocut must be a real folder inside the
 * project (created when missing) and handoff.md must not be a symlink (O_NOFOLLOW where available, plus an lstat
 * check for Windows).
 */
export async function appendHandoffNote(projectDir: string, text: string): Promise<void> {
  const dir = join(projectDir, '.solocut');
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('.solocut is not a folder');
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
    await mkdir(dir);
  }
  const path = handoffFilePath(projectDir);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('handoff.md is a link');
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(path, flags, 0o644);
  try {
    await fh.appendFile(text, 'utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Takes the last request sent with Enter from terminal input (Solocut's "last request" note). A bracketed paste
 * counts as one. Arrow and other key sequences are dropped. Kept in memory only, never logged.
 */
export class LastInputTracker {
  private line = '';
  private pasting = false;
  private last: string | null = null;

  push(data: string): void {
    let i = 0;
    while (i < data.length) {
      if (data.startsWith('\x1b[200~', i)) {
        this.pasting = true;
        i += 6;
        continue;
      }
      if (data.startsWith('\x1b[201~', i)) {
        this.pasting = false;
        i += 6;
        continue;
      }
      const ch = data[i]!;
      if (ch === '\x1b') {
        // arrows, function keys … (ESC [ … final byte)
        const match = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i));
        i += match?.[0].length || 1;
        continue;
      }
      if (this.pasting) {
        this.line += ch === '\r' ? '\n' : ch;
      } else if (ch === '\r' || ch === '\n') {
        this.commit();
      } else if (ch === '\x7f' || ch === '\b') {
        this.line = this.line.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {
        // Ctrl+C / Ctrl+U drop the half-typed line
        this.line = '';
      } else if (ch >= ' ') {
        this.line += ch;
      }
      i++;
      if (this.line.length > REQUEST_MAX_CHARS * 2) this.line = this.line.slice(-REQUEST_MAX_CHARS * 2);
    }
  }

  /** an instruction Solocut sent to the agent (overrides what arrived as input) */
  record(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.last = trimmed;
    this.line = '';
  }

  private commit(): void {
    const trimmed = this.line.trim();
    this.line = '';
    // 1–2 characters (y / n, menu numbers) and slash commands are not requests
    if (trimmed.length >= 3 && !trimmed.startsWith('/')) this.last = trimmed;
  }

  lastRequest(): string | null {
    return this.last;
  }
}
