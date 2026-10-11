// Ported from Ferret test/unit/usage.test.ts (MIT), plus fetchers with a fake HTTP request and the service with a
// fake fetch. No network, no Keychain.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPlanLabel,
  formatResetCountdown,
  formatResetDuration,
  formatWindowChipLabel,
  soonestResetLabel,
  tightestUsageSection,
  usageMeter,
  usageSections,
  usageStatusLabel,
  usageTone,
  type ProviderRateLimits,
} from '../src/shared/usage';
import {
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  fetchCodexUsage,
  mapClaudeUsageResponse,
  mapCodexUsageResponse,
  parseResetTimestamp,
  parseRetryAfterMs,
  readBoundedJson,
  type UsageRequest,
} from '../src/main/usage/fetchers';
import {
  MIN_REFETCH_MS,
  STALE_THRESHOLD_MS,
  applyStalePolicy,
  failureRetryAfterMs,
  failureRetryDelayMs,
  providersToRefresh,
  withFetchingStatus,
} from '../src/main/usage/policy';
import { createKeychainReader, parseClaudeCredentials, readCodexAccessToken } from '../src/main/usage/credentials';
import { UsageService, type UsageTarget } from '../src/main/usage/service';
import { type AccountAgent, type AgentAccountsSettings } from '../src/shared/accounts';
import { MANAGED_ACCOUNT_MARKER } from '../src/main/accounts/paths';

const NOW = 1_800_000_000_000;

function ok(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 29, windowMinutes: 300, resetsAt: NOW + (3 * 60 + 5) * 60_000 },
    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: NOW + 4 * 24 * 3_600_000 },
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...overrides,
  };
}

describe('display formatting (same as Orca)', () => {
  it('time left', () => {
    expect(formatResetDuration(0)).toBe('now');
    expect(formatResetDuration(-5)).toBe('now');
    expect(formatResetDuration(45 * 60_000)).toBe('45m');
    expect(formatResetDuration(60 * 60_000)).toBe('1h');
    expect(formatResetDuration((3 * 60 + 5) * 60_000)).toBe('3h 5m');
    expect(formatResetDuration((6 * 24 + 23) * 3_600_000)).toBe('6d 23h');
    expect(formatResetDuration(4 * 24 * 3_600_000)).toBe('4d');
    expect(formatResetCountdown((3 * 60 + 5) * 60_000)).toBe('Resets in 3h 5m');
    expect(formatResetCountdown(0)).toBe('Resets now');
    expect(formatResetCountdown((3 * 60 + 5) * 60_000, 'ja')).toBe('あと 3h 5m で回復');
  });

  it('footer chip: time left, else the window length', () => {
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 300, resetsAt: NOW + 3_600_000 }, NOW)).toBe('1h');
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 10080, resetsAt: null }, NOW)).toBe('wk');
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 1440, resetsAt: null }, NOW)).toBe('1d');
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 45, resetsAt: null }, NOW)).toBe('45m');
  });

  it('section order, tightest window, soonest reset', () => {
    const p = ok({ fableWeekly: { usedPercent: 3, windowMinutes: 10080, resetsAt: null } });
    expect(usageSections(p).map((s) => s.label)).toEqual(['5h', 'wk', 'Fable']);
    expect(tightestUsageSection(p)?.key).toBe('session');
    expect(soonestResetLabel(p, NOW)).toBe('Resets in 3h 5m');
    expect(tightestUsageSection(ok({ session: null, weekly: null }))).toBeNull();
    expect(soonestResetLabel(ok({ session: { usedPercent: 1, windowMinutes: 300, resetsAt: null }, weekly: null }), NOW)).toBeNull();
  });

  it('color thresholds 60 / 80 (clamped)', () => {
    expect(usageTone(59)).toBe('normal');
    expect(usageTone(60)).toBe('warning');
    expect(usageTone(80)).toBe('urgent');
    expect(usageTone(500)).toBe('urgent');
    expect(usageTone(Number.NaN)).toBe('normal');
  });

  it('plan names', () => {
    expect(formatPlanLabel('plus')).toBe('Plus');
    expect(formatPlanLabel('chatgpt_business')).toBe('ChatGPT Business');
    expect(formatPlanLabel('')).toBeNull();
    expect(formatPlanLabel(null)).toBeNull();
  });

  it('status labels per failure kind, in both languages', () => {
    const failed = (failureKind: ProviderRateLimits['failureKind']): ProviderRateLimits => ({ ...ok(), status: 'error', failureKind });
    expect(usageStatusLabel({ ...ok(), status: 'fetching' })).toBe('Loading…');
    expect(usageStatusLabel(failed('missing-credentials'), 'ja')).toBe('未ログイン');
    expect(usageStatusLabel(failed('keychain-unavailable'))).toBe('Check Keychain');
    expect(usageStatusLabel(failed('server'))).toBe('Failed');
    expect(usageStatusLabel({ ...ok(), status: 'unavailable' }, 'ja')).toBe('取得できません');
  });

  it('footer meter: tightest window, plan and status', () => {
    const m = usageMeter('codex', ok({ provider: 'codex', planType: 'plus', session: { usedPercent: 81.4, windowMinutes: 300, resetsAt: 5 } }), { accountId: null, label: 'System default' });
    expect(m).toMatchObject({ agent: 'codex', percent: 81, windowLabel: '5h', resetsAt: 5, plan: 'Plus', tone: 'urgent', status: 'ok', statusLabel: null });
    const none = usageMeter('claude', null, { accountId: 'x', label: 'work' });
    expect(none).toMatchObject({ percent: null, status: 'idle', statusLabel: null, accountLabel: 'work' });
    const failed = usageMeter('claude', { provider: 'claude', session: null, weekly: null, updatedAt: 0, error: 'nope', status: 'error', failureKind: 'network' }, { accountId: null, label: '' }, 'ja');
    expect(failed).toMatchObject({ percent: null, statusLabel: '接続できません', error: 'nope' });
  });
});

