// Brings the system default account's settings into a managed account's config folder.
//
// Ported from Ferret src/main/accounts/agentConfig.ts (MIT).
// Orca由来: ~/bench/orca/src/main/codex-accounts/codex-config-mirror.ts,
//           ~/bench/orca/src/main/codex/codex-daemon-socket-path-guard.ts（MIT, Copyright 2026 Lovecast Inc.）
//
// Orca syncs ~/.codex/config.toml and the managed config.toml both ways; here it is copied once at creation
// (later changes stay in the managed folder). ~/.codex and ~/.claude are only read, never written.
import { copyFileSync, existsSync, linkSync, lstatSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountAgent } from '../../shared/accounts';
import { errorKind, reportHandled } from '../../shared/report';

/** settings files copied at creation (changes made inside are not copied back) */
const SEED_FILES: Record<AccountAgent, string[]> = {
  codex: ['config.toml'],
  claude: ['settings.json'],
};

/**
 * Shared entries, shown through links to the system default account's copies (instructions, skills, custom
 * commands, plugins and hooks keep working across accounts). Credentials (.credentials.json, auth.json),
 * conversation history and per-account state are not shared. Codex `rules` is shared too, otherwise
 * ~/.codex/rules would not apply to added accounts (Orca #24431). Entries added later are linked into existing
 * accounts on every launch (linkSharedEntries).
 */
const SHARED_ENTRIES: Record<AccountAgent, string[]> = {
  codex: ['AGENTS.md', 'prompts', 'skills', 'rules'],
  claude: ['CLAUDE.md', 'commands', 'agents', 'skills', 'plugins', 'hooks'],
};

/**
 * Keys of Claude's global config (.claude.json) that may be copied: MCP servers and the "already seen" markers
 * that suppress onboarding and announcements. oauthAccount, userID, customApiKeyResponses and conversation history
 * (contents of `projects`) are never copied.
 */
const CLAUDE_GLOBAL_CONFIG_KEYS = [
  'mcpServers',
  // older Claude Code kept the bypass-permissions consent in the global config
  'bypassPermissionsModeAccepted',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'lastReleaseNotesSeen',
  'hasIdeOnboardingBeenShown',
  'hasAcknowledgedCostThreshold',
  'shiftEnterKeyBindingInstalled',
  'theme',
  'autoUpdates',
  'installMethod',
  'preferredNotifChannel',
  'verbose',
  'autoConnectIde',
  'editorMode',
] as const;

/**
 * Picks the copyable keys of the default account's .claude.json. Folder trust
 * (projects[path].hasTrustDialogAccepted) is copied only as a marker for trusted folders (no history).
 */
export function pickClaudeGlobalConfig(source: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of CLAUDE_GLOBAL_CONFIG_KEYS) if (key in source) picked[key] = source[key];
  const projects = source.projects;
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    const trusted: Record<string, { hasTrustDialogAccepted: true }> = {};
    for (const [path, value] of Object.entries(projects as Record<string, unknown>)) {
      if (value && typeof value === 'object' && (value as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true) {
        trusted[path] = { hasTrustDialogAccepted: true };
      }
    }
    if (Object.keys(trusted).length > 0) picked.projects = trusted;
  }
  return picked;
}

/** The default account's .claude.json: ~/.claude.json without CLAUDE_CONFIG_DIR (same as Claude Code). */
function systemClaudeGlobalConfigPath(systemDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim();
  if (inherited) return join(inherited, '.claude.json');
  const colocated = join(systemDir, '.claude.json');
  return existsSync(colocated) ? colocated : join(dirname(systemDir), '.claude.json');
}

