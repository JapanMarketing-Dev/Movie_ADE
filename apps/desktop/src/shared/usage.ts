// Claude Code / Codex usage (rate limits): types shared by main and renderer, plus pure display helpers.
//
// Ported from Ferret src/shared/usage.ts (MIT).
// Orca由来: ~/bench/orca/src/shared/rate-limit-types.ts,
//           ~/bench/orca/src/shared/rate-limit-reset-format.ts,
//           ~/bench/orca/src/renderer/src/lib/window-label-formatter.ts,
//           ~/bench/orca/src/renderer/src/components/status-bar/tooltip.tsx（getWindowSections / barColor の閾値）,
//           ~/bench/orca/src/renderer/src/components/status-bar/UsageRosterPanel.tsx（getTightestUsageSection）（MIT, Copyright 2026 Lovecast Inc.）
// Only Claude and Codex are fetched; monthly windows and buckets are not carried over.
import type { AccountAgent } from './accounts';
import type { Lang } from './types';

export interface RateLimitWindow {
  /** share of the window used (0–100) */
  usedPercent: number;
  /** window length in minutes: 300 = 5 hours, 10080 = 1 week */
  windowMinutes: number;
  /** when the window resets (Unix ms), null when unknown */
  resetsAt: number | null;
}

export type ProviderRateLimitStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable';

/** Failure kinds (the subset of Orca's UsageRateLimitFailureKind that can happen here). */
export type UsageFailureKind =
  | 'missing-credentials' | 'stale-token' | 'keychain-unavailable' | 'network' | 'server' | 'rate-limited' | 'unknown';

export interface ProviderRateLimits {
  provider: AccountAgent;
  /** 5-hour window */
  session: RateLimitWindow | null;
  /** 1-week window */
  weekly: RateLimitWindow | null;
  /** Claude per-model (Fable) weekly window */
  fableWeekly?: RateLimitWindow | null;
  /** Codex Business per-member spend limit (no period: windowMinutes 0, resetsAt null) */
  spendLimit?: RateLimitWindow | null;
  /** plans without limits (Codex Business credits.unlimited); no windows is not a failure then */
  unlimited?: boolean;
  /** Codex plan ("plus" …) */
  planType?: string | null;
  /** last successful fetch (Unix ms) */
  updatedAt: number;
  /** user-facing failure reason; null on success */
  error: string | null;
  status: ProviderRateLimitStatus;
  failureKind?: UsageFailureKind;
  /** do not refetch before this time (HTTP Retry-After, Unix ms) */
  retryAtMs?: number;
}

export type UsageState = Record<AccountAgent, ProviderRateLimits | null>;

/** One row of the per-account breakdown. accountId null = the system default account. */
export interface AccountUsage {
  accountId: string | null;
  label: string;
  active: boolean;
  rateLimits: ProviderRateLimits | null;
}

/** yellow / red thresholds (same as Orca: 60 / 80) */
const USAGE_WARNING_PERCENT = 60;
const USAGE_URGENT_PERCENT = 80;

export function clampUsedPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)));
}

export type UsageTone = 'normal' | 'warning' | 'urgent';

export function usageTone(usedPercent: number): UsageTone {
  const used = clampUsedPercent(usedPercent);
  return used >= USAGE_URGENT_PERCENT ? 'urgent' : used >= USAGE_WARNING_PERCENT ? 'warning' : 'normal';
}