describe('Claude response parsing', () => {
  it('reads 5h, week and Fable (limits[] shape)', () => {
    const p = mapClaudeUsageResponse({
      five_hour: { utilization: 29, resets_at: '2027-01-15T08:00:00Z' },
      seven_day: { utilization: 10, resets_at: 1_800_000_000 },
      limits: [{ kind: 'weekly_scoped', percent: 3, resets_at: 1_800_000_000, scope: { model: { display_name: 'Fable' } } }],
    });
    expect(p.session).toEqual({ usedPercent: 29, windowMinutes: 300, resetsAt: Date.parse('2027-01-15T08:00:00Z') });
    expect(p.weekly?.resetsAt).toBe(1_800_000_000_000);
    expect(p.fableWeekly?.usedPercent).toBe(3);
    expect(p.status).toBe('ok');
  });

  it('older Fable keys; out-of-range values are clamped', () => {
    const p = mapClaudeUsageResponse({ five_hour: { used_percentage: 140 }, seven_day_fable: { utilization: -5 } });
    expect(p.session?.usedPercent).toBe(100);
    expect(p.weekly).toBeNull();
    expect(p.fableWeekly?.usedPercent).toBe(0);
    expect(mapClaudeUsageResponse({}).session).toBeNull();
  });

  it('reset times in seconds, milliseconds or strings', () => {
    expect(parseResetTimestamp(1_800_000_000)).toBe(1_800_000_000_000);
    expect(parseResetTimestamp(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(parseResetTimestamp('1800000000')).toBe(1_800_000_000_000);
    expect(parseResetTimestamp('broken')).toBeNull();
    expect(parseResetTimestamp(undefined)).toBeNull();
    expect(parseResetTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('Retry-After as seconds or a date, capped at a day', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('999999999')).toBe(24 * 60 * 60 * 1000);
    expect(parseRetryAfterMs(new Date(NOW + 60_000).toUTCString(), NOW)).toBe(60_000);
    expect(parseRetryAfterMs('garbage')).toBeNull();
  });
});

describe('Codex response parsing', () => {
  it('tells 5h and week apart by window length (any order)', () => {
    const p = mapCodexUsageResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1_800_000_100 },
      },
    })!;
    expect(p.weekly).toEqual({ usedPercent: 0, windowMinutes: 10080, resetsAt: 1_800_000_000_000 });
    expect(p.session?.usedPercent).toBe(12);
    expect(p.planType).toBe('plus');
  });

  it('Business per-member spend limit as the "$" window (Orca #8664)', () => {
    const p = mapCodexUsageResponse({ plan_type: 'business', rate_limit: null, spend_control: { individual_limit: { used_percent: 39 } } })!;
    expect(p.spendLimit).toEqual({ usedPercent: 39, windowMinutes: 0, resetsAt: null });
    expect(usageSections(p)).toEqual([{ key: 'spend', label: '$', window: p.spendLimit }]);
    expect(formatWindowChipLabel(p.spendLimit!)).toBe('$');
    expect(p.unlimited).toBeUndefined();
  });

  it('Business without limits is ∞, not a failure (Orca #15764)', () => {
    const p = mapCodexUsageResponse({ plan_type: 'business', rate_limit: { primary_window: null, secondary_window: null }, credits: { unlimited: true } })!;
    expect(p.status).toBe('ok');
    expect(p.unlimited).toBe(true);
    expect(usageSections(p)).toEqual([]);
    expect(usageStatusLabel(p)).toBe('∞');
  });

  it('weekly-only plans; unknown durations fall back to primary = 5h, secondary = week', () => {
    const p = mapCodexUsageResponse({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } } })!;
    expect(p.session).toBeNull();
    expect(p.weekly?.usedPercent).toBe(5);
    const q = mapCodexUsageResponse({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 7 }, secondary_window: { used_percent: 8 } } })!;
    expect(q.session).toEqual({ usedPercent: 7, windowMinutes: 300, resetsAt: null });
    expect(q.weekly).toEqual({ usedPercent: 8, windowMinutes: 10080, resetsAt: null });
  });

  it('responses without plan_type are not used; bad percents are ignored', () => {
    expect(mapCodexUsageResponse({ rate_limit: null })).toBeNull();
    expect(mapCodexUsageResponse({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: Number.NaN } } })!.session).toBeNull();
  });
});

