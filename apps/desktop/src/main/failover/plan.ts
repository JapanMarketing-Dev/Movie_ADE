// Choosing the switch target, and limits on how often switches happen (pure part).
//
// Ported from Ferret src/main/failover/plan.ts (MIT).
//
// Order:
// 1. Another account of the same agent (when switchAccounts is on; Claude Code / Codex only). Accounts considered
//    limited or at/above the threshold are skipped; Claude in Chrome accounts (chrome) first, then lowest usage.
//    Accounts with unknown usage come last.
// 2. From the top of agentOrder, a usable agent other than the current one. For Claude Code / Codex, one of their
//    usable accounts (only the selected account when switchAccounts is off).
// null when nothing is usable (wait for a limit to reset).
import type { AccountAgent } from '../../shared/accounts';
import type { AgentId, LimitFailoverPrefs } from '../../shared/failover';

/** One account. accountId null = system default account. */
export interface AccountCandidate {
  accountId: string | null;
  signedIn: boolean;
  /** highest window (%); null when unknown */
  usedPercent: number | null;
  /** selected */
  active: boolean;
  /**
   * paired with Claude in Chrome (same claude.ai account as the extension; accounts/chromePairing.ts). The extension
   * does not connect to Claude Code on another account, so these are preferred when usable.
   */
  chrome?: boolean;
}

export interface FailoverTarget {
  agent: AgentId;
  /** Claude Code / Codex only. null = system default; undefined = agent without accounts */
  accountId?: string | null;
}

export interface PlanInput {
  prefs: LimitFailoverPrefs;
  /** agent and account that hit the limit */
  from: FailoverTarget;
  /** Claude Code / Codex accounts (accounts waiting for login excluded) */
  accounts: Record<AccountAgent, AccountCandidate[]>;
  /** installed agents */
  available: ReadonlySet<AgentId>;
  /** considered limited until (limitKey → time), from terminal messages and usage */
  limited: ReadonlyMap<string, number>;
  now: number;
}

export function isAccountAgentId(agent: AgentId): agent is AccountAgent {
  return agent === 'claude' || agent === 'codex';
}

/** key under which a limit is remembered */
export function limitKey(target: FailoverTarget): string {
  return isAccountAgentId(target.agent) ? `${target.agent}:${target.accountId ?? 'system'}` : target.agent;
}

function isLimited(input: Pick<PlanInput, 'limited' | 'now'>, target: FailoverTarget): boolean {
  const until = input.limited.get(limitKey(target));
  return until !== undefined && until > input.now;
}

/** The agent's usable accounts, lowest usage first (unknown last; ties: selected first). */
export function usableAccounts(input: PlanInput, agent: AccountAgent, exclude: string | null | undefined = undefined): AccountCandidate[] {
  const threshold = input.prefs.thresholdPercent;
  return input.accounts[agent]
    .filter((a) => a.signedIn && (exclude === undefined || a.accountId !== exclude))
    .filter((a) => !isLimited(input, { agent, accountId: a.accountId }))
    .filter((a) => a.usedPercent === null || a.usedPercent < threshold)
    .sort((a, b) => {
      if (Boolean(a.chrome) !== Boolean(b.chrome)) return a.chrome ? -1 : 1;
      if (a.usedPercent === null && b.usedPercent !== null) return 1;
      if (b.usedPercent === null && a.usedPercent !== null) return -1;
      const diff = (a.usedPercent ?? 0) - (b.usedPercent ?? 0);
      return diff !== 0 ? diff : Number(b.active) - Number(a.active);
    });
}

/** Where to hand over within another agent (null when not usable). */
function agentTarget(input: PlanInput, agent: AgentId): FailoverTarget | null {
  if (!input.available.has(agent)) return null;
  if (!isAccountAgentId(agent)) return isLimited(input, { agent }) ? null : { agent };
  const usable = usableAccounts(input, agent);
  if (input.prefs.switchAccounts) return usable[0] ? { agent, accountId: usable[0].accountId } : null;
  // without account switching, only the selected account is used
  const active = usable.find((a) => a.active);
  return active ? { agent, accountId: active.accountId } : null;
}

