// Ported from Ferret test/unit/accounts.test.ts, accounts-dedupe.test.ts, accounts-remove.test.ts and
// failover-chrome.test.ts (MIT). Real folders under a temp dir; no real CLI, Keychain or account.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountDisplayName, dedupeAccountRows, duplicateAccountIds, isAccountAgent, type AgentAccountsSettings } from '../src/shared/accounts';
import {
  MANAGED_ACCOUNT_MARKER,
  accountsRootFor,
  createManagedAccountDir,
  isValidAccountId,
  isWithin,
  managedAccountDir,
  removeManagedAccountDir,
  verifyManagedAccountDir,
} from '../src/main/accounts/paths';
import { normalizeAccountLabel, requireAccountAgent, sanitizeAgentAccounts } from '../src/main/accounts/sanitize';
import { resolveAgentEnvFrom } from '../src/main/accounts/env';
import {
  CODEX_DAEMON_OVERRIDE_MARKER,
  applyCodexDaemonSocketGuard,
  carryClaudeSettings,
  linkShared,
  linkSharedEntries,
  migrateManagedClaudeDir,
  pickClaudeGlobalConfig,
  seedManagedAccountDir,
} from '../src/main/accounts/agentConfig';
import { claudeKeychainService, extractJsonObject, hasCodexCredential, readClaudeIdentity, readCodexIdentity } from '../src/main/accounts/identity';
import { hasChromePairing, managedClaudeChromePaired, systemClaudeChromePaired } from '../src/main/accounts/chromePairing';
import { AccountsService } from '../src/main/accounts/service';
import { msg } from '../src/main/accounts/messages';

const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let base: string;
let root: string;
let systemDir: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'solocut-accounts-')));
  root = join(base, 'solocut', 'accounts');
  systemDir = join(base, 'home', '.codex');
  mkdirSync(root, { recursive: true });
  mkdirSync(systemDir, { recursive: true });
});

afterEach(() => {
  try {
    chmodSync(join(root, 'codex'), 0o755);
  } catch {
    // not created in this test
  }
  rmSync(base, { recursive: true, force: true });
});

function accountsWith(agent: 'claude' | 'codex', activeAccountId: string | null, ids = [ID]): AgentAccountsSettings {
  const list = { accounts: ids.map((id) => ({ id, label: '', email: null, workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 })), activeAccountId };
  return { claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null }, [agent]: list };
}

