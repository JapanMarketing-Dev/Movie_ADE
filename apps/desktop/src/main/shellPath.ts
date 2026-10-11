// The PATH the app uses to find and run agent CLIs and the solocut CLI's helpers.
//
// Ported from Ferret src/main/agentDetection.ts (MIT).
// Orca由来: ~/bench/orca/src/main/preflight/agent-detection.ts (detectInstalledAgents),
//           ~/bench/orca/src/main/ipc/preflight-command-exec.ts (isCommandOnPath),
//           ~/bench/orca/src/shared/tui-agent-detection-commands.ts (MIT, Copyright 2026 Lovecast Inc.)
//
// Apps launched from Finder / Dock / a desktop launcher get a short PATH (no Homebrew, nvm, ~/.local/bin), so
// installed agents looked missing. We read the login shell's PATH once (`$SHELL -ilc`), remember it in userData
// for the next launch (used immediately while a fresh value is read in the background), add common install dirs,
// and look commands up by listing each directory once instead of spawning `which` per command.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { errorKind, reportHandled } from '../shared/report';

const SHELL_PATH_TIMEOUT_MS = 3000;
const SHELL_PATH_REFRESH_TIMEOUT_MS = 10_000;
const SHELL_PATH_RETRY_MS = 60_000;
const MARKER = '__SOLOCUT_PATH__';

/** Install locations that are often missing from PATH (npm -g, bun, pipx/uv, cargo, volta, Homebrew, installers). */
export function extraInstallDirs(home: string = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    const local = process.env.LOCALAPPDATA;
    return [
      ...(appData ? [join(appData, 'npm')] : []),
      ...(local ? [join(local, 'Programs'), join(local, 'Microsoft', 'WinGet', 'Links')] : []),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
    ];
  }
  return [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.amp', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(platform === 'linux' ? ['/home/linuxbrew/.linuxbrew/bin', '/snap/bin'] : []),
  ];
}

let shellPathPromise: Promise<string> | null = null;
let shellPathFailedAt = 0;
let shellPathReported = false;
let cachedShellPath: string | null = null;
let freshShellPath: string | null = null;
let shellPathCacheFile: string | null = null;

export const usableShellPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length < 64 * 1024 && !value.includes('\0');

function loginShell(): string {
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/**
 * Called once at startup: loads the PATH remembered from the previous launch and starts reading a fresh one in the
 * background, so the first terminal / detection does not wait 1–3 s for the user's rc files.
 */
export async function warmLoginShellPath(cacheFile: string): Promise<void> {
  if (process.platform === 'win32') return;
  shellPathCacheFile = cacheFile;
  try {
    const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as { shell?: unknown; path?: unknown };
    if (raw.shell === loginShell() && usableShellPath(raw.path) && freshShellPath === null) cachedShellPath = raw.path;
  } catch {
    /* first launch or unreadable file: created once a fresh value arrives */
  }
  void loginShellPath();
}

/** Detection is using last launch's PATH; if something is missing it is worth retrying with a fresh one. */
export function shellPathIsProvisional(): boolean {
  return freshShellPath === null && cachedShellPath !== null;
}

function rememberShellPath(value: string): void {
  if (!shellPathCacheFile || value === cachedShellPath) return;
  cachedShellPath = value;
  void writeFile(shellPathCacheFile, JSON.stringify({ shell: loginShell(), path: value }), { mode: 0o600 }).catch(() => undefined);
}

/** Extracts the PATH printed after the marker (rc files may print banners before it). */
export function parseMarkedPath(stdout: unknown, marker = MARKER): string | null {
  if (typeof stdout !== 'string') return null;
  const i = stdout.lastIndexOf(marker);
  return i < 0 ? null : stdout.slice(i + marker.length).trim();
}

/**
 * What to report when the login shell gave no PATH (null = do not report). A timeout means slow rc files on the
 * user's machine; it is retried later and not reported.
 */
export function loginShellPathFailure(error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null): Error | null {
  if (!error) return new Error('login shell PATH marker missing');
  if (error.killed || error.signal === 'SIGTERM') return null;
  if (typeof error.code === 'number') return new Error(`login shell PATH exit ${error.code}`);
  if (typeof error.signal === 'string' && /^SIG[A-Z0-9]+$/.test(error.signal)) return new Error(`login shell PATH signal ${error.signal}`);
  return errorKind(error);
}

function loginShellPath(waitFresh = false): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('');
  if (freshShellPath !== null) return Promise.resolve(freshShellPath);
  const fallback = waitFresh ? null : cachedShellPath;
  if (!shellPathPromise && Date.now() - shellPathFailedAt < SHELL_PATH_RETRY_MS) return Promise.resolve(fallback ?? cachedShellPath ?? '');
  shellPathPromise ??= new Promise<string>((resolve) => {
    const timeout = cachedShellPath !== null ? SHELL_PATH_REFRESH_TIMEOUT_MS : SHELL_PATH_TIMEOUT_MS;
    execFile(loginShell(), ['-ilc', `printf "${MARKER}%s" "$PATH"`], { timeout, encoding: 'utf8' }, (error, stdout) => {
      // With the marker present the PATH is good even on a non-zero exit (.zlogout, a failing last rc command)
      const value = parseMarkedPath(stdout);
      if (value === null) {
        shellPathPromise = null;
        shellPathFailedAt = Date.now();
        const failure = loginShellPathFailure(error);
        if (failure && !shellPathReported) {
          shellPathReported = true;
          reportHandled(failure, { area: 'agent-launch', op: 'read login shell PATH' });
        }
        return resolve(cachedShellPath ?? '');
      }
      freshShellPath = value;
      if (usableShellPath(value)) rememberShellPath(value);
      resolve(value);
    });
  });
  return fallback !== null ? Promise.resolve(fallback) : shellPathPromise;
}

