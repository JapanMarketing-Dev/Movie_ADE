// Pure model of the Claude Code / Codex account switcher (footer usage popover and Settings → アカウント).
// Ported in spirit from Ferret src/renderer/components/UsageMeter.tsx (AccountBreakdown) and AccountsSection.tsx (MIT).
// Unit-tested; no React, no IPC.
// relative (not @shared) so the vitest node run resolves it without the renderer's path aliases
import { ACCOUNT_AGENTS, accountDisplayName, systemDefaultLabel, type AccountAgent, type AgentAccountSummary, type AgentAccountsState, type AgentAccountsView } from '../../../shared/accounts';
import type { Lang } from '@shared/types';
import type { AccountUsage } from '@shared/usage';

export const AGENT_LABEL: Record<AccountAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

/** what the switcher is doing right now (one action at a time; buttons are disabled meanwhile) */
export type AccountAction = 'idle' | `add:${AccountAgent}` | `select:${string}` | `remove:${string}` | `rename:${string}` | `login:${string}`;

/** key of a select action: the account id, or system-<agent> for the system default */
export function selectKey(agent: AccountAgent, accountId: string | null): AccountAction {
  return `select:${accountId ?? `system-${agent}`}`;
}

/** an account was added but its first login has not completed yet */
export function isPendingLogin(a: Pick<AgentAccountSummary, 'lastAuthenticatedAt'>): boolean {
  return a.lastAuthenticatedAt === null;
}

/** some account of any agent waits for its login (the list is re-read every few seconds meanwhile) */
export function hasPendingLogin(state: AgentAccountsState | null): boolean {
  if (!state) return false;
  return ACCOUNT_AGENTS.some((agent) => state[agent]?.accounts.some(isPendingLogin) ?? false);
}

export type AccountStatus = 'ok' | 'pending' | 'relogin' | 'unusable';

/** the badge of one account row */
export function accountStatus(a: Pick<AgentAccountSummary, 'lastAuthenticatedAt' | 'signedIn' | 'problem'>): AccountStatus {
  if (a.problem) return 'unusable';
  if (isPendingLogin(a)) return 'pending';
  if (!a.signedIn) return 'relogin';
  return 'ok';
}

/** only signed-in accounts without a problem can be selected (selecting one that cannot log in breaks new tabs) */
export function canSelect(a: Pick<AgentAccountSummary, 'lastAuthenticatedAt' | 'signedIn' | 'problem'>): boolean {
  return accountStatus(a) === 'ok';
}

/** display name of the account new terminals of this agent use */
export function activeAccountName(view: AgentAccountsView | undefined, lang: Lang): string {
  if (!view || view.activeAccountId === null) {
    const email = view?.systemDefault.email;
    return email ? `${systemDefaultLabel(lang)} (${email})` : systemDefaultLabel(lang);
  }
  const a = view.accounts.find((x) => x.id === view.activeAccountId);
  return a ? accountDisplayName(a, lang) : systemDefaultLabel(lang);
}

/** how many accounts of this agent can be switched between (system default counts when signed in) */
export function switchableCount(view: AgentAccountsView | undefined): number {
  if (!view) return 0;
  return (view.systemDefault.signedIn ? 1 : 0) + view.accounts.filter(canSelect).length;
}

/**
 * Rows of the footer breakdown (usage:accounts) in main's order (system default → oldest, so rows do not jump when
 * switching), each marked whether it can be selected.
 */
export interface BreakdownRow extends AccountUsage {
  selectable: boolean;
  status: AccountStatus;
}

export function breakdownRows(rows: readonly AccountUsage[], view: AgentAccountsView | undefined): BreakdownRow[] {
  return rows.map((row) => {
    if (row.accountId === null) {
      const signedIn = view?.systemDefault.signedIn ?? true;
      return { ...row, selectable: signedIn, status: signedIn ? 'ok' : 'relogin' };
    }
    const a = view?.accounts.find((x) => x.id === row.accountId);
    // not in the registry (removed meanwhile): shown but cannot be selected
    if (!a) return { ...row, selectable: false, status: 'unusable' };
    return { ...row, selectable: canSelect(a), status: accountStatus(a) };
  });
}

/** names of accounts main dropped because they duplicated an existing login (shown once as a note) */
export function removedDuplicates(state: AgentAccountsState): string[] {
  return ACCOUNT_AGENTS.flatMap((agent) => state[agent]?.removedDuplicates ?? []);
}

/** the selection actually changed (a no-op select does not show "switched") */
export function selectionChanged(before: AgentAccountsState | null, after: AgentAccountsState, agent: AccountAgent): boolean {
  return (before?.[agent].activeAccountId ?? null) !== after[agent].activeAccountId;
}

/** account names are trimmed and capped (main accepts any string; 80 like Ferret's field) */
export function cleanLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, 80);
}
