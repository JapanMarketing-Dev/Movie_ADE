// The account switcher model (src/renderer/src/shell/accountsModel.ts) shared by the footer and Settings → アカウント,
// plus the parity of its strings (shell/i18nAccounts.ts).
import { describe, expect, it } from 'vitest';
import type { AgentAccountSummary, AgentAccountsState, AgentAccountsView } from '../src/shared/accounts';
import type { AccountUsage } from '../src/shared/usage';
import {
  accountStatus,
  activeAccountName,
  breakdownRows,
  canSelect,
  cleanLabel,
  hasPendingLogin,
  isPendingLogin,
  removedDuplicates,
  selectKey,
  selectionChanged,
  switchableCount,
} from '../src/renderer/src/shell/accountsModel';
import { ACCOUNTS_EN, ACCOUNTS_JA } from '../src/renderer/src/shell/i18nAccounts';
import { SHELL_DICT } from '../src/renderer/src/shell/i18n';

function acct(id: string, o: Partial<AgentAccountSummary> = {}): AgentAccountSummary {
  return { id, label: '', email: `${id}@example.com`, workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 2, signedIn: true, problem: null, ...o };
}

function view(o: Partial<AgentAccountsView> = {}): AgentAccountsView {
  return { accounts: [], activeAccountId: null, systemDefault: { signedIn: true, email: 'me@example.com' }, ...o };
}

function state(claude: Partial<AgentAccountsView> = {}, codex: Partial<AgentAccountsView> = {}): AgentAccountsState {
  return { claude: view(claude), codex: view(codex) };
}

describe('account status', () => {
  it('pending: added, first login not finished', () => {
    const a = acct('a', { lastAuthenticatedAt: null, signedIn: false, email: null });
    expect(isPendingLogin(a)).toBe(true);
    expect(accountStatus(a)).toBe('pending');
    expect(canSelect(a)).toBe(false);
  });
  it('relogin: logged in once, credentials gone', () => {
    expect(accountStatus(acct('a', { signedIn: false }))).toBe('relogin');
    expect(canSelect(acct('a', { signedIn: false }))).toBe(false);
  });
  it('a problem wins over everything (folder missing, not ours)', () => {
    const a = acct('a', { problem: 'folder missing', lastAuthenticatedAt: null });
    expect(accountStatus(a)).toBe('unusable');
    expect(canSelect(a)).toBe(false);
  });
  it('ok: signed in, no problem → selectable', () => {
    expect(accountStatus(acct('a'))).toBe('ok');
    expect(canSelect(acct('a'))).toBe(true);
  });
  it('lastAuthenticatedAt 0 is a real time, not "pending"', () => {
    expect(isPendingLogin(acct('a', { lastAuthenticatedAt: 0 }))).toBe(false);
  });
});

describe('pending logins', () => {
  it('none before the list is loaded', () => {
    expect(hasPendingLogin(null)).toBe(false);
  });
  it('found in either agent', () => {
    expect(hasPendingLogin(state())).toBe(false);
    expect(hasPendingLogin(state({}, { accounts: [acct('x', { lastAuthenticatedAt: null })] }))).toBe(true);
    expect(hasPendingLogin(state({ accounts: [acct('x'), acct('y', { lastAuthenticatedAt: null })] }))).toBe(true);
  });
});

describe('selection', () => {
  it('select keys tell the system default of each agent apart', () => {
    expect(selectKey('claude', null)).toBe('select:system-claude');
    expect(selectKey('codex', null)).toBe('select:system-codex');
    expect(selectKey('codex', 'abc')).toBe('select:abc');
  });
  it('selectionChanged: only a real change (null before load counts as system default)', () => {
    const before = state({ activeAccountId: 'a' });
    expect(selectionChanged(before, state({ activeAccountId: 'b' }), 'claude')).toBe(true);
    expect(selectionChanged(before, state({ activeAccountId: 'a' }), 'claude')).toBe(false);
    expect(selectionChanged(before, state({ activeAccountId: 'a' }, { activeAccountId: 'z' }), 'claude')).toBe(false);
    expect(selectionChanged(null, state(), 'codex')).toBe(false);
    expect(selectionChanged(null, state({}, { activeAccountId: 'z' }), 'codex')).toBe(true);
  });
  it('active account name: label → email → system default (with its email)', () => {
    expect(activeAccountName(view({ accounts: [acct('a', { label: '仕事' })], activeAccountId: 'a' }), 'ja')).toBe('仕事');
    expect(activeAccountName(view({ accounts: [acct('a')], activeAccountId: 'a' }), 'ja')).toBe('a@example.com');
    expect(activeAccountName(view(), 'ja')).toBe('システムの既定 (me@example.com)');
    expect(activeAccountName(view({ systemDefault: { signedIn: false, email: null } }), 'en')).toBe('System default');
    expect(activeAccountName(undefined, 'ja')).toBe('システムの既定');
    // selected id that vanished from the list: falls back instead of showing nothing
    expect(activeAccountName(view({ activeAccountId: 'gone' }), 'en')).toBe('System default');
    expect(activeAccountName(view({ accounts: [acct('p', { email: null, lastAuthenticatedAt: null })], activeAccountId: 'p' }), 'ja')).toBe('ログイン待ち');
  });
  it('switchable count: signed-in system default + usable accounts', () => {
    expect(switchableCount(undefined)).toBe(0);
    expect(switchableCount(view())).toBe(1);
    expect(switchableCount(view({ systemDefault: { signedIn: false, email: null } }))).toBe(0);
    expect(switchableCount(view({ accounts: [acct('a'), acct('b', { signedIn: false }), acct('c', { lastAuthenticatedAt: null })] }))).toBe(2);
  });
});

