// Turns the selected account into environment variables for the agent's child process.
//
// Ported from Ferret src/main/accounts/env.ts (MIT).
// Orca由来: ~/bench/orca/src/main/claude-accounts/environment.ts（applyClaudeEnvPatch / CLAUDE_AUTH_ENV_VARS）,
//           ~/bench/orca/src/main/codex-accounts/runtime-home-service-launch.ts の考え方（MIT, Copyright 2026 Lovecast Inc.）
//
// - system default account → nothing is added (the user's environment as is)
// - managed Codex account → CODEX_HOME, managed Claude account → CLAUDE_CONFIG_DIR set to its folder
// - managed Claude account → Anthropic auth variables in the environment are blanked (otherwise the agent would
//   run with that key instead of the chosen account; same as Orca's stripAuthEnv)
// - when the folder cannot be verified we stop with a reason instead of silently falling back to the default
//   account (never bill the wrong account)
import type { AccountAgent, AgentAccountsSettings } from '../../shared/accounts';
import type { Lang } from '../../shared/types';
import { ensureCodexDaemonSocketGuard, linkSharedEntries, migrateManagedClaudeDir } from './agentConfig';
import { AccountsUserError, msg } from './messages';
import { assertManagedAccountDir, systemConfigDir } from './paths';

export const CLAUDE_AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'] as const;

export const AGENT_ACCOUNT_ENV_KEY: Record<AccountAgent, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

export function resolveAgentEnvFrom(options: {
  agent: AccountAgent;
  accounts: AgentAccountsSettings | undefined;
  /** ~/.solocut/accounts */
  root: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** explicit account (null = system default); undefined = the selected one */
  accountId?: string | null;
  /** the default account's config folder (tests; defaults to ~/.claude etc.) */
  systemDir?: string;
  lang?: Lang;
}): Record<string, string> {
  const { agent, root } = options;
  const list = options.accounts?.[agent];
  const accountId = options.accountId !== undefined ? options.accountId : (list?.activeAccountId ?? null);
  if (!accountId) return {};
  if (options.accountId === undefined && !list?.accounts.some((a) => a.id === accountId)) return {};
  const systemDir = options.systemDir ?? systemConfigDir(agent);
  let dir: string;
  try {
    dir = assertManagedAccountDir({ root, agent, accountId, systemDir, ...(options.lang ? { lang: options.lang } : {}) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AccountsUserError(msg(options.lang ?? 'ja', 'accounts.errors.unusable', { agent: agent === 'claude' ? 'Claude Code' : 'Codex', reason }));
  }
  const env: Record<string, string> = { [AGENT_ACCOUNT_ENV_KEY[agent]]: dir };
  if (agent === 'claude') {
    // carry consents (bypass-permissions mode …) into previously added accounts once, before the launch
    migrateManagedClaudeDir(dir, systemDir);
    const base = options.baseEnv ?? process.env;
    for (const key of CLAUDE_AUTH_ENV_VARS) if (base[key]) env[key] = '';
  } else {
    // long managed paths break Codex's daemon socket; check on every launch
    ensureCodexDaemonSocketGuard(dir);
    // link entries shared later (rules …) into previously added accounts
    linkSharedEntries('codex', dir, systemDir);
  }
  return env;
}
