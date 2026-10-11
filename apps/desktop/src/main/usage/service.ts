// Fetches and keeps usage (the source of the footer's usage meters).
//
// Ported from Ferret src/main/usage/service.ts (MIT).
// Orca由来: ~/bench/orca/src/main/rate-limits/service.ts,
//           ~/bench/orca/src/main/rate-limits/service/service-polling.ts,
//           ~/bench/orca/src/main/rate-limits/service/service-inactive-accounts.ts,
//           ~/bench/orca/src/main/rate-limits/claude-managed-account-usage.ts（MIT, Copyright 2026 Lovecast Inc.）
//
// Same as Orca:
// - the selected account (system default included) is fetched every 15 minutes, only while the window is active
// - when the window comes to the front, only stale and failed values are refetched
// - the per-account breakdown is fetched only when opened (not again within 60 s)
// - switching accounts refetches right away
// Nothing is read before the UI first asks (refresh): Claude credentials live in the Keychain and are not touched
// unless usage is shown.
import { dedupeAccountRows, accountDisplayName, ACCOUNT_AGENTS, systemDefaultLabel, type AccountAgent, type AgentAccountsSettings } from '../../shared/accounts';
import { errorKind, reportHandled } from '../../shared/report';
import type { Lang } from '../../shared/types';
import type { AccountUsage, ProviderRateLimits, UsageState } from '../../shared/usage';
import type { AccountIdentity } from '../accounts/identity';
import { msg } from '../accounts/messages';
import { verifyManagedAccountDir } from '../accounts/paths';
import { fetchClaudeUsage, fetchCodexUsage, type UsageRequest } from './fetchers';
import {
  DEFAULT_POLL_MS,
  INACTIVE_FETCH_DEBOUNCE_MS,
  MAX_ACTIVE_FAILURE_STREAK,
  applyStalePolicy,
  failureRetryAfterMs,
  isRetryAfterActive,
  providersToRefresh,
  withFetchingStatus,
} from './policy';

/** Where an account's credentials live: key identifies the account, dir is its config folder (undefined = Claude default). */
export interface UsageTarget {
  key: string;
  dir: string | undefined;
}

/** What the usage service needs from the accounts service. */
export interface UsageAccountsSource {
  /** ~/.solocut/accounts */
  root: string;
  settings(): AgentAccountsSettings;
  systemDir(agent: AccountAgent): string;
  readSystemDefault(agent: AccountAgent): Promise<AccountIdentity>;
}

export interface UsageDeps {
  accounts: UsageAccountsSource;
  /** HTTP; defaults to fetch without following redirects (the request carries an OAuth token) */
  request?: UsageRequest;
  language?: () => Lang;
  /** whether the main window is visible, not minimized and focused (no background polling otherwise) */
  isActive?: () => boolean;
  /** called on every state change (IPC event usage:changed) */
  emit?: (state: UsageState) => void;
  /** replaces the network fetch (tests, demo data) */
  fetch?: (agent: AccountAgent, target: UsageTarget | null, force: boolean) => Promise<ProviderRateLimits>;
  env?: NodeJS.ProcessEnv;
}

const defaultRequest: UsageRequest = (url, init) => fetch(url, { ...init, redirect: 'error' });

export class UsageService {
  private state: UsageState = { claude: null, codex: null };
  /** which account `state` belongs to (detects switches) */
  private readonly stateKey: Record<AccountAgent, string | null> = { claude: null, codex: null };
  private readonly inFlight: Partial<Record<AccountAgent, Promise<void>>> = {};
  private readonly lastFailureRetryAt: Record<AccountAgent, number> = { claude: 0, codex: 0 };
  private readonly failureStreak: Record<AccountAgent, number> = { claude: 0, codex: 0 };
  /** per-account breakdown cache (agent:accountKey) */
  private readonly inactiveCache = new Map<string, ProviderRateLimits>();
  private readonly retryTimers: Partial<Record<AccountAgent, NodeJS.Timeout>> = {};
  private timer: NodeJS.Timeout | null = null;
  /** whether the footer has asked for usage at least once; no polling before that */
  private started = false;
  private readonly listeners = new Set<(state: UsageState) => void>();

  constructor(private readonly deps: UsageDeps) {}

  private lang(): Lang {
    return this.deps.language?.() ?? 'ja';
  }

