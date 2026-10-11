// Reads Claude / Codex usage from their official endpoints.
//
// Ported from Ferret src/main/usage/fetchers.ts (MIT).
// Orca由来: ~/bench/orca/src/main/rate-limits/claude-oauth-usage-request.ts,
//           ~/bench/orca/src/main/rate-limits/claude-oauth-usage-error.ts,
//           ~/bench/orca/src/main/rate-limits/claude-usage-window.ts,
//           ~/bench/orca/src/main/rate-limits/codex-backend-usage-client.ts,
//           ~/bench/orca/src/main/rate-limits/codex-rate-limit-window-classification.ts,
//           ~/bench/orca/src/main/rate-limits/codex-rate-limit-window-mapper.ts（MIT, Copyright 2026 Lovecast Inc.）
//
// Orca falls back to reading /usage from a hidden Claude Code PTY and tries Codex's app-server RPC first; Solocut
// keeps the single HTTP path (no extra child processes). Tokens go only into the Authorization header; response
// bodies of failures are never read (they may echo the token).
import type { AccountAgent } from '../../shared/accounts';
import { errorKind, reportHandled } from '../../shared/report';
import type { Lang } from '../../shared/types';
import type { ProviderRateLimits, RateLimitWindow, UsageFailureKind } from '../../shared/usage';
import { msg } from '../accounts/messages';
import { readClaudeAccessToken, readCodexAccessToken } from './credentials';

export type UsageRequest = (url: string, init: RequestInit) => Promise<Response>;

const API_TIMEOUT_MS = 10_000;
/** cap so a broken Retry-After never stops fetching for days */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** usage responses are small JSON */
export const USAGE_JSON_MAX_BYTES = 1024 * 1024;

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const SESSION_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

const NAME: Record<AccountAgent, string> = { claude: 'Claude', codex: 'Codex' };

function failure(provider: AccountAgent, failureKind: UsageFailureKind, error: string, retryAtMs?: number): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    failureKind,
    ...(retryAtMs ? { retryAtMs } : {}),
  };
}

export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
  const dateMs = Date.parse(header);
  if (!Number.isFinite(dateMs)) return null;
  const delta = dateMs - now;
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null;
}

/** HTTP failure → user-facing sentence and kind (the body is not read: it may contain the token). */
function httpFailure(provider: AccountAgent, response: Response, lang: Lang): ProviderRateLimits {
  const name = NAME[provider];
  if (response.status === 429) {
    const retry = parseRetryAfterMs(response.headers.get('retry-after'));
    return failure(provider, 'rate-limited', msg(lang, 'usage.errors.rateLimited', { name }), retry ? Date.now() + retry : undefined);
  }
  if (response.status === 401 || response.status === 403) {
    return failure(provider, 'stale-token', msg(lang, 'usage.errors.staleToken', { name }));
  }
  return failure(provider, response.status >= 500 ? 'server' : 'unknown', msg(lang, 'usage.errors.http', { name, status: response.status }));
}

function networkFailure(provider: AccountAgent, lang: Lang): ProviderRateLimits {
  return failure(provider, 'network', msg(lang, 'usage.errors.network', { name: NAME[provider] }));
}

/** Reads at most maxBytes of the body and parses it as JSON (huge responses are cut off, not buffered). */
export async function readBoundedJson(res: Response, maxBytes: number = USAGE_JSON_MAX_BYTES): Promise<unknown> {
  const declared = res.headers.get('content-length');
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new RangeError('response too large');
  }
  if (!res.body) throw new SyntaxError('empty body');
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) throw new RangeError('response too large');
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
  } finally {
    // stop the connection when we quit early (no-op after a full read)
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
}

// ───────────────────────── Claude ─────────────────────────

type ClaudeUsageWindowInput = { utilization?: number; used_percentage?: number; resets_at?: string | number };

