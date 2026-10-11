// registerAccountsIpc: every declared channel gets a handler, renderer arguments are validated, service events are
// forwarded. Real AccountsService / UsageService on a temp folder with a fake usage fetch.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS_EVENT_CHANNELS, ACCOUNTS_INVOKE_CHANNELS, isAccountsEventChannel, isAccountsInvokeChannel } from '../src/shared/ipc-accounts';
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc';
import { registerAccountsIpc, type AccountsHandle } from '../src/main/ipc-accounts';
import { AccountsService } from '../src/main/accounts/service';
import { UsageService } from '../src/main/usage/service';

describe('accounts IPC registry', () => {
  it('channel lists match the maps and do not clash with the main registry', () => {
    expect(ACCOUNTS_INVOKE_CHANNELS).toContain('usage:meters');
    expect(ACCOUNTS_EVENT_CHANNELS).toContain('failover:notice');
    for (const c of ACCOUNTS_INVOKE_CHANNELS) expect((INVOKE_CHANNELS as readonly string[]).includes(c)).toBe(false);
    for (const c of ACCOUNTS_EVENT_CHANNELS) expect((EVENT_CHANNELS as readonly string[]).includes(c)).toBe(false);
    expect(isAccountsInvokeChannel('accounts:list')).toBe(true);
    expect(isAccountsInvokeChannel('constructor')).toBe(false);
    expect(isAccountsEventChannel('usage:changed')).toBe(true);
    expect(isAccountsEventChannel(42)).toBe(false);
  });
});

describe('registerAccountsIpc', () => {
  let base: string;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let events: { channel: string; args: unknown[] }[];
  let off: () => void;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'solocut-accounts-ipc-')));
    handlers = new Map();
    events = [];
    const accounts = new AccountsService({
      root: join(base, 'accounts'),
      language: () => 'en',
      systemDir: (agent) => join(base, 'home', agent),
      readSystemDefault: async () => ({ signedIn: false, email: null, workspaceLabel: null }),
      env: {},
      home: join(base, 'home'),
    });
    const usage = new UsageService({
      accounts,
      language: () => 'en',
      fetch: async (agent) => ({ provider: agent, session: { usedPercent: 42, windowMinutes: 300, resetsAt: null }, weekly: null, updatedAt: Date.now(), error: null, status: 'ok' }),
      env: {},
    });
    const handle: AccountsHandle = (channel, fn) => {
      handlers.set(channel, fn as (...args: unknown[]) => unknown);
    };
    off = registerAccountsIpc({
      handle,
      emit: (channel, ...args) => events.push({ channel, args }),
      accounts,
      usage,
      failover: null,
      openLoginTab: async (launch) => `login:${launch.argv.join(' ')}`,
      language: () => 'en',
    });
  });
  afterEach(() => {
    off();
    rmSync(base, { recursive: true, force: true });
  });

  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args);

  it('registers a handler for every invoke channel', () => {
    expect([...handlers.keys()].sort()).toEqual([...ACCOUNTS_INVOKE_CHANNELS].sort());
  });

  it('usage: refresh emits usage:changed and meters show the selected account', async () => {
    const state = (await call('usage:refresh', true)) as { claude: { session: { usedPercent: number } } };
    expect(state.claude.session.usedPercent).toBe(42);
    expect(events.some((e) => e.channel === 'usage:changed')).toBe(true);
    const meters = (await call('usage:meters')) as { agent: string; percent: number; accountLabel: string }[];
    expect(meters.map((m) => [m.agent, m.percent, m.accountLabel])).toEqual([
      ['claude', 42, 'System default'],
      ['codex', 42, 'System default'],
    ]);
  });

  it('accounts: add emits accounts:changed; startLogin opens a login tab built in main', async () => {
    const added = (await call('accounts:add', 'codex')) as { login: { accountId: string } };
    expect(events.some((e) => e.channel === 'accounts:changed')).toBe(true);
    expect(await call('accounts:startLogin', 'codex', added.login.accountId)).toEqual({ tabId: 'login:codex login' });
  });

  it('rejects invalid renderer arguments', async () => {
    await expect(call('accounts:add', 'gemini')).rejects.toThrow('Invalid agent type.');
    await expect(call('accounts:remove', 'codex', '../../etc')).rejects.toThrow('Invalid account ID.');
    await expect(call('accounts:select', 'claude', 7)).rejects.toThrow('Invalid account ID.');
    await expect(call('accounts:startLogin', 'codex', '11111111-2222-4333-8444-555555555555')).rejects.toThrow('That account no longer exists.');
    await expect(call('usage:accounts', null)).rejects.toThrow('Invalid agent type.');
  });

  it('select null returns the state and no switching without failover; status is off', async () => {
    const result = (await call('accounts:select', 'claude', null)) as { switchingTabs: number; state: { claude: { activeAccountId: null } } };
    expect(result.switchingTabs).toBe(0);
    expect(result.state.claude.activeAccountId).toBeNull();
    expect(await call('failover:status')).toMatchObject({ enabled: false, last: null, waiting: [], switching: [] });
  });
});