/** Directories to search, deduplicated: process PATH, login shell PATH, common install dirs. */
export async function searchDirs(options: { fresh?: boolean } = {}): Promise<string[]> {
  const fromShell = await loginShellPath(options.fresh === true);
  return mergeDirs(process.env.PATH ?? process.env.Path ?? '', fromShell, extraInstallDirs());
}

export function mergeDirs(processPath: string, shellPath: string, extra: string[], sep: string = delimiter): string[] {
  const dirs = [...processPath.split(sep), ...shellPath.split(process.platform === 'win32' ? ';' : ':'), ...extra];
  return [...new Set(dirs.map((d) => d.trim()).filter(Boolean))];
}

/**
 * The PATH value for child processes (agent terminals, the solocut CLI, version probes). Synchronous: uses the
 * best value known right now (fresh, else last launch's, else the process PATH) plus the install dirs.
 */
export function appPath(): string {
  const shell = freshShellPath ?? cachedShellPath ?? '';
  return mergeDirs(process.env.PATH ?? process.env.Path ?? '', shell, extraInstallDirs()).join(delimiter);
}

/** Same, after waiting for the login shell (bounded by its timeout). */
export async function appPathAsync(): Promise<string> {
  return (await searchDirs()).join(delimiter);
}

function commandExts(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.PS1').toLowerCase().split(';').filter(Boolean)] : [''];
}

function dirNames(dir: string, platform: NodeJS.Platform): Promise<Map<string, string>> {
  return readdir(dir).then(
    (names) => new Map(names.map((name) => [platform === 'win32' ? name.toLowerCase() : name, name])),
    () => new Map<string, string>(),
  );
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false; // stat follows symlinks (~/bin/claude → …)
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds each command in `dirs` (first match wins). Each directory is listed once; only matching names are
 * checked, which keeps long Windows PATHs from blocking main.
 */
export async function resolveCommandsInDirs(commands: readonly string[], dirs: readonly string[], platform: NodeJS.Platform = process.platform): Promise<Map<string, string>> {
  const exts = commandExts(platform);
  const listings = await Promise.all(dirs.map((dir) => (dir ? dirNames(dir, platform) : Promise.resolve(new Map<string, string>()))));
  const found = new Map<string, string>();
  for (const command of new Set(commands)) {
    if (!command) continue;
    if (/[\\/]/.test(command)) {
      if (await isExecutable(command, platform)) found.set(command, command);
      continue;
    }
    search: for (const [i, dir] of dirs.entries()) {
      for (const ext of exts) {
        const key = command + ext;
        const name = listings[i]!.get(platform === 'win32' ? key.toLowerCase() : key);
        if (!name) continue;
        const path = join(dir, name);
        if (await isExecutable(path, platform)) {
          found.set(command, path);
          break search;
        }
      }
    }
  }
  return found;
}

/** Test hook. */
export function resetShellPathForTests(): void {
  shellPathPromise = null;
  shellPathFailedAt = 0;
  shellPathReported = false;
  cachedShellPath = null;
  freshShellPath = null;
  shellPathCacheFile = null;
}