/** Seconds or milliseconds (told apart at 1e10, same as Orca). */
export function parseResetTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 10_000_000_000 ? value : value * 1000) : null;
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== '') return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function mapClaudeUsageWindow(raw: ClaudeUsageWindowInput | undefined, windowMinutes: number): RateLimitWindow | null {
  if (!raw) return null;
  const used = typeof raw.utilization === 'number' ? raw.utilization : typeof raw.used_percentage === 'number' ? raw.used_percentage : null;
  if (used === null) return null;
  return { usedPercent: Math.min(100, Math.max(0, used)), windowMinutes, resetsAt: parseResetTimestamp(raw.resets_at) };
}

export type ClaudeUsageResponse = {
  five_hour?: ClaudeUsageWindowInput;
  seven_day?: ClaudeUsageWindowInput;
  fable_weekly?: ClaudeUsageWindowInput;
  fable_seven_day?: ClaudeUsageWindowInput;
  seven_day_fable?: ClaudeUsageWindowInput;
  limits?: Array<{ kind?: string; percent?: number; resets_at?: string | number; scope?: { model?: { display_name?: string } | null } | null }> | null;
};

/** Per-model (Fable) weekly window: the newer limits[] shape and the older key names. */
function mapClaudeFableWindow(data: ClaudeUsageResponse): RateLimitWindow | null {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (l) => l?.kind === 'weekly_scoped' && Number.isFinite(l.percent) && l.scope?.model?.display_name?.trim().toLowerCase() === 'fable',
      )
    : undefined;
  return (
    mapClaudeUsageWindow(scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : undefined, WEEKLY_MINUTES) ??
    mapClaudeUsageWindow(data.fable_weekly, WEEKLY_MINUTES) ??
    mapClaudeUsageWindow(data.fable_seven_day, WEEKLY_MINUTES) ??
    mapClaudeUsageWindow(data.seven_day_fable, WEEKLY_MINUTES)
  );
}

export function mapClaudeUsageResponse(data: ClaudeUsageResponse): ProviderRateLimits {
  return {
    provider: 'claude',
    session: mapClaudeUsageWindow(data.five_hour, SESSION_MINUTES),
    weekly: mapClaudeUsageWindow(data.seven_day, WEEKLY_MINUTES),
    fableWeekly: mapClaudeFableWindow(data),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
  };
}

/**
 * configDir omitted = the system default account. retryKeychain is true only for a manual refresh (retries a Keychain
 * item that could not be read before).
 */
export async function fetchClaudeUsage(
  request: UsageRequest,
  configDir?: string,
  options: { retryKeychain?: boolean; lang?: Lang } = {},
): Promise<ProviderRateLimits> {
  const lang = options.lang ?? 'ja';
  const credential = await readClaudeAccessToken(configDir, { retryBlocked: options.retryKeychain ?? false });
  if (credential.token === null) {
    return credential.reason === 'keychain-unavailable'
      ? failure('claude', 'keychain-unavailable', msg(lang, 'usage.errors.keychain'))
      : failure('claude', 'missing-credentials', msg(lang, 'usage.errors.claudeNotLoggedIn'));
  }
  let response: Response;
  try {
    response = await request(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return networkFailure('claude', lang);
  }
  if (!response.ok) return httpFailure('claude', response, lang);
  try {
    return mapClaudeUsageResponse((await readBoundedJson(response)) as ClaudeUsageResponse);
  } catch (err) {
    // the API shape changed; the body is never sent
    reportHandled(errorKind(err), { area: 'usage', op: 'parse claude usage' });
    return failure('claude', 'unknown', msg(lang, 'usage.errors.badFormat', { name: 'Claude' }));
  }
}

// ───────────────────────── Codex ─────────────────────────

type CodexBackendWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number };
export type CodexUsageResponse = {
  plan_type?: string;
  rate_limit?: { primary_window?: CodexBackendWindow | null; secondary_window?: CodexBackendWindow | null } | null;
  /** Business: per-member spend limit (Orca #8664) */
  spend_control?: { individual_limit?: { used_percent?: number } | null } | null;
  /** Business without limits: windows are null and credits.unlimited is true (Orca #15764) */
  credits?: { unlimited?: boolean } | null;
};

