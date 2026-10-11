// Claude Code / Codex accounts: one store shared by the footer usage popover and Settings → アカウント, so switching in
// one place shows in the other at once (Ferret src/renderer/hooks/useAgentAccounts.ts + lib/accountLogin.ts, MIT; there
// the two parts talk through window events, here they read the same module store).
//
// Channels (shared/ipc-accounts.ts): accounts:list / add / rename / remove / select / startLogin, event accounts:changed.
// Logins run in a built-in terminal that main opens (accounts:startLogin); the login dialog (components/AgentAccounts.tsx)
// shows it. While an account waits for its first login the list is re-read every few seconds.
import { useSyncExternalStore } from 'react';
import type { AccountAgent, AgentAccountsState } from '@shared/accounts';
import { api, errMsg } from '../lib/api';
import { refreshUsage } from './agentUsage';
import { cleanLabel, hasPendingLogin, removedDuplicates, selectKey, selectionChanged, type AccountAction } from './accountsModel';

/** re-read interval while an account waits for its login */
export const PENDING_POLL_MS = 3000;

export interface AccountsSnapshot {
  state: AgentAccountsState | null;
  action: AccountAction;
  error: string | null;
  /** names dropped by main because the same login already existed */
  duplicates: string[];
  /** the agent whose selection just changed, and how many running terminals switch once idle */
  switched: { agent: AccountAgent; switchingTabs: number } | null;
  /** an open login terminal (main's terminal id), shown by the login dialog */
  login: { agent: AccountAgent; accountId: string; tabId: string } | null;
}

let snap: AccountsSnapshot = { state: null, action: 'idle', error: null, duplicates: [], switched: null, login: null };
const listeners = new Set<() => void>();
let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function set(patch: Partial<AccountsSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
  syncPoll();
}

function syncPoll(): void {
  const want = hasPendingLogin(snap.state) || snap.login !== null;
  if (want && !pollTimer) pollTimer = setInterval(() => void reloadAccounts(), PENDING_POLL_MS);
  if (!want && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function apply(next: AgentAccountsState): void {
  const dups = removedDuplicates(next);
  set({ state: next, ...(dups.length ? { duplicates: dups } : {}) });
}

export async function reloadAccounts(): Promise<void> {
  try {
    apply(await api.invoke('accounts:list'));
  } catch (e) {
    set({ error: errMsg(e) });
  }
}

async function run(action: AccountAction, task: () => Promise<void>): Promise<boolean> {
  if (snap.action !== 'idle') return false;
  set({ action, error: null, duplicates: [] });
  try {
    await task();
    return true;
  } catch (e) {
    set({ error: errMsg(e) });
    return false;
  } finally {
    set({ action: 'idle' });
  }
}

/** open the login terminal for an account (added or needing a fresh login) */
async function openLogin(agent: AccountAgent, accountId: string): Promise<void> {
  const r = await api.invoke('accounts:startLogin', agent, accountId);
  if (!r.tabId) throw new Error('login terminal could not be opened');
  set({ login: { agent, accountId, tabId: r.tabId } });
}

export const accountActions = {
  /** add an account: main creates a "waiting for login" entry, then the login runs in a terminal */
  add: (agent: AccountAgent) =>
    run(`add:${agent}`, async () => {
      const r = await api.invoke('accounts:add', agent);
      apply(r.state);
      await openLogin(r.login.agent, r.login.accountId);
    }),
  login: (agent: AccountAgent, accountId: string) => run(`login:${accountId}`, () => openLogin(agent, accountId)),
  /** new terminals of this agent use the account; running ones are handed over once idle */
  select: (agent: AccountAgent, accountId: string | null) =>
    run(selectKey(agent, accountId), async () => {
      const before = snap.state;
      const r = await api.invoke('accounts:select', agent, accountId);
      apply(r.state);
      if (selectionChanged(before, r.state, agent)) set({ switched: { agent, switchingTabs: r.switchingTabs } });
      // the footer shows the new account's usage right away
      void refreshUsage(true);
    }),
  rename: (agent: AccountAgent, accountId: string, label: string) =>
    run(`rename:${accountId}`, async () => apply(await api.invoke('accounts:rename', agent, accountId, cleanLabel(label)))),
  remove: (agent: AccountAgent, accountId: string) =>
    run(`remove:${accountId}`, async () => apply(await api.invoke('accounts:remove', agent, accountId))),
  /** the login dialog closed (the terminal is closed by the dialog) */
  loginClosed: () => {
    set({ login: null });
    void reloadAccounts();
    void refreshUsage(true);
  },
  clearSwitched: () => set({ switched: null }),
};

function start(): void {
  if (started) return;
  started = true;
  void reloadAccounts();
  api.on('accounts:changed', () => void reloadAccounts());
  // logins usually finish in the browser: re-read when the window comes back
  window.addEventListener('focus', () => void reloadAccounts());
}

export function useAgentAccounts(): AccountsSnapshot {
  return useSyncExternalStore(
    (l) => {
      start();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}