describe('config folder paths', () => {
  it('<root>/<agent>/<id>', () => {
    expect(accountsRootFor('/u', 'codex')).toBe(join('/u', 'codex'));
    expect(managedAccountDir('/u', 'claude', ID)).toBe(join('/u', 'claude', ID));
  });

  it('only UUIDs become paths', () => {
    expect(isValidAccountId(ID)).toBe(true);
    for (const bad of ['../x', '', 'abc', `${ID}/..`, ID2.toUpperCase(), 123, null, undefined]) expect(isValidAccountId(bad)).toBe(false);
    expect(() => managedAccountDir('/u', 'codex', '../../etc')).toThrow();
  });

  it('isWithin', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
  });

  it('a created folder carries the marker and is recognised as Solocut’s', () => {
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    expect(readFileSync(join(dir, MANAGED_ACCOUNT_MARKER), 'utf8').trim()).toBe(ID);
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir })).toEqual({ kind: 'owned', dir });
  });

  it('never recreates an existing folder', () => {
    createManagedAccountDir(root, 'codex', ID, systemDir);
    expect(() => createManagedAccountDir(root, 'codex', ID, systemDir)).toThrow();
  });

  it('refuses a missing folder, a missing / mismatched marker or a file in place of the folder', () => {
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir, lang: 'en' })).toEqual({ kind: 'untrusted', reason: 'Config folder not found. Sign in again.' });
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    writeFileSync(join(dir, MANAGED_ACCOUNT_MARKER), `${ID2}\n`);
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir }).kind).toBe('untrusted');
    rmSync(join(dir, MANAGED_ACCOUNT_MARKER));
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir, lang: 'ja' })).toEqual({ kind: 'untrusted', reason: '設定フォルダに所有の印がありません。' });
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'x');
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir }).kind).toBe('untrusted');
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: 'nope', systemDir }).kind).toBe('untrusted');
  });

  it('a symlink to the default account’s folder is neither used nor deleted', () => {
    mkdirSync(accountsRootFor(root, 'codex'), { recursive: true });
    writeFileSync(join(systemDir, MANAGED_ACCOUNT_MARKER), `${ID}\n`);
    writeFileSync(join(systemDir, 'auth.json'), '{}');
    symlinkSync(systemDir, managedAccountDir(root, 'codex', ID));
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir }).kind).toBe('untrusted');
    expect(removeManagedAccountDir(root, 'codex', ID, systemDir)).toBe(false);
    expect(existsSync(join(systemDir, 'auth.json'))).toBe(true);
  });

  it('a symlink to a folder outside the store is refused', () => {
    const outside = join(base, 'outside', ID);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, MANAGED_ACCOUNT_MARKER), `${ID}\n`);
    mkdirSync(accountsRootFor(root, 'codex'), { recursive: true });
    symlinkSync(outside, managedAccountDir(root, 'codex', ID));
    expect(verifyManagedAccountDir({ root, agent: 'codex', accountId: ID, systemDir, lang: 'en' })).toEqual({ kind: 'untrusted', reason: "The config folder points outside Solocut's storage." });
  });

  it('deletes only Solocut’s folders', () => {
    const dir = createManagedAccountDir(root, 'claude', ID, systemDir);
    expect(removeManagedAccountDir(root, 'claude', ID, systemDir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removeManagedAccountDir(root, 'claude', ID, systemDir)).toBe(false);
  });
});

describe('registry sanitize', () => {
  it('drops broken rows, duplicates and bad ids; a selection pointing nowhere goes back to the default', () => {
    const result = sanitizeAgentAccounts({
      codex: {
        accounts: [
          { id: ID, label: '  仕事用  ', email: 'a@example.com', createdAt: 5, lastAuthenticatedAt: 6 },
          { id: ID, label: 'dup' },
          { id: '../evil', label: 'x' },
          'garbage',
          null,
        ],
        activeAccountId: ID2,
      },
      claude: { accounts: [{ id: ID2, label: 1, lastAuthenticatedAt: 'x', createdAt: -1 }], activeAccountId: ID2 },
    });
    expect(result.codex.accounts).toEqual([{ id: ID, label: '仕事用', email: 'a@example.com', workspaceLabel: null, createdAt: 5, updatedAt: 5, lastAuthenticatedAt: 6 }]);
    expect(result.codex.activeAccountId).toBeNull();
    expect(result.claude.accounts[0]).toMatchObject({ id: ID2, label: '', lastAuthenticatedAt: null, createdAt: 0 });
    expect(result.claude.activeAccountId).toBe(ID2);
  });

  it('fills a missing agent with an empty list; non-objects become empty', () => {
    expect(sanitizeAgentAccounts({ claude: { accounts: [] } })).toEqual({ claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null } });
    expect(sanitizeAgentAccounts('nope')).toEqual({ claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null } });
  });

  it('labels are trimmed and capped; agent kinds from IPC are checked', () => {
    expect(normalizeAccountLabel(`  ${'x'.repeat(100)} `)).toHaveLength(80);
    expect(requireAccountAgent('codex')).toBe('codex');
    expect(() => requireAccountAgent('gemini', 'en')).toThrow('Invalid agent type.');
    expect(isAccountAgent('claude')).toBe(true);
    expect(isAccountAgent('opencode')).toBe(false);
  });
});

