// When to check for updates. No electron here, so the schedule is unit-tested with fake timers.
//
// Ported from Ferret src/main/autoUpdate.ts (MIT) — Orca由来: ~/bench/orca/src/main/updater/ (MIT) の
// updater-setup.ts / updater-scheduling.ts（起動時に少し待って確認・一定間隔・利用者の［更新を確認］・二重の確認を止める）.
// - first check a little after launch (not on top of startup work), then every CHECK_INTERVAL_MS
// - after sleep: wait RESUME_DELAY_MS for the network to come back (no stale-focus checks in between)
// - window focus: check when the last check is older than STALE_CHECK_MS (a long-open app misses releases)
// - a network failure retries with backoff (1 min, 5 min, 15 min, 1 h) instead of waiting a full interval
// - while recording / rendering a scheduled check is postponed (no downloads or prompts mid-take); the user's own
//   "check for updates" is never postponed
// - one check at a time: a second request gets the running one
import { BUSY_RETRY_MS, CHECK_DELAY_MS, CHECK_INTERVAL_MS, RESUME_DELAY_MS, networkBackoffMs } from './logic';

export type CheckOutcome = 'ok' | 'network-error' | 'error';

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export interface UpdateLoopDeps {
  /** background checks run (packaged build with updates.auto on). The user's check works either way. */
  enabled: boolean;
  /** one check (and download, if any). Must not throw; failures are an outcome. */
  run(): Promise<CheckOutcome>;
  isBusy(): boolean;
  /** told when the next scheduled check moves (null = none) */
  onSchedule?(at: number | null): void;
  timers?: Timers;
  now?: () => number;
}

export class UpdateLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<CheckOutcome> | null = null;
  private lastChecked: number | null = null;
  private resumeUntil: number | null = null;
  private networkFailures = 0;
  private stopped = false;

  constructor(private readonly deps: UpdateLoopDeps) {}

  private get timers(): Timers {
    return this.deps.timers ?? globalThis;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  lastCheckedAt(): number | null {
    return this.lastChecked;
  }

  start(): void {
    if (!this.deps.enabled) return;
    this.stopped = false;
    this.schedule(CHECK_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.deps.onSchedule?.(null);
  }

  /** wake from sleep: check after the network is back, then resume the normal interval */
  resumed(): void {
    if (!this.deps.enabled || this.stopped) return;
    this.resumeUntil = this.now() + RESUME_DELAY_MS;
    this.schedule(RESUME_DELAY_MS);
  }

  /** window focus: check if the last check is older than maxAgeMs (not while waiting after a wake, nor when busy) */
  checkIfStale(maxAgeMs: number): Promise<CheckOutcome> | null {
    if (!this.deps.enabled || this.stopped) return null;
    const now = this.now();
    if (this.resumeUntil !== null && now < this.resumeUntil) return null;
    if (this.lastChecked !== null && now - this.lastChecked < maxAgeMs) return null;
    if (this.deps.isBusy()) return null;
    return this.checkNow().finally(() => this.schedule(this.nextDelay()));
  }

  /** check now (the user's "check for updates", or a timer). Joins a running check. */
  checkNow(): Promise<CheckOutcome> {
    if (this.running) return this.running;
    this.running = (async () => {
      let outcome: CheckOutcome;
      try {
        outcome = await this.deps.run();
      } catch {
        outcome = 'error';
      }
      this.lastChecked = this.now();
      this.networkFailures = outcome === 'network-error' ? this.networkFailures + 1 : 0;
      return outcome;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** the delay after a check: back off after network failures, else the normal interval */
  private nextDelay(): number {
    return this.networkFailures > 0 ? networkBackoffMs(this.networkFailures) : CHECK_INTERVAL_MS;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
    this.deps.onSchedule?.(this.now() + delay);
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.deps.isBusy()) {
      this.schedule(BUSY_RETRY_MS);
      return;
    }
    void this.checkNow().finally(() => this.schedule(this.nextDelay()));
  }
}
