// After a take is ingested, the app hands the project to the agent by itself: it renders the `finish` prompt
// (動画を完成させて) and sends it with sendToAgent({ launch }), which opens an agent terminal when none runs.
// Decision logic is pure (settings `autopilot.autoStart`, agent choice, one send per take); runAutoFinish wires it
// to injected effects so it can be tested without IPC.

export const DEFAULT_AGENT = 'claude';

/** `autopilot.autoStart` from the raw settings.json object; default true (missing, broken file or non-boolean). */
export function autoStartEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const ap = settings?.autopilot;
  if (!ap || typeof ap !== 'object' || Array.isArray(ap)) return true;
  const v = (ap as Record<string, unknown>).autoStart;
  return typeof v === 'boolean' ? v : true;
}

/** The agent the prompt asks for; 'default', empty or missing → claude. */
export function agentFor(promptAgent: string | null | undefined): string {
  const a = (promptAgent ?? '').trim();
  return a === '' || a === 'default' ? DEFAULT_AGENT : a;
}

/** Display name for the toast. */
export function agentLabel(agent: string): string {
  const known: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
  return known[agent] ?? (agent.startsWith('custom:') ? agent.slice('custom:'.length) : agent);
}

export type AutoFinishDecision = { send: true } | { send: false; reason: 'disabled' | 'no-take' | 'already-sent' };

/** Whether this take should be handed to the agent now. */
export function decideAutoFinish(o: { settings: Record<string, unknown> | null | undefined; takeId: string | null | undefined; sent: ReadonlySet<string> }): AutoFinishDecision {
  if (!o.takeId) return { send: false, reason: 'no-take' };
  if (!autoStartEnabled(o.settings)) return { send: false, reason: 'disabled' };
  if (o.sent.has(o.takeId)) return { send: false, reason: 'already-sent' };
  return { send: true };
}

export interface AutoFinishDeps {
  settings: () => Record<string, unknown> | null | undefined;
  render: (dir: string) => Promise<{ text: string; agent?: string }>;
  send: (text: string, agent: string, dir: string) => Promise<{ ok: boolean; message: string }>;
  toast: (m: string) => void;
  /** Takes already handed over in this app session (module-level, survives screen switches). */
  sent: Set<string>;
  messages: { started: (agent: string) => string; failed: (detail: string) => string };
}

export type AutoFinishOutcome = 'sent' | 'skipped' | 'failed';

/** Sends the finish prompt for a just-ingested take at most once. Never throws. */
export async function runAutoFinish(dir: string, takeId: string | null | undefined, deps: AutoFinishDeps): Promise<AutoFinishOutcome> {
  const d = decideAutoFinish({ settings: deps.settings(), takeId, sent: deps.sent });
  if (!d.send) return 'skipped';
  // marked before the async work so a second stop/ingest of the same take cannot race a second send
  deps.sent.add(takeId!);
  try {
    const p = await deps.render(dir);
    if (!p.text.trim()) throw new Error('empty prompt');
    const agent = agentFor(p.agent);
    const r = await deps.send(p.text, agent, dir);
    if (!r.ok) {
      deps.toast(deps.messages.failed(r.message));
      return 'failed';
    }
    deps.toast(deps.messages.started(agentLabel(agent)));
    return 'sent';
  } catch (e) {
    deps.toast(deps.messages.failed(e instanceof Error ? e.message : String(e)));
    return 'failed';
  }
}

/** One set for the app session. */
export const sentTakes = new Set<string>();
