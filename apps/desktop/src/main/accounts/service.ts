// Account list / add / rename / remove / select (the IPC entry points).
//
// Ported from Ferret src/main/accounts/service.ts (MIT).
// Orca由来: ~/bench/orca/src/main/codex-accounts/service.ts,
//           ~/bench/orca/src/main/codex-accounts/codex-account-selection.ts,
//           ~/bench/orca/src/main/codex-accounts/codex-account-registration.ts,
//           ~/bench/orca/src/main/claude-accounts/claude-account-registration.ts（MIT, Copyright 2026 Lovecast Inc.）
//
// Differences from Orca:
// - Orca runs `codex login` / `claude auth login` as a hidden child process on "add" and registers the account
//   afterwards. Solocut shows the login in a built-in terminal, so the config folder and a "waiting for login"
//   row are created first, and every list read checks the folder to complete the registration.
// - After the first login a new Codex account becomes the selected one; Claude keeps its selection (same as Orca).
// - A switch applies to agents opened afterwards; running agents keep their environment (same as Orca). The
//   failover service reopens running tabs when the user picks another account (switchRunningAgents).
//
// The registry lives in ~/.solocut/accounts/accounts.json (not settings.json): ids, labels, emails and times only,
// never paths or tokens. Paths are derived from ids (paths.ts).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EMPTY_AGENT_ACCOUNTS,
  accountDisplayName,
  duplicateAccountIds,
  isAccountAgent,
  type AccountAgent,
  type AccountLoginLaunch,
  type AccountLoginRequest,
  type AgentAccount,
  type AgentAccountAddResult,
  type AgentAccountList,
  type AgentAccountsSettings,
  type AgentAccountsState,
  type AgentAccountsView,
} from '../../shared/accounts';
import { errorKind, reportHandled } from '../../shared/report';
import type { Lang } from '../../shared/types';
import { seedManagedAccountDir } from './agentConfig';
import { managedClaudeChromePaired, systemClaudeChromePaired } from './chromePairing';
import { resolveAgentEnvFrom } from './env';
import { claudeKeychainService, claudeKeychainUser, readClaudeIdentity, readClaudeSystemIdentity, readCodexIdentity, type AccountIdentity } from './identity';
import { AccountsUserError, msg } from './messages';
import { createManagedAccountDir, isValidAccountId, removeManagedAccountDir, systemConfigDir, verifyManagedAccountDir } from './paths';
import { normalizeAccountLabel, sanitizeAgentAccounts } from './sanitize';

export interface AccountsDeps {
  /** ~/.solocut/accounts */
  root: string;
  /** default <root>/accounts.json */
  registryPath?: string;
  language?: () => Lang;
  /** the system default account's config folder (tests) */
  systemDir?: (agent: AccountAgent) => string;
  /** reads the system default account (tests) */
  readSystemDefault?: (agent: AccountAgent) => Promise<AccountIdentity>;
  /** the executable that starts the agent (first word of the configured command); null when unknown */
  agentExecutable?: (agent: AccountAgent) => string | null;
  /** deletes the per-folder Claude Keychain item (macOS); tests replace it */
  deleteClaudeKeychainItem?: (configDir: string) => Promise<void>;
  /** called after every change of the registry */
  onChange?: (settings: AgentAccountsSettings) => void;
  env?: NodeJS.ProcessEnv;
  /** the user's home folder (system default Chrome pairing lookup; tests) */
  home?: string;
  now?: () => number;
}

/** Login subcommands (same as Orca's runClaudeLoginSession / runCodexLoginSession). */
const LOGIN_ARGS: Record<AccountAgent, string[]> = {
  claude: ['auth', 'login', '--claudeai'],
  codex: ['login'],
};

const AGENT_NAME: Record<AccountAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Only accounts whose first login happened within this time after adding count as "just added" (may be dropped as duplicates). */
const FRESH_ACCOUNT_MS = 24 * 60 * 60 * 1000;

function deleteScopedClaudeKeychainItem(configDir: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  const service = claudeKeychainService(configDir);
  return new Promise((resolve) => {
    execFile('security', ['delete-generic-password', '-s', service, '-a', claudeKeychainUser()], { timeout: 5000 }, () => resolve());
  });
}

export class AccountsService {
  readonly root: string;
  private readonly registryPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(settings: AgentAccountsSettings) => void>();

  constructor(private readonly deps: AccountsDeps) {
    this.root = deps.root;
    this.registryPath = deps.registryPath ?? join(deps.root, 'accounts.json');
  }

