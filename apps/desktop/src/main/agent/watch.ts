// Agent state for every terminal tab, polled in main once a second and pushed to the renderer as `agent:state`.
// Ferret did this poll in the renderer (TerminalPane + terminal/pollSchedule + terminal/agentAttention); Solocut
// runs it once in main so the terminal tabs and the status-bar footer read the same state.
import type { AgentStateInfo, AgentTabInfo, AgentTabState, TerminalSessionInfo } from '../../shared/terminal'
import { INITIAL_TRACK, advancePaneState, type PaneTrack } from '../../shared/agentAttention'
import { panesDueForPoll } from '../../shared/pollSchedule'

/** What the watcher needs from TerminalManager (a fake in the unit tests). */
export interface WatchedTerminals {
  list(): TerminalSessionInfo[]
  isVisible(id: string): boolean
  agentState(id: string): Promise<AgentStateInfo>
}

export interface AgentWatchOptions {
  /** The app window has focus (a tab counts as seen only then). */
  focused: () => boolean
  platform?: NodeJS.Platform
  /** On Windows each poll starts PowerShell; without focus poll only every n-th tick. */
  backgroundEvery?: number
}

/** Display state: unknown (no agent in the foreground) shows as idle. */
export function displayState(track: PaneTrack): AgentTabState {
  return track.state === 'unknown' ? 'idle' : track.state
}

export class AgentWatch {
  private readonly tracks = new Map<string, PaneTrack>()
  private readonly agents = new Map<string, string | null>()
  private readonly lastPolled = new Map<string, number>()
  private readonly emitted = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private tickCount = 0
  private running = false

  constructor(
    private readonly terminals: WatchedTerminals,
    private readonly emit: (info: AgentTabInfo) => void,
    private readonly options: AgentWatchOptions
  ) {}

  start(intervalMs = 1000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One poll. Visible tabs every time, hidden ones every few seconds (shared/pollSchedule.ts). */
  async tick(now = Date.now()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      this.tickCount += 1
      const focused = this.options.focused()
      const platform = this.options.platform ?? process.platform
      if (platform === 'win32' && !focused && this.tickCount % (this.options.backgroundEvery ?? 5) !== 0) return
      const sessions = this.terminals.list()
      const live = new Set(sessions.map((s) => s.id))
      for (const id of [...this.tracks.keys()]) if (!live.has(id)) this.forget(id)
      const foreground = new Set(sessions.filter((s) => this.terminals.isVisible(s.id)).map((s) => s.id))
      const due = new Set(panesDueForPoll(sessions.map((s) => s.id), foreground, this.lastPolled, now))
      for (const session of sessions) {
        if (!due.has(session.id)) continue
        this.lastPolled.set(session.id, now)
        const result = await this.terminals.agentState(session.id).catch(() => null)
        const seen = focused && foreground.has(session.id)
        const track = advancePaneState(this.tracks.get(session.id) ?? INITIAL_TRACK, result?.state ?? 'unknown', seen)
        this.tracks.set(session.id, track)
        const agent = result && result.kind !== 'unknown' ? result.agent : null
        // keep the last agent while a finished (done) tab waits to be looked at
        if (agent || track.state !== 'done') this.agents.set(session.id, agent)
        this.publish(session)
      }
    } finally {
      this.running = false
    }
  }

  private info(session: TerminalSessionInfo): AgentTabInfo {
    return {
      tabId: session.id,
      agentId: this.agents.get(session.id) ?? null,
      state: displayState(this.tracks.get(session.id) ?? INITIAL_TRACK),
      title: session.title,
      cwd: session.cwd
    }
  }

  private publish(session: TerminalSessionInfo): void {
    const info = this.info(session)
    const key = `${info.agentId}\0${info.state}\0${info.title}`
    if (this.emitted.get(session.id) === key) return
    this.emitted.set(session.id, key)
    this.emit(info)
  }

  /** Every open tab with its state (agent:tabs). */
  tabs(): AgentTabInfo[] {
    return this.terminals.list().map((session) => this.info(session))
  }

  /** The tab closed. */
  forget(id: string): void {
    this.tracks.delete(id)
    this.agents.delete(id)
    this.lastPolled.delete(id)
    this.emitted.delete(id)
  }
}