describe('resolveAgentEnvFrom', () => {
  it('system default → nothing added', () => {
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts: undefined, root })).toEqual({});
    expect(resolveAgentEnvFrom({ agent: 'claude', accounts: accountsWith('claude', null), root })).toEqual({});
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts: accountsWith('codex', ID), root, accountId: null })).toEqual({});
  });

  it('Codex → CODEX_HOME of the selected folder', () => {
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts: accountsWith('codex', ID), root, systemDir })).toEqual({ CODEX_HOME: dir });
  });

  it('Claude → CLAUDE_CONFIG_DIR, and Anthropic auth variables present in the env are blanked', () => {
    const dir = createManagedAccountDir(root, 'claude', ID, systemDir);
    const env = resolveAgentEnvFrom({
      agent: 'claude',
      accounts: accountsWith('claude', ID),
      root,
      baseEnv: { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: '', AWS_BEARER_TOKEN_BEDROCK: 'b', PATH: '/bin' },
      systemDir,
    });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: '', AWS_BEARER_TOKEN_BEDROCK: '' });
  });

  it('a selected id missing from the list counts as the system default', () => {
    const accounts = accountsWith('codex', ID);
    accounts.codex.accounts = [];
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts, root })).toEqual({});
  });

  it('an unverifiable folder stops the launch instead of silently using the default account', () => {
    expect(() => resolveAgentEnvFrom({ agent: 'codex', accounts: accountsWith('codex', ID), root, systemDir, lang: 'ja' })).toThrow(/Codexアカウントを使えません/);
    expect(() => resolveAgentEnvFrom({ agent: 'codex', accounts: accountsWith('codex', ID), root, systemDir, lang: 'en', accountId: ID })).toThrow(/Can't use the selected Codex account/);
  });
});

describe('Codex daemon socket length guard', () => {
  const longHome = `/Users/someone/.solocut/accounts/codex/${ID}/${'x'.repeat(40)}`;

  it('short paths are left alone', () => {
    expect(applyCodexDaemonSocketGuard('model = "o3"\n', '/tmp/c', 'darwin')).toBe('model = "o3"\n');
  });

  it('long paths add daemon_auto_start = false under [features] (idempotent)', () => {
    const once = applyCodexDaemonSocketGuard('model = "o3"\n', longHome, 'darwin');
    expect(once).toContain('[features]');
    expect(once).toContain(`daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`);
    expect(applyCodexDaemonSocketGuard(once, longHome, 'darwin')).toBe(once);
    expect(applyCodexDaemonSocketGuard('', longHome, 'linux')).toBe(`[features]\ndaemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}\n`);
  });

  it('adds inside an existing [features] and respects the user’s value', () => {
    const merged = applyCodexDaemonSocketGuard('[features]\nfoo = true\n', longHome, 'darwin');
    expect(merged.split('\n').slice(0, 2)).toEqual(['[features]', `daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`]);
    expect(applyCodexDaemonSocketGuard('[features]\ndaemon_auto_start = true\n', longHome, 'darwin')).toBe('[features]\ndaemon_auto_start = true\n');
  });

  it('creation copies the default settings and links instruction files; credentials stay out', () => {
    writeFileSync(join(systemDir, 'config.toml'), 'model = "o3"\n');
    writeFileSync(join(systemDir, 'AGENTS.md'), '# 指示\n');
    writeFileSync(join(systemDir, 'auth.json'), '{"tokens":{}}');
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    seedManagedAccountDir('codex', dir, systemDir);
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('model = "o3"');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# 指示\n');
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
    expect(readFileSync(join(systemDir, 'config.toml'), 'utf8')).toBe('model = "o3"\n');
  });
});

