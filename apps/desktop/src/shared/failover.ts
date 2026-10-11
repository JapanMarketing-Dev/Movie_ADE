// Failover on usage limits (when an agent hits its limit, continue on another account or the next agent).
// Settings type and defaults shared by main and renderer; detection and planning live in src/main/failover/*.
//
// Ported from Ferret src/shared/failover.ts (MIT). Settings live under `agents.*` in ~/.solocut/settings.json:
//   agents.order                      → agentOrder (shared with the rest of the app)
//   agents.failover.enabled           → enabled
//   agents.failover.thresholdPercent  → thresholdPercent
//   agents.failover.switchAccounts    → switchAccounts
//   agents.failover.returnToPreferred → returnToPreferred
//   agents.failover.handoffPercent    → handoffPercent
import type { AccountAgent } from './accounts';

/** Agent id: catalog id (lower-case) or custom:<name>. */
export type AgentId = string;

export interface LimitFailoverPrefs {
  /** switch automatically (default on) */
  enabled: boolean;
  /** an account whose highest window (5h / week / per model) is at or above this percent counts as limited */
  thresholdPercent: number;
  /** try another account of the same agent first (Claude Code / Codex) */
  switchAccounts: boolean;
  /** handoff order (first = preferred). Agents not listed are never handed to */
  agentOrder: AgentId[];
  /** when a higher-priority agent has quota again, move back once the current one is idle (default off) */
  returnToPreferred: boolean;
  /**
   * When the running tab's account reaches this percent, do not wait for the limit message: ask the current
   * agent to write its progress into the handoff file, then continue on the next account / agent in a new tab
   * (keeps unattended overnight runs going). 100 disables the early handoff.
   */
  handoffPercent: number;
}

export const MIN_FAILOVER_THRESHOLD = 50;
export const MAX_FAILOVER_THRESHOLD = 100;

export const DEFAULT_LIMIT_FAILOVER: LimitFailoverPrefs = {
  enabled: true,
  thresholdPercent: 95,
  switchAccounts: true,
  agentOrder: ['claude', 'codex', 'gemini'],
  returnToPreferred: false,
  handoffPercent: 98,
};

/** most agents the order can hold */
const MAX_ORDER = 12;

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && /^([a-z0-9][a-z0-9-]{0,47}|custom:[A-Za-z0-9_.-]{1,48})$/.test(value);
}

function percent(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(MAX_FAILOVER_THRESHOLD, Math.max(MIN_FAILOVER_THRESHOLD, Math.round(v)))
    : fallback;
}

/**
 * Normalises the values read from settings. `failover` is `agents.failover`, `order` is `agents.order`.
 * Unknown values fall back to the defaults.
 */
export function sanitizeLimitFailover(failover: unknown, order?: unknown): LimitFailoverPrefs {
  const r = failover && typeof failover === 'object' && !Array.isArray(failover) ? (failover as Record<string, unknown>) : {};
  const rawOrder = order !== undefined ? order : r.agentOrder;
  return {
    enabled: r.enabled !== false,
    thresholdPercent: percent(r.thresholdPercent, DEFAULT_LIMIT_FAILOVER.thresholdPercent),
    switchAccounts: r.switchAccounts !== false,
    agentOrder: Array.isArray(rawOrder) ? [...new Set(rawOrder.filter(isAgentId))].slice(0, MAX_ORDER) : DEFAULT_LIMIT_FAILOVER.agentOrder,
    returnToPreferred: r.returnToPreferred === true,
    handoffPercent: percent(r.handoffPercent, DEFAULT_LIMIT_FAILOVER.handoffPercent),
  };
}

/** Why a switch happened. */
export type FailoverReason = 'limit-message' | 'usage-threshold' | 'near-limit-handoff' | 'return-to-preferred' | 'account-selected';

/** main → renderer: a switch finished or could not be done (footer and toast). */
export interface FailoverNotice {
  /** one user-facing sentence */
  message: string;
  reason: FailoverReason | null;
  /** agent id and label switched from / to (null when nothing was switched) */
  fromAgent: AgentId | null;
  toAgent: AgentId | null;
  toLabel: string | null;
  /** account switched to (Claude Code / Codex only; null = system default, undefined = agent without accounts) */
  toAccountId?: string | null;
  /** tab opened for the next agent (when done); the UI focuses it */
  toTabId: string | null;
  /** tab that hit the limit; the host closes it after a successful switch */
  fromTabId: string | null;
  at: number;
}

/** Footer status of the failover service. */
export interface FailoverStatus {
  enabled: boolean;
  prefs: LimitFailoverPrefs;
  /** last switch (or failed attempt) */
  last: FailoverNotice | null;
  /** projects currently waiting for quota (no usable account / agent), with the time to retry */
  waiting: { projectDir: string; agent: AgentId; until: number | null }[];
  /** projects with a switch in progress */
  switching: string[];
}

/** account agents among the agent ids */
export function accountAgentOf(agent: AgentId): AccountAgent | null {
  return agent === 'claude' || agent === 'codex' ? agent : null;
}
