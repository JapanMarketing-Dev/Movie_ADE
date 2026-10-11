// Ported from Ferret test/unit/failover.test.ts (handoff file, last input) (MIT), plus the FailoverService against a
// fake FailoverHost: no real terminal, CLI or account.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountAgent, AgentAccountsState } from '../src/shared/accounts';
import { DEFAULT_LIMIT_FAILOVER, type FailoverNotice, type LimitFailoverPrefs } from '../src/shared/failover';
import type { AccountUsage, ProviderRateLimits } from '../src/shared/usage';
import {
  HANDOFF_RELATIVE_PATH,
  LastInputTracker,
  appendHandoffNote,
  changedFilesFrom,
  findFeedbackPath,
  handoffFilePath,
  nextAgentPrompt,
  solocutNote,
  updateRequest,
} from '../src/main/failover/handoff';
import { FailoverService, type AgentRunState, type FailoverHost, type FailoverTab } from '../src/main/failover/service';

describe('handoff file', () => {
  it('lives at <project>/.solocut/handoff.md', () => {
    expect(handoffFilePath('/w/acme-shop')).toBe(join('/w/acme-shop', '.solocut', 'handoff.md'));
    expect(HANDOFF_RELATIVE_PATH).toBe('.solocut/handoff.md');
  });

  it('asks the outgoing agent to update the file with fixed items', () => {
    const text = updateRequest('en');
    expect(text).toContain('update ".solocut/handoff.md"');
    for (const item of ['the goal', 'what is done', 'remaining work as a checklist', 'files you changed', 'next step', 'feedback.md', 'watch out for']) expect(text).toContain(item);
    expect(updateRequest('ja', '/x/h.md')).toContain('"/x/h.md" を更新してください');
  });

  it('tells the next agent why and points at the handoff file and `solocut next --json` (app language)', () => {
    expect(nextAgentPrompt({ lang: 'en', reason: 'limit', from: 'Codex CLI', to: 'Claude Code' })).toBe(
      'Codex CLI reached its usage limit, so Claude Code is taking over this work. Read .solocut/handoff.md and `solocut next --json`, then continue where the previous agent stopped.',
    );
    expect(nextAgentPrompt({ lang: 'ja', reason: 'return', from: 'Codex CLI', to: 'Claude Code' })).toBe(
      'Claude Code の利用上限が戻ったため、Codex CLI からこの作業を Claude Code に戻します。.solocut/handoff.md と `solocut next --json` を見て、前のエージェントの続きから作業を進めてください。',
    );
    expect(nextAgentPrompt({ lang: 'en', reason: 'switch', from: 'x', to: 'Claude Code (work)' })).toContain('Claude Code (work)');
    expect(nextAgentPrompt({ lang: 'en', reason: 'limit', from: 'a', to: 'b' })).not.toContain('\n');
  });

  it('Solocut’s note when the agent could not update: last request, feedback.md path, changed files', () => {
    const request = 'Read "feedback/20261004-101500/feedback.md" and fix the items.';
    const note = solocutNote({ lang: 'en', time: '10/4 10:00', agent: 'Codex', lastRequest: request, changedFiles: changedFilesFrom(' M timeline.json\n?? renders/new.mp4\n'), fileExists: false });
    expect(note).toBe(
      [
        '# Handoff', '',
        '## Added by Solocut (10/4 10:00)', '',
        'Codex did not update this file before the switch (it was at its usage limit or not responding). This is what Solocut knows:', '',
        'Last request:', '', `> ${request}`, '',
        'Feedback being worked on: feedback/20261004-101500/feedback.md', '',
        'Changed files (git status):', '', '```', ' M timeline.json', '?? renders/new.mp4', '```', '',
      ].join('\n'),
    );
    const appended = solocutNote({ lang: 'en', time: 't', agent: 'Claude Code', lastRequest: null, changedFiles: null, fileExists: true });
    expect(appended.startsWith('\n## Added by Solocut (t)')).toBe(true);
    expect(appended).not.toContain('Last request');
    expect(appended).not.toContain('git status');
    expect(solocutNote({ lang: 'en', time: 't', agent: 'x', lastRequest: null, changedFiles: [], fileExists: true })).toContain('No uncommitted changes (git status).');
    expect(solocutNote({ lang: 'ja', time: 't', agent: 'x', lastRequest: 'a\nb', changedFiles: null, fileExists: false })).toContain('> a\n> b');
  });

  it('caps the last request and the changed-file list', () => {
    const note = solocutNote({ lang: 'en', time: 't', agent: 'x', lastRequest: 'y'.repeat(10_000), changedFiles: null, fileExists: true });
    expect(note.length).toBeLessThan(4300);
    expect(changedFilesFrom(Array.from({ length: 500 }, (_, i) => ` M f${i}`).join('\n'))).toHaveLength(200);
    expect(changedFilesFrom('\n\n')).toEqual([]);
  });

  it('finds the feedback.md path in an instruction', () => {
    expect(findFeedbackPath('Read feedback/x/feedback.md')).toBe('feedback/x/feedback.md');
    expect(findFeedbackPath('"C:\\p\\feedback\\1\\feedback.md"')).toBe('C:\\p\\feedback\\1\\feedback.md');
    expect(findFeedbackPath('nothing here')).toBeNull();
    expect(findFeedbackPath(null)).toBeNull();
  });
});