/** "3h 5m" / "6d 23h" / "now" (same as Orca's formatResetDuration) */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMins = Math.floor(ms / 60_000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** "Resets in 3h 54m" / "Resets now" (ja: "あと 3h 54m で回復" / "まもなく回復") */
export function formatResetCountdown(ms: number, lang: Lang = 'en'): string {
  const duration = formatResetDuration(ms);
  if (lang === 'ja') return duration === 'now' ? 'まもなく回復' : `あと ${duration} で回復`;
  return duration === 'now' ? 'Resets now' : `Resets in ${duration}`;
}

/** short window name (5h / wk …) */
export function formatWindowLabel(windowMinutes: number): string {
  // limits without a period (Codex Business spend)
  if (windowMinutes <= 0) return '$';
  if (windowMinutes === 10080) return 'wk';
  if (windowMinutes === 300) return '5h';
  if (windowMinutes === 60) return '1h';
  if (windowMinutes < 60) return `${windowMinutes}m`;
  if (windowMinutes % (60 * 24 * 7) === 0) return `${windowMinutes / (60 * 24 * 7)}wk`;
  if (windowMinutes % (60 * 24) === 0) return `${windowMinutes / (60 * 24)}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/** Footer chip label: time left when the reset time is known, otherwise the window length. */
export function formatWindowChipLabel(window: RateLimitWindow, now: number = Date.now()): string {
  return window.resetsAt != null ? formatResetDuration(window.resetsAt - now) : formatWindowLabel(window.windowMinutes);
}

export interface UsageSection {
  key: 'session' | 'weekly' | 'fableWeekly' | 'spend';
  /** 5h / wk / Fable / $ */
  label: string;
  window: RateLimitWindow;
}

/** The windows that have data, ordered 5h → week → Fable → spend. */
export function usageSections(p: ProviderRateLimits): UsageSection[] {
  const sections: UsageSection[] = [];
  if (p.session) sections.push({ key: 'session', label: formatWindowLabel(p.session.windowMinutes), window: p.session });
  if (p.weekly) sections.push({ key: 'weekly', label: formatWindowLabel(p.weekly.windowMinutes), window: p.weekly });
  if (p.fableWeekly) sections.push({ key: 'fableWeekly', label: 'Fable', window: p.fableWeekly });
  if (p.spendLimit) sections.push({ key: 'spend', label: '$', window: p.spendLimit });
  return sections;
}

/** The most used window (compact footer display and bar color). */
export function tightestUsageSection(p: ProviderRateLimits): UsageSection | null {
  const sections = usageSections(p);
  if (sections.length === 0) return null;
  return sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent) ? candidate : current,
  );
}

/** "Resets in …" for the window that resets first. */
export function soonestResetLabel(p: ProviderRateLimits, now: number = Date.now(), lang: Lang = 'en'): string | null {
  const resets = usageSections(p)
    .map((s) => s.window.resetsAt)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
  return resets.length > 0 ? formatResetCountdown(Math.min(...resets) - now, lang) : null;
}

const STATUS_LABEL: Record<Lang, Record<string, string>> = {
  ja: {
    loading: '読み込み中…',
    unavailable: '取得できません',
    notLoggedIn: '未ログイン',
    staleToken: '再ログインが必要',
    keychain: 'キーチェーンを確認',
    network: '接続できません',
    rateLimited: '少し待って再取得',
    failed: '取得に失敗',
  },
  en: {
    loading: 'Loading…',
    unavailable: 'Unavailable',
    notLoggedIn: 'Not signed in',
    staleToken: 'Sign in again',
    keychain: 'Check Keychain',
    network: 'Offline',
    rateLimited: 'Retrying later',
    failed: 'Failed',
  },
};

/** Short status when no numbers can be shown (simplified Orca getProviderUsageStatusLabel). */
export function usageStatusLabel(p: ProviderRateLimits, lang: Lang = 'en'): string {
  const l = STATUS_LABEL[lang];
  if (p.status === 'idle' || p.status === 'fetching') return l.loading!;
  if (p.status === 'unavailable') return l.unavailable!;
  if (p.status === 'ok' && p.unlimited) return '∞';
  switch (p.failureKind) {
    case 'missing-credentials':
      return l.notLoggedIn!;
    case 'stale-token':
      return l.staleToken!;
    case 'keychain-unavailable':
      return l.keychain!;
    case 'network':
      return l.network!;
    case 'rate-limited':
      return l.rateLimited!;
    default:
      return l.failed!;
  }
}

/** "plus" → "Plus", "chatgpt_business" → "ChatGPT Business" */
export function formatPlanLabel(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[\s_-]+/)
    .map((word) => {
      const normalized = word.toLowerCase();
      return normalized === 'chatgpt' ? 'ChatGPT' : normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(' ');
}


/** One footer meter: the tightest window of the selected account of an agent. */
export interface UsageMeter {
  agent: AccountAgent;
  /** selected account (null = system default) and its display name */
  accountId: string | null;
  accountLabel: string;
  /** used percent of the tightest window (0–100); null when no numbers are available */
  percent: number | null;
  /** 5h / wk / Fable / $ */
  windowLabel: string | null;
  /** when the tightest window resets (Unix ms) */
  resetsAt: number | null;
  /** "Plus", "ChatGPT Business" … (Codex) */
  plan: string | null;
  tone: UsageTone;
  status: ProviderRateLimitStatus | 'idle';
  /** short label when no numbers can be shown ("Not signed in" …); null otherwise */
  statusLabel: string | null;
  /** user-facing error sentence (tooltip) */
  error: string | null;
}

/** Footer meter for one agent from the usage state. */
export function usageMeter(
  agent: AccountAgent,
  limits: ProviderRateLimits | null,
  account: { accountId: string | null; label: string },
  lang: Lang = 'en',
): UsageMeter {
  const tight = limits ? tightestUsageSection(limits) : null;
  const percent = tight ? clampUsedPercent(tight.window.usedPercent) : null;
  return {
    agent,
    accountId: account.accountId,
    accountLabel: account.label,
    percent,
    windowLabel: tight?.label ?? null,
    resetsAt: tight?.window.resetsAt ?? null,
    plan: formatPlanLabel(limits?.planType),
    tone: percent === null ? 'normal' : usageTone(percent),
    status: limits?.status ?? 'idle',
    statusLabel: !limits ? null : tight && limits.status !== 'error' ? null : usageStatusLabel(limits, lang),
    error: limits?.error ?? null,
  };
}