describe('fetching (fake HTTP, never a real endpoint)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solocut-usage-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const codexAuth = (tokens: Record<string, unknown>) => writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens }));

  it('Codex: sends the token only in headers, never follows the body of failures', async () => {
    codexAuth({ access_token: 'secret-token', account_id: 'acct' });
    const calls: { url: string; init: RequestInit }[] = [];
    const request: UsageRequest = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000 } } }), { status: 200 });
    };
    const p = await fetchCodexUsage(request, dir, { lang: 'en' });
    expect(p.status).toBe('ok');
    expect(p.session?.usedPercent).toBe(50);
    expect(calls[0]!.url).toBe(CODEX_USAGE_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['ChatGPT-Account-Id']).toBe('acct');
  });

  it('Codex: not signed in, 401, 429 with Retry-After, 500, network error, bad JSON', async () => {
    expect((await fetchCodexUsage(async () => new Response('{}'), dir, { lang: 'en' })).failureKind).toBe('missing-credentials');
    codexAuth({ access_token: 'secret-token' });
    const respond = (status: number, body = 'secret-token echoed', headers: Record<string, string> = {}): UsageRequest => async () => new Response(body, { status, headers });
    const stale = await fetchCodexUsage(respond(401), dir, { lang: 'en' });
    expect(stale.failureKind).toBe('stale-token');
    expect(stale.error).not.toContain('secret-token');
    const limited = await fetchCodexUsage(respond(429, '', { 'retry-after': '60' }), dir);
    expect(limited.failureKind).toBe('rate-limited');
    expect(limited.retryAtMs).toBeGreaterThan(Date.now());
    expect((await fetchCodexUsage(respond(503), dir)).failureKind).toBe('server');
    expect((await fetchCodexUsage(respond(404), dir)).failureKind).toBe('unknown');
    expect((await fetchCodexUsage(async () => { throw new Error('ECONNRESET secret-token'); }, dir, { lang: 'ja' })).error).toBe('Codex の使用量を取得できませんでした（通信エラー）。');
    expect((await fetchCodexUsage(respond(200, '<html>'), dir)).failureKind).toBe('unknown');
    expect((await fetchCodexUsage(respond(200, '{"no_plan":1}'), dir)).failureKind).toBe('unknown');
  });

  it('bounded JSON: refuses declared or streamed bodies over the cap', async () => {
    await expect(readBoundedJson(new Response('{"a":1}'), 100)).resolves.toEqual({ a: 1 });
    await expect(readBoundedJson(new Response('x'.repeat(200), { headers: { 'content-length': '200' } }), 100)).rejects.toThrow(RangeError);
    await expect(readBoundedJson(new Response(`"${'x'.repeat(200)}"`), 100)).rejects.toThrow(RangeError);
  });

  it('the Claude endpoint constant is the official OAuth usage URL', () => {
    expect(CLAUDE_USAGE_URL).toBe('https://api.anthropic.com/api/oauth/usage');
  });

  it('Codex credentials: token and account id, or missing', async () => {
    expect(await readCodexAccessToken(dir)).toEqual({ token: null, reason: 'missing' });
    codexAuth({ access_token: 'tok', account_id: 7 });
    expect(await readCodexAccessToken(dir)).toEqual({ token: 'tok', accountId: null });
    writeFileSync(join(dir, 'auth.json'), '{broken');
    expect(await readCodexAccessToken(dir)).toEqual({ token: null, reason: 'missing' });
  });
});

