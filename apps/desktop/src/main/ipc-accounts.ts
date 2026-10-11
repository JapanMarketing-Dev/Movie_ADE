// IPC handlers of the accounts / usage / failover services (channels in shared/ipc-accounts.ts).
//
// Standalone on purpose: `handle` and `emit` are passed in, so this compiles without touching the main registry.
// Wiring from main/index.ts once the maps are merged into shared/ipc.ts:
//   registerAccountsIpc({
//     handle: (channel, fn) => handle(channel, (_e, ...args) => fn(...args)),
//     emit: (channel, ...args) => emit(mainWindow?.webContents, channel, ...args),
//     ...createAccountsStack({ host: failoverHost, openLoginTab, isWindowActive }),
//   });
// Arguments come from the renderer and are validated here before reaching the services.
import { isAccountAgent, type AccountAgent, type AccountLoginLaunch } from '../shared/accounts';
import type { AccountsEventChannel, AccountsEventMap, AccountsInvokeChannel, AccountsInvokeMap } from '../shared/ipc-accounts';
import { errorKind, reportHandled } from '../shared/report';
import type { Lang } from '../shared/types';
import { usageMeter, type UsageMeter } from '../shared/usage';
import { AccountsUserError, msg } from './accounts/messages';
import { isValidAccountId } from './accounts/paths';
import type { AccountsService } from './accounts/service';
import type { FailoverService } from './failover/service';
import type { UsageService } from './usage/service';

export type AccountsHandle = <C extends AccountsInvokeChannel>(
  channel: C,
  fn: (...args: AccountsInvokeMap[C]['args']) => AccountsInvokeMap[C]['result'] | Promise<AccountsInvokeMap[C]['result']>,
) => void;

export type AccountsEmit = <C extends AccountsEventChannel>(channel: C, ...args: AccountsEventMap[C]) => void;

export interface AccountsIpcDeps {
  handle: AccountsHandle;
  emit: AccountsEmit;
  accounts: AccountsService;
  usage: UsageService;
  /** null when failover is not wired (no terminal host yet) */
  failover: FailoverService | null;
  /** opens a built-in terminal tab running the login command; resolves with the tab id (terminal host) */
  openLoginTab?: (launch: AccountLoginLaunch) => Promise<string | null>;
  language: () => Lang;
}

function agentArg(value: unknown, lang: Lang): AccountAgent {
  if (isAccountAgent(value)) return value;
  throw new AccountsUserError(msg(lang, 'accounts.errors.invalidAgent'));
}

function accountIdArg(value: unknown, lang: Lang): string {
  if (isValidAccountId(value)) return value;
  throw new AccountsUserError(msg(lang, 'accounts.errors.invalidId'));
}

/** Footer meters for both account agents. */
export function usageMeters(deps: Pick<AccountsIpcDeps, 'accounts' | 'usage' | 'language'>): UsageMeter[] {
  const lang = deps.language();
  const state = deps.usage.getState();
  return (['claude', 'codex'] as const).map((agent) => {
    const accountId = deps.accounts.activeAccountId(agent);
    return usageMeter(agent, state[agent], { accountId, label: deps.accounts.accountLabel(agent, accountId) }, lang);
  });
}

/** Registers every channel of AccountsInvokeMap and forwards service events. Returns an unsubscribe function. */
export function registerAccountsIpc(deps: AccountsIpcDeps): () => void {
  const { handle, emit, accounts, usage, failover } = deps;
  const lang = () => deps.language();

  handle('usage:state', () => usage.getState());
  handle('usage:refresh', (force) => usage.refresh(force === true));
  handle('usage:meters', () => usageMeters(deps));
  handle('usage:accounts', (agent, force) => usage.accountUsage(agentArg(agent, lang()), force === true));

  handle('accounts:list', () => accounts.list());
  handle('accounts:add', (agent) => accounts.add(agentArg(agent, lang())));
  handle('accounts:rename', (agent, accountId, label) =>
    accounts.rename(agentArg(agent, lang()), accountIdArg(accountId, lang()), typeof label === 'string' ? label : ''),
  );
  handle('accounts:remove', (agent, accountId) => accounts.remove(agentArg(agent, lang()), accountIdArg(accountId, lang())));
  handle('accounts:select', async (agentRaw, accountIdRaw) => {
    const agent = agentArg(agentRaw, lang());
    const accountId = accountIdRaw === null ? null : accountIdArg(accountIdRaw, lang());
    const state = await accounts.select(agent, accountId);
    const switchingTabs = failover ? await failover.switchRunningAgents(agent, accountId) : 0;
    return { state, switchingTabs };
  });
  handle('accounts:startLogin', async (agentRaw, accountIdRaw) => {
    const launch = accounts.loginLaunch({ agent: agentArg(agentRaw, lang()), accountId: accountIdArg(accountIdRaw, lang()) });
    if (!deps.openLoginTab) return { tabId: null };
    return { tabId: await deps.openLoginTab(launch) };
  });

  handle('failover:status', () =>
    failover?.status() ?? { enabled: false, prefs: { enabled: false, thresholdPercent: 95, switchAccounts: true, agentOrder: [], returnToPreferred: false, handoffPercent: 100 }, last: null, waiting: [], switching: [] },
  );

  const offs: (() => void)[] = [];
  offs.push(
    accounts.onChange(() => {
      emit('accounts:changed');
      usage.accountChanged();
    }),
  );
  offs.push(
    usage.onChange((state) => {
      emit('usage:changed', state);
      try {
        failover?.onUsageChanged(state);
      } catch (err) {
        reportHandled(errorKind(err), { area: 'failover', op: 'usage changed' });
      }
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
