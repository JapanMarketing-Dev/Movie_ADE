// "Send to agent" from the prompt bar and the feedback review: pick the terminal, then paste + verify + Enter.
// Target choice follows Ferret src/main/agent/sendTarget.ts (focused tab → same project's agent; MIT).
import type { AgentSendRequest, AgentSendResult, AgentStateInfo } from '../../shared/terminal'
import { delay } from '../../shared/terminal'
import { t } from '../terminal/messages'

/** Upper bound for one request's text (one bracketed paste; sanitize.ts splits above 64 KiB anyway). */
export const MAX_SEND_TEXT = 100_000
/** Longest wait for an agent tab the renderer just opened. */
export const MAX_SEND_WAIT_MS = 30_000

export interface SendHost {
  agentState(id: string): Promise<AgentStateInfo>
  findAgentTerminal(agent: string, projectDir: string | null): Promise<string | null>
  resolveSendTarget(preferred: string | null, projectDir: string | null): Promise<string | null>
  sendText(id: string, text: string): Promise<{ ok: boolean; message: string; submitted?: boolean }>
}

export async function pickSendTarget(host: SendHost, req: AgentSendRequest): Promise<string | null> {
  const projectDir = req.projectDir ?? null
  const agent = req.agent && req.agent !== 'default' ? req.agent : null
  if (agent) {
    if (req.tabId && (await host.agentState(req.tabId)).agent === agent) return req.tabId
    const running = await host.findAgentTerminal(agent, projectDir)
    if (running) return running
  }
  return host.resolveSendTarget(req.tabId ?? null, projectDir)
}

export async function sendAgentRequest(
  host: SendHost,
  req: AgentSendRequest,
  sleep: (ms: number) => Promise<void> = delay,
  now: () => number = Date.now
): Promise<AgentSendResult> {
  const text = typeof req.text === 'string' ? req.text.slice(0, MAX_SEND_TEXT) : ''
  if (!text.trim()) return { ok: false, message: t('agent.send.empty') }
  const waitMs = Math.min(MAX_SEND_WAIT_MS, Math.max(0, Number(req.waitMs) || 0))
  const deadline = now() + waitMs
  let target = await pickSendTarget(host, req)
  while (!target) {
    if (now() >= deadline) return { ok: false, noAgent: true, message: t('terminal.send.noAgent') }
    await sleep(500)
    target = await pickSendTarget(host, req)
  }
  const result = await host.sendText(target, text)
  return { ...result, tabId: target }
}
