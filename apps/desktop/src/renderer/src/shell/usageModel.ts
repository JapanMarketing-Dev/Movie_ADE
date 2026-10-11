// Pure model of agent usage / failover for the status bar and Settings → Accounts (parsing is defensive because the
// main-process side is still being built; see agentUsage.ts). Unit-tested.

/** One rate-limit window (5 hours, weekly …). */
export interface UsageWindow {
  /** short label: '5h', 'week', 'Opus' … */
  label: string;
  /** 0..100 */
  usedPercent: number;
  /** ISO time the window resets */
  resetsAt?: string;
}

export interface AgentUsage {
  agent: string;
  status: 'idle' | 'fetching' | 'ok' | 'unavailable' | 'error';
  windows: UsageWindow[];
  account?: string;
  plan?: string;
  error?: string;
}

export interface FailoverState {
  enabled: boolean;
  /** agent currently used for new work */
  current?: string;
  /** the agent work moves to when `current` hits its limit */
  next?: string;
  /** last hand-off, for the popover */
  last?: { from: string; to: string; at: string; reason?: string };
}

export interface UsageSnapshot {
  available: boolean;
  usage: AgentUsage[];
  failover: FailoverState | null;
}

function clampPercent(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, v));
}

export function parseUsage(raw: unknown): AgentUsage[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { usage?: unknown }).usage) ? (raw as { usage: unknown[] }).usage : [];
  const out: AgentUsage[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const agent = typeof o.agent === 'string' ? o.agent : typeof o.id === 'string' ? o.id : null;
    if (!agent) continue;
    const windows = Array.isArray(o.windows)
      ? o.windows.flatMap((w) => {
          if (!w || typeof w !== 'object') return [];
          const ww = w as Record<string, unknown>;
          const win: UsageWindow = { label: typeof ww.label === 'string' ? ww.label : '', usedPercent: clampPercent(ww.usedPercent) };
          if (typeof ww.resetsAt === 'string') win.resetsAt = ww.resetsAt;
          return [win];
        })
      : [];
    const status = typeof o.status === 'string' && ['idle', 'fetching', 'ok', 'unavailable', 'error'].includes(o.status) ? (o.status as AgentUsage['status']) : windows.length ? 'ok' : 'unavailable';
    const u: AgentUsage = { agent, status, windows };
    if (typeof o.account === 'string') u.account = o.account;
    if (typeof o.plan === 'string') u.plan = o.plan;
    if (typeof o.error === 'string') u.error = o.error;
    out.push(u);
  }
  return out;
}

/** The window closest to its limit (what the status bar shows when narrow). */
export function tightestWindow(u: AgentUsage): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const w of u.windows) if (!best || w.usedPercent > best.usedPercent) best = w;
  return best;
}

/** neutral < 70% ≤ warn < 90% ≤ danger (same thresholds as Ferret's usageTone). */
export function usageTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'ok';
}

/** "2h 05m" / "3d 4h" until reset; '' when unknown or past. */
export function resetIn(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t <= now) return '';
  const min = Math.round((t - now) / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function parseFailover(raw: unknown): FailoverState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return null;
  const f: FailoverState = { enabled: o.enabled };
  if (typeof o.current === 'string') f.current = o.current;
  if (typeof o.next === 'string') f.next = o.next;
  const l = o.last as Record<string, unknown> | undefined;
  if (l && typeof l.from === 'string' && typeof l.to === 'string' && typeof l.at === 'string') {
    f.last = { from: l.from, to: l.to, at: l.at, ...(typeof l.reason === 'string' ? { reason: l.reason } : {}) };
  }
  return f;
}

// ---- the desktop worker's IPC shapes (shared/ipc-accounts.ts: usage:state, usage:meters, failover:status) ----

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function windowOf(label: string, w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  const used = num(o.usedPercent);
  if (used === null) return null;
  const win: UsageWindow = { label, usedPercent: clampPercent(used) };
  const at = num(o.resetsAt);
  if (at !== null) win.resetsAt = new Date(at).toISOString();
  return win;
}

const STATUSES = ['idle', 'fetching', 'ok', 'unavailable', 'error'] as const;

/**
 * `usage:state` (Record<agent, ProviderRateLimits | null>) + `usage:meters` (UsageMeter[]) → one AgentUsage per agent:
 * the 5-hour / weekly / per-model windows from the state, the account label and plan from the meter.
 */
export function usageFromDesktop(state: unknown, meters: unknown): AgentUsage[] {
  const byAgent = new Map<string, AgentUsage>();
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    for (const [agent, raw] of Object.entries(state as Record<string, unknown>)) {
      const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      const status = o && typeof o.status === 'string' && (STATUSES as readonly string[]).includes(o.status) ? (o.status as AgentUsage['status']) : 'idle';
      const windows = o
        ? [windowOf('5h', o.session), windowOf('week', o.weekly), windowOf('Fable', o.fableWeekly), windowOf('$', o.spendLimit)].filter((w): w is UsageWindow => w !== null)
        : [];
      const u: AgentUsage = { agent, status, windows };
      if (o && typeof o.planType === 'string' && o.planType) u.plan = o.planType;
      if (o && typeof o.error === 'string' && o.error) u.error = o.error;
      byAgent.set(agent, u);
    }
  }
  if (Array.isArray(meters)) {
    for (const m of meters) {
      if (!m || typeof m !== 'object') continue;
      const o = m as Record<string, unknown>;
      if (typeof o.agent !== 'string') continue;
      const u = byAgent.get(o.agent) ?? { agent: o.agent, status: 'idle' as const, windows: [] };
      if (typeof o.accountLabel === 'string' && o.accountLabel) u.account = o.accountLabel;
      if (typeof o.plan === 'string' && o.plan) u.plan = o.plan;
      if (!u.error && typeof o.statusLabel === 'string' && o.statusLabel) u.error = o.statusLabel;
      if (u.windows.length === 0) {
        const p = num(o.percent);
        if (p !== null) {
          const w: UsageWindow = { label: typeof o.windowLabel === 'string' ? o.windowLabel : '', usedPercent: clampPercent(p) };
          const at = num(o.resetsAt);
          if (at !== null) w.resetsAt = new Date(at).toISOString();
          u.windows.push(w);
        }
      }
      if (typeof o.status === 'string' && (STATUSES as readonly string[]).includes(o.status) && u.status === 'idle') u.status = o.status as AgentUsage['status'];
      byAgent.set(o.agent, u);
    }
  }
  return [...byAgent.values()];
}

/** `failover:status` (FailoverStatus) → FailoverState. */
export function failoverFromStatus(raw: unknown): FailoverState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return null;
  const f: FailoverState = { enabled: o.enabled };
  const l = o.last && typeof o.last === 'object' ? (o.last as Record<string, unknown>) : null;
  if (l && typeof l.fromAgent === 'string' && typeof l.toAgent === 'string' && num(l.at) !== null) {
    f.last = { from: l.fromAgent, to: l.toAgent, at: new Date(num(l.at)!).toISOString(), ...(typeof l.message === 'string' ? { reason: l.message } : {}) };
    f.current = l.toAgent;
  }
  return f;
}
