// IPC channels of the accounts / usage / failover services (footer meters, account switcher, failover status).
// Same shape as shared/ipc.ts (invoke: { args; result }, events: tuples) so the maps can be merged into the main
// registry: spread AccountsInvokeMap into InvokeMap and AccountsEventMap into EventMap, and add the channel names
// below to the `invoke` / `events` records there.
import type { AccountAgent, AgentAccountAddResult, AgentAccountsState } from './accounts';
import type { FailoverNotice, FailoverStatus } from './failover';
import type { AccountUsage, UsageMeter, UsageState } from './usage';

/** renderer -> main (ipcRenderer.invoke) */
export interface AccountsInvokeMap {
  /** current usage of the selected account of each agent (no fetch) */
  'usage:state': { args: []; result: UsageState };
  /** fetch usage: force = manual refresh (passes the 5-minute debounce); the first call starts polling */
  'usage:refresh': { args: [force: boolean]; result: UsageState };
  /** footer meters (one per account agent: percent used, reset time, plan, current account) */
  'usage:meters': { args: []; result: UsageMeter[] };
  /** per-account breakdown of one agent (system default + added accounts); fetched only when opened */
  'usage:accounts': { args: [agent: AccountAgent, force?: boolean]; result: AccountUsage[] };

  'accounts:list': { args: []; result: AgentAccountsState };
  /** creates a "waiting for login" account; then call accounts:startLogin with result.login */
  'accounts:add': { args: [agent: AccountAgent]; result: AgentAccountAddResult };
  'accounts:rename': { args: [agent: AccountAgent, accountId: string, label: string]; result: AgentAccountsState };
  'accounts:remove': { args: [agent: AccountAgent, accountId: string]; result: AgentAccountsState };
  /**
   * select the account for new tabs (null = system default). Running tabs of that agent are handed over to the new
   * account once idle; switchingTabs = how many.
   */
  'accounts:select': { args: [agent: AccountAgent, accountId: string | null]; result: { state: AgentAccountsState; switchingTabs: number } };
  /** opens a built-in terminal tab that runs the agent's login for that account (main builds argv / env) */
  'accounts:startLogin': { args: [agent: AccountAgent, accountId: string]; result: { tabId: string | null } };

  'failover:status': { args: []; result: FailoverStatus };
}

/** main -> renderer events */
export interface AccountsEventMap {
  'usage:changed': [state: UsageState];
  /** the account registry changed (added, logged in, renamed, removed, selected): re-invoke accounts:list */
  'accounts:changed': [];
  /** a switch finished or could not be done (footer + toast); fromTabId is closed by main when the host can */
  'failover:notice': [notice: FailoverNotice];
  'failover:status': [status: FailoverStatus];
}

export type AccountsInvokeChannel = keyof AccountsInvokeMap;
export type AccountsEventChannel = keyof AccountsEventMap;

const invoke: Record<AccountsInvokeChannel, true> = {
  'usage:state': true, 'usage:refresh': true, 'usage:meters': true, 'usage:accounts': true,
  'accounts:list': true, 'accounts:add': true, 'accounts:rename': true, 'accounts:remove': true,
  'accounts:select': true, 'accounts:startLogin': true,
  'failover:status': true,
};
const events: Record<AccountsEventChannel, true> = {
  'usage:changed': true, 'accounts:changed': true, 'failover:notice': true, 'failover:status': true,
};

export const ACCOUNTS_INVOKE_CHANNELS = Object.freeze(Object.keys(invoke) as AccountsInvokeChannel[]);
export const ACCOUNTS_EVENT_CHANNELS = Object.freeze(Object.keys(events) as AccountsEventChannel[]);

export function isAccountsInvokeChannel(c: unknown): c is AccountsInvokeChannel {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(invoke, c);
}
export function isAccountsEventChannel(c: unknown): c is AccountsEventChannel {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(events, c);
}
