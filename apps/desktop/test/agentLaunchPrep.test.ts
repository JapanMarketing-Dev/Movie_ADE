// Before an agent starts (src/main/agentLaunchPrep.ts): Claude Code's bypass-mode consent is pre-accepted in the
// tab account's settings.json, and the project folder is trusted, so an unattended agent never stops at a prompt.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_BYPASS_FLAG, launchPrepSteps, prepareAgentLaunch } from '../src/main/agentLaunchPrep';
import { acceptClaudeBypassConsent, applyClaudeBypassConsent, claudeSettingsFile } from '../src/main/agentWorkspaceTrust';

describe('launchPrepSteps', () => {
  it('Claude Code with the bypass flag: consent; in a project folder also trust', () => {
    expect(launchPrepSteps({ agent: 'claude', argv: ['claude', CLAUDE_BYPASS_FLAG], projectDir: '/p' })).toEqual({ trustFolder: true, bypassConsent: true });
    expect(launchPrepSteps({ agent: 'claude', argv: ['claude', CLAUDE_BYPASS_FLAG, '--continue'], projectDir: null })).toEqual({ trustFolder: false, bypassConsent: true });
  });
  it('no flag (user picked a mode / skipPermissions off): no consent written', () => {
    expect(launchPrepSteps({ agent: 'claude', argv: ['claude', '--permission-mode', 'plan'], projectDir: '/p' }).bypassConsent).toBe(false);
    expect(launchPrepSteps({ agent: 'claude', argv: ['claude'], projectDir: null })).toEqual({ trustFolder: false, bypassConsent: false });
  });
  it('the flag after -- is prompt text, not a flag', () => {
    expect(launchPrepSteps({ agent: 'claude', argv: ['claude', '--', CLAUDE_BYPASS_FLAG], projectDir: null }).bypassConsent).toBe(false);
  });
  it('Codex: trust only (its yolo flag asks nothing); other agents: nothing', () => {
    expect(launchPrepSteps({ agent: 'codex', argv: ['codex', '--dangerously-bypass-approvals-and-sandbox'], projectDir: '/p' })).toEqual({ trustFolder: true, bypassConsent: false });
    expect(launchPrepSteps({ agent: 'gemini', argv: ['gemini', CLAUDE_BYPASS_FLAG], projectDir: '/p' })).toEqual({ trustFolder: false, bypassConsent: false });
  });
});

describe('prepareAgentLaunch', () => {
  it('passes the tab env (its account) to both steps', async () => {
    const consent = vi.fn();
    const trust = vi.fn(async () => 'granted');
    const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.solocut/accounts/claude/a1' };
    await prepareAgentLaunch({ agent: 'claude', argv: ['claude', CLAUDE_BYPASS_FLAG], projectDir: '/p', env }, { consent, trust });
    expect(consent).toHaveBeenCalledWith(env);
    expect(trust).toHaveBeenCalledWith('claude', '/p', env);
  });
  it('skips what does not apply', async () => {
    const consent = vi.fn();
    const trust = vi.fn(async () => 'granted');
    await prepareAgentLaunch({ agent: 'codex', argv: ['codex'], projectDir: null, env: {} }, { consent, trust });
    expect(consent).not.toHaveBeenCalled();
    expect(trust).not.toHaveBeenCalled();
  });
});

describe('applyClaudeBypassConsent', () => {
  it('adds the marker, keeps everything else', () => {
    expect(applyClaudeBypassConsent({ model: 'opus', permissions: { defaultMode: 'dontAsk' } })).toEqual({
      kind: 'changed',
      config: { model: 'opus', permissions: { defaultMode: 'dontAsk' }, skipDangerousModePermissionPrompt: true },
    });
  });
  it('already true → unchanged; false → set to true', () => {
    expect(applyClaudeBypassConsent({ skipDangerousModePermissionPrompt: true })).toEqual({ kind: 'unchanged' });
    expect(applyClaudeBypassConsent({ skipDangerousModePermissionPrompt: false }).kind).toBe('changed');
  });
  it('not an object → refuse', () => {
    for (const bad of [null, [], 'x', 3]) expect(applyClaudeBypassConsent(bad).kind).toBe('refuse');
  });
});

describe('acceptClaudeBypassConsent (files)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'solocut-consent-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

  it('settings file: CLAUDE_CONFIG_DIR of the account, else ~/.claude', () => {
    expect(claudeSettingsFile({}, '/h')).toBe(join('/h', '.claude', 'settings.json'));
    expect(claudeSettingsFile({ CLAUDE_CONFIG_DIR: '/acc' }, '/h')).toBe(join('/acc', 'settings.json'));
    expect(claudeSettingsFile({ CLAUDE_CONFIG_DIR: '  ' }, '/h')).toBe(join('/h', '.claude', 'settings.json'));
  });
  it('creates ~/.claude/settings.json when Claude never ran', () => {
    expect(acceptClaudeBypassConsent({}, home)).toBe('granted');
    expect(read(join(home, '.claude', 'settings.json'))).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(acceptClaudeBypassConsent({}, home)).toBe('unchanged');
  });
  it("adds to an existing file without touching the user's settings", () => {
    mkdirSync(join(home, '.claude'));
    const file = join(home, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(*)'], defaultMode: 'dontAsk' }, model: 'opus' }));
    expect(acceptClaudeBypassConsent({}, home)).toBe('granted');
    expect(read(file)).toEqual({ permissions: { allow: ['Bash(*)'], defaultMode: 'dontAsk' }, model: 'opus', skipDangerousModePermissionPrompt: true });
  });
  it('writes into the added account, not ~/.claude', () => {
    const acc = join(home, 'acc');
    mkdirSync(acc);
    expect(acceptClaudeBypassConsent({ CLAUDE_CONFIG_DIR: acc }, home)).toBe('granted');
    expect(read(join(acc, 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
    expect(() => readFileSync(join(home, '.claude', 'settings.json'))).toThrow();
  });
  it('broken JSON is left alone (Claude asks once instead)', () => {
    mkdirSync(join(home, '.claude'));
    const file = join(home, '.claude', 'settings.json');
    writeFileSync(file, '{ broken');
    expect(acceptClaudeBypassConsent({}, home)).toBe('unreadable');
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });
  it('an array is not a settings object', () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), '[]');
    expect(acceptClaudeBypassConsent({}, home)).toBe('unreadable');
  });
  it.skipIf(process.platform === 'win32')('a linked settings.json is written through the link (dotfiles repos)', () => {
    mkdirSync(join(home, '.claude'));
    const real = join(home, 'dotfiles-settings.json');
    writeFileSync(real, '{"model":"x"}');
    symlinkSync(real, join(home, '.claude', 'settings.json'));
    expect(acceptClaudeBypassConsent({}, home)).toBe('granted');
    expect(read(real)).toEqual({ model: 'x', skipDangerousModePermissionPrompt: true });
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unwritable folder does not throw', () => {
    const ro = join(home, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(acceptClaudeBypassConsent({ CLAUDE_CONFIG_DIR: join(ro, 'sub') }, home)).toBe('unreadable');
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});