function codexWindow(raw: CodexBackendWindow | null | undefined): (RateLimitWindow & { durationKnown: boolean }) | null {
  if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null;
  const seconds = raw.limit_window_seconds;
  const minutes = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null;
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: minutes ?? 0,
    // Codex returns seconds
    resetsAt: typeof raw.reset_at === 'number' && Number.isFinite(raw.reset_at) && raw.reset_at > 0 ? raw.reset_at * 1000 : null,
    durationKnown: minutes !== null,
  };
}

/** Within one minute counts as 5 hours / a week (older Codex values; same as Orca). */
function classifyMinutes(minutes: number): 'session' | 'weekly' | null {
  if (Math.abs(minutes - SESSION_MINUTES) <= 1) return 'session';
  if (Math.abs(minutes - WEEKLY_MINUTES) <= 1) return 'weekly';
  return null;
}

export function mapCodexUsageResponse(payload: CodexUsageResponse): ProviderRateLimits | null {
  if (typeof payload.plan_type !== 'string') return null;
  const primary = codexWindow(payload.rate_limit?.primary_window);
  const secondary = codexWindow(payload.rate_limit?.secondary_window);
  let session: RateLimitWindow | null = null;
  let weekly: RateLimitWindow | null = null;
  for (const w of [primary, secondary]) {
    if (!w) continue;
    const kind = classifyMinutes(w.windowMinutes);
    if (kind === 'session' && !session) session = { ...w, windowMinutes: SESSION_MINUTES };
    else if (kind === 'weekly' && !weekly) weekly = { ...w, windowMinutes: WEEKLY_MINUTES };
  }
  // windows of unknown length: primary = 5 hours, secondary = week (Orca's legacy handling)
  if (!session && primary && classifyMinutes(primary.windowMinutes) === null) {
    session = { ...primary, windowMinutes: primary.durationKnown ? primary.windowMinutes : SESSION_MINUTES };
  }
  if (!weekly && secondary && classifyMinutes(secondary.windowMinutes) === null) {
    weekly = { ...secondary, windowMinutes: secondary.durationKnown ? secondary.windowMinutes : WEEKLY_MINUTES };
  }
  const strip = (w: RateLimitWindow | null): RateLimitWindow | null => (w ? { usedPercent: w.usedPercent, windowMinutes: w.windowMinutes, resetsAt: w.resetsAt } : null);
  const spent = payload.spend_control?.individual_limit?.used_percent;
  const spendLimit = typeof spent === 'number' && Number.isFinite(spent) ? { usedPercent: Math.min(100, Math.max(0, spent)), windowMinutes: 0, resetsAt: null } : null;
  const unlimited = !session && !weekly && !spendLimit && payload.credits?.unlimited === true;
  return {
    provider: 'codex',
    session: strip(session),
    weekly: strip(weekly),
    ...(spendLimit ? { spendLimit } : {}),
    ...(unlimited ? { unlimited } : {}),
    planType: payload.plan_type,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
  };
}

export async function fetchCodexUsage(request: UsageRequest, codexHome: string, options: { lang?: Lang } = {}): Promise<ProviderRateLimits> {
  const lang = options.lang ?? 'ja';
  const credential = await readCodexAccessToken(codexHome);
  if (credential.token === null) return failure('codex', 'missing-credentials', msg(lang, 'usage.errors.codexNotLoggedIn'));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;
  let response: Response;
  try {
    response = await request(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch {
    return networkFailure('codex', lang);
  }
  if (!response.ok) return httpFailure('codex', response, lang);
  try {
    return mapCodexUsageResponse((await readBoundedJson(response)) as CodexUsageResponse) ?? failure('codex', 'unknown', msg(lang, 'usage.errors.badFormat', { name: 'Codex' }));
  } catch (err) {
    reportHandled(errorKind(err), { area: 'usage', op: 'parse codex usage' });
    return failure('codex', 'unknown', msg(lang, 'usage.errors.badFormat', { name: 'Codex' }));
  }
}
