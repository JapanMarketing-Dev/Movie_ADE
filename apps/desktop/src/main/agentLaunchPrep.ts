// What is written before an agent terminal starts, so an unattended agent (動画を完成させて after a take, a failover
// hand-off, a restored tab) never stops at a question nobody answers:
// - Claude Code / Codex: the project folder is trusted (only a project folder itself; agentWorkspaceTrust.ts)
// - Claude Code started with --dangerously-skip-permissions: the bypass-mode consent is pre-accepted in the
//   settings.json of the tab's account (CLAUDE_CONFIG_DIR, else ~/.claude)
// Codex's --dangerously-bypass-approvals-and-sandbox asks nothing, so it needs no consent.
import { acceptClaudeBypassConsent, trustWorkspace } from './agentWorkspaceTrust';

export const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';

export interface LaunchPrepInput {
  agent: string;
  /** the argv the terminal will run (agentLaunchLine) */
  argv: readonly string[];
  /** the cwd when it is a project folder itself, else null */
  projectDir: string | null;
}

/** Which preparations apply (pure). Arguments after `--` are a prompt, not flags. */
export function launchPrepSteps(o: LaunchPrepInput): { trustFolder: boolean; bypassConsent: boolean } {
  const end = o.argv.indexOf('--');
  const flags = end === -1 ? o.argv : o.argv.slice(0, end);
  return {
    trustFolder: (o.agent === 'claude' || o.agent === 'codex') && o.projectDir !== null,
    bypassConsent: o.agent === 'claude' && flags.includes(CLAUDE_BYPASS_FLAG),
  };
}

export interface LaunchPrepDeps {
  trust: (agent: string, projectDir: string, env: Record<string, string>) => Promise<unknown>;
  consent: (env: Record<string, string>) => unknown;
}

const realDeps: LaunchPrepDeps = {
  trust: (agent, dir, env) => trustWorkspace(agent, dir, env),
  consent: (env) => acceptClaudeBypassConsent(env),
};

/** Runs the preparations with the tab's final env (its account). Never throws past the caller's catch. */
export async function prepareAgentLaunch(o: LaunchPrepInput & { env: Record<string, string> }, deps: LaunchPrepDeps = realDeps): Promise<void> {
  const steps = launchPrepSteps(o);
  if (steps.bypassConsent) deps.consent(o.env);
  if (steps.trustFolder && o.projectDir) await deps.trust(o.agent, o.projectDir, o.env);
}
