// When a downloaded update may restart the app. No electron here (unit-tested).
//
// Updates are automatic: checked on start and periodically (loop.ts), downloaded and verified in the background, and
// installed when the app quits. On top of that, a ready update restarts the app by itself once nothing would be lost:
// - never while recording (a take must not be cut), and not while an agent is working or waiting for an answer
//   (its terminal would be killed mid-task)
// - while the user is at the computer, the footer only offers "restart to update" (non-blocking pill)
// - when the user has been away for AWAY_RESTART_MS and the app is idle, it restarts by itself (background updates on)
// - the user's "restart to update" while busy is remembered and done as soon as the app is idle

/** the user counts as away after this much system idle time (no keyboard / mouse) */
export const AWAY_RESTART_MS = 15 * 60 * 1000;
/** how often the idle state is looked at while an update is ready */
export const RESTART_POLL_MS = 60 * 1000;

export interface UpdateActivity {
  /** a take is being recorded (or its tracks are still being written) */
  recording: boolean;
  /** agent terminals that are working or waiting for the user (restarting would kill them) */
  agentsBusy: number;
  /** system idle time (no keyboard / mouse input), ms */
  userIdleMs: number;
}

export type RestartDecision =
  /** nothing to install */
  | { kind: 'none' }
  /** installed later: when the take / the agent's work ends */
  | { kind: 'wait'; reason: 'recording' | 'agent' }
  /** show the "restart to update" pill */
  | { kind: 'offer' }
  /** restart now (the user asked, or is away and nothing runs) */
  | { kind: 'restart' };

export interface RestartInput {
  /** a verified update is ready to install */
  ready: boolean;
  /** background updates are on (settings autoUpdate) */
  auto: boolean;
  /** the user pressed "restart to update" (possibly while busy) */
  requested: boolean;
  activity: UpdateActivity;
}

export function restartDecision(i: RestartInput): RestartDecision {
  if (!i.ready) return { kind: 'none' };
  if (i.activity.recording) return { kind: 'wait', reason: 'recording' };
  if (i.activity.agentsBusy > 0) return { kind: 'wait', reason: 'agent' };
  if (i.requested) return { kind: 'restart' };
  if (i.auto && Number.isFinite(i.activity.userIdleMs) && i.activity.userIdleMs >= AWAY_RESTART_MS) return { kind: 'restart' };
  return { kind: 'offer' };
}

/** agent tab states that must not be cut by a restart (shared/terminal.ts AgentTabState) */
export function agentBlocksRestart(state: string): boolean {
  return state === 'working' || state === 'blocked';
}

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

export interface RestartWatchDeps {
  ready(): boolean;
  auto(): boolean;
  activity(): UpdateActivity;
  /** what a ready update waits for (undefined = nothing); called on every look, the caller drops repeats */
  onWaiting(reason: 'recording' | 'agent' | undefined): void;
  /** quit and relaunch into the new version (called at most once) */
  restart(): void;
  timers?: Timers;
}

/** Looks at the idle state every RESTART_POLL_MS and restarts into a ready update when restartDecision says so. */
export class RestartWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private requested = false;
  private restarted = false;

  constructor(private readonly deps: RestartWatchDeps) {}

  private get timers(): Timers {
    return this.deps.timers ?? globalThis;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.timers.setInterval(() => this.evaluate(), RESTART_POLL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** the user pressed "restart to update": now if idle, else as soon as it is */
  request(): RestartDecision {
    this.requested = true;
    return this.evaluate();
  }

  isRequested(): boolean {
    return this.requested;
  }

  evaluate(): RestartDecision {
    if (this.restarted) return { kind: 'none' };
    let activity: UpdateActivity;
    try {
      activity = this.deps.activity();
    } catch {
      // unknown activity counts as busy: never restart blind
      activity = { recording: true, agentsBusy: 0, userIdleMs: 0 };
    }
    const d = restartDecision({ ready: this.deps.ready(), auto: this.deps.auto(), requested: this.requested, activity });
    this.deps.onWaiting(d.kind === 'wait' ? d.reason : undefined);
    if (d.kind === 'restart') {
      this.restarted = true;
      this.stop();
      this.deps.restart();
    }
    return d;
  }
}
