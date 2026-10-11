// Claude Code / Codex account switching: types shared by main and renderer.
//
// Ported from Ferret src/shared/accounts.ts (MIT).
// Orca由来: ~/bench/orca/src/shared/managed-account-types.ts（MIT, Copyright 2026 Lovecast Inc.）
// Orca's CodexManagedAccount / ClaudeManagedAccount merged into one shape; WSL, remote runtimes and
// organisation details are not carried over.
//
// Each account has its own config folder (CODEX_HOME for Codex, CLAUDE_CONFIG_DIR for Claude), always at
// ~/.solocut/accounts/<agent>/<id>/. The path is never stored; it is derived from the id every time so a
// hand-edited registry cannot point the agent at an arbitrary folder.
import type { Lang } from './types';

/** Agents whose accounts can be switched. */
export type AccountAgent = 'claude' | 'codex';
export const ACCOUNT_AGENTS: readonly AccountAgent[] = ['claude', 'codex'];

export function isAccountAgent(value: unknown): value is AccountAgent {
  return value === 'claude' || value === 'codex';
}

/** One stored account. */
export interface AgentAccount {
  id: string;
  /** name the user gave; empty → the email is shown */
  label: string;
  /** email read from the config folder after login; null before login */
  email: string | null;
  /** plan / workspace (Codex "Personal (Plus)", Claude organisation name …) */
  workspaceLabel: string | null;
  createdAt: number;
  updatedAt: number;
  /** last time login was confirmed; null right after adding (waiting for login) */
  lastAuthenticatedAt: number | null;
}

/** Accounts and selection per agent. activeAccountId null = "system default account". */
export interface AgentAccountList {
  accounts: AgentAccount[];
  activeAccountId: string | null;
}

export type AgentAccountsSettings = Record<AccountAgent, AgentAccountList>;

export const EMPTY_AGENT_ACCOUNTS: AgentAccountsSettings = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
};

/** One account as shown on screen; the login state is read from the config folder every time. */
export interface AgentAccountSummary extends AgentAccount {
  /** credentials exist in the config folder */
  signedIn: boolean;
  /** why the account cannot be used (folder missing, not owned by Solocut …) */
  problem: string | null;
}

/**
 * The system default account (~/.claude, ~/.codex), read for display only and never modified
 * (same as Orca's CodexSystemDefaultIdentity).
 */
export interface SystemDefaultAccount {
  signedIn: boolean;
  email: string | null;
}

export interface AgentAccountsView {
  accounts: AgentAccountSummary[];
  activeAccountId: string | null;
  systemDefault: SystemDefaultAccount;
  /** accounts removed on this read because they duplicated an existing login (display names) */
  removedDuplicates?: string[];
}

export type AgentAccountsState = Record<AccountAgent, AgentAccountsView>;

/** Result of "add": the state plus what is needed to start the login in a built-in terminal. */
export interface AgentAccountAddResult {
  state: AgentAccountsState;
  login: AccountLoginRequest;
}

/** Start an account login in a built-in terminal. */
export interface AccountLoginRequest {
  agent: AccountAgent;
  accountId: string;
}

/** What the terminal host needs to run the login: argv (agent command + login subcommand), env and tab title. */
export interface AccountLoginLaunch {
  argv: string[];
  env: Record<string, string>;
  title: string;
}

function loginKey(email: string | null | undefined, workspaceLabel: string | null | undefined): string | null {
  return email ? `${email.trim().toLowerCase()}|${(workspaceLabel ?? '').trim().toLowerCase()}` : null;
}

/**
 * Accounts to drop so the same login is never registered twice. Only signed-in accounts with a known email
 * are compared.
 *
 * Only accounts whose first login completed on this read (fresh) may be dropped. Accounts in use before are
 * never dropped, even when a later account has the same login or they are not selected (dropping deletes the
 * config folder with its history and login). A fresh account is dropped when the same login already exists or
 * equals the system default (switching to it would not add any quota). When several fresh accounts collide,
 * the selected one is kept, otherwise the oldest.
 */
export function duplicateAccountIds(
  accounts: ReadonlyArray<Pick<AgentAccount, 'id' | 'email' | 'workspaceLabel' | 'createdAt'> & { signedIn: boolean; fresh: boolean }>,
  activeAccountId: string | null,
  systemDefault: { signedIn: boolean; email: string | null; workspaceLabel: string | null } | null,
): string[] {
  const systemKey = systemDefault?.signedIn ? loginKey(systemDefault.email, systemDefault.workspaceLabel) : null;
  const groups = new Map<string, (typeof accounts)[number][]>();
  for (const account of accounts) {
    const key = account.signedIn ? loginKey(account.email, account.workspaceLabel) : null;
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), account]);
  }
  const drop: string[] = [];
  for (const [key, members] of groups) {
    const fresh = members.filter((m) => m.fresh);
    if (fresh.length === 0) continue;
    const alreadyKnown = members.some((m) => !m.fresh) || key === systemKey;
    const keeper = alreadyKnown
      ? null
      : (fresh.find((m) => m.id === activeAccountId) ?? [...fresh].sort((a, b) => a.createdAt - b.createdAt)[0]);
    for (const m of fresh) if (m !== keeper) drop.push(m.id);
  }
  return drop;
}

/**
 * Rows for the per-account breakdown, merging rows with the same login (same email and organisation) so the
 * same account added twice, or equal to the system default, is shown once. The selected row wins; otherwise the
 * first one (system default → oldest). Rows without an email are never merged.
 */
export function dedupeAccountRows<T extends { accountId: string | null; email: string | null; workspaceLabel: string | null }>(
  rows: readonly T[],
  activeAccountId: string | null,
): T[] {
  const keyOf = (row: T) => loginKey(row.email, row.workspaceLabel);
  const keep = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const kept = keep.get(key);
    if (!kept || (row.accountId === activeAccountId && kept.accountId !== activeAccountId)) keep.set(key, row);
  }
  return rows.filter((row) => {
    const key = keyOf(row);
    return !key || keep.get(key) === row;
  });
}

/** Display name: label → email → "waiting for login". */
export function accountDisplayName(account: Pick<AgentAccount, 'label' | 'email'>, lang: Lang = 'ja'): string {
  return account.label.trim() || account.email || (lang === 'ja' ? 'ログイン待ち' : 'Waiting for login');
}

/** Label of the system default account row. */
export function systemDefaultLabel(lang: Lang = 'ja'): string {
  return lang === 'ja' ? 'システムの既定' : 'System default';
}