describe('refetch frequency and failure display (same as Orca)', () => {
  const failed = (extra: Partial<ProviderRateLimits> = {}): ProviderRateLimits => ({
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: NOW,
    error: 'offline',
    status: 'error',
    failureKind: 'network',
    ...extra,
  });

  it('after a failure, a success younger than 30 minutes stays visible with status error', () => {
    const previous = ok({ updatedAt: NOW - 60_000 });
    const shown = applyStalePolicy(failed(), previous, NOW);
    expect(shown.status).toBe('error');
    expect(shown.session?.usedPercent).toBe(29);
    expect(shown.error).toBe('offline');
    expect(shown.failureKind).toBe('network');
  });

  it('too old successes are dropped (kept 24 h while rate-limited)', () => {
    const previous = ok({ updatedAt: NOW - STALE_THRESHOLD_MS - 1 });
    expect(applyStalePolicy(failed(), previous, NOW).session).toBeNull();
    expect(applyStalePolicy(failed({ failureKind: 'rate-limited' }), previous, NOW).session?.usedPercent).toBe(29);
    expect(applyStalePolicy(failed(), null, NOW)).toEqual(failed());
    expect(applyStalePolicy(ok(), failed(), NOW)).toEqual(ok());
  });

  it('values stay visible while fetching', () => {
    expect(withFetchingStatus(null, 'codex').status).toBe('fetching');
    const current = ok();
    expect(withFetchingStatus(current, 'claude')).toBe(current);
    expect(withFetchingStatus({ ...current, status: 'idle' }, 'claude').status).toBe('fetching');
  });

  it('retries start at 30 s, double, cap at 15 min', () => {
    expect(failureRetryDelayMs(0)).toBe(30_000);
    expect(failureRetryDelayMs(1)).toBe(30_000);
    expect(failureRetryDelayMs(2)).toBe(60_000);
    expect(failureRetryDelayMs(10)).toBe(15 * 60_000);
  });

  it('on focus: refetch missing values, 5-minute-old successes and spaced-out failures only', () => {
    const base = { lastFailureRetryAt: { claude: 0, codex: 0 }, failureStreak: { claude: 0, codex: 0 }, now: NOW };
    expect(providersToRefresh({ ...base, state: { claude: null, codex: ok({ provider: 'codex' }) } })).toEqual(['claude']);
    expect(providersToRefresh({ ...base, state: { claude: ok({ updatedAt: NOW - MIN_REFETCH_MS }), codex: null } })).toEqual(['claude', 'codex']);
    expect(providersToRefresh({ ...base, state: { claude: failed({ retryAtMs: NOW + 1000 }), codex: ok({ provider: 'codex' }) } })).toEqual([]);
    expect(
      providersToRefresh({
        ...base,
        lastFailureRetryAt: { claude: NOW - 10_000, codex: 0 },
        failureStreak: { claude: 1, codex: 0 },
        state: { claude: failed(), codex: ok({ provider: 'codex' }) },
      }),
    ).toEqual([]);
    expect(providersToRefresh({ ...base, state: { claude: { ...ok(), status: 'fetching' }, codex: ok({ provider: 'codex' }) } })).toEqual([]);
  });
});

