// Reads "signed in?" and "signed in as whom" from a config folder.
//
// Ported from Ferret src/main/accounts/identity.ts (MIT).
// Orca由来: ~/bench/orca/src/main/codex-accounts/managed-codex-auth-readiness.ts（hasStoredCodexCredential）,
//           ~/bench/orca/src/main/codex-accounts/codex-auth-identity.ts（readCodexAuthIdentity）,
//           ~/bench/orca/src/main/claude-accounts/claude-auth-capture.ts（resolveClaudeIdentity）,
//           ~/bench/orca/src/main/claude-accounts/keychain.ts（getActiveClaudeService）（MIT, Copyright 2026 Lovecast Inc.）
//
// Tokens are never returned or logged; only the email and plan name are extracted. Orca copies Claude credentials
// out of the Keychain and swaps them; here Claude Code itself keeps a separate Keychain item per
// CLAUDE_CONFIG_DIR and we only check whether the item exists.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Lang } from '../../shared/types';
import { msg } from './messages';

export interface AccountIdentity {
  signedIn: boolean;
  email: string | null;
  workspaceLabel: string | null;
}

const NONE: AccountIdentity = { signedIn: false, email: null, workspaceLabel: null };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // not signed in (no file) or broken credentials count as "unknown" (expected)
    return null;
  }
}

// ───────────────────────── Codex ─────────────────────────

/** Reads only the JWT payload (no signature check; it only provides the email for display). */
function parseJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')));
  } catch {
    // not a JWT (expected)
    return null;
  }
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Personal (Free)',
  go: 'Personal (Go)',
  plus: 'Personal (Plus)',
  pro: 'Personal (Pro)',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Education',
};

/** Whether auth.json holds usable credentials (simplified Orca hasCredentialForDeclaredMode). */
export function hasCodexCredential(auth: Record<string, unknown> | null): boolean {
  if (!auth || Object.keys(auth).length === 0) return false;
  if (readString(auth, 'OPENAI_API_KEY')) return true;
  const tokens = asRecord(auth.tokens);
  if (readString(tokens, 'access_token') && readString(tokens, 'refresh_token')) return true;
  if (readString(auth, 'personal_access_token')) return true;
  if (auth.agent_identity) return true;
  return readString(asRecord(auth.bedrock_api_key), 'api_key') !== null;
}

/** Reads auth.json of a CODEX_HOME (or the system ~/.codex). */
export function readCodexIdentity(codexHome: string, lang: Lang = 'ja'): AccountIdentity {
  const auth = readJsonFile(join(codexHome, 'auth.json'));
  if (!hasCodexCredential(auth)) return NONE;
  const tokens = asRecord(auth?.tokens);
  const idToken = readString(tokens, 'id_token');
  const payload = idToken ? parseJwtPayload(idToken) : null;
  const authClaims = asRecord(payload?.['https://api.openai.com/auth']);
  const profileClaims = asRecord(payload?.['https://api.openai.com/profile']);
  const plan = readString(authClaims, 'chatgpt_plan_type')?.toLowerCase();
  return {
    signedIn: true,
    email: readString(payload, 'email') ?? readString(profileClaims, 'email'),
    workspaceLabel:
      readString(authClaims, 'workspace_name') ??
      readString(profileClaims, 'workspace_name') ??
      (plan ? (PLAN_LABEL[plan] ?? null) : readString(auth, 'OPENAI_API_KEY') ? msg(lang, 'accounts.plan.apiKey') : null),
  };
}

// ───────────────────────── Claude ─────────────────────────

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Claude Code 2.1+ uses a separate Keychain item per CLAUDE_CONFIG_DIR (suffix: first 8 hex chars of
 * sha256(NFC(dir))). Same as Orca's getActiveClaudeService.
 */
