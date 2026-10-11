// Claude Code / Codex account switching, usage meters and failover, wired to the app's settings and paths.
// Everything else in main uses these through createAccountsStack() and main/ipc-accounts.ts.
//
// Settings read (~/.solocut/settings.json): language, agents.order, agents.failover.{enabled, thresholdPercent,
// switchAccounts, returnToPreferred, handoffPercent}, agents.custom (labels). The account registry is
// ~/.solocut/accounts/accounts.json and managed config folders are ~/.solocut/accounts/<agent>/<id>/.
import { join } from 'node:path';
import { AGENTS } from '@solocut/agents';
import type { AccountLoginLaunch } from '../../shared/accounts';
import { sanitizeLimitFailover, type LimitFailoverPrefs } from '../../shared/failover';
import type { AccountsEmit } from '../ipc-accounts';
import { FailoverService, type FailoverHost } from '../failover/service';
import { getPath, home, language, settingsObject } from '../services/platform';
import { UsageService } from '../usage/service';
import { AccountsService } from './service';

export { AccountsService } from './service';
export { AccountsUserError } from './messages';

/** agents.failover + agents.order from settings, normalised. */
export function failoverPrefsFromSettings(settings: unknown = settingsObject()): LimitFailoverPrefs {
  return sanitizeLimitFailover(getPath(settings, 'agents.failover'), getPath(settings, 'agents.order'));
}

/** Display name of an agent id (catalog label, or the custom agent's label from settings). */
export function agentLabelFor(id: string, settings: unknown = settingsObject()): string {
  const def = AGENTS.find((d) => d.id === id);
  if (def) return def.label;
  const custom = getPath(settings, 'agents.custom');
  const found = Array.isArray(custom) ? (custom as { id?: unknown; label?: unknown }[]).find((c) => c.id === id) : undefined;
  if (typeof found?.label === 'string' && found.label.trim()) return found.label.trim();
  return id.startsWith('custom:') ? id.slice('custom:'.length) : id;
}

export interface AccountsStackOptions {
  emit: AccountsEmit;
  /** the terminal side of failover; null until the terminal module provides it (failover stays off) */
  host?: FailoverHost | null;
  /** whether the main window is visible, not minimized and focused */
  isWindowActive?: () => boolean;
  openLoginTab?: (launch: AccountLoginLaunch) => Promise<string | null>;
}

export function createAccountsStack(options: AccountsStackOptions) {
  const accounts = new AccountsService({
    root: join(home(), 'accounts'),
    language,
    agentExecutable: (agent) => AGENTS.find((d) => d.id === agent)?.command ?? agent,
  });
  const usage = new UsageService({
    accounts,
    language,
    ...(options.isWindowActive ? { isActive: options.isWindowActive } : {}),
  });
  const failover = options.host
    ? new FailoverService({
        host: options.host,
        prefs: () => failoverPrefsFromSettings(),
        language,
        agentLabel: (id) => agentLabelFor(id),
        accounts,
        usage,
        emit: (notice) => options.emit('failover:notice', notice),
        emitStatus: (status) => options.emit('failover:status', status),
      })
    : null;
  usage.start();
  failover?.start();
  return {
    accounts,
    usage,
    failover,
    language,
    ...(options.openLoginTab ? { openLoginTab: options.openLoginTab } : {}),
    /** env additions for spawning an agent: the terminal host calls this (resolveAgentEnv hook) */
    resolveAgentEnv: (agentId: string, baseEnv: NodeJS.ProcessEnv, accountId?: string | null) => accounts.resolveAgentEnv(agentId, baseEnv, accountId),
    dispose(): void {
      failover?.dispose();
      usage.dispose();
    },
  };
}
