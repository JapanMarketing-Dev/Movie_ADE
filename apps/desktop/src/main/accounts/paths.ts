// Where each account's config folder lives, and the check that a folder really belongs to Solocut.
//
// Ported from Ferret src/main/accounts/paths.ts (MIT).
// Orca由来: ~/bench/orca/src/main/codex-accounts/codex-managed-home-path.ts,
//           ~/bench/orca/src/main/codex-accounts/host-codex-managed-home-ownership.ts,
//           ~/bench/orca/src/main/claude-accounts/managed-auth-path.ts（MIT, Copyright 2026 Lovecast Inc.）
//
// Like Orca, each folder carries an ownership marker file. Before using or deleting a folder we check that
//   - it is inside the store (no symlink escaping it)
//   - it does not point into ~/.codex or ~/.claude
//   - the marker content equals the account id
// WSL / Windows path dialects and transient read failures are not distinguished.
//
// Store: ~/.solocut/accounts/<agent>/<id> (the `root` argument is ~/.solocut/accounts).
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AccountAgent } from '../../shared/accounts';
import type { Lang } from '../../shared/types';
import { AccountsUserError, msg } from './messages';

export const MANAGED_ACCOUNT_MARKER = '.solocut-managed-account';

/** only randomUUID ids are accepted (they become part of a path) */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id);
}

/** true when `child` is `parent` or inside it */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** <root>/<agent> */
export function accountsRootFor(root: string, agent: AccountAgent): string {
  return join(root, agent);
}

/** <root>/<agent>/<id>; used as CODEX_HOME / CLAUDE_CONFIG_DIR */
export function managedAccountDir(root: string, agent: AccountAgent, accountId: string, lang: Lang = 'ja'): string {
  if (!isValidAccountId(accountId)) throw new AccountsUserError(msg(lang, 'accounts.errors.invalidId'));
  return join(accountsRootFor(root, agent), accountId);
}

/** The system default account's config folder; follows CODEX_HOME / CLAUDE_CONFIG_DIR when set. */
export function systemConfigDir(agent: AccountAgent, env: NodeJS.ProcessEnv = process.env): string {
  if (agent === 'codex') return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

function realpathIfPresent(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // not created yet (expected)
    return resolve(path);
  }
}

export type ManagedDirVerdict = { kind: 'owned'; dir: string } | { kind: 'untrusted'; reason: string };

/** Whether the config folder belongs to Solocut (non-throwing). The reason is a user-facing sentence. */
export function verifyManagedAccountDir(options: {
  root: string;
  agent: AccountAgent;
  accountId: string;
  systemDir?: string;
  lang?: Lang;
}): ManagedDirVerdict {
  const { root, agent, accountId } = options;
  const lang = options.lang ?? 'ja';
  if (!isValidAccountId(accountId)) return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.invalidId') };
  const expected = managedAccountDir(root, agent, accountId, lang);
  let canonical: string;
  let canonicalRoot: string;
  try {
    if (!statSync(expected).isDirectory()) return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.notDirectory') };
    canonical = realpathSync(expected);
    canonicalRoot = realpathSync(accountsRootFor(root, agent));
  } catch {
    return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.folderMissing') };
  }
  // the store must not have been swapped to point at the real ~/.codex or ~/.claude (same check as Orca)
  const systemDir = realpathIfPresent(options.systemDir ?? systemConfigDir(agent));
  if (isWithin(systemDir, canonical) || isWithin(canonical, systemDir)) {
    return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.pointsToDefault') };
  }
  if (canonical !== join(canonicalRoot, accountId)) {
    return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.outsideStore') };
  }
  const markerPath = join(canonical, MANAGED_ACCOUNT_MARKER);
  try {
    if (!lstatSync(markerPath).isFile()) return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.markerBroken') };
    if (readFileSync(markerPath, 'utf8').trim() !== accountId) {
      return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.markerMismatch') };
    }
  } catch {
    return { kind: 'untrusted', reason: msg(lang, 'accounts.errors.markerMissing') };
  }
  return { kind: 'owned', dir: canonical };
}

/** Check before use (throwing). */
export function assertManagedAccountDir(options: Parameters<typeof verifyManagedAccountDir>[0]): string {
  const verdict = verifyManagedAccountDir(options);
  if (verdict.kind === 'owned') return verdict.dir;
  throw new AccountsUserError(verdict.reason);
}

/** Creates a new config folder with the marker. An existing folder is never reused (never write into someone else's). */
export function createManagedAccountDir(root: string, agent: AccountAgent, accountId: string, systemDir?: string): string {
  const agentRoot = accountsRootFor(root, agent);
  mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
  const dir = managedAccountDir(root, agent, accountId);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, MANAGED_ACCOUNT_MARKER), `${accountId}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return assertManagedAccountDir({ root, agent, accountId, ...(systemDir ? { systemDir } : {}) });
}

/**
 * Deletes the config folder, only when it is verified to belong to Solocut. Otherwise nothing is deleted and
 * false is returned (same idea as Orca's safeRemove).
 */
export function removeManagedAccountDir(root: string, agent: AccountAgent, accountId: string, systemDir?: string): boolean {
  const verdict = verifyManagedAccountDir({ root, agent, accountId, ...(systemDir ? { systemDir } : {}) });
  if (verdict.kind !== 'owned') return false;
  rmSync(verdict.dir, { recursive: true, force: true });
  return true;
}