describe('automatic retry after failures', () => {
  const failed = (failureKind: ProviderRateLimits['failureKind'], extra: Partial<ProviderRateLimits> = {}): ProviderRateLimits => ({
    provider: 'claude', session: null, weekly: null, updatedAt: 0, error: 'x', status: 'error', failureKind, ...extra,
  });
  it('network / server / unknown retry with growing gaps', () => {
    expect(failureRetryAfterMs(failed('network'), 1)).toBe(30_000);
    expect(failureRetryAfterMs(failed('server'), 2)).toBe(60_000);
    expect(failureRetryAfterMs(failed('unknown'), 10)).toBe(15 * 60_000);
  });
  it('Keychain permission, signed out and expired login never retry automatically (no OS prompts)', () => {
    expect(failureRetryAfterMs(failed('keychain-unavailable'), 1)).toBeNull();
    expect(failureRetryAfterMs(failed('missing-credentials'), 1)).toBeNull();
    expect(failureRetryAfterMs(failed('stale-token'), 1)).toBeNull();
  });
  it('rate-limited never before Retry-After', () => {
    expect(failureRetryAfterMs(failed('rate-limited', { retryAtMs: 1000 + 120_000 }), 1, 1000)).toBe(120_000);
    expect(failureRetryAfterMs(failed('rate-limited', { retryAtMs: 500 }), 1, 1000)).toBe(30_000);
  });
  it('nothing scheduled after success', () => {
    expect(failureRetryAfterMs({ ...failed('network'), status: 'ok' }, 1)).toBeNull();
  });
});

describe('Keychain reads (never wait for a dialog)', () => {
  type Result = { ok: true; stdout: string } | { ok: false; code: unknown };
  function fakeExec(results: Record<'exists' | 'read', Result>) {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<Result> => {
      calls.push(args);
      return args.includes('-w') ? results.read : results.exists;
    };
    return { exec, calls };
  }

  it('reads with -w when the item exists', async () => {
    const { exec, calls } = fakeExec({ exists: { ok: true, stdout: '' }, read: { ok: true, stdout: '{"x":1}\n' } });
    expect(await createKeychainReader(exec).read('svc', 'me')).toBe('{"x":1}');
    expect(calls).toEqual([
      ['find-generic-password', '-s', 'svc', '-a', 'me'],
      ['find-generic-password', '-s', 'svc', '-a', 'me', '-w'],
    ]);
  });

  it('never reads the secret when the item is missing', async () => {
    const { exec, calls } = fakeExec({ exists: { ok: false, code: 44 }, read: { ok: true, stdout: 'x' } });
    expect(await createKeychainReader(exec).read('svc', 'me')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('gives up on denial / timeout and only retries on a manual refresh', async () => {
    const { exec, calls } = fakeExec({ exists: { ok: true, stdout: '' }, read: { ok: false, code: 'ETIMEDOUT' } });
    const reader = createKeychainReader(exec);
    expect(await reader.read('svc', 'me')).toBe('unavailable');
    expect(await reader.read('svc', 'me')).toBe('unavailable');
    expect(calls).toHaveLength(2);
    await reader.read('svc', 'me', { retryBlocked: true });
    expect(calls).toHaveLength(4);
  });

  it('a locked keychain on the existence check counts as unavailable', async () => {
    const { exec } = fakeExec({ exists: { ok: false, code: 51 }, read: { ok: true, stdout: 'x' } });
    expect(await createKeychainReader(exec).read('svc', 'me')).toBe('unavailable');
  });
});

describe('Claude credential expiry', () => {
  it('tells expired file tokens apart', () => {
    const raw = (expiresAt?: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', ...(expiresAt === undefined ? {} : { expiresAt }) } });
    expect(parseClaudeCredentials(raw(2_000), 1_000)).toEqual({ token: 'tok', expired: false });
    expect(parseClaudeCredentials(raw(500), 1_000)).toEqual({ token: 'tok', expired: true });
    expect(parseClaudeCredentials(raw(), 1_000)).toEqual({ token: 'tok', expired: false });
    expect(parseClaudeCredentials('{broken', 1_000)).toBeNull();
    expect(parseClaudeCredentials('{}', 1_000)).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: '' } }), 1_000)).toBeNull();
  });
});

