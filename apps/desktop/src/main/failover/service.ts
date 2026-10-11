// Failover on usage limits (the orchestrator).
//
// Ported from Ferret src/main/failover/service.ts (MIT). Ferret drove its TerminalManager directly; Solocut talks to
// the terminal through FailoverHost (implemented by the terminal module), so this file never imports terminal code.
//
// - When an agent tab prints a limit message, wait a moment and check the end of the screen; then open a new tab in
//   the same project with another account of the same agent → the next agent in agents.order, and hand over.
// - When fetched usage reaches thresholdPercent, new tabs of that agent switch to an account with room.
// - returnToPreferred: when a higher-priority agent has quota again, idle failover tabs move back.
// - Claude in Chrome only connects to Claude Code on the same claude.ai account: Chrome accounts are preferred and
//   new tabs move back to them when they have room again (unless the user picked an account during this run).
// - handoffPercent (default 98): a running tab whose account reaches it is handed over once idle, without waiting
//   for the limit message (unattended overnight runs keep going).
// The handoff goes through <project>/.solocut/handoff.md (handoff.ts). Before switching, the current agent is asked
// to update it; without a response Solocut appends what it knows. The new tab gets one line pointing at the file and
// `solocut next --json`. A notice goes to the footer / toast and the host closes the old tab. switchAllowed() caps
// how often switches repeat.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AccountAgent, AgentAccountsState } from '../../shared/accounts';
import type { AgentId, FailoverNotice, FailoverReason, FailoverStatus, LimitFailoverPrefs } from '../../shared/failover';
import { errorKind, flow, reportHandled } from '../../shared/report';
import type { Lang } from '../../shared/types';
import type { AccountUsage, UsageState } from '../../shared/usage';
import { msg } from '../accounts/messages';
import { limitOnScreen, limitedUntil, maxUsedPercent, mentionsLimit } from './detect';
import { appendHandoffNote, changedFilesFrom, handoffFilePath, HANDOFF_RELATIVE_PATH, LastInputTracker, nextAgentPrompt, solocutNote, updateRequest, type HandoffReason } from './handoff';
import {
  DEFAULT_LIMIT_COOLDOWN_MS,
  chromeReturnTarget,
  isAccountAgentId,
  limitKey,
  nearLimitTabs,
  planFailover,
  planReturn,
  switchAllowed,
  tabsToSwitch,
  usableAccounts,
  type AccountCandidate,
  type FailoverTarget,
  type PlanInput,
  type RunningTab,
} from './plan';

// ───────────────────────── host interface (implemented by the terminal module) ─────────────────────────

/** Agent activity in a tab: idle = waiting for input, blocked = waiting for a confirmation (trust prompt …). */
export type AgentRunState = 'idle' | 'working' | 'blocked' | 'unknown';

export interface FailoverTab {
  id: string;
  /** agent running in the tab (null for a plain shell) */
  agentId: string | null;
  /** project folder the tab works in */
  projectDir: string;
  /**
   * Claude Code / Codex: the account the tab was launched with (null = system default; undefined = unknown →
   * the selected account is assumed). The host gets it from AccountsService.tabAccountId() when spawning.
   */
  accountId?: string | null;
}

export interface FailoverHost {
  /** open agent tabs */
  tabs(): FailoverTab[];
  /** activity of the agent in the tab */
  agentState(tabId: string): Promise<AgentRunState> | AgentRunState;
  /** current screen text of the tab (the last ~50 lines are enough; ANSI may remain) */
  screenText(tabId: string): string;
  /** terminal output as it arrives; returns an unsubscribe function */
  onOutput(cb: (tabId: string, text: string) => void): () => void;
  /** keystrokes / pastes typed into the tab (for the "last request" note); optional */
  onInput?(cb: (tabId: string, data: string) => void): () => void;
  /** a tab closed; optional (stale entries are also dropped when tabs() no longer lists them) */
  onClosed?(cb: (tabId: string) => void): () => void;
  /**
   * Opens a new tab running `agentId` in `projectDir` and resolves with its id once spawned. accountId: Claude Code /
   * Codex account to launch with (null = system default); the host passes it to AccountsService.resolveAgentEnv().
   */
  spawnAgent(projectDir: string, agentId: string, opts: { accountId?: string | null }): Promise<string>;
  /** Sends text to the agent as a bracketed paste followed by Enter; false when not delivered. */
  send(tabId: string, text: string): Promise<boolean>;
  /** Closes the tab that hit the limit after a successful handover (optional; otherwise the UI does it from the notice). */
  closeTab?(tabId: string): void;
  /** installed (usable) agent ids */
  installedAgents(): Promise<ReadonlySet<string>>;
}