describe('appending the note inside the project', () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'solocut-handoff-')));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('creates .solocut and appends', async () => {
    await appendHandoffNote(project, 'one\n');
    await appendHandoffNote(project, 'two\n');
    expect(readFileSync(handoffFilePath(project), 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a .solocut link or a handoff.md link (never writes outside the project)', async () => {
    const outside = join(project, '..', `${project.split(/[\\/]/).pop()}-outside`);
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, join(project, '.solocut'));
      await expect(appendHandoffNote(project, 'x')).rejects.toThrow();
      expect(existsSync(join(outside, 'handoff.md'))).toBe(false);
      rmSync(join(project, '.solocut'));
      mkdirSync(join(project, '.solocut'));
      writeFileSync(join(outside, 'target.md'), 'keep');
      symlinkSync(join(outside, 'target.md'), handoffFilePath(project));
      await expect(appendHandoffNote(project, 'x')).rejects.toThrow();
      expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('keep');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('last input', () => {
  it('remembers the line sent with Enter; drops deleted chars, arrows, short replies and slash commands', () => {
    const tracker = new LastInputTracker();
    tracker.push('fix the heade');
    tracker.push('\x7fer\x1b[A');
    tracker.push('\r');
    expect(tracker.lastRequest()).toBe('fix the header');
    tracker.push('y\r');
    tracker.push('/usage\r');
    expect(tracker.lastRequest()).toBe('fix the header');
    tracker.push('drop this\x15\r');
    expect(tracker.lastRequest()).toBe('fix the header');
  });

  it('a paste counts as one; an instruction sent by Solocut overrides it', () => {
    const tracker = new LastInputTracker();
    tracker.push('\x1b[200~line one\rline two\x1b[201~\r');
    expect(tracker.lastRequest()).toBe('line one\nline two');
    tracker.record('Read feedback/1/feedback.md');
    expect(tracker.lastRequest()).toBe('Read feedback/1/feedback.md');
    tracker.record('   ');
    expect(tracker.lastRequest()).toBe('Read feedback/1/feedback.md');
  });
});

// ───────────────────────── FailoverService with a fake host ─────────────────────────

const ACCOUNT = '11111111-2222-4333-8444-555555555555';

class FakeHost implements FailoverHost {
  tabList: FailoverTab[] = [];
  states = new Map<string, AgentRunState>();
  screens = new Map<string, string>();
  sent: { tabId: string; text: string }[] = [];
  spawned: { projectDir: string; agentId: string; accountId?: string | null }[] = [];
  closedTabs: string[] = [];
  installed = new Set(['claude', 'codex', 'gemini']);
  spawnFails = false;
  private outputCbs: ((id: string, text: string) => void)[] = [];
  private next = 1;

  tabs(): FailoverTab[] {
    return this.tabList;
  }
  agentState(id: string): AgentRunState {
    return this.states.get(id) ?? 'unknown';
  }
  screenText(id: string): string {
    return this.screens.get(id) ?? '';
  }
  onOutput(cb: (id: string, text: string) => void): () => void {
    this.outputCbs.push(cb);
    return () => (this.outputCbs = this.outputCbs.filter((c) => c !== cb));
  }
  output(id: string, text: string): void {
    for (const cb of this.outputCbs) cb(id, text);
  }
  async spawnAgent(projectDir: string, agentId: string, opts: { accountId?: string | null }): Promise<string> {
    if (this.spawnFails) throw new Error('spawn failed');
    this.spawned.push({ projectDir, agentId, ...opts });
    const id = `new${this.next++}`;
    this.tabList.push({ id, agentId, projectDir, ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}) });
    this.states.set(id, 'idle');
    return id;
  }
  async send(tabId: string, text: string): Promise<boolean> {
    this.sent.push({ tabId, text });
    return true;
  }
  closeTab(tabId: string): void {
    this.closedTabs.push(tabId);
    this.tabList = this.tabList.filter((t) => t.id !== tabId);
  }
  async installedAgents(): Promise<ReadonlySet<string>> {
    return this.installed;
  }
}

function view(signedIn: boolean, accounts: { id: string; signedIn: boolean }[] = [], active: string | null = null) {
  return {
    accounts: accounts.map((a) => ({ id: a.id, label: 'work', email: 'w@example.com', workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1, signedIn: a.signedIn, problem: null })),
    activeAccountId: active,
    systemDefault: { signedIn, email: null },
  };
}

describe('FailoverService', () => {
  let project: string;
  let host: FakeHost;
  let prefs: LimitFailoverPrefs;
  let notices: FailoverNotice[];
  let accountsState: AgentAccountsState;
  let usage: Record<AccountAgent, AccountUsage[]>;
  let selected: { agent: AccountAgent; accountId: string | null }[];
  let svc: FailoverService;
  let clock: number;

  const limits = (used: number): ProviderRateLimits => ({ provider: 'claude', session: { usedPercent: used, windowMinutes: 300, resetsAt: null }, weekly: null, updatedAt: 0, error: null, status: 'ok' });

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'solocut-failover-')));
    clock = 1_000_000_000;
    host = new FakeHost();
    prefs = { ...DEFAULT_LIMIT_FAILOVER };
    notices = [];
    selected = [];
    accountsState = { claude: view(true), codex: view(true) };
    usage = { claude: [], codex: [] };
    svc = new FailoverService({
      host,
      prefs: () => prefs,
      language: () => 'en',
      agentLabel: (id) => ({ claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' })[id] ?? id,
      accounts: {
        list: async () => accountsState,
        select: async (agent, accountId) => {
          selected.push({ agent, accountId });
          accountsState[agent].activeAccountId = accountId;
        },
        activeAccountId: (agent) => accountsState[agent].activeAccountId,
        accountLabel: (_agent, id) => (id === null ? 'System default' : 'work'),
        claudeChromeAccounts: async () => new Set(),
      },
      usage: { accountUsage: async (agent) => usage[agent] },
      emit: (n) => notices.push(n),
      changedFiles: async () => [' M timeline.json'],
      // a fake clock: every wait advances it and yields to timers
      now: () => clock,
      delay: async (ms) => {
        clock += Math.max(ms, 1);
        await new Promise((r) => setImmediate(r));
      },
      timing: { confirmDelayMs: 0, updateStartMs: 0, updateTimeoutMs: 0, readyTimeoutMs: 5000, pollMs: 1000, switchWaitMs: 10_000, nearLimitIdleWaitMs: 10_000, createTimeoutMs: 1000 },
    });
  });
  afterEach(() => {
    svc.dispose();
    rmSync(project, { recursive: true, force: true });
  });

  it('a confirmed Claude limit with no other account hands over to Codex in the same project', async () => {
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', 'work…\n5-hour limit reached ∙ resets 3pm\n');
    svc.input('t1', 'make the video\r');
    await svc.onLimitSeen('t1');
    expect(host.spawned).toEqual([{ projectDir: project, agentId: 'codex', accountId: null }]);
    expect(host.sent).toEqual([{ tabId: 'new1', text: expect.stringContaining('Claude Code reached its usage limit, so Codex CLI is taking over') }]);
    expect(host.sent[0]!.text).toContain('.solocut/handoff.md');
    expect(notices.at(-1)).toMatchObject({ reason: 'limit-message', fromAgent: 'claude', toAgent: 'codex', toTabId: 'new1', fromTabId: 't1', message: 'Claude Code reached its usage limit, so Codex CLI took over the work.' });
    expect(host.closedTabs).toEqual(['t1']);
    // the blocked agent could not update the file: Solocut appended what it knows
    const note = readFileSync(handoffFilePath(project), 'utf8');
    expect(note).toContain('# Handoff');
    expect(note).toContain('> make the video');
    expect(note).toContain(' M timeline.json');
    expect(svc.status().last?.toTabId).toBe('new1');
  });

  it('prefers another signed-in account of the same agent', async () => {
    accountsState.claude = view(true, [{ id: ACCOUNT, signedIn: true }]);
    usage.claude = [
      { accountId: null, label: 'System default', active: true, rateLimits: limits(100) },
      { accountId: ACCOUNT, label: 'work', active: false, rateLimits: limits(20) },
    ];
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', "You've hit your session limit · resets 3:45pm");
    await svc.onLimitSeen('t1');
    expect(selected).toEqual([{ agent: 'claude', accountId: ACCOUNT }]);
    expect(host.spawned).toEqual([{ projectDir: project, agentId: 'claude', accountId: ACCOUNT }]);
    expect(notices.at(-1)!.message).toBe('Claude Code reached its usage limit, so the work continues with the account work.');
    expect(host.sent[0]!.text).toContain('Claude Code (work)');
  });

  it('an idle agent is asked to update the handoff file first', async () => {
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'idle');
    host.screens.set('t1', 'Claude usage limit reached. Your limit will reset at 3pm');
    await svc.onLimitSeen('t1');
    expect(host.sent[0]).toEqual({ tabId: 't1', text: expect.stringContaining('update ".solocut/handoff.md"') });
  });

  it('does nothing when the message is gone from the screen, the tab is unknown, or failover is off', async () => {
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project }];
    host.states.set('t1', 'idle');
    host.screens.set('t1', 'all fine');
    await svc.onLimitSeen('t1');
    await svc.onLimitSeen('missing');
    host.screens.set('t1', '5-hour limit reached');
    host.states.set('t1', 'unknown');
    await svc.onLimitSeen('t1');
    prefs = { ...prefs, enabled: false };
    host.states.set('t1', 'idle');
    await svc.onLimitSeen('t1');
    expect(host.spawned).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('when every agent is limited, waits and says so once', async () => {
    host.installed = new Set(['claude']);
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', '5-hour limit reached');
    await svc.onLimitSeen('t1');
    expect(host.spawned).toEqual([]);
    expect(notices.map((n) => n.message)).toEqual(['Claude Code reached its usage limit, and the other agents in the order are at their limits too. The work can continue when a limit resets.']);
    expect(svc.status().waiting).toEqual([{ projectDir: project, agent: 'claude', until: expect.any(Number) }]);
  });

  it('a failed spawn keeps the current tab and reports it', async () => {
    host.spawnFails = true;
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', '5-hour limit reached');
    await svc.onLimitSeen('t1');
    expect(notices.at(-1)).toMatchObject({ message: 'A new Codex CLI tab could not be opened. The current tab is left as it is.', toTabId: null, fromTabId: null });
    expect(host.closedTabs).toEqual([]);
  });

  it('caps repeated switches per project', async () => {
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', '5-hour limit reached');
    await svc.onLimitSeen('t1');
    host.tabList.push({ id: 't2', agentId: 'claude', projectDir: project, accountId: null });
    host.states.set('t2', 'blocked');
    host.screens.set('t2', '5-hour limit reached');
    await svc.onLimitSeen('t2');
    expect(host.spawned).toHaveLength(1);
    expect(notices.at(-1)!.message).toMatch(/^It switched several times in a short while/);
  });

  it('output triggers the confirm step only for limit-looking text', async () => {
    svc.start();
    host.tabList = [{ id: 't1', agentId: 'codex', projectDir: project, accountId: null }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', "■ You've hit your usage limit. try again in 3 hours");
    host.output('t1', 'regular output');
    await new Promise((r) => setTimeout(r, 5));
    expect(host.spawned).toEqual([]);
    host.output('t1', "■ You've hit your usage limit. try again in 3 hours");
    await new Promise((r) => setTimeout(r, 20));
    expect(host.spawned[0]).toMatchObject({ agentId: 'claude' });
  });

  it('usage at the threshold switches new tabs to an account with room', async () => {
    accountsState.claude = view(true, [{ id: ACCOUNT, signedIn: true }]);
    usage.claude = [
      { accountId: null, label: 'System default', active: true, rateLimits: limits(96) },
      { accountId: ACCOUNT, label: 'work', active: false, rateLimits: limits(10) },
    ];
    svc.onUsageChanged({ claude: limits(96), codex: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(selected).toEqual([{ agent: 'claude', accountId: ACCOUNT }]);
    expect(notices.at(-1)).toMatchObject({ reason: 'usage-threshold', toAccountId: ACCOUNT });
    // not again within the gap
    svc.onUsageChanged({ claude: limits(97), codex: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(selected).toHaveLength(1);
  });

  it('re-selecting an account reopens running tabs of that agent once idle', async () => {
    accountsState.claude = view(true, [{ id: ACCOUNT, signedIn: true }], ACCOUNT);
    host.tabList = [
      { id: 't1', agentId: 'claude', projectDir: project, accountId: null },
      { id: 't2', agentId: 'codex', projectDir: project, accountId: null },
      { id: 't3', agentId: 'claude', projectDir: project, accountId: ACCOUNT },
    ];
    host.states.set('t1', 'blocked');
    const count = await svc.switchRunningAgents('claude', ACCOUNT);
    expect(count).toBe(1);
    expect(notices[0]!.message).toBe('Switching to the account work. 1 open Claude Code tab(s) reopen with it as soon as they finish their current work.');
    await new Promise((r) => setTimeout(r, 20));
    // blocked is neither idle nor gone: still waiting
    expect(host.spawned).toEqual([]);
  });

  it('near-limit handoff: an idle tab whose account is at handoffPercent is handed over', async () => {
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'idle');
    usage.claude = [{ accountId: null, label: 'System default', active: true, rateLimits: limits(98) }];
    await svc.checkNearLimit();
    await new Promise((r) => setTimeout(r, 20));
    expect(host.spawned).toEqual([{ projectDir: project, agentId: 'codex', accountId: null }]);
    expect(notices.at(-1)!.reason).toBe('near-limit-handoff');
    // 100 disables it
    prefs = { ...prefs, handoffPercent: 100 };
    host.tabList.push({ id: 't9', agentId: 'claude', projectDir: join(project, 'b') });
    await svc.checkNearLimit();
    expect(host.spawned).toHaveLength(1);
  });

  it('remembers instructions the app sent as the last request', async () => {
    svc.sent('t1', 'Read feedback/3/feedback.md and fix it');
    host.tabList = [{ id: 't1', agentId: 'claude', projectDir: project, accountId: null }];
    host.states.set('t1', 'blocked');
    host.screens.set('t1', '5-hour limit reached');
    await svc.onLimitSeen('t1');
    expect(readFileSync(handoffFilePath(project), 'utf8')).toContain('Feedback being worked on: feedback/3/feedback.md');
  });
});
