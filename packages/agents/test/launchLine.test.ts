import { describe, expect, it } from 'vitest';
import {
  AGENTS, BUILTIN_AGENTS, DEFAULT_AGENT_PREFERENCES, agentLaunchLine, agentPrefsFromSettings, argvToLine, catalogAgentDef,
  catalogCustomId, getAgent,
} from '../src/index.js';

const on = { ...DEFAULT_AGENT_PREFERENCES, skipPermissions: true };
const off = { ...DEFAULT_AGENT_PREFERENCES, skipPermissions: false };

describe('agentPrefsFromSettings (Solocut settings.json → catalog prefs)', () => {
  it('empty or broken input gives the defaults: permission prompts skipped (Solocut runs agents unattended)', () => {
    for (const input of [undefined, null, 42, 'x', [], {}]) {
      const p = agentPrefsFromSettings(input);
      expect(p.skipPermissions).toBe(true);
      expect(p.launch.claude).toEqual(DEFAULT_AGENT_PREFERENCES.launch.claude);
      expect(p.customAgents).toEqual([]);
    }
  });

  it('maps custom[{id,label,command}] and splits the command into command + args', () => {
    const p = agentPrefsFromSettings({
      order: ['claude'], failover: { enabled: true },
      custom: [{ id: 'custom:My_Agent.v2', label: 'Mine', command: 'my-agent --auto "a b"' }, null, { id: 'custom:x', label: 'X', command: '   ' }],
    });
    expect(p.customAgents).toEqual([{ id: 'custom:my-agent-v2', name: 'Mine', command: 'my-agent', args: "--auto 'a b'" }]);
  });

  it('keeps launch overrides and skipPermissions only when well formed', () => {
    const p = agentPrefsFromSettings({ skipPermissions: true, launch: { gemini: { command: '/opt/gemini', args: '--model x' }, codex: 'bad' } });
    expect(p.skipPermissions).toBe(true);
    expect(p.launch.gemini).toEqual({ command: '/opt/gemini', args: '--model x' });
    expect(p.launch.codex).toEqual(DEFAULT_AGENT_PREFERENCES.launch.codex);
    // only an explicit false turns it off
    expect(agentPrefsFromSettings({ skipPermissions: false }).skipPermissions).toBe(false);
    expect(agentPrefsFromSettings({ skipPermissions: 'yes' }).skipPermissions).toBe(true);
    expect(agentPrefsFromSettings({ skipPermissions: 0 }).skipPermissions).toBe(true);
  });

  it('catalogCustomId folds Solocut ids into the catalog id form and leaves built-in ids alone', () => {
    expect(catalogCustomId('custom:My_Agent.v2')).toBe('custom:my-agent-v2');
    expect(catalogCustomId('custom:___')).toBe('custom:agent');
    expect(catalogCustomId('custom:' + 'a'.repeat(80))).toBe('custom:' + 'a'.repeat(48));
    expect(catalogCustomId('claude')).toBe('claude');
  });
});

