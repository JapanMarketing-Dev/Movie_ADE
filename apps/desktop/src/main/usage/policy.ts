// How often usage is refetched and what is shown after a failure (pure part).
//
// Ported from Ferret src/main/usage/policy.ts (MIT).
// Orca由来: ~/bench/orca/src/main/rate-limits/service/service-types.ts（間隔の定数）,
//           ~/bench/orca/src/main/rate-limits/service/service-polling.ts（getActiveWindowRefreshPlan）,
//           ~/bench/orca/src/main/rate-limits/service/service-result-policy.ts（applyStalePolicy / withFetchingStatus）,
//           ~/bench/orca/src/main/rate-limits/service/service-fetch-policy.ts（isRetryAfterActive）（MIT, Copyright 2026 Lovecast Inc.）
import type { AccountAgent } from '../../shared/accounts';
import type { ProviderRateLimits } from '../../shared/usage';

/** background poll interval (15 min) */
export const DEFAULT_POLL_MS = 15 * 60 * 1000;
/** debounce when the window comes to the front or refresh is pressed (5 min) */
export const MIN_REFETCH_MS = 5 * 60 * 1000;
/** shortest retry after a failure (30 s), doubled per consecutive failure, capped at 15 min */
const ACTIVE_FAILURE_REFETCH_MS = 30 * 1000;
const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS;
export const MAX_ACTIVE_FAILURE_STREAK = 6;
/** successful values older than this are not shown after a failure (30 min; 24 h while rate-limited) */
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const RATE_LIMITED_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** refetch interval of the per-account breakdown (60 s) */
export const INACTIVE_FETCH_DEBOUNCE_MS = 60 * 1000;

export function isRetryAfterActive(limits: ProviderRateLimits | null, now: number = Date.now()): boolean {
  return Boolean(limits?.retryAtMs && limits.retryAtMs > now);
}

function hasData(p: ProviderRateLimits | null): boolean {
  return Boolean(p?.session || p?.weekly || p?.fableWeekly || p?.spendLimit || p?.unlimited);
}

/**
 * Turns a new result into the value shown. After a failure a recent successful value stays visible with the status
 * set to error (so the bar does not flip between empty and a value).
 */
export function applyStalePolicy(fresh: ProviderRateLimits, previous: ProviderRateLimits | null, now: number = Date.now()): ProviderRateLimits {
  if (fresh.status === 'ok' || fresh.status === 'unavailable') return fresh;
  if (!previous || !hasData(previous)) return fresh;
  const threshold = fresh.failureKind === 'rate-limited' ? RATE_LIMITED_STALE_THRESHOLD_MS : STALE_THRESHOLD_MS;
  if (now - previous.updatedAt > threshold) return fresh;
  const next: ProviderRateLimits = { ...previous, error: fresh.error, status: 'error' };
  if (fresh.failureKind) next.failureKind = fresh.failureKind;
  else delete next.failureKind;
  if (fresh.retryAtMs) next.retryAtMs = fresh.retryAtMs;
  else delete next.retryAtMs;
  return next;
}

/** Status while fetching; values already shown stay shown (no "…" on every refresh). */
export function withFetchingStatus(current: ProviderRateLimits | null, provider: AccountAgent): ProviderRateLimits {
  if (!current) return { provider, session: null, weekly: null, updatedAt: 0, error: null, status: 'fetching' };
  if (current.status === 'ok' || current.status === 'error' || current.status === 'unavailable') return current;
  return { ...current, status: 'fetching' };
}

/** Delay before the next retry, from the number of consecutive failures. */
export function failureRetryDelayMs(streak: number): number {
  return Math.min(ACTIVE_FAILURE_REFETCH_MS * 2 ** Math.max(0, streak - 1), MAX_ACTIVE_FAILURE_REFETCH_MS);
}

/**
 * Providers to refetch when the window comes to the front:
 * - no value yet, or 5 minutes since success → refetch
 * - failing → wait during Retry-After, otherwise retry after the failure-count based delay
 */
export function providersToRefresh(options: {
  state: Record<AccountAgent, ProviderRateLimits | null>;
  lastFailureRetryAt: Record<AccountAgent, number>;
  failureStreak: Record<AccountAgent, number>;
  now?: number;
}): AccountAgent[] {
  const now = options.now ?? Date.now();
  return (Object.keys(options.state) as AccountAgent[]).filter((provider) => {
    const limits = options.state[provider];
    if (!limits || limits.status === 'idle') return true;
    if (limits.status === 'fetching') return false;
    if (limits.status === 'ok' || limits.status === 'unavailable') return now - limits.updatedAt >= MIN_REFETCH_MS;
    if (isRetryAfterActive(limits, now)) return false;
    return now - options.lastFailureRetryAt[provider] >= failureRetryDelayMs(options.failureStreak[provider]);
  });
}

/**
 * Delay before retrying automatically after a failure; null for no automatic retry. A single failure (a network
 * blip at startup) should not stick, so we retry quietly with growing gaps. Failures that retrying cannot fix or that
 * may trigger an OS prompt are manual-refresh only:
 *   keychain-unavailable … reading the Keychain automatically may show a permission dialog
 *   missing-credentials / stale-token … only fixed by signing in again
 * rate-limited never retries before the server's Retry-After.
 */
export function failureRetryAfterMs(p: ProviderRateLimits, streak: number, now: number = Date.now()): number | null {
  if (p.status !== 'error') return null;
  if (p.failureKind === 'keychain-unavailable' || p.failureKind === 'missing-credentials' || p.failureKind === 'stale-token') return null;
  const delay = failureRetryDelayMs(streak);
  return p.retryAtMs && p.retryAtMs > now ? Math.max(delay, p.retryAtMs - now) : delay;
}