describe('sharing Codex rules (Orca #24431)', () => {
  it('links rules at creation', () => {
    mkdirSync(join(systemDir, 'rules'));
    writeFileSync(join(systemDir, 'rules', 'default.rules'), 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    seedManagedAccountDir('codex', dir, systemDir);
    expect(readFileSync(join(dir, 'rules', 'default.rules'), 'utf8')).toContain('forbidden');
  });

  it('older accounts get only the missing links (the user’s own files are left alone)', () => {
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    seedManagedAccountDir('codex', dir, systemDir);
    mkdirSync(join(systemDir, 'rules'));
    writeFileSync(join(systemDir, 'AGENTS.md'), '# default\n');
    writeFileSync(join(dir, 'AGENTS.md'), '# this account only\n');
    linkSharedEntries('codex', dir, systemDir);
    linkSharedEntries('codex', dir, systemDir);
    expect(lstatSync(join(dir, 'rules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# this account only\n');
  });
});

describe('bringing Claude settings into managed accounts', () => {
  const claudeHome = () => {
    const dir = join(base, 'home', '.claude');
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('global config: only MCP and "seen" markers; no auth or history', () => {
    expect(
      pickClaudeGlobalConfig({
        mcpServers: { a: { command: 'x' } },
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'me@example.com' },
        userID: 'u',
        customApiKeyResponses: { approved: ['k'] },
        projects: { '/p': { hasTrustDialogAccepted: true, history: ['secret'] }, '/q': { hasTrustDialogAccepted: false } },
      }),
    ).toEqual({ mcpServers: { a: { command: 'x' } }, hasCompletedOnboarding: true, projects: { '/p': { hasTrustDialogAccepted: true } } });
    expect(pickClaudeGlobalConfig({ projects: [] })).toEqual({});
  });

  it('creation copies settings and the global config, and links plugins', () => {
    const home = claudeHome();
    mkdirSync(join(home, 'plugins'));
    writeFileSync(join(home, 'settings.json'), '{"enabledPlugins":{}}');
    writeFileSync(join(home, '.credentials.json'), '{"claudeAiOauth":{}}');
    writeFileSync(join(base, 'home', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'x' } }));
    const dir = createManagedAccountDir(root, 'claude', ID, home);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      seedManagedAccountDir('claude', dir, home);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
    }
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(realpathSync(join(dir, 'plugins'))).toBe(realpathSync(join(home, 'plugins')));
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false);
  });

  it('carries the bypass-permissions consent without overwriting the account’s own values', () => {
    const home = claudeHome();
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true, model: 'opus' }));
    const dir = createManagedAccountDir(root, 'claude', ID, home);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    expect(carryClaudeSettings(dir, home)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: false }));
    expect(carryClaudeSettings(dir, home)).toBe(false);
  });

  it('never writes through a linked settings.json into the default account', () => {
    const home = claudeHome();
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const dir = createManagedAccountDir(root, 'claude', ID, home);
    symlinkSync(join(home, 'settings.json'), join(dir, 'settings.json'));
    expect(carryClaudeSettings(dir, home)).toBe(false);
  });

  it('existing accounts are migrated once before a launch', () => {
    const home = claudeHome();
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const dir = createManagedAccountDir(root, 'claude', ID, home);
    migrateManagedClaudeDir(dir, home);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({}));
    migrateManagedClaudeDir(dir, home);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('resolving the launch env runs the migration', () => {
    const home = claudeHome();
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const dir = createManagedAccountDir(root, 'claude', ID, home);
    resolveAgentEnvFrom({ agent: 'claude', accounts: accountsWith('claude', ID), root, baseEnv: {}, systemDir: home });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true);
  });
});

