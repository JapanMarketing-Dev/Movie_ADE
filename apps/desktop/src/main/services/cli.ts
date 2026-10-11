// Runs the bundled `solocut` CLI with Electron's Node so the CLI stays the single source of truth for
// project operations. Every call adds --json and parses the result.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { CliResult } from '../../shared/types';
import { parseCliJson } from '../../shared/project';
import { cliBinDir, cliScript, templatesDir } from '../paths';
import { prependPath } from '../../shared/terminal';
import { delimiter } from 'node:path';
import { secretEnv } from './secrets';
import { appPath } from '../shellPath';

export function cliAvailable(): boolean {
  return existsSync(cliScript());
}

/** Environment shared by CLI child processes and agent terminals. */
export function solocutEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (process.platform === 'win32') delete env.Path; // one PATH key only
  return {
    ...env,
    // the login shell's PATH (Finder-launched apps get a short one) so the CLI finds claude / codex / ffmpeg
    PATH: prependPath(cliBinDir(), appPath(), delimiter),
    SOLOCUT_ELECTRON: process.execPath,
    SOLOCUT_TEMPLATES_DIR: base.SOLOCUT_TEMPLATES_DIR ?? templatesDir(),
    SOLOCUT_APP: '1',
    ...secretEnv(),
  };
}

export function runCli<T = unknown>(
  args: string[],
  o: { cwd?: string; timeoutMs?: number; json?: boolean; onLine?: (line: string, stream: 'stdout' | 'stderr') => void } = {},
): Promise<CliResult<T>> {
  const script = cliScript();
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, code: null, stdout: '', stderr: '', error: `solocut CLI not found at ${script}` });
  }
  const full = o.json === false || args.includes('--json') ? args : [...args, '--json'];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...full], {
      cwd: o.cwd,
      env: { ...solocutEnv(), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const lines = (stream: 'stdout' | 'stderr') => {
      let rest = '';
      return (d: string) => {
        if (stream === 'stdout') stdout += d;
        else stderr += d;
        if (!o.onLine) return;
        rest += d;
        const parts = rest.split(/\r?\n|\r/);
        rest = parts.pop() ?? '';
        for (const l of parts) if (l.trim()) o.onLine(l, stream);
      };
    };
    child.stdout.setEncoding('utf8').on('data', lines('stdout'));
    child.stderr.setEncoding('utf8').on('data', lines('stderr'));
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const data = parseCliJson(stdout) as T | undefined;
      const r: CliResult<T> = { ok: code === 0, code, stdout, stderr };
      if (data !== undefined) r.data = data;
      if (code !== 0) r.error = firstLine(stderr) || firstLine(stdout) || `solocut exited with ${code}`;
      resolve(r);
    });
  });
}

function firstLine(s: string): string {
  const errObj = parseCliJson(s);
  if (errObj && typeof errObj === 'object' && 'error' in errObj) {
    const e = (errObj as { error: unknown }).error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  }
  return s.trim().split(/\r?\n/)[0] ?? '';
}