describe('UsageService (fake fetch)', () => {
  let root: string;
  let registry: AgentAccountsSettings;
  const ID = '11111111-2222-4333-8444-555555555555';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solocut-usage-svc-'));
    registry = { claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null } };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function service(fetch: (agent: AccountAgent, target: UsageTarget | null) => ProviderRateLimits) {
    const emitted: unknown[] = [];
    const calls: string[] = [];
    const svc = new UsageService({
      accounts: {
        root,
        settings: () => registry,
        systemDir: (agent) => join(root, 'system', agent),
        readSystemDefault: async () => ({ signedIn: true, email: 'me@example.com', workspaceLabel: null }),
      },
      emit: (s) => emitted.push(s),
      fetch: async (agent, target) => {
        calls.push(`${agent}:${target?.key ?? 'broken'}`);
        return fetch(agent, target);
      },
      env: {},
    });
    return { svc, emitted, calls };
  }

  it('fetches both agents on the first refresh and emits each change', async () => {
    const { svc, emitted, calls } = service((agent) => ok({ provider: agent, updatedAt: Date.now() }));
    const state = await svc.refresh(false);
    expect(state.claude?.status).toBe('ok');
    expect(state.codex?.provider).toBe('codex');
    expect(calls.sort()).toEqual(['claude:system', 'codex:system']);
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    // fresh values are not refetched within 5 minutes; force does
    await svc.refresh(false);
    expect(calls).toHaveLength(2);
    await svc.refresh(true);
    expect(calls).toHaveLength(4);
  });

  it('a selected account whose folder cannot be verified shows an error instead of another account’s usage', async () => {
    registry.codex = { accounts: [{ id: ID, label: 'w', email: null, workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }], activeAccountId: ID };
    const { svc } = service((agent, target) => ok({ provider: agent, updatedAt: Date.now(), error: target ? null : 'x' }));
    expect(svc.targetFor('codex', ID)).toBeNull();
    mkdirSync(join(root, 'codex', ID), { recursive: true });
    writeFileSync(join(root, 'codex', ID, MANAGED_ACCOUNT_MARKER), `${ID}\n`);
    expect(svc.targetFor('codex', ID)?.key).toBe(ID);
    expect(svc.targetFor('codex', null)).toEqual({ key: 'system', dir: join(root, 'system', 'codex') });
    expect(svc.targetFor('claude', null)).toEqual({ key: 'system', dir: undefined });
  });

  it('switching accounts drops the previous account’s values before the refetch', async () => {
    let n = 0;
    const { svc } = service((agent) => ok({ provider: agent, updatedAt: Date.now(), session: { usedPercent: ++n, windowMinutes: 300, resetsAt: null } }));
    await svc.refresh(false);
    mkdirSync(join(root, 'claude', ID), { recursive: true });
    writeFileSync(join(root, 'claude', ID, MANAGED_ACCOUNT_MARKER), `${ID}\n`);
    registry.claude = { accounts: [{ id: ID, label: 'w', email: null, workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }], activeAccountId: ID };
    const before = svc.getState().claude?.session?.usedPercent;
    await svc.refresh(false);
    expect(svc.getState().claude?.session?.usedPercent).not.toBe(before);
  });

  it('per-account breakdown: system default + signed-in accounts, cached for 60 s', async () => {
    mkdirSync(join(root, 'codex', ID), { recursive: true });
    writeFileSync(join(root, 'codex', ID, MANAGED_ACCOUNT_MARKER), `${ID}\n`);
    registry.codex = {
      accounts: [
        { id: ID, label: 'work', email: 'w@example.com', workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 },
        { id: '22222222-2222-4333-8444-555555555555', label: '', email: null, workspaceLabel: null, createdAt: 2, updatedAt: 2, lastAuthenticatedAt: null },
      ],
      activeAccountId: null,
    };
    const { svc, calls } = service((agent) => ok({ provider: agent, updatedAt: Date.now() }));
    const rows = await svc.accountUsage('codex');
    expect(rows.map((r) => [r.accountId, r.label, r.active])).toEqual([
      [null, 'システムの既定', true],
      [ID, 'work', false],
    ]);
    await svc.accountUsage('codex');
    expect(calls).toHaveLength(2);
    await svc.accountUsage('codex', true);
    expect(calls).toHaveLength(4);
  });

  it('listeners are notified and can unsubscribe; a throwing listener does not break others', async () => {
    const { svc } = service((agent) => ok({ provider: agent, updatedAt: Date.now() }));
    let seen = 0;
    svc.onChange(() => {
      throw new Error('boom');
    });
    const off = svc.onChange(() => seen++);
    await svc.refresh(false);
    expect(seen).toBeGreaterThan(0);
    off();
    const before = seen;
    await svc.refresh(true);
    expect(seen).toBe(before);
    svc.dispose();
  });
});