  private lang(): Lang {
    return this.deps.language?.() ?? 'ja';
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  systemDir(agent: AccountAgent): string {
    return this.deps.systemDir?.(agent) ?? systemConfigDir(agent, this.deps.env ?? process.env);
  }

  // ---------- registry ----------

  settings(): AgentAccountsSettings {
    try {
      return sanitizeAgentAccounts(JSON.parse(readFileSync(this.registryPath, 'utf8')));
    } catch {
      // no registry yet (expected) or a broken file: start empty without deleting anything
      return { claude: { ...EMPTY_AGENT_ACCOUNTS.claude, accounts: [] }, codex: { ...EMPTY_AGENT_ACCOUNTS.codex, accounts: [] } };
    }
  }

  private save(next: AgentAccountsSettings): void {
    mkdirSync(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.registryPath);
    this.deps.onChange?.(next);
    for (const cb of this.listeners) {
      try {
        cb(next);
      } catch (err) {
        reportHandled(errorKind(err), { area: 'accounts', op: 'notify accounts listener' });
      }
    }
  }

  /** Subscribe to registry changes (IPC event, usage refetch). */
  onChange(cb: (settings: AgentAccountsSettings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private saveList(agent: AccountAgent, next: AgentAccountList): void {
    this.save({ ...this.settings(), [agent]: next });
  }

  /** The selected account (null = system default; a selection pointing to a missing account is ignored). */
  activeAccountId(agent: AccountAgent): string | null {
    const list = this.settings()[agent];
    return list.accounts.some((a) => a.id === list.activeAccountId) ? list.activeAccountId : null;
  }

  accountLabel(agent: AccountAgent, accountId: string | null): string {
    const lang = this.lang();
    if (accountId === null) return lang === 'ja' ? 'システムの既定' : 'System default';
    const account = this.settings()[agent].accounts.find((a) => a.id === accountId);
    return account ? accountDisplayName(account, lang) : lang === 'ja' ? 'システムの既定' : 'System default';
  }

  private requireAccount(agent: AccountAgent, accountId: string): AgentAccount {
    const account = this.settings()[agent].accounts.find((a) => a.id === accountId);
    if (!account) throw new AccountsUserError(msg(this.lang(), 'accounts.errors.gone'));
    return account;
  }

  /** Like Orca, registry reads and writes run in one queue so no update is lost. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // failures go to the caller of `next`; the queue only orders work (expected)
    this.queue = next.catch(() => undefined);
    return next;
  }

  private verify(agent: AccountAgent, accountId: string) {
    return verifyManagedAccountDir({ root: this.root, agent, accountId, systemDir: this.systemDir(agent), lang: this.lang() });
  }

  private async readIdentity(agent: AccountAgent, dir: string): Promise<AccountIdentity> {
    return agent === 'codex' ? readCodexIdentity(dir, this.lang()) : readClaudeIdentity(dir);
  }

  readSystemDefault(agent: AccountAgent): Promise<AccountIdentity> {
    if (this.deps.readSystemDefault) return this.deps.readSystemDefault(agent);
    return agent === 'codex'
      ? Promise.resolve(readCodexIdentity(this.systemDir('codex'), this.lang()))
      : readClaudeSystemIdentity(this.deps.env ?? process.env);
  }

  /** Reads one agent; rows whose login completed get their email etc. written back. */
  private async refreshAgent(agent: AccountAgent): Promise<AgentAccountsView> {
    const list = this.settings()[agent];
    const now = this.now();
    let changed = false;
    let activeAccountId = list.activeAccountId;
    const summaries = await Promise.all(
      list.accounts.map(async (account) => {
        const verdict = this.verify(agent, account.id);
        if (verdict.kind !== 'owned') return { account, signedIn: false, fresh: false, problem: verdict.reason as string | null };
        const identity = await this.readIdentity(agent, verdict.dir);
        let next = account;
        // added recently and signed in for the first time on this read: the only kind that may be dropped as a duplicate
        let fresh = false;
        if (identity.signedIn) {
          const firstLogin = account.lastAuthenticatedAt === null;
          // an account added days ago whose login is only now noticed may have been in use: never drop it
          fresh = firstLogin && now - account.createdAt < FRESH_ACCOUNT_MS;
          if (firstLogin || identity.email !== account.email || identity.workspaceLabel !== account.workspaceLabel) {
            next = {
              ...account,
              email: identity.email ?? account.email,
              workspaceLabel: identity.workspaceLabel,
              updatedAt: now,
              lastAuthenticatedAt: firstLogin ? now : account.lastAuthenticatedAt,
            };
            changed = true;
            // Orca selects a newly added Codex account right away (Claude keeps its selection)
            if (firstLogin && agent === 'codex') activeAccountId = account.id;
          }
        }
        return { account: next, signedIn: identity.signedIn, fresh, problem: null as string | null };
      }),
    );
    const systemDefault = await this.readSystemDefault(agent).catch((): AccountIdentity => ({ signedIn: false, email: null, workspaceLabel: null }));
    // Never register the same login twice: a just-added account whose login equals a registered one or the system
    // default is removed (folder and Keychain item). Accounts used before are never removed. Accounts that cannot be
    // deleted stay listed (so the folder holding credentials can still be removed).
    const removed = new Set<string>();
    for (const id of duplicateAccountIds(summaries.map((s) => ({ ...s.account, signedIn: s.signedIn, fresh: s.fresh })), activeAccountId, systemDefault)) {
      if (await this.removeOwnedAccountFolder(agent, id)) removed.add(id);
    }
    // a removed just-added Codex account that became selected: back to the previous selection
    if (activeAccountId !== null && removed.has(activeAccountId)) {
      activeAccountId = list.activeAccountId !== null && removed.has(list.activeAccountId) ? null : list.activeAccountId;
    }
    const kept = summaries.filter((s) => !removed.has(s.account.id));
    if (changed || removed.size > 0 || activeAccountId !== list.activeAccountId) {
      this.saveList(agent, { accounts: kept.map((s) => s.account), activeAccountId });
    }
    const lang = this.lang();
    return {
      accounts: kept.map((s) => ({ ...s.account, signedIn: s.signedIn, problem: s.problem })).sort((a, b) => a.createdAt - b.createdAt),
      activeAccountId,
      systemDefault: { signedIn: systemDefault.signedIn, email: systemDefault.email },
      ...(removed.size > 0
        ? { removedDuplicates: summaries.filter((s) => removed.has(s.account.id)).map((s) => accountDisplayName(s.account, lang)) }
        : {}),
    };
  }

  /** Deletes a duplicate account's folder (and its macOS Keychain item). true when deleted. */
  private async removeOwnedAccountFolder(agent: AccountAgent, accountId: string): Promise<boolean> {
    const verdict = this.verify(agent, accountId);
    if (verdict.kind !== 'owned') return false;
    try {
      if (agent === 'claude') await (this.deps.deleteClaudeKeychainItem ?? deleteScopedClaudeKeychainItem)(verdict.dir);
      return removeManagedAccountDir(this.root, agent, accountId, this.systemDir(agent));
    } catch (err) {
      reportHandled(errorKind(err), { area: 'accounts', op: 'remove duplicate account' });
      return false;
    }
  }

  list(): Promise<AgentAccountsState> {
    return this.serialize(async () => {
      const [claude, codex] = await Promise.all([this.refreshAgent('claude'), this.refreshAgent('codex')]);
      return { claude, codex };
    });
  }

  /**
   * Creates a new config folder and a "waiting for login" row. The UI then starts the login in a built-in terminal
   * (Orca's add → login split in two) using loginLaunch().
   */
  async add(agent: AccountAgent): Promise<AgentAccountAddResult> {
    const login = await this.serialize(async (): Promise<AccountLoginRequest> => {
      const accountId = randomUUID();
      const systemDir = this.systemDir(agent);
      const dir = createManagedAccountDir(this.root, agent, accountId, systemDir);
      seedManagedAccountDir(agent, dir, systemDir);
      const now = this.now();
      const list = this.settings()[agent];
      this.saveList(agent, {
        ...list,
        accounts: [...list.accounts, { id: accountId, label: '', email: null, workspaceLabel: null, createdAt: now, updatedAt: now, lastAuthenticatedAt: null }],
      });
      return { agent, accountId };
    });
    return { state: await this.list(), login };
  }

  async rename(agent: AccountAgent, accountId: string, label: string): Promise<AgentAccountsState> {
    await this.serialize(async () => {
      this.requireAccount(agent, accountId);
      const list = this.settings()[agent];
      this.saveList(agent, {
        ...list,
        accounts: list.accounts.map((a) => (a.id === accountId ? { ...a, label: normalizeAccountLabel(label), updatedAt: this.now() } : a)),
      });
    });
    return this.list();
  }

  /**
   * Removes the account and deletes its config folder; folders that cannot be verified as Solocut's are not deleted.
   * On macOS the Keychain item Claude Code created for that folder is deleted too (only the folder-derived item;
   * the default account's item is never touched). No server-side logout.
   */
  async remove(agent: AccountAgent, accountId: string): Promise<AgentAccountsState> {
    await this.serialize(async () => {
      this.requireAccount(agent, accountId);
      const verdict = this.verify(agent, accountId);
      // Delete the folder first. If that fails (a file in use on Windows …) keep the row and report it: removing the
      // row first would leave a folder with credentials and no way to delete it (Orca #11653)
      if (verdict.kind === 'owned') {
        if (agent === 'claude') await (this.deps.deleteClaudeKeychainItem ?? deleteScopedClaudeKeychainItem)(verdict.dir);
        try {
          removeManagedAccountDir(this.root, agent, accountId, this.systemDir(agent));
        } catch (err) {
          reportHandled(errorKind(err), { area: 'accounts', op: 'remove account folder' });
          throw new AccountsUserError(msg(this.lang(), 'accounts.errors.removeFailed', { agent: AGENT_NAME[agent], reason: errorKind(err).message }));
        }
      }
      const list = this.settings()[agent];
      this.saveList(agent, {
        accounts: list.accounts.filter((a) => a.id !== accountId),
        activeAccountId: list.activeAccountId === accountId ? null : list.activeAccountId,
      });
    });
    return this.list();
  }

  /** null switches back to the system default. Accounts that have not finished their login cannot be selected. */
  async select(agent: AccountAgent, accountId: string | null): Promise<AgentAccountsState> {
    await this.serialize(async () => {
      const list = this.settings()[agent];
      if (accountId !== null) {
        this.requireAccount(agent, accountId);
        const verdict = this.verify(agent, accountId);
        if (verdict.kind !== 'owned') throw new AccountsUserError(verdict.reason);
        if (!(await this.readIdentity(agent, verdict.dir)).signedIn) throw new AccountsUserError(msg(this.lang(), 'accounts.errors.notSignedIn'));
      }
      this.saveList(agent, { ...list, activeAccountId: accountId });
    });
    return this.list();
  }

  /** Sign in again (still waiting, or expired): the row stays, only the login starts. */
  relogin(agent: AccountAgent, accountId: string): AccountLoginRequest {
    this.requireAccount(agent, accountId);
    return { agent, accountId };
  }

  /**
   * Claude Code accounts that have paired with Claude in Chrome (null = system default). The extension only connects
   * to the same claude.ai account, so failover prefers these. Empty when none has paired.
   */
  async claudeChromeAccounts(): Promise<Set<string | null>> {
    const found = new Set<string | null>();
    if (await systemClaudeChromePaired(this.deps.env ?? process.env, ...(this.deps.home ? [this.deps.home] : [])).catch(() => false)) found.add(null);
    for (const account of this.settings().claude.accounts) {
      const verdict = this.verify('claude', account.id);
      if (verdict.kind === 'owned' && (await managedClaudeChromePaired(verdict.dir).catch(() => false))) found.add(account.id);
    }
    return found;
  }

  /**
   * Environment additions for launching `agentId` (CLAUDE_CONFIG_DIR / CODEX_HOME and blanked auth variables).
   * `accountId` undefined = the selected account, null = system default. {} for agents without accounts and for the
   * system default. Throws AccountsUserError when the selected account's folder cannot be used (never falls back).
   * This is the `resolveAgentEnv(agentId, env)` hook the terminal host calls before spawning an agent.
   */
  resolveAgentEnv(agentId: string, baseEnv: NodeJS.ProcessEnv = process.env, accountId?: string | null): Record<string, string> {
    if (!isAccountAgent(agentId)) return {};
    return resolveAgentEnvFrom({
      agent: agentId,
      accounts: this.settings(),
      root: this.root,
      baseEnv,
      systemDir: this.systemDir(agentId),
      lang: this.lang(),
      ...(accountId !== undefined ? { accountId } : {}),
    });
  }

  /**
   * The account a tab opens with. undefined = the selected one, null = system default; an id that no longer exists
   * falls back to the selected one (restoring a tab opens it with its previous account when still present).
   * undefined for agents without accounts.
   */
  tabAccountId(agentId: string, requested: string | null | undefined): string | null | undefined {
    if (!isAccountAgent(agentId)) return undefined;
    const list = this.settings()[agentId];
    const known = (id: string | null | undefined): id is string => typeof id === 'string' && list.accounts.some((a) => a.id === id);
    const active = known(list.activeAccountId) ? list.activeAccountId : null;
    if (requested === undefined) return active;
    if (requested === null) return null;
    return known(requested) ? requested : active;
  }

  /**
   * argv / env / title for running the login in a built-in terminal. Only the executable of the configured agent
   * command is used (flags such as permission or trust overrides in the command field are never passed to login).
   */
  loginLaunch(req: AccountLoginRequest): AccountLoginLaunch {
    const lang = this.lang();
    const { agent, accountId } = req;
    if (!isAccountAgent(agent)) throw new AccountsUserError(msg(lang, 'accounts.errors.invalidAgent'));
    if (!isValidAccountId(accountId)) throw new AccountsUserError(msg(lang, 'accounts.errors.invalidId'));
    this.requireAccount(agent, accountId);
    const env = this.resolveAgentEnv(agent, this.deps.env ?? process.env, accountId);
    const exe = this.deps.agentExecutable?.(agent) ?? agent;
    if (!exe) throw new AccountsUserError(msg(lang, 'accounts.errors.noCommand', { agent: AGENT_NAME[agent] }));
    return { argv: [exe, ...LOGIN_ARGS[agent]], env, title: msg(lang, 'accounts.loginTabTitle', { agent: AGENT_NAME[agent] }) };
  }
}
