// The agent to start when "send to agent" finds none running (Ferret's defaultLaunchAgent, src/shared/sendTarget.ts,
// MIT): Claude Code when installed, else the first installed agent in catalog order.

export function defaultAgent(agents: ReadonlyArray<{ id: string; installed: boolean }>): string | null {
  const installed = agents.filter((a) => a.installed)
  return (installed.find((a) => a.id === 'claude') ?? installed[0])?.id ?? null
}