describe('identity from the config folder', () => {
  const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

  it('Codex auth.json: email and plan only', () => {
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) } }),
    );
    expect(readCodexIdentity(dir)).toEqual({ signedIn: true, email: 'me@example.com', workspaceLabel: 'Personal (Plus)' });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk' }));
    expect(readCodexIdentity(dir, 'en')).toEqual({ signedIn: true, email: null, workspaceLabel: 'API key' });
  });

  it('missing, empty or broken auth.json = signed out', () => {
    const dir = createManagedAccountDir(root, 'codex', ID, systemDir);
    expect(readCodexIdentity(dir).signedIn).toBe(false);
    writeFileSync(join(dir, 'auth.json'), '{');
    expect(readCodexIdentity(dir).signedIn).toBe(false);
    expect(hasCodexCredential({})).toBe(false);
    expect(hasCodexCredential(null)).toBe(false);
    expect(hasCodexCredential({ OPENAI_API_KEY: 'sk' })).toBe(true);
    expect(hasCodexCredential({ tokens: { access_token: 'a' } })).toBe(false);
    expect(hasCodexCredential({ bedrock_api_key: { api_key: 'k' } })).toBe(true);
  });

  it('Claude identity from .credentials.json and oauthAccount (no Keychain on this path)', async () => {
    const dir = createManagedAccountDir(root, 'claude', ID, systemDir);
    expect((await readClaudeIdentity(dir)).signedIn).toBe(process.platform !== 'darwin' && false);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects: { '/p': { history: ['"oauthAccount": {}'] } }, oauthAccount: { emailAddress: 'c@example.com', organizationName: 'Acme' } }));
    writeFileSync(join(dir, '.credentials.json'), '{}');
    expect(await readClaudeIdentity(dir)).toEqual({ signedIn: true, email: 'c@example.com', workspaceLabel: 'Acme' });
  });

  it('extractJsonObject ignores the key inside strings and braces inside strings', () => {
    const text = '{"a":"\\"oauthAccount\\": {","oauthAccount":{"x":"}{","y":{"z":1}},"b":2}';
    expect(JSON.parse(extractJsonObject(text, 'oauthAccount')!)).toEqual({ x: '}{', y: { z: 1 } });
    expect(extractJsonObject('{"oauthAccount": null}', 'oauthAccount')).toBeNull();
    expect(extractJsonObject('{"oauthAccount": {"a": 1', 'oauthAccount')).toBeNull();
    expect(extractJsonObject('{}', 'oauthAccount')).toBeNull();
  });

  it('Claude Keychain item names are per config folder (Claude Code 2.1 rule)', () => {
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
    expect(claudeKeychainService('/a')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(claudeKeychainService('/a')).not.toBe(claudeKeychainService('/b'));
  });
});

describe('linkShared (Windows: junctions for folders)', () => {
  it('folders and files point at the shared copy, also on the Windows branch', () => {
    mkdirSync(join(base, 'skills'));
    writeFileSync(join(base, 'skills', 'a.md'), 'x');
    writeFileSync(join(base, 'CLAUDE.md'), 'y');
    mkdirSync(join(base, 'managed'));
    linkShared(join(base, 'skills'), join(base, 'managed', 'skills'), 'win32');
    linkShared(join(base, 'CLAUDE.md'), join(base, 'managed', 'CLAUDE.md'), 'win32');
    expect(readFileSync(join(base, 'managed', 'skills', 'a.md'), 'utf8')).toBe('x');
    expect(readFileSync(join(base, 'managed', 'CLAUDE.md'), 'utf8')).toBe('y');
    linkShared(join(base, 'skills'), join(base, 'managed', 'skills2'), 'darwin');
    expect(lstatSync(join(base, 'managed', 'skills2')).isSymbolicLink()).toBe(true);
  });
});

