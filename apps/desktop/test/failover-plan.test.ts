// Ported from Ferret test/unit/failover.test.ts and failover-near-limit.test.ts (MIT): the pure parts of
// failover (detection, choosing the target, switch caps, settings). No real CLI or account is used.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT_FAILOVER, sanitizeLimitFailover, type LimitFailoverPrefs } from '../src/shared/failover';
import type { ProviderRateLimits } from '../src/shared/usage';
import { limitOnScreen, limitedUntil, maxUsedPercent, mentionsLimit } from '../src/main/failover/detect';
import {
  MAX_SWITCHES_PER_HOUR,
  MIN_SWITCH_INTERVAL_MS,
  chromeReturnTarget,
  limitKey,
  nearLimitTabs,
  planFailover,
  planReturn,
  switchAllowed,
  tabsToSwitch,
  usableAccounts,
  type PlanInput,
  type RunningTab,
} from '../src/main/failover/plan';

describe('limit message detection', () => {
  it('catches real Claude Code wording', () => {
    for (const line of [
      '5-hour limit reached ∙ resets 3pm',
      "You've hit your session limit · resets 3:45pm",
      "  ⎿  You've hit your weekly limit · resets Mon 12:00am",
      'Claude usage limit reached. Your limit will reset at 3pm (Asia/Tokyo)',
      'Usage limit reached · continuing automatically at 3:45pm · esc to cancel',
      'Claude AI usage limit reached|1760000000',
      'Opus weekly limit reached ∙ resets Oct 6, 3pm',
    ]) {
      expect(limitOnScreen('claude', `some output\n${line}\n❯ `), line).toBe(true);
      expect(mentionsLimit(line), line).toBe(true);
    }
  });

  it('catches Codex and Gemini CLI wording', () => {
    expect(limitOnScreen('codex', "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 3 hours 2 minutes.")).toBe(true);
    expect(limitOnScreen('codex', "You've hit your usage limit. To get more access now, send a request to your admin or try again at 3:05 PM.")).toBe(true);
    expect(limitOnScreen('gemini', "✕ [API Error: Quota exceeded for quota metric 'Gemini 2.5 Pro Requests']")).toBe(false);
    expect(limitOnScreen('gemini', 'Quota exceeded for quota metric Gemini Requests per day')).toBe(true);
    expect(limitOnScreen('gemini', 'Error: RESOURCE_EXHAUSTED (429)')).toBe(true);
  });

  it('also uses the catalog patterns of @solocut/agents (other agents)', () => {
    expect(limitOnScreen('copilot', 'You have exceeded your monthly quota')).toBe(true);
    expect(limitOnScreen('opencode', 'Error: rate limit exceeded')).toBe(true);
    expect(limitOnScreen('custom:mine', 'all good')).toBe(false);
  });

  it('ignores quotes, diffs, long paragraphs and other agents’ wording', () => {
    expect(limitOnScreen('claude', '+  "5-hour limit reached ∙ resets 3pm",')).toBe(false);
    expect(limitOnScreen('claude', '12 + const message = "usage limit reached"')).toBe(false);
    expect(limitOnScreen('claude', `I added detection for the case where ${'x'.repeat(200)} usage limit reached appears`)).toBe(false);
    expect(limitOnScreen('claude', 'The function returns when the rate limit reached zero')).toBe(false);
    expect(limitOnScreen('codex', 'Opus weekly limit reached ∙ resets Oct 6')).toBe(false);
    expect(mentionsLimit('ordinary output without anything')).toBe(false);
    expect(mentionsLimit('')).toBe(false);
  });

  it('ignores an old message that scrolled off the end of the screen', () => {
    const old = ['5-hour limit reached ∙ resets 3pm', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
    expect(limitOnScreen('claude', old)).toBe(false);
    expect(limitOnScreen('claude', old, 40)).toBe(true);
  });

  it('strips ANSI colors before matching', () => {
    expect(limitOnScreen('claude', '\x1b[31m5-hour limit reached ∙ resets 3pm\x1b[0m')).toBe(true);
    expect(mentionsLimit('\x1b[1mYou\'ve hit your usage limit.\x1b[0m')).toBe(true);
  });

  it('highest window and reset time', () => {
    const limits: ProviderRateLimits = {
      provider: 'claude', updatedAt: 0, error: null, status: 'ok',
      session: { usedPercent: 55, windowMinutes: 300, resetsAt: 1000 },
      weekly: { usedPercent: 97, windowMinutes: 10080, resetsAt: 5000 },
      fableWeekly: { usedPercent: 96, windowMinutes: 10080, resetsAt: 7000 },
    };
    expect(maxUsedPercent(limits)).toBe(97);
    expect(limitedUntil(limits, 95)).toBe(7000);
    expect(limitedUntil(limits, 98)).toBeNull();
    expect(limitedUntil(null, 95)).toBeNull();
    expect(maxUsedPercent(null)).toBeNull();
    expect(maxUsedPercent({ ...limits, session: null, weekly: null, fableWeekly: null })).toBeNull();
    expect(maxUsedPercent({ ...limits, unlimited: true })).toBe(0);
    expect(maxUsedPercent({ ...limits, session: { usedPercent: Number.NaN, windowMinutes: 300, resetsAt: null }, weekly: null, fableWeekly: null })).toBe(0);
  });
});

function input(overrides: Omit<Partial<PlanInput>, 'prefs'> & { prefs?: Partial<LimitFailoverPrefs> } = {}): PlanInput {
  return {
    from: { agent: 'claude', accountId: null },
    accounts: {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 100, active: true },
        { accountId: 'a', signedIn: true, usedPercent: 40, active: false },
        { accountId: 'b', signedIn: true, usedPercent: 10, active: false },
      ],
      codex: [{ accountId: null, signedIn: true, usedPercent: 5, active: true }],
    },
    available: new Set(['claude', 'codex', 'gemini']),
    limited: new Map(),
    now: 1_000_000,
    ...overrides,
    prefs: { ...DEFAULT_LIMIT_FAILOVER, ...overrides.prefs },
  };
}

