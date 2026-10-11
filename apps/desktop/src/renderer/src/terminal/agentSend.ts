// "Send to agent" for the prompt bar and the feedback review. main picks the terminal and pastes (agent:send);
// when no agent runs in the project, the terminal pane opens one and the send is retried while it starts.
// Same flow as Ferret's review send (ReviewFindings → onAgentLaunchRequest → review:send).
import type { AgentSendRequest, AgentSendResult } from '@shared/terminal';
import { api } from '../lib/api';

/** How long the retry waits for a just-opened agent tab to show its input box. */
export const LAUNCH_WAIT_MS = 20_000;

/** Opens an agent tab and returns its terminal id (null: none could be opened). TerminalPane registers it. */
export type AgentLauncher = (agent: string | null) => Promise<string | null>;

let launcher: AgentLauncher | null = null;
let activeTerminalId: string | null = null;

export function registerAgentLauncher(fn: AgentLauncher): () => void {
  launcher = fn;
  return () => {
    if (launcher === fn) launcher = null;
  };
}

/** The terminal the user last focused in the pane (tried first). */
export function setActiveTerminal(id: string | null): void {
  activeTerminalId = id;
}

export function activeTerminal(): string | null {
  return activeTerminalId;
}

export interface SendOptions {
  /** Open an agent when none is running: the given id, or null for the default agent. Omit to only send. */
  launch?: string | null;
}

export async function sendToAgent(req: AgentSendRequest, options: SendOptions = {}): Promise<AgentSendResult> {
  const request: AgentSendRequest = { ...req, tabId: req.tabId ?? activeTerminalId };
  const first = await api.invoke('agent:send', request);
  if (!first.noAgent || options.launch === undefined || !launcher) return first;
  const tabId = await launcher(options.launch);
  if (!tabId) return first;
  return api.invoke('agent:send', { ...request, tabId, waitMs: LAUNCH_WAIT_MS });
}