describe('Claude in Chrome pairing marker', () => {
  it('chromeExtension.pairedDeviceId means paired', () => {
    expect(hasChromePairing(JSON.stringify({ chromeExtension: { pairedDeviceId: 'dev-1', pairedDeviceName: 'Browser 1' } }))).toBe(true);
    expect(hasChromePairing('{\n  "a": 1,\n  "chromeExtension": {\n    "pairedDeviceId": "x"\n  }\n}')).toBe(true);
  });

  it('missing, empty, wrong shape or broken = not paired', () => {
    expect(hasChromePairing(JSON.stringify({ claudeInChromeDefaultEnabled: true }))).toBe(false);
    expect(hasChromePairing(JSON.stringify({ chromeExtension: { pairedDeviceId: '' } }))).toBe(false);
    expect(hasChromePairing(JSON.stringify({ chromeExtension: { pairedDeviceId: 3 } }))).toBe(false);
    expect(hasChromePairing(JSON.stringify({ chromeExtension: [] }))).toBe(false);
    expect(hasChromePairing('{"chromeExtension": {"pairedDeviceId": "x"')).toBe(false);
    expect(hasChromePairing('')).toBe(false);
  });

  it('managed accounts read CLAUDE_CONFIG_DIR/.claude.json; the system default ~/.claude.json or the inherited dir', async () => {
    const dir = join(base, 'acct');
    mkdirSync(dir);
    expect(await managedClaudeChromePaired(dir)).toBe(false);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {}, chromeExtension: { pairedDeviceId: 'd' } }));
    expect(await managedClaudeChromePaired(dir)).toBe(true);
    const home = join(base, 'h');
    mkdirSync(home);
    expect(await systemClaudeChromePaired({}, home)).toBe(false);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ chromeExtension: { pairedDeviceId: 'd' } }));
    expect(await systemClaudeChromePaired({}, home)).toBe(true);
    expect(await systemClaudeChromePaired({ CLAUDE_CONFIG_DIR: join(base, 'none') }, home)).toBe(false);
  });
});

describe('same login rows are merged', () => {
  const row = (accountId: string | null, email: string | null, workspaceLabel: string | null = null) => ({ accountId, email, workspaceLabel });

  it('keeps the selected row among duplicates of the system default; other accounts stay', () => {
    const rows = [row(null, 'a@example.com'), row('x', 'a@example.com'), row('y', 'A@Example.com '), row('z', 'b@example.com')];
    expect(dedupeAccountRows(rows, 'y').map((r) => r.accountId)).toEqual(['y', 'z']);
  });

  it('without a selection the system default stays', () => {
    const rows = [row(null, 'a@example.com'), row('x', 'a@example.com'), row('z', 'b@example.com')];
    expect(dedupeAccountRows(rows, null).map((r) => r.accountId)).toEqual([null, 'z']);
  });

  it('different organisations are different rows; rows without email are never merged', () => {
    const rows = [row(null, null), row('x', 'a@example.com', 'Acme'), row('y', 'a@example.com', 'Personal'), row('w', null)];
    expect(dedupeAccountRows(rows, null).map((r) => r.accountId)).toEqual([null, 'x', 'y', 'w']);
  });
});

describe('the same login is never registered twice', () => {
  const acc = (id: string, email: string | null, createdAt: number, signedIn = true, workspaceLabel: string | null = null, fresh = true) => ({ id, email, workspaceLabel, createdAt, signedIn, fresh });
  const old = (id: string, email: string | null, createdAt: number) => acc(id, email, createdAt, true, null, false);
  const system = (email: string | null) => ({ signedIn: !!email, email, workspaceLabel: null });

  it('the later of two fresh duplicates is dropped', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'X@example.com', 2), acc('c', 'y@example.com', 3)], null, system(null))).toEqual(['b']);
  });

  it('among fresh duplicates the selected one stays', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['a']);
  });

  it('a fresh account equal to the system default is dropped', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2), acc('g', 'g@example.com', 3)], null, system('x@example.com'))).toEqual(['a', 'b']);
    expect(duplicateAccountIds([acc('b', 'x@example.com', 2)], 'b', system('x@example.com'))).toEqual(['b']);
  });

  it('signed out, unknown email or another organisation are never dropped', () => {
    expect(
      duplicateAccountIds([acc('a', 'x@example.com', 1, true, 'Acme'), acc('b', 'x@example.com', 2, true, 'Personal'), acc('c', 'x@example.com', 3, false, 'Acme'), acc('d', null, 4)], null, system(null)),
    ).toEqual([]);
  });

  it('accounts in use before are never dropped (the 2026-10-10 loss)', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['b']);
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], null, system('x@example.com'))).toEqual(['b']);
    expect(duplicateAccountIds([old('a', 'x@example.com', 1)], null, system('x@example.com'))).toEqual([]);
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), old('b', 'X@Example.com', 2)], 'b', system('x@example.com'))).toEqual([]);
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'y@example.com', 2)], 'b', system('z@example.com'))).toEqual([]);
  });

  it('display names: label → email → waiting for login', () => {
    expect(accountDisplayName({ label: ' work ', email: 'a@x' })).toBe('work');
    expect(accountDisplayName({ label: '', email: 'a@x' })).toBe('a@x');
    expect(accountDisplayName({ label: '', email: null }, 'en')).toBe('Waiting for login');
  });
});