function seedClaudeGlobalConfig(managedDir: string, sourcePath: string): void {
  const target = join(managedDir, '.claude.json');
  try {
    if (!existsSync(sourcePath) || lstatExists(target)) return;
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    const picked = pickClaudeGlobalConfig(source as Record<string, unknown>);
    if (Object.keys(picked).length > 0) writeFileSync(target, `${JSON.stringify(picked, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    // may contain secrets (MCP keys): report the error kind only
    reportHandled(errorKind(err), { area: 'accounts', op: 'copy claude global config' });
  }
}

/**
 * Keys of Claude's settings.json carried into added accounts. skipDangerousModePermissionPrompt records the
 * consent to bypass-permissions mode (otherwise it asks on every --dangerously-skip-permissions launch).
 */
const CLAUDE_SETTINGS_CARRY_KEYS = ['skipDangerousModePermissionPrompt'] as const;

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    // missing or broken settings count as absent (expected; the caller continues with defaults)
    return null;
  }
}

/**
 * Adds the carried keys of the default settings.json to the managed settings.json when absent there. Values already
 * set in the managed folder are kept (the user changed them for that account). Returns true when something was added.
 */
export function carryClaudeSettings(managedDir: string, systemDir: string): boolean {
  const target = join(managedDir, 'settings.json');
  // never write through a link into the default account
  if (lstatExists(target) && lstatSync(target).isSymbolicLink()) return false;
  const source = readJsonObject(join(systemDir, 'settings.json'));
  if (!source) return false;
  const current = existsSync(target) ? readJsonObject(target) : {};
  if (!current) return false;
  const additions = CLAUDE_SETTINGS_CARRY_KEYS.filter((key) => key in source && !(key in current));
  if (additions.length === 0) return false;
  const next = { ...current };
  for (const key of additions) next[key] = source[key];
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}

/** record of one-time fixes (inside the managed folder) */
const MIGRATION_MARKER = '.solocut-migrations';
const CLAUDE_CARRY_MIGRATION = 'claude-settings-carry-v1';

/** Applies keys carried later to previously added accounts, once (called before launching the agent). Never blocks the launch. */
export function migrateManagedClaudeDir(managedDir: string, systemDir: string): void {
  const markerPath = join(managedDir, MIGRATION_MARKER);
  try {
    const done = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').split('\n').map((l) => l.trim()) : [];
    if (done.includes(CLAUDE_CARRY_MIGRATION)) return;
    carryClaudeSettings(managedDir, systemDir);
    writeFileSync(markerPath, `${[...done.filter(Boolean), CLAUDE_CARRY_MIGRATION].join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    reportHandled(errorKind(err), { area: 'accounts', op: 'migrate account settings' });
  }
}

/** Prepares a new config folder. Failures never stop adding the account. */
export function seedManagedAccountDir(agent: AccountAgent, managedDir: string, systemDir: string): void {
  if (agent === 'claude') seedClaudeGlobalConfig(managedDir, systemClaudeGlobalConfigPath(systemDir));
  for (const name of SEED_FILES[agent]) {
    const source = join(systemDir, name);
    const target = join(managedDir, name);
    try {
      if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
    } catch (err) {
      reportHandled(errorKind(err), { area: 'accounts', op: 'copy account file' });
    }
  }
  linkSharedEntries(agent, managedDir, systemDir);
  if (agent === 'claude') {
    // carry the consent even when settings.json already existed; then record that no migration is needed
    try {
      carryClaudeSettings(managedDir, systemDir);
    } catch (err) {
      reportHandled(errorKind(err), { area: 'accounts', op: 'carry claude settings' });
    }
    migrateManagedClaudeDir(managedDir, systemDir);
  }
  if (agent === 'codex') ensureCodexDaemonSocketGuard(managedDir);
}

/**
 * Links a shared entry. Windows symlinks need developer mode or admin (EPERM), so folders use junctions (no
 * privilege needed) and files fall back to hard links.
 */
export function linkShared(source: string, target: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') {
    symlinkSync(source, target);
    return;
  }
  if (statSync(source).isDirectory()) {
    symlinkSync(source, target, 'junction');
    return;
  }
  try {
    symlinkSync(source, target, 'file');
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'EPERM') throw err;
    linkSync(source, target);
  }
}

/**
 * Links the default account's shared entries into the managed folder. Existing names (including the user's own)
 * are left alone. Idempotent (runs on every launch so entries shared later reach existing accounts).
 */
export function linkSharedEntries(agent: AccountAgent, managedDir: string, systemDir: string): void {
  for (const name of SHARED_ENTRIES[agent]) {
    const source = join(systemDir, name);
    const target = join(managedDir, name);
    try {
      if (!existsSync(source) || lstatExists(target)) continue;
      linkShared(realpathSync(source), target);
    } catch (err) {
      // EPERM on Windows is the user's environment; reporting it would not help
      if ((err as { code?: unknown } | null)?.code !== 'EPERM') reportHandled(errorKind(err), { area: 'accounts', op: 'link account file' });
    }
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // checking for absence (expected)
    return false;
  }
}

// ───────────────────────── Codex daemon socket length guard ─────────────────────────

/**
 * Codex 0.157+ connects to <CODEX_HOME>/app-server-control/app-server-control.sock. Managed folders have long
 * paths; beyond the Unix socket limit (macOS 104 / Linux 108 bytes) Codex fails with "path must be shorter than
 * SUN_LEN". Only then is the daemon auto start turned off (same fix as Orca).
 */
const DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock'];
export const CODEX_DAEMON_OVERRIDE_MARKER = '# solocut: CODEX_HOME too long for the daemon socket';

function codexDaemonSocketPathExceedsLimit(homePath: string, platform: NodeJS.Platform = process.platform): boolean {
  let canonical = homePath;
  try {
    canonical = realpathSync.native(homePath);
  } catch {
    // measure the path as written when it cannot be resolved
  }
  const socketPath = [canonical.replace(/[\\/]+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join(platform === 'win32' ? '\\' : '/');
  return Buffer.byteLength(socketPath, 'utf8') > (platform === 'darwin' ? 103 : 107);
}

/**
 * Adds daemon_auto_start = false under [features] of config.toml (left alone when already set). Less general than
 * Orca's upsertTableSettingsInContent: only handles a `[features]` table header.
 */
export function applyCodexDaemonSocketGuard(config: string, homePath: string, platform: NodeJS.Platform = process.platform): string {
  if (!codexDaemonSocketPathExceedsLimit(homePath, platform)) return config;
  if (/^\s*daemon_auto_start\s*=/m.test(config)) return config;
  const line = `daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`;
  const header = /^\[features\][ \t]*(#.*)?$/m.exec(config);
  if (header) {
    const at = header.index + header[0].length;
    return `${config.slice(0, at)}\n${line}${config.slice(at)}`;
  }
  const base = config.length === 0 || config.endsWith('\n') ? config : `${config}\n`;
  return `${base}${base ? '\n' : ''}[features]\n${line}\n`;
}

export function ensureCodexDaemonSocketGuard(homePath: string): void {
  const configPath = join(homePath, 'config.toml');
  try {
    // never write through a link into the default account
    if (lstatExists(configPath) && lstatSync(configPath).isSymbolicLink()) return;
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const next = applyCodexDaemonSocketGuard(current, homePath);
    if (next !== current) writeFileSync(configPath, next, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    // config.toml may contain secrets: kind only
    reportHandled(errorKind(err), { area: 'accounts', op: 'guard codex daemon socket' });
  }
}