  private active(): boolean {
    return this.deps.isActive?.() ?? true;
  }

  /** Subscribe to state changes (the failover service listens here). */
  onChange(cb: (state: UsageState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The account's config folder; accountId null = system default. null when the managed folder cannot be verified. */
  targetFor(agent: AccountAgent, accountId: string | null): UsageTarget | null {
    if (accountId) {
      const verdict = verifyManagedAccountDir({ root: this.deps.accounts.root, agent, accountId, systemDir: this.deps.accounts.systemDir(agent) });
      return verdict.kind === 'owned' ? { key: accountId, dir: verdict.dir } : null;
    }
    if (agent === 'codex') return { key: 'system', dir: this.deps.accounts.systemDir('codex') };
    // Claude's default: an inherited CLAUDE_CONFIG_DIR, else the unsuffixed Keychain item and ~/.claude
    const inherited = (this.deps.env ?? process.env).CLAUDE_CONFIG_DIR?.trim();
    return { key: 'system', dir: inherited || undefined };
  }

  private activeAccountId(agent: AccountAgent): string | null {
    const list = this.deps.accounts.settings()[agent];
    return list.accounts.some((a) => a.id === list.activeAccountId) ? list.activeAccountId : null;
  }

  private fetchFor(agent: AccountAgent, target: UsageTarget | null, force = false): Promise<ProviderRateLimits> {
    if (this.deps.fetch) return this.deps.fetch(agent, target, force);
    const lang = this.lang();
    if (!target) {
      return Promise.resolve({
        provider: agent,
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: msg(lang, 'usage.errors.accountFolderUnusable'),
        status: 'error',
        failureKind: 'missing-credentials',
      });
    }
    const request = this.deps.request ?? defaultRequest;
    return agent === 'claude'
      ? fetchClaudeUsage(request, target.dir, { retryKeychain: force, lang })
      : fetchCodexUsage(request, target.dir!, { lang });
  }

  private setState(agent: AccountAgent, next: ProviderRateLimits | null): void {
    this.state = { ...this.state, [agent]: next };
    this.deps.emit?.(this.state);
    for (const cb of this.listeners) {
      try {
        cb(this.state);
      } catch (err) {
        reportHandled(errorKind(err), { area: 'usage', op: 'notify usage listener' });
      }
    }
  }

  private async fetchProvider(agent: AccountAgent, force = false): Promise<void> {
    const running = this.inFlight[agent];
    if (running) return running;
    const work = (async () => {
      const accountId = this.activeAccountId(agent);
      const target = this.targetFor(agent, accountId);
      const key = target?.key ?? `broken:${accountId}`;
      // never carry another account's values
      if (this.stateKey[agent] !== key) {
        this.stateKey[agent] = key;
        this.state = { ...this.state, [agent]: null };
        // drop the previous account's pending retry
        this.cancelFailureRetry(agent);
      }
      this.setState(agent, withFetchingStatus(this.state[agent], agent));
      const fresh = await this.fetchFor(agent, target, force);
      if (this.stateKey[agent] !== key) return;
      if (fresh.status === 'error') {
        this.failureStreak[agent] = Math.min(this.failureStreak[agent] + 1, MAX_ACTIVE_FAILURE_STREAK);
        this.lastFailureRetryAt[agent] = Date.now();
      } else {
        this.failureStreak[agent] = 0;
      }
      const shown = applyStalePolicy(fresh, this.state[agent]);
      this.setState(agent, shown);
      this.scheduleFailureRetry(agent, fresh);
      if (shown.status === 'ok') this.inactiveCache.set(`${agent}:${key}`, shown);
    })();
    this.inFlight[agent] = work;
    try {
      await work;
    } finally {
      this.inFlight[agent] = undefined;
    }
  }

  private cancelFailureRetry(agent: AccountAgent): void {
    const pending = this.retryTimers[agent];
    if (pending) clearTimeout(pending);
    this.retryTimers[agent] = undefined;
  }

  /** Automatic retry of a failed provider (one per agent), cancelled by success, switch or stop. */
  private scheduleFailureRetry(agent: AccountAgent, fresh: ProviderRateLimits): void {
    this.cancelFailureRetry(agent);
    const delay = failureRetryAfterMs(fresh, this.failureStreak[agent]);
    if (delay === null) return;
    const handle = setTimeout(() => {
      this.retryTimers[agent] = undefined;
      // in the background, leave it to refreshStale when the window comes back (same as Orca)
      if (this.started && this.active()) void this.fetchProvider(agent);
    }, delay);
    handle.unref?.();
    this.retryTimers[agent] = handle;
  }

  /** Refetches only stale / failed values and agents whose account changed. */
  private async refreshStale(): Promise<void> {
    const switched = ACCOUNT_AGENTS.filter(
      (agent) => this.stateKey[agent] !== null && this.stateKey[agent] !== (this.targetFor(agent, this.activeAccountId(agent))?.key ?? null),
    );
    const due = providersToRefresh({ state: this.state, lastFailureRetryAt: this.lastFailureRetryAt, failureStreak: this.failureStreak });
    await Promise.all([...new Set([...switched, ...due])].map((agent) => this.fetchProvider(agent)));
  }

  getState(): UsageState {
    return this.state;
  }

  /**
   * Refresh. force passes the 5-minute debounce (still waits for Retry-After); otherwise only stale values and
   * switched accounts. The first call starts the service.
   */
  async refresh(force: boolean): Promise<UsageState> {
    this.started = true;
    if (force) for (const agent of ACCOUNT_AGENTS) this.cancelFailureRetry(agent);
    if (force) await Promise.all(ACCOUNT_AGENTS.filter((agent) => !isRetryAfterActive(this.state[agent])).map((agent) => this.fetchProvider(agent, true)));
    else await this.refreshStale();
    return this.state;
  }

  /** The account changed: refetch right away when the UI has started the service. */
  accountChanged(): void {
    if (this.started) void this.refreshStale().catch((err: unknown) => reportHandled(errorKind(err), { area: 'usage', op: 'refresh after switch' }));
  }

  /** Per-account breakdown (system default + added accounts); called only when opened. */
  async accountUsage(agent: AccountAgent, force = false): Promise<AccountUsage[]> {
    const lang = this.lang();
    const list = this.deps.accounts.settings()[agent];
    const active = this.activeAccountId(agent);
    // the system default and a registered account with the same login become one row (also an account added twice)
    const system = await this.deps.accounts.readSystemDefault(agent).catch(() => null);
    const rows = dedupeAccountRows(
      [
        { accountId: null as string | null, label: systemDefaultLabel(lang), email: system?.signedIn ? system.email : null, workspaceLabel: system?.workspaceLabel ?? null },
        ...list.accounts
          .filter((a) => a.lastAuthenticatedAt !== null)
          .map((a) => ({ accountId: a.id as string | null, label: accountDisplayName(a, lang), email: a.email, workspaceLabel: a.workspaceLabel })),
      ],
      active,
    );
    return Promise.all(
      rows.map(async ({ accountId, label }): Promise<AccountUsage> => {
        const isActive = accountId === active;
        const target = this.targetFor(agent, accountId);
        const cacheKey = `${agent}:${target?.key ?? `broken:${accountId}`}`;
        let rateLimits: ProviderRateLimits | null;
        const current = this.state[agent];
        if (isActive && current && this.stateKey[agent] === (target?.key ?? `broken:${accountId}`)) rateLimits = current;
        else {
          const cached = this.inactiveCache.get(cacheKey) ?? null;
          if (cached && !force && Date.now() - cached.updatedAt < INACTIVE_FETCH_DEBOUNCE_MS) rateLimits = cached;
          else {
            rateLimits = applyStalePolicy(await this.fetchFor(agent, target, force), cached);
            if (rateLimits.status === 'ok') this.inactiveCache.set(cacheKey, rateLimits);
          }
        }
        return { accountId, label, active: isActive, rateLimits };
      }),
    );
  }

  /** The main window came to the front (focus / show / restore). */
  windowActivated(): void {
    if (this.started) void this.refreshStale().catch((err: unknown) => reportHandled(errorKind(err), { area: 'usage', op: 'refresh on focus' }));
  }

  /** Starts the 15-minute poll (fetches only after the UI asked once and while the window is active). */
  start(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.started && this.active()) void this.refreshStale().catch((err: unknown) => reportHandled(errorKind(err), { area: 'usage', op: 'poll usage' }));
    }, DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const agent of ACCOUNT_AGENTS) this.cancelFailureRetry(agent);
    this.listeners.clear();
  }
}