describe('agentLaunchLine', () => {
  it('without consent adds no bypass or trust args', () => {
    const r = agentLaunchLine('claude', off, { shell: 'posix', projectId: 'p1' });
    expect(r.ok && r.argv.includes('--dangerously-skip-permissions')).toBe(false);
    expect(r.ok && r.trustFolder).toBe(false);
  });

  it('with skipPermissions adds the yolo args for Claude Code / Codex only', () => {
    const claude = agentLaunchLine('claude', on, { shell: 'posix', projectId: 'p1' });
    expect(claude.ok && claude.line).toMatch(/^claude .*--dangerously-skip-permissions/);
    const codex = agentLaunchLine('codex', on, { shell: 'posix', projectId: 'p1' });
    expect(codex.ok && codex.argv.slice(1).some((a) => a.includes('never') || a.includes('bypass') || a === '--yolo' || a.includes('danger'))).toBe(true);
    const gemini = agentLaunchLine('gemini', on, { shell: 'posix', projectId: 'p1' });
    expect(gemini.ok && gemini.argv).toEqual(['gemini']);
  });

  it('refuses permission flags typed into the command field, in every shell', () => {
    const prefs = { ...on, launch: { ...on.launch, claude: { command: 'claude --dangerously-skip-permissions', args: '' } } };
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      const r = agentLaunchLine('claude', prefs, { shell });
      expect(r.ok ? 'ok' : r.reason).toBe('flag-in-command');
      expect(r.ok ? '' : r.error).not.toBe('');
    }
  });

  it('resume continues the last conversation (Claude --continue, Codex resume --last)', () => {
    const c = agentLaunchLine('claude', DEFAULT_AGENT_PREFERENCES, { shell: 'posix', resume: true });
    expect(c.ok && c.argv).toContain('--continue');
    expect(c.ok && c.resumed).toBe(true);
    const x = agentLaunchLine('codex', DEFAULT_AGENT_PREFERENCES, { shell: 'posix', resume: true });
    expect(x.ok && x.argv.slice(1, 3)).toEqual(['resume', '--last']);
  });

  it('quotes per shell (a program path with spaces)', () => {
    const prefs = { ...DEFAULT_AGENT_PREFERENCES, launch: { ...DEFAULT_AGENT_PREFERENCES.launch, gemini: { command: '"C:\\Program Files\\gemini.cmd"', args: '--model "a b"' } } };
    const ps = agentLaunchLine('gemini', prefs, { shell: 'powershell' });
    expect(ps.ok && ps.line).toBe("& 'C:\\Program Files\\gemini.cmd' '--model' 'a b'");
    const cmd = agentLaunchLine('gemini', prefs, { shell: 'cmd' });
    expect(cmd.ok && cmd.line).toMatch(/^"C:\\Program Files\\gemini\.cmd" "?--model"? "a b"$/);
  });

  it('custom agents launch as written; unknown ids are refused', () => {
    const prefs = agentPrefsFromSettings({ custom: [{ id: 'custom:My_Agent', label: 'Mine', command: 'my-agent --auto' }] });
    const r = agentLaunchLine('custom:My_Agent', prefs, { shell: 'posix' });
    expect(r).toEqual({ ok: true, line: 'my-agent --auto', argv: ['my-agent', '--auto'], trustFolder: false });
    const missing = agentLaunchLine('custom:gone', prefs, { shell: 'posix' });
    expect(missing.ok ? 'ok' : missing.reason).toBe('unknown-agent');
  });
});

describe('argvToLine', () => {
  it('quotes per shell and adds & in PowerShell for a quoted program', () => {
    // PowerShell quotes every word, so the program always needs the call operator
    expect(argvToLine(['claude', '--chrome'], 'powershell')).toBe("& 'claude' '--chrome'");
    expect(argvToLine(['claude', '--chrome'], 'posix')).toMatch(/^'?claude'? '?--chrome'?$/);
    expect(argvToLine(['/a b/claude', "it's"], 'posix')).toBe(`'/a b/claude' 'it'"'"'s'`);
    expect(argvToLine([], 'posix')).toBe("''");
  });
});

describe('AGENTS / catalogAgentDef', () => {
  it('every catalog agent becomes an AgentDef with label, homepage, detect aliases and popular flag', () => {
    for (const id of BUILTIN_AGENTS) {
      const d = catalogAgentDef(id);
      expect(d.id).toBe(id);
      expect(d.label.trim()).not.toBe('');
      expect(d.command.trim(), id).not.toBe('');
      expect(d.detect.length).toBeGreaterThan(0);
      expect(typeof d.popular).toBe('boolean');
    }
    expect(catalogAgentDef('dsh')).toMatchObject({ command: 'dsh', args: ['tui'], detect: ['dsh', 'dsh-tui', 'dst'] });
    expect(catalogAgentDef('zcode').install).toEqual({ mac: '', win: '', linux: '' });
  });

  it('core agents keep their tuned values (usage-limit patterns, print mode)', () => {
    expect(getAgent('claude')!.limitPatterns.length).toBeGreaterThan(0);
    expect(getAgent('claude')!.printMode).toBeTruthy();
    expect(getAgent('claude')!.homepage).toMatch(/^https:/);
    expect(AGENTS.filter((a) => a.popular).length).toBeGreaterThan(3);
  });
});