/** What failover needs from the accounts service. */
export interface FailoverAccounts {
  list(): Promise<AgentAccountsState>;
  select(agent: AccountAgent, accountId: string | null): Promise<unknown>;
  activeAccountId(agent: AccountAgent): string | null;
  accountLabel(agent: AccountAgent, accountId: string | null): string;
  claudeChromeAccounts(): Promise<Set<string | null>>;
}

export interface FailoverDeps {
  host: FailoverHost;
  prefs: () => LimitFailoverPrefs;
  language: () => Lang;
  agentLabel: (agentId: AgentId) => string;
  accounts: FailoverAccounts;
  usage: { accountUsage(agent: AccountAgent): Promise<AccountUsage[]> };
  /** footer / toast notice (IPC event) */
  emit: (notice: FailoverNotice) => void;
  /** status changed (IPC event) */
  emitStatus?: (status: FailoverStatus) => void;
  /** `git status --porcelain` lines; null when not a git repository (tests replace it) */
  changedFiles?: (projectDir: string) => Promise<string[] | null>;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  timing?: Partial<typeof TIMING>;
}

export const TIMING = {
  /** after a limit message, wait before checking the end of the screen (avoids redraws in progress) */
  confirmDelayMs: 2500,
  /** wait for the new tab to open / to accept input */
  createTimeoutMs: 20_000,
  readyTimeoutMs: 60_000,
  /** no repeated usage-based account switches for the same agent within this time */
  usageSwitchGapMs: 10 * 60 * 1000,
  /** returnToPreferred check interval */
  returnCheckMs: 5 * 60 * 1000,
  /** "everything is at its limit" is not repeated for a project within this time */
  waitingNoticeGapMs: 30 * 60 * 1000,
  /** after asking for a handoff update, how long to wait for the agent to start (not starting = stopped) */
  updateStartMs: 8000,
  /** longest wait for the update to finish */
  updateTimeoutMs: 120_000,
  /** handoffPercent check interval */
  nearLimitCheckMs: 60 * 1000,
  /** longest wait for a working tab to become idle before a near-limit handover */
  nearLimitIdleWaitMs: 10 * 60 * 1000,
  /** longest wait for a working tab before reopening it with a newly selected account */
  switchWaitMs: 60 * 60 * 1000,
  /** Chrome account return check interval */
  chromeReturnGapMs: 5 * 60 * 1000,
  /** state polling while waiting */
  pollMs: 1000,
};

const execFileAsync = promisify(execFile);

/** `git status --porcelain` without running repository fsmonitor hooks; null when not git. */
async function gitChangedFiles(projectDir: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectDir, '-c', 'core.fsmonitor=false', 'status', '--porcelain'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return changedFilesFrom(stdout);
  } catch {
    // not a git repository or git missing (expected)
    return null;
  }
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    // not created yet (expected)
    return 0;
  }
}

const HOUR_MS = 60 * 60 * 1000;