export function planFailover(input: PlanInput): FailoverTarget | null {
  const { from, prefs } = input;
  if (prefs.switchAccounts && isAccountAgentId(from.agent)) {
    const next = usableAccounts(input, from.agent, from.accountId ?? null)[0];
    if (next) return { agent: from.agent, accountId: next.accountId };
  }
  for (const agent of prefs.agentOrder) {
    if (agent === from.agent) continue;
    const target = agentTarget(input, agent);
    if (target) return target;
  }
  return null;
}

/**
 * Whether to move back to a higher-priority agent (returnToPreferred): a usable agent ranked before the current one.
 * When the current agent is not in the order, the first usable one.
 */
export function planReturn(input: Omit<PlanInput, 'from'> & { current: AgentId }): FailoverTarget | null {
  const rank = input.prefs.agentOrder.indexOf(input.current);
  const ahead = rank < 0 ? input.prefs.agentOrder : input.prefs.agentOrder.slice(0, rank);
  for (const agent of ahead) {
    const target = agentTarget({ ...input, from: { agent: input.current } }, agent);
    if (target) return target;
  }
  return null;
}

/**
 * The Claude in Chrome account to move back to: when the current account is not a Chrome account and a Chrome account
 * has room. null when none has paired, the current one is paired, or none has room.
 */
export function chromeReturnTarget(input: Omit<PlanInput, 'from'>, agent: AccountAgent, current: string | null): AccountCandidate | null {
  const candidates = input.accounts[agent];
  if (!candidates.some((a) => a.chrome)) return null;
  if (candidates.some((a) => a.chrome && a.accountId === current)) return null;
  const usable = usableAccounts({ ...input, from: { agent, accountId: current } }, agent, current);
  return usable.find((a) => a.chrome) ?? null;
}

// ───────────────────────── how often ─────────────────────────

/** switches allowed per hour (per project) */
export const MAX_SWITCHES_PER_HOUR = 6;
/** shortest gap between consecutive switches */
export const MIN_SWITCH_INTERVAL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

/** Whether a switch is allowed now; otherwise from when. */
export function switchAllowed(history: readonly number[], now: number): { ok: true } | { ok: false; retryAt: number } {
  const recent = history.filter((at) => now - at < HOUR_MS).sort((a, b) => a - b);
  const last = recent[recent.length - 1];
  if (last !== undefined && now - last < MIN_SWITCH_INTERVAL_MS) return { ok: false, retryAt: last + MIN_SWITCH_INTERVAL_MS };
  if (recent.length >= MAX_SWITCHES_PER_HOUR) return { ok: false, retryAt: recent[recent.length - MAX_SWITCHES_PER_HOUR]! + HOUR_MS };
  return { ok: true };
}

/** How long a limit is assumed: until the known reset time, otherwise one hour. */
export const DEFAULT_LIMIT_COOLDOWN_MS = HOUR_MS;

/**
 * Tabs to reopen after the user picks another account: tabs of that agent launched with a different account.
 * Tabs whose launch account is unknown (undefined) count as opened with the system default.
 */
export function tabsToSwitch<T extends { id: string; agent: AgentId | null; launchedAccount: string | null | undefined }>(
  tabs: readonly T[],
  agent: AccountAgent,
  accountId: string | null,
): T[] {
  return tabs.filter((tab) => tab.agent === agent && (tab.launchedAccount ?? null) !== accountId);
}

// ───────────────────────── hand over before the limit ─────────────────────────

export interface RunningTab {
  id: string;
  projectDir: string;
  agent: AccountAgent;
  /** account the tab was launched with (null = system default) */
  accountId: string | null;
}

/**
 * Tabs to hand over before the limit: their account's usage is at or above handoffPercent; tabs already started
 * and projects with a switch in progress (busy) are skipped; one tab per project (switches run one per project).
 * Nothing when handoffPercent ≥ 100.
 */
export function nearLimitTabs(
  tabs: readonly RunningTab[],
  usedPercent: (agent: AccountAgent, accountId: string | null) => number | null,
  handoffPercent: number,
  started: ReadonlySet<string>,
  busy: ReadonlySet<string>,
): RunningTab[] {
  if (handoffPercent >= 100) return [];
  const out: RunningTab[] = [];
  for (const tab of tabs) {
    if (started.has(tab.id) || busy.has(tab.projectDir) || out.some((t) => t.projectDir === tab.projectDir)) continue;
    const used = usedPercent(tab.agent, tab.accountId);
    if (used !== null && used >= handoffPercent) out.push(tab);
  }
  return out;
}