describe('footer breakdown rows', () => {
  const rows: AccountUsage[] = [
    { accountId: null, label: 'me@example.com', active: false, rateLimits: null },
    { accountId: 'a', label: 'a@example.com', active: true, rateLimits: null },
    { accountId: 'p', label: 'ログイン待ち', active: false, rateLimits: null },
    { accountId: 'gone', label: 'old', active: false, rateLimits: null },
  ];
  it('keeps main order and marks which rows can be selected', () => {
    const v = view({ accounts: [acct('a'), acct('p', { lastAuthenticatedAt: null, signedIn: false })], activeAccountId: 'a' });
    const out = breakdownRows(rows, v);
    expect(out.map((r) => r.accountId)).toEqual([null, 'a', 'p', 'gone']);
    expect(out.map((r) => r.selectable)).toEqual([true, true, false, false]);
    expect(out.map((r) => r.status)).toEqual(['ok', 'ok', 'pending', 'unusable']);
    expect(out[1]!.active).toBe(true);
  });
  it('system default signed out cannot be selected', () => {
    const out = breakdownRows(rows.slice(0, 1), view({ systemDefault: { signedIn: false, email: null } }));
    expect(out[0]).toMatchObject({ selectable: false, status: 'relogin' });
  });
  it('before the registry is loaded the system default stays selectable, added accounts do not', () => {
    const out = breakdownRows(rows.slice(0, 2), undefined);
    expect(out.map((r) => r.selectable)).toEqual([true, false]);
  });
  it('empty in, empty out', () => {
    expect(breakdownRows([], view())).toEqual([]);
  });
});

describe('misc', () => {
  it('removed duplicates of both agents are collected', () => {
    expect(removedDuplicates(state())).toEqual([]);
    expect(removedDuplicates(state({ removedDuplicates: ['x'] }, { removedDuplicates: ['y', 'z'] }))).toEqual(['x', 'y', 'z']);
  });
  it('cleanLabel trims, collapses whitespace and caps at 80', () => {
    expect(cleanLabel('  仕事   用  ')).toBe('仕事 用');
    expect(cleanLabel('\n\t')).toBe('');
    expect(cleanLabel('x'.repeat(200))).toHaveLength(80);
  });
});

describe('strings', () => {
  it('ja and en have the same keys, none empty, placeholders match', () => {
    expect(Object.keys(ACCOUNTS_EN).sort()).toEqual(Object.keys(ACCOUNTS_JA).sort());
    for (const [k, ja] of Object.entries(ACCOUNTS_JA)) {
      const en = ACCOUNTS_EN[k as keyof typeof ACCOUNTS_JA];
      expect(ja.length, k).toBeGreaterThan(0);
      expect(en.length, k).toBeGreaterThan(0);
      const vars = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();
      expect(vars(en), k).toEqual(vars(ja));
    }
  });
  it('are merged into the shell dictionary', () => {
    expect(SHELL_DICT.ja['acct.add' as keyof (typeof SHELL_DICT)['ja']]).toBe(ACCOUNTS_JA['acct.add']);
    expect(SHELL_DICT.en['upd.pill.restart' as keyof (typeof SHELL_DICT)['en']]).toBe(ACCOUNTS_EN['upd.pill.restart']);
  });
  it('no leftover output-switcher / archive strings in the shell dictionary', () => {
    for (const k of Object.keys(SHELL_DICT.ja)) expect(k.startsWith('variant.') || k === 'nav.archive').toBe(false);
  });
});