describe('AccountsService', () => {
  let claudeHome: string;
  let deletedKeychain: string[];
  let system: { claude: { signedIn: boolean; email: string | null; workspaceLabel: string | null }; codex: { signedIn: boolean; email: string | null; workspaceLabel: string | null } };
  let now: number;

  beforeEach(() => {
    claudeHome = join(base, 'home', '.claude');
    mkdirSync(claudeHome, { recursive: true });
    deletedKeychain = [];
    system = { claude: { signedIn: false, email: null, workspaceLabel: null }, codex: { signedIn: false, email: null, workspaceLabel: null } };
    now = 10_000_000;
  });

  function service(changes: unknown[] = []) {
    return new AccountsService({
      root,
      language: () => 'en',
      systemDir: (agent) => (agent === 'codex' ? systemDir : claudeHome),
      readSystemDefault: async (agent) => system[agent],
      deleteClaudeKeychainItem: async (dir) => {
        deletedKeychain.push(dir);
      },
      onChange: (s) => changes.push(s),
      env: {},
      home: join(base, 'home'),
      now: () => now,
    });
  }

  const signInCodex = (dir: string, email: string) =>
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', id_token: `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y` } }));

  it('add → waiting row; login completes on the next list; new Codex accounts become selected', async () => {
    const changes: unknown[] = [];
    const svc = service(changes);
    const { state, login } = await svc.add('codex');
    expect(login.agent).toBe('codex');
    expect(state.codex.accounts).toHaveLength(1);
    expect(state.codex.accounts[0]).toMatchObject({ signedIn: false, lastAuthenticatedAt: null, problem: null });
    expect(state.codex.activeAccountId).toBeNull();
    signInCodex(join(root, 'codex', login.accountId), 'w@example.com');
    const after = await svc.list();
    expect(after.codex.accounts[0]).toMatchObject({ signedIn: true, email: 'w@example.com', lastAuthenticatedAt: now });
    expect(after.codex.activeAccountId).toBe(login.accountId);
    expect(changes.length).toBeGreaterThanOrEqual(2);
    // the registry never contains paths or tokens
    const raw = readFileSync(join(root, 'accounts.json'), 'utf8');
    expect(raw).not.toContain(root);
    expect(raw).not.toContain('refresh');
  });

  it('a fresh login equal to the system default is removed with its folder', async () => {
    system.codex = { signedIn: true, email: 'me@example.com', workspaceLabel: null };
    const svc = service();
    const { login } = await svc.add('codex');
    signInCodex(join(root, 'codex', login.accountId), 'me@example.com');
    const state = await svc.list();
    expect(state.codex.accounts).toEqual([]);
    expect(state.codex.activeAccountId).toBeNull();
    expect(state.codex.removedDuplicates).toEqual(['me@example.com']);
    expect(existsSync(join(root, 'codex', login.accountId))).toBe(false);
  });

  it('rename / select / relogin / unknown accounts', async () => {
    const svc = service();
    const { login } = await svc.add('codex');
    await expect(svc.select('codex', login.accountId)).rejects.toThrow("You can't select an account that hasn't finished signing in.");
    signInCodex(join(root, 'codex', login.accountId), 'w@example.com');
    // the first list after the login completes the registration and selects the new Codex account
    expect((await svc.list()).codex.activeAccountId).toBe(login.accountId);
    await svc.select('codex', null);
    expect(svc.activeAccountId('codex')).toBeNull();
    await svc.select('codex', login.accountId);
    expect(svc.activeAccountId('codex')).toBe(login.accountId);
    const renamed = await svc.rename('codex', login.accountId, '  Work  ');
    expect(renamed.codex.accounts[0]!.label).toBe('Work');
    expect(svc.accountLabel('codex', login.accountId)).toBe('Work');
    expect(svc.accountLabel('codex', null)).toBe('System default');
    expect(svc.relogin('codex', login.accountId)).toEqual({ agent: 'codex', accountId: login.accountId });
    await expect(svc.rename('codex', ID2, 'x')).rejects.toThrow('That account no longer exists.');
    expect(() => svc.relogin('claude', login.accountId)).toThrow('That account no longer exists.');
  });

  it('remove deletes the folder first (and the Claude Keychain item), then the row', async () => {
    const svc = service();
    const { login } = await svc.add('claude');
    const dir = join(root, 'claude', login.accountId);
    expect(existsSync(dir)).toBe(true);
    const state = await svc.remove('claude', login.accountId);
    expect(state.claude.accounts).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(deletedKeychain).toEqual([join(realpathSync(join(root, 'claude')), login.accountId)]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('when the folder cannot be deleted, the row stays and an error is returned', async () => {
    const svc = service();
    const { login } = await svc.add('codex');
    chmodSync(join(root, 'codex'), 0o555);
    await expect(svc.remove('codex', login.accountId)).rejects.toThrow(/Couldn't delete the Codex account folder/);
    expect(existsSync(join(root, 'codex', login.accountId))).toBe(true);
    expect(svc.settings().codex.accounts).toHaveLength(1);
  });

  it('a broken registry reads as empty without deleting anything', () => {
    writeFileSync(join(root, 'accounts.json'), '{broken');
    expect(service().settings()).toEqual({ claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null } });
  });

  it('resolveAgentEnv / tabAccountId / loginLaunch', async () => {
    const svc = service();
    expect(svc.resolveAgentEnv('gemini')).toEqual({});
    expect(svc.resolveAgentEnv('codex', {})).toEqual({});
    const { login } = await svc.add('codex');
    const dir = realpathSync(join(root, 'codex', login.accountId));
    expect(svc.resolveAgentEnv('codex', {}, login.accountId)).toEqual({ CODEX_HOME: dir });
    expect(svc.tabAccountId('gemini', undefined)).toBeUndefined();
    expect(svc.tabAccountId('codex', undefined)).toBeNull();
    expect(svc.tabAccountId('codex', login.accountId)).toBe(login.accountId);
    expect(svc.tabAccountId('codex', ID2)).toBeNull();
    expect(svc.tabAccountId('codex', null)).toBeNull();
    const launch = svc.loginLaunch(login);
    expect(launch).toEqual({ argv: ['codex', 'login'], env: { CODEX_HOME: dir }, title: 'Codex Login' });
    expect(() => svc.loginLaunch({ agent: 'codex', accountId: '../x' })).toThrow('Invalid account ID.');
  });

  it('Claude login uses `auth login --claudeai` with only the executable of the agent command', async () => {
    const svc = new AccountsService({ root, language: () => 'ja', systemDir: () => claudeHome, readSystemDefault: async () => system.claude, agentExecutable: () => '/opt/bin/claude', env: {} });
    const { login } = await svc.add('claude');
    const launch = svc.loginLaunch(login);
    expect(launch.argv).toEqual(['/opt/bin/claude', 'auth', 'login', '--claudeai']);
    expect(launch.title).toBe(msg('ja', 'accounts.loginTabTitle', { agent: 'Claude Code' }));
    expect(Object.keys(launch.env)).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('claudeChromeAccounts: system default and paired managed accounts', async () => {
    const svc = service();
    const { login } = await svc.add('claude');
    expect([...(await svc.claudeChromeAccounts())]).toEqual([]);
    writeFileSync(join(root, 'claude', login.accountId, '.claude.json'), JSON.stringify({ chromeExtension: { pairedDeviceId: 'd' } }));
    expect([...(await svc.claudeChromeAccounts())]).toEqual([login.accountId]);
  });
});