export class FailoverService {
  private readonly t: typeof TIMING;
  private readonly inputs = new Map<string, LastInputTracker>();
  private readonly confirmTimers = new Map<string, NodeJS.Timeout>();
  /** account each tab was launched with, when known from a failover spawn */
  private readonly launchedAccount = new Map<string, string | null>();
  /** tabs opened by failover (returnToPreferred candidates) */
  private readonly failoverTabs = new Set<string>();
  /** considered limited until (limitKey → time) */
  private readonly limited = new Map<string, number>();
  /** switch times per project */
  private readonly history = new Map<string, number[]>();
  /** projects with a switch in progress */
  private readonly busy = new Set<string>();
  private readonly usageSwitchAt: Record<AccountAgent, number> = { claude: 0, codex: 0 };
  private readonly waitingNoticeAt = new Map<string, number>();
  /** projects waiting for a limit to reset */
  private readonly waiting = new Map<string, { agent: AgentId; until: number | null }>();
  /** accounts the user picked during this run (not moved back to the Chrome account automatically) */
  private readonly manualChoice: Partial<Record<AccountAgent, string | null>> = {};
  private chromeReturnCheckAt = 0;
  /** tabs receiving a handoff instruction (not remembered as the "last request") */
  private readonly handoffSending = new Set<string>();
  private readonly nearLimitStarted = new Set<string>();
  private returnTimer: NodeJS.Timeout | null = null;
  private nearLimitTimer: NodeJS.Timeout | null = null;
  private last: FailoverNotice | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly deps: FailoverDeps) {
    this.t = { ...TIMING, ...deps.timing };
  }

  // ---------- wiring ----------

  /** Subscribes to the host and starts the timers. */
  start(): void {
    const { host } = this.deps;
    this.unsubscribe.push(host.onOutput((id, text) => this.output(id, text)));
    if (host.onInput) this.unsubscribe.push(host.onInput((id, data) => this.input(id, data)));
    if (host.onClosed) this.unsubscribe.push(host.onClosed((id) => this.closed(id)));
    this.syncTimers();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    for (const timer of this.confirmTimers.values()) clearTimeout(timer);
    this.confirmTimers.clear();
    if (this.returnTimer) clearInterval(this.returnTimer);
    if (this.nearLimitTimer) clearInterval(this.nearLimitTimer);
    this.returnTimer = this.nearLimitTimer = null;
  }

  /** Re-reads the prefs (call after agents.failover / agents.order changed). */
  syncTimers(): void {
    if (this.disposed) return;
    const prefs = this.deps.prefs();
    const wantReturn = prefs.enabled && prefs.returnToPreferred;
    if (wantReturn && !this.returnTimer) {
      this.returnTimer = setInterval(() => void this.checkReturn().catch((err: unknown) => reportHandled(errorKind(err), { area: 'failover', op: 'return' })), this.t.returnCheckMs);
      this.returnTimer.unref?.();
    } else if (!wantReturn && this.returnTimer) {
      clearInterval(this.returnTimer);
      this.returnTimer = null;
    }
    const wantNear = prefs.enabled && prefs.handoffPercent < 100;
    if (wantNear && !this.nearLimitTimer) {
      this.nearLimitTimer = setInterval(() => void this.checkNearLimit().catch((err: unknown) => reportHandled(errorKind(err), { area: 'failover', op: 'near limit' })), this.t.nearLimitCheckMs);
      this.nearLimitTimer.unref?.();
    } else if (!wantNear && this.nearLimitTimer) {
      clearInterval(this.nearLimitTimer);
      this.nearLimitTimer = null;
    }
    this.emitStatus();
  }

  status(): FailoverStatus {
    const prefs = this.deps.prefs();
    const now = this.now();
    return {
      enabled: prefs.enabled,
      prefs,
      last: this.last,
      waiting: [...this.waiting].filter(([, w]) => w.until === null || w.until > now).map(([projectDir, w]) => ({ projectDir, ...w })),
      switching: [...this.busy],
    };
  }

  private emitStatus(): void {
    this.deps.emitStatus?.(this.status());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private delay(ms: number): Promise<void> {
    if (this.deps.delay) return this.deps.delay(ms);
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  private lang(): Lang {
    return this.deps.language();
  }

  private label(agent: AgentId): string {
    return this.deps.agentLabel(agent);
  }

  private notify(notice: Omit<FailoverNotice, 'at'>): void {
    const full: FailoverNotice = { ...notice, at: this.now() };
    this.last = full;
    this.deps.emit(full);
    this.emitStatus();
  }

  private plainNotice(message: string, reason: FailoverReason | null, fromAgent: AgentId | null): Omit<FailoverNotice, 'at'> {
    return { message, reason, fromAgent, toAgent: null, toLabel: null, toTabId: null, fromTabId: null };
  }

  private tab(id: string): FailoverTab | undefined {
    return this.deps.host.tabs().find((t) => t.id === id);
  }

  private async runState(id: string): Promise<AgentRunState> {
    try {
      return await this.deps.host.agentState(id);
    } catch {
      return 'unknown';
    }
  }

  /** Account a tab runs on (Claude Code / Codex). */
  private tabAccount(tab: FailoverTab, agent: AccountAgent): string | null {
    if (this.launchedAccount.has(tab.id)) return this.launchedAccount.get(tab.id)!;
    if (tab.accountId !== undefined) return tab.accountId;
    return this.deps.accounts.activeAccountId(agent);
  }

  // ---------- terminal signals ----------

  input(id: string, data: string): void {
    let tracker = this.inputs.get(id);
    if (!tracker) this.inputs.set(id, (tracker = new LastInputTracker()));
    tracker.push(data);
  }

  /** An instruction the app sent to the agent (feedback, prompt buttons): remembered as the last request. */
  sent(id: string, text: string): void {
    if (this.handoffSending.has(id)) return;
    let tracker = this.inputs.get(id);
    if (!tracker) this.inputs.set(id, (tracker = new LastInputTracker()));
    tracker.record(text);
  }

  output(id: string, text: string): void {
    if (this.disposed || this.confirmTimers.has(id) || !mentionsLimit(text)) return;
    if (!this.deps.prefs().enabled) return;
    const timer = setTimeout(() => {
      this.confirmTimers.delete(id);
      void this.onLimitSeen(id).catch((err: unknown) => reportHandled(errorKind(err), { area: 'failover', op: 'handle limit' }));
    }, this.t.confirmDelayMs);
    timer.unref?.();
    this.confirmTimers.set(id, timer);
  }

  closed(id: string): void {
    this.inputs.delete(id);
    this.launchedAccount.delete(id);
    this.failoverTabs.delete(id);
    this.nearLimitStarted.delete(id);
    const timer = this.confirmTimers.get(id);
    if (timer) clearTimeout(timer);
    this.confirmTimers.delete(id);
  }

  /** Exposed for tests: the confirm step after a limit message. */
  async onLimitSeen(id: string): Promise<void> {
    const prefs = this.deps.prefs();
    if (!prefs.enabled) return;
    const tab = this.tab(id);
    const agent = tab?.agentId;
    if (!tab || !agent) return;
    if ((await this.runState(id)) === 'unknown') return;
    if (!limitOnScreen(agent, this.deps.host.screenText(id))) return;
    const from: FailoverTarget = isAccountAgentId(agent) ? { agent, accountId: this.tabAccount(tab, agent) } : { agent };
    flow('failover limit', { agent: isAccountAgentId(agent) ? agent : 'other' });
    await this.switchFrom(id, tab.projectDir, from, 'limit');
  }

  // ---------- choosing and switching ----------

  private async planInput(from: FailoverTarget): Promise<PlanInput> {
    const prefs = this.deps.prefs();
    const [accounts, installed] = await Promise.all([this.deps.accounts.list(), this.deps.host.installedAgents()]);
    const candidates = {} as Record<AccountAgent, AccountCandidate[]>;
    for (const agent of ['claude', 'codex'] as const) {
      const view = accounts[agent];
      // usage only for agents involved in the switch (per-account breakdown, not refetched within 60 s)
      const wanted = from.agent === agent || prefs.agentOrder.includes(agent);
      const usage = wanted ? await this.deps.usage.accountUsage(agent).catch((): AccountUsage[] => []) : [];
      const used = (accountId: string | null) => maxUsedPercent(usage.find((u) => u.accountId === accountId)?.rateLimits);
      for (const row of usage) {
        const until = limitedUntil(row.rateLimits, prefs.thresholdPercent);
        if (until) this.markLimited({ agent, accountId: row.accountId }, until);
      }
      candidates[agent] = [
        // a selected system default is usable even when no login is visible (API key env vars …)
        { accountId: null, signedIn: view.systemDefault.signedIn || view.activeAccountId === null, usedPercent: used(null), active: view.activeAccountId === null },
        ...view.accounts
          .filter((a) => a.lastAuthenticatedAt !== null && !a.problem)
          .map((a) => ({ accountId: a.id, signedIn: a.signedIn, usedPercent: used(a.id), active: view.activeAccountId === a.id })),
      ];
    }
    // prefer Claude in Chrome accounts (same claude.ai account as the extension)
    const chrome = await this.deps.accounts.claudeChromeAccounts().catch(() => new Set<string | null>());
    candidates.claude = candidates.claude.map((c) => (chrome.has(c.accountId) ? { ...c, chrome: true } : c));
    return { prefs, from, accounts: candidates, available: installed, limited: this.limited, now: this.now() };
  }

  private markLimited(target: FailoverTarget, until: number): void {
    const key = limitKey(target);
    this.limited.set(key, Math.max(this.limited.get(key) ?? 0, until));
  }

  private async switchFrom(id: string, projectDir: string, from: FailoverTarget, reason: HandoffReason, planned?: FailoverTarget, why?: FailoverReason): Promise<void> {
    if (this.busy.has(projectDir)) return;
    const now = this.now();
    if (reason === 'limit') this.markLimited(from, now + DEFAULT_LIMIT_COOLDOWN_MS);
    // a user re-selection (switch) is not capped: the cap only stops runaway automatic switching
    const allowed = reason === 'switch' ? { ok: true as const } : switchAllowed(this.history.get(projectDir) ?? [], now);
    if (!allowed.ok) {
      if (reason === 'limit') {
        const time = new Date(allowed.retryAt).toLocaleTimeString(this.lang() === 'ja' ? 'ja-JP' : 'en-US', { hour: '2-digit', minute: '2-digit' });
        this.notify(this.plainNotice(msg(this.lang(), 'failover.notice.paused', { time }), why ?? 'limit-message', from.agent));
      }
      return;
    }
    this.busy.add(projectDir);
    this.emitStatus();
    try {
      const input = await this.planInput(from);
      const target = planned ?? (reason === 'limit' ? planFailover(input) : null);
      if (!target) {
        if (reason === 'limit') {
          this.waiting.set(projectDir, { agent: from.agent, until: this.limited.get(limitKey(from)) ?? null });
          const last = this.waitingNoticeAt.get(projectDir) ?? 0;
          if (now - last > this.t.waitingNoticeGapMs) {
            this.waitingNoticeAt.set(projectDir, now);
            this.notify(this.plainNotice(msg(this.lang(), 'failover.notice.waiting', { agent: this.label(from.agent) }), why ?? 'limit-message', from.agent));
          }
        }
        return;
      }
      this.waiting.delete(projectDir);
      if (reason !== 'switch') this.history.set(projectDir, [...(this.history.get(projectDir) ?? []).filter((at) => now - at < HOUR_MS), now]);
      await this.launchTarget(id, projectDir, from, target, reason, why);
    } finally {
      this.busy.delete(projectDir);
      this.emitStatus();
    }
  }

  private async launchTarget(fromId: string, projectDir: string, from: FailoverTarget, target: FailoverTarget, reason: HandoffReason, why?: FailoverReason): Promise<void> {
    const { host, accounts } = this.deps;
    const lang = this.lang();
    const sameAgent = target.agent === from.agent;
    const fromLabel = this.label(from.agent);
    const toLabel = this.label(target.agent);
    const noticeReason: FailoverReason = why ?? (reason === 'switch' ? 'account-selected' : reason === 'return' ? 'return-to-preferred' : 'limit-message');
    // ask the current agent to update the handoff file first (Solocut appends otherwise)
    await this.prepareHandoff(fromId, projectDir, fromLabel);
    if (isAccountAgentId(target.agent) && target.accountId !== undefined && target.accountId !== accounts.activeAccountId(target.agent)) {
      await accounts.select(target.agent, target.accountId);
    }
    const accountName = isAccountAgentId(target.agent) ? accounts.accountLabel(target.agent, target.accountId ?? null) : '';
    const prompt = nextAgentPrompt({ lang, reason, from: fromLabel, to: sameAgent && isAccountAgentId(target.agent) ? `${toLabel} (${accountName})` : toLabel });
    const spawnOpts = isAccountAgentId(target.agent) ? { accountId: target.accountId ?? null } : {};
    let newId: string | null = null;
    try {
      newId = await Promise.race([
        host.spawnAgent(projectDir, target.agent, spawnOpts),
        this.delay(this.t.createTimeoutMs).then(() => null),
      ]);
    } catch (err) {
      reportHandled(errorKind(err), { area: 'failover', op: 'spawn agent' });
    }
    const base = { reason: noticeReason, fromAgent: from.agent, toAgent: target.agent, ...(isAccountAgentId(target.agent) ? { toAccountId: target.accountId ?? null } : {}) };
    if (!newId) {
      this.notify({ ...base, message: msg(lang, 'failover.notice.notOpened', { agent: toLabel }), toLabel: null, toTabId: null, fromTabId: null });
      return;
    }
    if (isAccountAgentId(target.agent)) this.launchedAccount.set(newId, target.accountId ?? null);
    this.failoverTabs.add(newId);
    // the last request moves to the new tab (used if it switches again)
    this.inputs.set(newId, this.inputs.get(fromId) ?? new LastInputTracker());
    this.handoffSending.add(newId);
    let sent = false;
    try {
      sent = (await this.waitReady(newId)) ? await host.send(newId, prompt) : false;
    } catch (err) {
      reportHandled(errorKind(err), { area: 'failover', op: 'send handoff' });
    } finally {
      this.handoffSending.delete(newId);
    }
    const message = !sent
      ? msg(lang, 'failover.notice.notReady', { agent: toLabel })
      : (reason === 'switch' || (reason === 'return' && sameAgent)) && isAccountAgentId(target.agent)
        ? msg(lang, 'failover.notice.switched', { agent: toLabel, account: accountName })
        : reason === 'return'
          ? msg(lang, 'failover.notice.return', { from: fromLabel, to: toLabel })
          : sameAgent && isAccountAgentId(target.agent)
            ? msg(lang, 'failover.notice.account', { agent: toLabel, account: accountName })
            : msg(lang, 'failover.notice.agent', { from: fromLabel, to: toLabel });
    flow('failover switched', { kind: sameAgent ? 'account' : 'agent', sent: sent ? 1 : 0 });
    // after a successful handover close the old tab (it must not continue the same work when its limit resets)
    this.notify({ ...base, message, toLabel, toTabId: newId, fromTabId: sent ? fromId : null });
    if (sent) host.closeTab?.(fromId);
  }

  /**
   * Prepares the handoff file:
   * 1. if the current agent accepts input, ask it to update the file and wait until it is done
   * 2. if it does not start (stopped at its limit) or does not update it, Solocut appends the last request,
   *    feedback.md path and changed files
   */
  private async prepareHandoff(fromId: string, projectDir: string, fromLabel: string): Promise<void> {
    const path = handoffFilePath(projectDir);
    const before = await mtimeOf(path);
    let updated = false;
    if ((await this.runState(fromId)) === 'idle') {
      this.handoffSending.add(fromId);
      try {
        if (await this.deps.host.send(fromId, updateRequest(this.lang(), HANDOFF_RELATIVE_PATH))) updated = await this.waitForUpdate(fromId, path, before);
      } catch (err) {
        reportHandled(errorKind(err), { area: 'failover', op: 'ask agent to update handoff' });
      } finally {
        this.handoffSending.delete(fromId);
      }
    }
    if (!updated) {
      try {
        const note = solocutNote({
          lang: this.lang(),
          time: new Date(this.now()).toLocaleString(this.lang() === 'ja' ? 'ja-JP' : 'en-US'),
          agent: fromLabel,
          lastRequest: this.inputs.get(fromId)?.lastRequest() ?? null,
          changedFiles: await (this.deps.changedFiles ?? gitChangedFiles)(projectDir),
          fileExists: before > 0,
        });
        await appendHandoffNote(projectDir, note);
      } catch (err) {
        reportHandled(errorKind(err), { area: 'failover', op: 'write handoff note' });
      }
    }
  }

  /** After asking, wait for the agent to start working, update the file and become idle. Give up early if it never starts. */
  private async waitForUpdate(id: string, path: string, before: number): Promise<boolean> {
    const started = this.now();
    let sawWorking = false;
    while (this.now() - started < this.t.updateTimeoutMs) {
      await this.delay(this.t.pollMs);
      const state = await this.runState(id);
      if (state === 'unknown') break;
      if (state === 'working') sawWorking = true;
      const changed = (await mtimeOf(path)) > before;
      if (changed && state === 'idle') return true;
      if (!sawWorking && !changed && this.now() - started >= this.t.updateStartMs) break;
    }
    return (await mtimeOf(path)) > before;
  }

  private async waitReady(id: string): Promise<boolean> {
    const deadline = this.now() + this.t.readyTimeoutMs;
    while (this.now() < deadline) {
      const state = await this.runState(id);
      if (state === 'idle') return true;
      // confirmations (folder trust …) are left to the user
      if (state === 'blocked') return false;
      await this.delay(this.t.pollMs / 2);
    }
    return false;
  }

  // ---------- user re-selection ----------

  /**
   * The user picked another account in the footer / settings. The choice applies to running tabs of that agent too:
   * like a limit switch, each tab writes the handoff file, is reopened on the chosen account and asked to continue,
   * and the old tab closes. Tabs of one project go one by one. Returns how many tabs will switch.
   */
  async switchRunningAgents(agent: AccountAgent, accountId: string | null): Promise<number> {
    this.manualChoice[agent] = accountId;
    const tabs = this.deps.host.tabs().map((tab) => ({
      id: tab.id,
      projectDir: tab.projectDir,
      agent: tab.agentId,
      launchedAccount: this.launchedAccount.has(tab.id) ? this.launchedAccount.get(tab.id) : tab.accountId,
    }));
    const targets = tabsToSwitch(tabs, agent, accountId).map((tab) => ({ id: tab.id, projectDir: tab.projectDir, from: tab.launchedAccount ?? null }));
    if (targets.length > 0) {
      this.notify(
        this.plainNotice(
          msg(this.lang(), 'failover.notice.switching', { count: targets.length, agent: this.label(agent), account: this.deps.accounts.accountLabel(agent, accountId) }),
          'account-selected',
          agent,
        ),
      );
    }
    void (async () => {
      for (const target of targets) {
        // never cut a tab mid-task: wait until idle; skip when it closed or the user picked again meanwhile
        if (!(await this.waitIdleForSwitch(target.id, agent, accountId))) continue;
        await this.switchFrom(target.id, target.projectDir, { agent, accountId: target.from }, 'switch', { agent, accountId }, 'account-selected').catch((err: unknown) =>
          reportHandled(errorKind(err), { area: 'failover', op: 'switch running agent' }),
        );
      }
    })();
    return targets.length;
  }

  private async waitIdleForSwitch(id: string, agent: AccountAgent, accountId: string | null): Promise<boolean> {
    const deadline = this.now() + this.t.switchWaitMs;
    while (!this.disposed && this.now() < deadline) {
      if (this.deps.accounts.activeAccountId(agent) !== accountId) return false;
      const tab = this.tab(id);
      if (!tab || tab.agentId !== agent) return false;
      const state = await this.runState(id);
      if (state === 'idle') return true;
      if (state === 'unknown') return false;
      await this.delay(this.t.pollMs * 2);
    }
    return false;
  }

  // ---------- from usage ----------

  /**
   * Usage changed. When the selected account is at/above the threshold, new tabs of that agent switch to an account
   * with room. Running agents continue (their limit message triggers the terminal failover).
   */
  onUsageChanged(state: UsageState): void {
    const prefs = this.deps.prefs();
    if (!prefs.enabled || this.disposed) return;
    for (const agent of ['claude', 'codex'] as const) {
      const limits = state[agent];
      if (limits?.status !== 'ok') continue;
      const used = maxUsedPercent(limits);
      if (used === null || used < prefs.thresholdPercent) {
        if (agent === 'claude') this.maybeReturnNewTabsToChrome(prefs);
        continue;
      }
      const from: FailoverTarget = { agent, accountId: this.deps.accounts.activeAccountId(agent) };
      this.markLimited(from, limitedUntil(limits, prefs.thresholdPercent) ?? this.now() + DEFAULT_LIMIT_COOLDOWN_MS);
      if (!prefs.switchAccounts || this.now() - this.usageSwitchAt[agent] < this.t.usageSwitchGapMs) continue;
      this.usageSwitchAt[agent] = this.now();
      void (async () => {
        const next = usableAccounts(await this.planInput(from), agent, from.accountId ?? null)[0];
        if (!next) return;
        await this.deps.accounts.select(agent, next.accountId);
        this.notify({
          ...this.plainNotice(
            msg(this.lang(), 'failover.notice.accountForNewTabs', { agent: this.label(agent), account: this.deps.accounts.accountLabel(agent, next.accountId) }),
            'usage-threshold',
            agent,
          ),
          toAgent: agent,
          toAccountId: next.accountId,
        });
      })().catch((err: unknown) => reportHandled(errorKind(err), { area: 'failover', op: 'switch account from usage' }));
    }
  }

  private keepManualChoice(agent: AccountAgent): boolean {
    return agent in this.manualChoice && this.manualChoice[agent] === this.deps.accounts.activeAccountId(agent);
  }

  /** New Claude Code tabs move back to a Claude in Chrome account once it has room again. */
  private maybeReturnNewTabsToChrome(prefs: LimitFailoverPrefs): void {
    if (!prefs.enabled || !prefs.switchAccounts || this.keepManualChoice('claude')) return;
    const now = this.now();
    if (now - this.chromeReturnCheckAt < this.t.chromeReturnGapMs) return;
    this.chromeReturnCheckAt = now;
    void (async () => {
      const current = this.deps.accounts.activeAccountId('claude');
      // no usage fetch when the current account is a Chrome account or none has paired
      const chrome = await this.deps.accounts.claudeChromeAccounts();
      if (chrome.size === 0 || chrome.has(current)) return;
      const target = chromeReturnTarget(await this.planInput({ agent: 'claude', accountId: current }), 'claude', current);
      // the user re-selected meanwhile: do nothing
      if (!target || this.deps.accounts.activeAccountId('claude') !== current || this.keepManualChoice('claude')) return;
      await this.deps.accounts.select('claude', target.accountId);
      flow('failover chrome account', { kind: 'new tabs' });
    })().catch((err: unknown) => reportHandled(errorKind(err), { area: 'failover', op: 'return to chrome account' }));
  }

  // ---------- back to the preferred agent ----------

  async checkReturn(): Promise<void> {
    const prefs = this.deps.prefs();
    if (!prefs.enabled || !prefs.returnToPreferred) return;
    await this.returnTabsToChrome(prefs);
    for (const id of [...this.failoverTabs]) {
      const tab = this.tab(id);
      if (!tab) {
        this.failoverTabs.delete(id);
        continue;
      }
      if (!tab.agentId || this.busy.has(tab.projectDir)) continue;
      if ((await this.runState(id)) !== 'idle') continue;
      const current = tab.agentId;
      const from: FailoverTarget = isAccountAgentId(current) ? { agent: current, accountId: this.tabAccount(tab, current) } : { agent: current };
      const target = planReturn({ ...(await this.planInput(from)), current });
      if (target) await this.switchFrom(id, tab.projectDir, from, 'return', target, 'return-to-preferred');
    }
  }

  /** returnToPreferred: idle Claude Code tabs on a non-Chrome account move back to a Chrome account with room. */
  private async returnTabsToChrome(prefs: LimitFailoverPrefs): Promise<void> {
    if (!prefs.switchAccounts || this.keepManualChoice('claude')) return;
    const chrome = await this.deps.accounts.claudeChromeAccounts().catch(() => new Set<string | null>());
    if (chrome.size === 0) return;
    let input: PlanInput | null = null;
    for (const tab of this.deps.host.tabs()) {
      if (tab.agentId !== 'claude' || this.busy.has(tab.projectDir)) continue;
      const accountId = this.tabAccount(tab, 'claude');
      if (chrome.has(accountId)) continue;
      if ((await this.runState(tab.id)) !== 'idle') continue;
      input ??= await this.planInput({ agent: 'claude', accountId });
      const target = chromeReturnTarget(input, 'claude', accountId);
      if (!target) continue;
      await this.switchFrom(tab.id, tab.projectDir, { agent: 'claude', accountId }, 'return', { agent: 'claude', accountId: target.accountId }, 'return-to-preferred');
    }
  }

  // ---------- hand over before the limit ----------

  /**
   * Running Claude Code / Codex tabs whose account usage is at/above handoffPercent are handed over once idle (waiting
   * at most nearLimitIdleWaitMs): the agent summarises into the handoff file and the work reopens on the next account
   * / agent.
   */
  async checkNearLimit(): Promise<void> {
    const prefs = this.deps.prefs();
    if (!prefs.enabled || prefs.handoffPercent >= 100) return;
    const tabs: RunningTab[] = [];
    for (const tab of this.deps.host.tabs()) {
      const agent = tab.agentId;
      if (!agent || !isAccountAgentId(agent)) continue;
      tabs.push({ id: tab.id, projectDir: tab.projectDir, agent, accountId: this.tabAccount(tab, agent) });
    }
    if (tabs.length === 0) return;
    const used = new Map<string, number | null>();
    for (const agent of ['claude', 'codex'] as const) {
      if (!tabs.some((tab) => tab.agent === agent)) continue;
      for (const row of await this.deps.usage.accountUsage(agent).catch((): AccountUsage[] => [])) {
        used.set(limitKey({ agent, accountId: row.accountId }), maxUsedPercent(row.rateLimits));
      }
    }
    const due = nearLimitTabs(tabs, (agent, accountId) => used.get(limitKey({ agent, accountId })) ?? null, prefs.handoffPercent, this.nearLimitStarted, this.busy);
    for (const tab of due) {
      this.nearLimitStarted.add(tab.id);
      flow('failover near limit', { agent: tab.agent });
      void this.handOffNearLimit(tab).catch((err: unknown) => reportHandled(errorKind(err), { area: 'failover', op: 'hand off near limit' }));
    }
  }

  private async handOffNearLimit(tab: RunningTab): Promise<void> {
    // cutting mid-task leaves half-done work: wait until idle (do nothing when it closed)
    const deadline = this.now() + this.t.nearLimitIdleWaitMs;
    while (!this.disposed && this.now() < deadline) {
      const current = this.tab(tab.id);
      if (!current || current.agentId !== tab.agent) return;
      const state = await this.runState(tab.id);
      if (state === 'idle' || state === 'unknown') break;
      await this.delay(this.t.pollMs * 5);
    }
    if (!this.tab(tab.id)) return;
    // treat this account as limited and pick the next (another account → next agent)
    await this.switchFrom(tab.id, tab.projectDir, { agent: tab.agent, accountId: tab.accountId }, 'limit', undefined, 'near-limit-handoff');
    // not handed over (everything limited, or the switch cap): allow another check later
    if (this.tab(tab.id)) setTimeout(() => this.nearLimitStarted.delete(tab.id), this.t.waitingNoticeGapMs).unref?.();
  }
}
