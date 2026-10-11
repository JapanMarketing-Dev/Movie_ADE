// Reads the access tokens used to fetch usage. Values are used in memory only and never leave the return value
// (no logs, no screen, no exception messages).
//
// Ported from Ferret src/main/usage/credentials.ts (MIT).
// Orca由来: ~/bench/orca/src/main/rate-limits/claude-oauth-credentials.ts,
//           ~/bench/orca/src/main/rate-limits/codex-backend-auth.ts（MIT, Copyright 2026 Lovecast Inc.）
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeKeychainService, claudeKeychainUser } from '../accounts/identity';

export type CredentialRead = { token: string; accountId?: string | null } | { token: null; reason: 'missing' | 'keychain-unavailable' };

/**
 * The macOS Keychain is read through the `security` command (same as Orca's generic-password.ts), never through a
 * Keychain API from Electron. Claude Code itself uses `security`, so items it created are usually readable without a
 * dialog. Where permission is still requested, we give up instead of waiting:
 * - stdin is closed and the command is killed after 3 s (never wait for a dialog)
 * - an item that could not be read is not read automatically again during this run (only a manual refresh retries)
 * - before reading the secret, existence is checked with an attribute read (no -w, no permission needed)
 */
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3000;

export type SecurityExec = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; code: unknown }>;

const execSecurity: SecurityExec = (args) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (result: Awaited<ReturnType<SecurityExec>>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = execFile('security', args, { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout) =>
      done(error ? { ok: false, code: (error as { code?: unknown }).code } : { ok: true, stdout: String(stdout) }),
    );
    child.stdin?.end();
    // backup in case execFile's timeout does not fire (never leave the promise pending)
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, code: 'ETIMEDOUT' });
    }, KEYCHAIN_COMMAND_TIMEOUT_MS + 500);
  });

/** item not found (44); other failures mean "could not read" (denied, timeout, locked) */
const NOT_FOUND = 44;

export function createKeychainReader(exec: SecurityExec = execSecurity) {
  /** items that could not be read; not retried automatically until a manual refresh (retryBlocked) */
  const blocked = new Set<string>();
  return {
    async read(service: string, account: string, options: { retryBlocked?: boolean } = {}): Promise<string | null | 'unavailable'> {
      const key = `${service}\u0000${account}`;
      if (blocked.has(key) && !options.retryBlocked) return 'unavailable';
      const exists = await exec(['find-generic-password', '-s', service, '-a', account]);
      if (!exists.ok) return exists.code === NOT_FOUND ? null : 'unavailable';
      const result = await exec(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (result.ok) {
        blocked.delete(key);
        return result.stdout.trim() || null;
      }
      if (result.code === NOT_FOUND) return null;
      blocked.add(key);
      return 'unavailable';
    },
  };
}

const keychain = createKeychainReader();

/** Access token and expiry from the credentials JSON (exported for unit tests). */
export function parseClaudeCredentials(raw: string, now: number = Date.now()): { token: string; expired: boolean } | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
    return { token: oauth.accessToken, expired: typeof oauth.expiresAt === 'number' && oauth.expiresAt < now };
  } catch {
    // not credentials (treated as signed out; expected; never reported since it may contain a token)
    return null;
  }
}

/**
 * Claude's OAuth access token. With configDir, the Keychain item and .credentials.json of that CLAUDE_CONFIG_DIR;
 * without, the system default account (unsuffixed item and ~/.claude/.credentials.json).
 *
 * On macOS an old .credentials.json may remain while the fresh token is in the Keychain (Claude Code writes to the
 * Keychain on macOS). When the file token has expired the Keychain is checked, and the expired file token is used
 * only when the Keychain has nothing (the fetch then fails with 401 → "sign in again").
 */
export async function readClaudeAccessToken(configDir?: string, options: { retryBlocked?: boolean } = {}): Promise<CredentialRead> {
  // the file first (Linux, Windows, or macOS setups that keep a file): avoids touching the Keychain
  let file: { token: string; expired: boolean } | null = null;
  try {
    file = parseClaudeCredentials(await readFile(join(configDir ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8'));
  } catch {
    // no file: look in the Keychain
  }
  if (file && !file.expired) return { token: file.token };
  if (process.platform !== 'darwin') return file ? { token: file.token } : { token: null, reason: 'missing' };
  const raw = await keychain.read(claudeKeychainService(configDir), claudeKeychainUser(), options);
  const fromKeychain = raw && raw !== 'unavailable' ? (parseClaudeCredentials(raw)?.token ?? null) : null;
  if (fromKeychain) return { token: fromKeychain };
  if (file) return { token: file.token };
  if (raw === 'unavailable') return { token: null, reason: 'keychain-unavailable' };
  return { token: null, reason: 'missing' };
}

/** Codex's auth.json access token and ChatGPT account id. */
export async function readCodexAccessToken(codexHome: string): Promise<CredentialRead> {
  try {
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const token = auth.tokens?.access_token;
    if (typeof token === 'string' && token) {
      return { token, accountId: typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : null };
    }
  } catch {
    // unreadable → signed out
  }
  return { token: null, reason: 'missing' };
}