describe('choosing the switch target', () => {
  it('picks another account of the same agent, lowest usage first', () => {
    expect(planFailover(input())).toEqual({ agent: 'claude', accountId: 'b' });
  });

  it('skips accounts at/above the threshold, limited ones and signed-out ones', () => {
    const accounts = {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 100, active: true },
        { accountId: 'a', signedIn: true, usedPercent: 96, active: false },
        { accountId: 'b', signedIn: true, usedPercent: 10, active: false },
        { accountId: 'c', signedIn: false, usedPercent: 0, active: false },
      ],
      codex: [{ accountId: null, signedIn: true, usedPercent: 5, active: true }],
    };
    const limited = new Map([[limitKey({ agent: 'claude', accountId: 'b' }), 2_000_000]]);
    expect(planFailover(input({ accounts, limited }))).toEqual({ agent: 'codex', accountId: null });
    // a limit that already expired no longer counts
    expect(planFailover(input({ accounts, limited: new Map([[limitKey({ agent: 'claude', accountId: 'b' }), 500]]) }))).toEqual({ agent: 'claude', accountId: 'b' });
  });

  it('exactly at the threshold counts as limited', () => {
    const accounts = { claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }, { accountId: 'a', signedIn: true, usedPercent: 95, active: false }], codex: [] };
    expect(planFailover(input({ accounts, available: new Set(['claude']) }))).toBeNull();
    expect(planFailover(input({ accounts, prefs: { thresholdPercent: 96 } }))).toEqual({ agent: 'claude', accountId: 'a' });
  });

  it('accounts with unknown usage come after known ones', () => {
    const accounts = {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 99, active: true },
        { accountId: 'x', signedIn: true, usedPercent: null, active: false },
        { accountId: 'y', signedIn: true, usedPercent: 70, active: false },
      ],
      codex: [],
    };
    expect(planFailover(input({ accounts }))).toEqual({ agent: 'claude', accountId: 'y' });
  });

  it('with account switching off, hands over to the next agent', () => {
    expect(planFailover(input({ prefs: { switchAccounts: false } }))).toEqual({ agent: 'codex', accountId: null });
  });

  it('walks agentOrder for an installed, not limited agent; agents outside the order are never used', () => {
    const accounts = { claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }], codex: [{ accountId: null, signedIn: true, usedPercent: 99, active: true }] };
    expect(planFailover(input({ accounts }))).toEqual({ agent: 'gemini' });
    expect(planFailover(input({ accounts, available: new Set(['claude', 'codex']) }))).toBeNull();
    expect(planFailover(input({ accounts, prefs: { agentOrder: ['claude', 'codex'] } }))).toBeNull();
    expect(planFailover(input({ accounts, limited: new Map([['gemini', 2_000_000]]) }))).toBeNull();
    expect(planFailover(input({ accounts, prefs: { agentOrder: ['gemini', 'claude', 'codex'] } }))).toEqual({ agent: 'gemini' });
    expect(planFailover(input({ accounts, prefs: { agentOrder: [] } }))).toBeNull();
  });

  it('when Codex is limited, goes back to Claude Code first (skipping the current agent)', () => {
    const accounts = { claude: [{ accountId: null, signedIn: true, usedPercent: 20, active: true }], codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }] };
    expect(planFailover(input({ accounts, from: { agent: 'codex', accountId: null } }))).toEqual({ agent: 'claude', accountId: null });
  });

  it('with account switching off, other agents only use their selected account', () => {
    const accounts = {
      claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }],
      codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }, { accountId: 'k', signedIn: true, usedPercent: 0, active: false }],
    };
    expect(planFailover(input({ accounts, prefs: { switchAccounts: false } }))).toEqual({ agent: 'gemini' });
    expect(planFailover(input({ accounts }))).toEqual({ agent: 'codex', accountId: 'k' });
  });

  it('Chrome accounts first, then usage; ties prefer the selected account', () => {
    const accounts = {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 10, active: true },
        { accountId: 'c', signedIn: true, usedPercent: 50, active: false, chrome: true },
        { accountId: 'd', signedIn: true, usedPercent: 10, active: false },
      ],
      codex: [],
    };
    expect(usableAccounts(input({ accounts }), 'claude').map((a) => a.accountId)).toEqual(['c', null, 'd']);
  });

  it('moves back only when an agent ranked above the current one is usable', () => {
    const base = input();
    const free = { claude: [{ accountId: null, signedIn: true, usedPercent: 10, active: true }], codex: base.accounts.codex };
    expect(planReturn({ ...base, accounts: free, current: 'codex' })).toEqual({ agent: 'claude', accountId: null });
    expect(planReturn({ ...base, accounts: { claude: [{ accountId: null, signedIn: true, usedPercent: 99, active: true }], codex: base.accounts.codex }, current: 'codex' })).toBeNull();
    expect(planReturn({ ...base, accounts: free, current: 'claude' })).toBeNull();
    // an agent outside the order: the first usable one
    expect(planReturn({ ...base, accounts: free, current: 'opencode' })).toEqual({ agent: 'claude', accountId: null });
  });

  it('Chrome return target: only when the current account is not paired and a paired one has room', () => {
    const accounts = {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 30, active: true },
        { accountId: 'c', signedIn: true, usedPercent: 20, active: false, chrome: true },
      ],
      codex: [],
    };
    const base = input({ accounts });
    expect(chromeReturnTarget(base, 'claude', null)?.accountId).toBe('c');
    expect(chromeReturnTarget(base, 'claude', 'c')).toBeNull();
    expect(chromeReturnTarget(input({ accounts: { claude: accounts.claude.map((a) => ({ ...a, chrome: false })), codex: [] } }), 'claude', null)).toBeNull();
    const full = { claude: [accounts.claude[0]!, { ...accounts.claude[1]!, usedPercent: 99 }], codex: [] };
    expect(chromeReturnTarget(input({ accounts: full }), 'claude', null)).toBeNull();
  });
});

