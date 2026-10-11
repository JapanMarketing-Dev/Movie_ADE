// Agent terminals: node-pty processes running the user's shell in the project folder, with the bundled
// solocut CLI first on PATH. Output is batched to the renderer; a heuristic marks each tab working/waiting.
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { cliBinDir } from '../paths';
import type { AgentActivity, PtyInfo, PtySpawnOptions } from '../../shared/types';
import { activityOf, newTracker, noteInput, noteOutput, promptWrites, SUBMIT_DELAY_MS, type ActivityTracker } from '../../shared/terminal';
import { solocutEnv } from './cli';

interface Session {
  info: PtyInfo;
  pty: IPty;
  tracker: ActivityTracker;
  activity: AgentActivity;
  buf: string;
  flush: NodeJS.Timeout | null;
}

export interface PtyEvents {
  data(id: string, data: string): void;
  exit(id: string, code: number): void;
  activity(id: string, a: AgentActivity): void;
}

// Login shells rebuild PATH from the user's profile (path_helper, ~/.zprofile, …), which would push the bundled
// CLI back. These rc files load the user's own files first and then put SOLOCUT_CLI_BIN in front again.
const ZSH_RC = (name: string) => `ZDOTDIR="\${SOLOCUT_USER_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/${name}" ] && . "$ZDOTDIR/${name}"
${name === '.zlogin' ? 'if [ -n "$SOLOCUT_USER_ZDOTDIR" ]; then ZDOTDIR="$SOLOCUT_USER_ZDOTDIR"; else unset ZDOTDIR; fi' : 'ZDOTDIR="$SOLOCUT_ZDOTDIR"'}
[ -n "$SOLOCUT_CLI_BIN" ] && export PATH="$SOLOCUT_CLI_BIN:$PATH"
`;
const BASH_RC = `for f in /etc/profile ~/.bash_profile ~/.bash_login ~/.profile; do [ -r "$f" ] && . "$f" && [ "$f" != /etc/profile ] && break; done
[ -r ~/.bashrc ] && . ~/.bashrc
[ -n "$SOLOCUT_CLI_BIN" ] && export PATH="$SOLOCUT_CLI_BIN:$PATH"
`;

function integrationDir(): string {
  const dir = join(tmpdir(), `solocut-shell-${process.getuid?.() ?? 'u'}`);
  mkdirSync(dir, { recursive: true });
  for (const n of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(join(dir, n), ZSH_RC(n));
  writeFileSync(join(dir, 'bashrc'), BASH_RC);
  return dir;
}

function shellFor(env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = process.env.SOLOCUT_SHELL ?? 'powershell.exe';
    return { file: pwsh, args: ['-NoLogo'] };
  }
  const sh = process.env.SOLOCUT_SHELL ?? process.env.SHELL ?? (existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  try {
    const dir = integrationDir();
    if (basename(sh) === 'zsh') {
      if (env.ZDOTDIR) env.SOLOCUT_USER_ZDOTDIR = env.ZDOTDIR;
      env.SOLOCUT_ZDOTDIR = dir;
      env.ZDOTDIR = dir;
      return { file: sh, args: ['-l'] };
    }
    if (basename(sh) === 'bash') return { file: sh, args: ['--rcfile', join(dir, 'bashrc'), '-i'] };
  } catch {
    /* fall back to a plain login shell */
  }
  return { file: sh, args: ['-l'] };
}

export class PtyManager {
  private sessions = new Map<string, Session>();
  private ticker: NodeJS.Timeout;

  constructor(private ev: PtyEvents) {
    this.ticker = setInterval(() => this.tick(), 500);
    this.ticker.unref();
  }

  spawn(o: PtySpawnOptions & { title: string }): PtyInfo {
    const env = solocutEnv({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Solocut' });
    delete env.ELECTRON_RUN_AS_NODE;
    env.SOLOCUT_CLI_BIN = cliBinDir();
    const { file, args } = shellFor(env);
    const pty = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, o.cols),
      rows: Math.max(2, o.rows),
      cwd: existsSync(o.cwd) ? o.cwd : process.env.HOME,
      env: env as Record<string, string>,
    });
    const id = randomUUID();
    const info: PtyInfo = { id, title: o.title, pid: pty.pid };
    if (o.agentId) info.agentId = o.agentId;
    const s: Session = { info, pty, tracker: newTracker(), activity: 'starting', buf: '', flush: null };
    this.sessions.set(id, s);

    pty.onData((d) => {
      noteOutput(s.tracker, d, Date.now());
      s.buf += d;
      if (!s.flush) {
        s.flush = setTimeout(() => {
          s.flush = null;
          const chunk = s.buf;
          s.buf = '';
          if (chunk) this.ev.data(id, chunk);
        }, 8);
      }
    });
    pty.onExit(({ exitCode }) => {
      s.tracker.exited = true;
      if (s.buf) this.ev.data(id, s.buf);
      s.buf = '';
      this.setActivity(s, 'exited');
      this.ev.exit(id, exitCode);
      this.sessions.delete(id);
    });

    if (o.command) {
      // Run the agent inside the interactive shell so the tab survives the agent exiting.
      setTimeout(() => pty.write(`${o.command}\r`), 300);
    }
    return info;
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    noteInput(s.tracker, Date.now());
    s.pty.write(data);
  }

  /** Bracketed paste of a prompt, then Enter after SUBMIT_DELAY_MS. */
  paste(id: string, text: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const [paste, enter] = promptWrites(text);
    noteInput(s.tracker, Date.now());
    s.pty.write(paste);
    setTimeout(() => this.sessions.get(id)?.pty.write(enter), SUBMIT_DELAY_MS);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || cols < 2 || rows < 2) return;
    try {
      s.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      /* pty may have exited */
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.pty.kill();
    } catch {
      /* already gone */
    }
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
    clearInterval(this.ticker);
  }

  private setActivity(s: Session, a: AgentActivity): void {
    if (s.activity === a) return;
    s.activity = a;
    this.ev.activity(s.info.id, a);
  }

  private tick(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) this.setActivity(s, activityOf(s.tracker, now));
  }
}