export function claudeKeychainService(configDir?: string): string {
  if (!configDir) return CLAUDE_KEYCHAIN_SERVICE;
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

/** The Keychain account name Claude Code uses (same as Orca's getKeychainUser). */
export function claudeKeychainUser(): string {
  try {
    const user = process.env.USER || process.env.USERNAME || userInfo().username;
    return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user';
  } catch {
    // same fallback as Claude Code when the user name is unavailable (expected)
    return 'claude-code-user';
  }
}

const execFileAsync = promisify(execFile);

/**
 * Whether a macOS Keychain item exists. Without -w the secret is never read. `security` exits 44 when not found.
 */
async function keychainItemExists(service: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await execFileAsync('security', ['find-generic-password', '-s', service, '-a', claudeKeychainUser()], { timeout: 5000 });
    return true;
  } catch {
    // not found (exit 44) is expected
    return false;
  }
}

/**
 * Cuts the object following `"key":` out of a JSON text (braces inside strings are not counted); null when absent.
 * Claude Code's .claude.json includes conversation history and can be tens of MB; parsing it whole blocks main.
 * Only oauthAccount (and chromeExtension) is needed.
 */
export function extractJsonObject(text: string, key: string): string | null {
  const needle = `"${key}"`;
  let at = text.indexOf(needle);
  while (at >= 0) {
    let i = at + needle.length;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === ':') {
      i++;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== '{') return null;
      let depth = 0;
      let inString = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j]!;
        if (inString) {
          if (ch === '\\') j++;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return text.slice(i, j + 1);
      }
      return null;
    }
    at = text.indexOf(needle, at + needle.length);
  }
  return null;
}

/** oauthAccount of .claude.json (contains no token); read asynchronously, parsing only that part. */
async function readClaudeOauthAccount(configPaths: string[]): Promise<Record<string, unknown> | null> {
  for (const path of configPaths) {
    const text = await readFile(path, 'utf8').catch(() => null); // not signed in (no file) is expected
    if (!text) continue;
    const slice = extractJsonObject(text, 'oauthAccount');
    if (!slice) continue;
    try {
      const oauth = asRecord(JSON.parse(slice));
      if (oauth) return oauth;
    } catch {
      // broken config counts as "unknown" (expected)
    }
  }
  return null;
}

function claudeIdentityFrom(oauth: Record<string, unknown> | null, signedIn: boolean): AccountIdentity {
  if (!signedIn) return NONE;
  return {
    signedIn,
    email: readString(oauth, 'emailAddress') ?? readString(oauth, 'email'),
    workspaceLabel: readString(oauth, 'organizationName'),
  };
}

/** Reads a managed account's CLAUDE_CONFIG_DIR. */
export async function readClaudeIdentity(configDir: string): Promise<AccountIdentity> {
  const oauth = await readClaudeOauthAccount([join(configDir, '.claude.json'), join(configDir, '.config.json')]);
  // Linux / Windows keep credentials in a file, macOS in the Keychain
  const signedIn =
    existsSync(join(configDir, '.credentials.json')) ||
    (oauth !== null && (process.platform !== 'darwin' || (await keychainItemExists(claudeKeychainService(configDir)))));
  return claudeIdentityFrom(oauth, signedIn);
}

/**
 * The system default account (read only). Without CLAUDE_CONFIG_DIR the config is ~/.claude.json and the
 * credentials are ~/.claude/.credentials.json or the unsuffixed Keychain item.
 */
export async function readClaudeSystemIdentity(env: NodeJS.ProcessEnv = process.env): Promise<AccountIdentity> {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim();
  if (inherited) return readClaudeIdentity(inherited);
  const configDir = join(homedir(), '.claude');
  const oauth = await readClaudeOauthAccount([join(configDir, '.claude.json'), join(homedir(), '.claude.json')]);
  const signedIn =
    existsSync(join(configDir, '.credentials.json')) ||
    (oauth !== null && (process.platform !== 'darwin' || (await keychainItemExists(claudeKeychainService()))));
  return claudeIdentityFrom(oauth, signedIn);
}