describe('switch caps', () => {
  it('keeps the minimum gap between consecutive switches', () => {
    expect(switchAllowed([], 0)).toEqual({ ok: true });
    expect(switchAllowed([1000], 1000 + MIN_SWITCH_INTERVAL_MS - 1)).toEqual({ ok: false, retryAt: 1000 + MIN_SWITCH_INTERVAL_MS });
    expect(switchAllowed([1000], 1000 + MIN_SWITCH_INTERVAL_MS)).toEqual({ ok: true });
  });

  it('beyond the hourly count, waits until an hour after the oldest switch', () => {
    const history = Array.from({ length: MAX_SWITCHES_PER_HOUR }, (_, i) => i * 5 * 60_000);
    const now = history[history.length - 1]! + 10 * 60_000;
    expect(switchAllowed(history, now)).toEqual({ ok: false, retryAt: 60 * 60_000 });
    expect(switchAllowed(history, 60 * 60_000 + 1)).toEqual({ ok: true });
  });

  it('ignores switches older than an hour and unsorted history', () => {
    expect(switchAllowed([5 * 60_000, 0, 10 * 60_000], 3 * 60 * 60_000)).toEqual({ ok: true });
  });
});

describe('re-selecting an account in the footer / settings', () => {
  it('reopens only tabs of that agent launched with another account (unknown = system default)', () => {
    const tabs = [
      { id: 't1', agent: 'claude', launchedAccount: 'a' },
      { id: 't2', agent: 'claude', launchedAccount: 'b' },
      { id: 't3', agent: 'codex', launchedAccount: 'a' },
      { id: 't4', agent: 'claude', launchedAccount: undefined },
      { id: 't5', agent: null, launchedAccount: undefined },
    ];
    expect(tabsToSwitch(tabs, 'claude', 'b').map((t) => t.id)).toEqual(['t1', 't4']);
    expect(tabsToSwitch(tabs, 'claude', null).map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('handing over before the limit', () => {
  const tabs: RunningTab[] = [
    { id: 't1', projectDir: '/p/a', agent: 'claude', accountId: null },
    { id: 't2', projectDir: '/p/a', agent: 'claude', accountId: null },
    { id: 't3', projectDir: '/p/b', agent: 'codex', accountId: 'k' },
    { id: 't4', projectDir: '/p/c', agent: 'claude', accountId: 'x' },
  ];
  const used = (agent: string, accountId: string | null) => (agent === 'claude' && accountId === null ? 98 : agent === 'codex' ? 99 : null);

  it('picks tabs at/above handoffPercent, one per project; unknown usage never hands over', () => {
    expect(nearLimitTabs(tabs, used, 98, new Set(), new Set()).map((t) => t.id)).toEqual(['t1', 't3']);
    expect(nearLimitTabs(tabs, used, 99, new Set(), new Set()).map((t) => t.id)).toEqual(['t3']);
  });

  it('skips tabs already started and projects being switched; 100 disables it', () => {
    expect(nearLimitTabs(tabs, used, 98, new Set(['t1']), new Set()).map((t) => t.id)).toEqual(['t2', 't3']);
    expect(nearLimitTabs(tabs, used, 98, new Set(), new Set(['/p/b'])).map((t) => t.id)).toEqual(['t1']);
    expect(nearLimitTabs(tabs, used, 100, new Set(), new Set())).toEqual([]);
  });
});

describe('settings', () => {
  it('defaults: on, 95%, accounts first, Claude Code → Codex → Gemini CLI, no return, hand over at 98%', () => {
    expect(sanitizeLimitFailover(undefined)).toEqual(DEFAULT_LIMIT_FAILOVER);
    expect(DEFAULT_LIMIT_FAILOVER).toEqual({ enabled: true, thresholdPercent: 95, switchAccounts: true, agentOrder: ['claude', 'codex', 'gemini'], returnToPreferred: false, handoffPercent: 98 });
  });

  it('repairs broken values (50–100, invalid ids and duplicates dropped)', () => {
    expect(sanitizeLimitFailover({ enabled: false, thresholdPercent: 10, agentOrder: ['codex', 'Nope!', 'codex', 'custom:mine', 3], returnToPreferred: true, switchAccounts: 'x' }))
      .toEqual({ enabled: false, thresholdPercent: 50, switchAccounts: true, agentOrder: ['codex', 'custom:mine'], returnToPreferred: true, handoffPercent: 98 });
    expect(sanitizeLimitFailover({ thresholdPercent: 1000 }).thresholdPercent).toBe(100);
    expect(sanitizeLimitFailover({ thresholdPercent: 96.6 }).thresholdPercent).toBe(97);
    expect(sanitizeLimitFailover({ thresholdPercent: Number.NaN }).thresholdPercent).toBe(95);
    expect(sanitizeLimitFailover({ handoffPercent: 0 }).handoffPercent).toBe(50);
    expect(sanitizeLimitFailover({ agentOrder: [] }).agentOrder).toEqual([]);
    expect(sanitizeLimitFailover([1, 2]).enabled).toBe(true);
  });

  it('agents.order wins over a stray agentOrder inside agents.failover', () => {
    expect(sanitizeLimitFailover({ agentOrder: ['codex'] }, ['gemini', 'claude']).agentOrder).toEqual(['gemini', 'claude']);
    expect(sanitizeLimitFailover({}, 'nope').agentOrder).toEqual(DEFAULT_LIMIT_FAILOVER.agentOrder);
    expect(sanitizeLimitFailover({}, Array.from({ length: 20 }, (_, i) => `a${i}`)).agentOrder).toHaveLength(12);
  });
});