// Every Solocut launch path (pane agent button, sendToAgent({ launch }) after a take, failover hand-off, restored
// tab) starts the agent through agentLaunchLine with the prefs read from settings.json, so these cover all of them.
describe('Solocut launch paths: Claude Code bypass, Codex yolo by default', () => {
  const fromSettings = agentPrefsFromSettings({});
  const CLAUDE = '--dangerously-skip-permissions';
  const CODEX = '--dangerously-bypass-approvals-and-sandbox';
  // the catalog's default Claude Code args (--chrome), kept after the bypass flag
  const DEFAULT_ARGS = DEFAULT_AGENT_PREFERENCES.launch.claude.args.split(/\s+/).filter(Boolean);

  it('agent button / auto-launch after recording, in the project folder', () => {
    const claude = agentLaunchLine('claude', fromSettings, { shell: 'posix', projectId: '/v/2026-10-11-x' });
    expect(claude.ok && claude.argv).toEqual(['claude', CLAUDE, ...DEFAULT_ARGS]);
    expect(claude.ok && claude.trustFolder).toBe(true);
    const codex = agentLaunchLine('codex', fromSettings, { shell: 'posix', projectId: '/v/2026-10-11-x' });
    expect(codex.ok && codex.argv).toContain(CODEX);
    expect(codex.ok && codex.argv[0]).toBe('codex');
  });

  it('failover hand-off / a tab opened outside a project folder: still bypass, no folder trust', () => {
    for (const projectId of [null, undefined]) {
      const claude = agentLaunchLine('claude', fromSettings, { shell: 'posix', projectId });
      expect(claude.ok && claude.argv).toContain(CLAUDE);
      expect(claude.ok && claude.trustFolder).toBe(false);
      const codex = agentLaunchLine('codex', fromSettings, { shell: 'posix', projectId });
      expect(codex.ok && codex.argv).toContain(CODEX);
    }
  });

  it('restored tab (resume) keeps the bypass flags', () => {
    const claude = agentLaunchLine('claude', fromSettings, { shell: 'posix', projectId: '/p', resume: true });
    expect(claude.ok && claude.argv).toEqual(['claude', CLAUDE, ...DEFAULT_ARGS, '--continue']);
    const codex = agentLaunchLine('codex', fromSettings, { shell: 'posix', projectId: '/p', resume: true });
    expect(codex.ok && codex.argv.slice(0, 3)).toEqual(['codex', 'resume', '--last']);
    expect(codex.ok && codex.argv).toContain(CODEX);
  });

  it('Windows shells get the same flags', () => {
    for (const shell of ['powershell', 'cmd'] as const) {
      const claude = agentLaunchLine('claude', fromSettings, { shell, projectId: null });
      expect(claude.ok && claude.argv).toContain(CLAUDE);
      const codex = agentLaunchLine('codex', fromSettings, { shell, projectId: null });
      expect(codex.ok && codex.argv).toContain(CODEX);
    }
  });

  it("the user's own args that pick a mode win (no bypass added)", () => {
    const plan = agentPrefsFromSettings({ launch: { claude: { command: 'claude', args: '--permission-mode plan' } } });
    const claude = agentLaunchLine('claude', plan, { shell: 'posix', projectId: null });
    expect(claude.ok && claude.argv).toEqual(['claude', '--permission-mode', 'plan']);
    const ask = agentPrefsFromSettings({ launch: { codex: { command: 'codex', args: '--ask-for-approval on-request' } } });
    const codex = agentLaunchLine('codex', ask, { shell: 'posix', projectId: null });
    expect(codex.ok && codex.argv).not.toContain(CODEX);
  });

  it('other args are kept next to the bypass flag', () => {
    const model = agentPrefsFromSettings({ launch: { claude: { command: 'claude', args: '--model opus' } } });
    const claude = agentLaunchLine('claude', model, { shell: 'posix', projectId: null });
    expect(claude.ok && claude.argv).toEqual(['claude', CLAUDE, '--model', 'opus']);
  });

  it('skipPermissions: false in settings turns it off for both', () => {
    const off2 = agentPrefsFromSettings({ skipPermissions: false });
    const claude = agentLaunchLine('claude', off2, { shell: 'posix', projectId: '/p' });
    expect(claude.ok && claude.argv).toEqual(['claude', ...DEFAULT_ARGS]);
    const codex = agentLaunchLine('codex', off2, { shell: 'posix', projectId: '/p' });
    expect(codex.ok && codex.argv).toEqual(['codex']);
  });
});
