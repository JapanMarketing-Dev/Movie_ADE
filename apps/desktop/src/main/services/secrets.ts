// API keys and OAuth tokens, encrypted with Electron safeStorage (Keychain / DPAPI / libsecret). Only the
// ciphertext touches disk (userData/secrets.json). Without OS encryption (bare Linux) values live in memory
// for this session only (docs/14). Keys reach the CLI and agent terminals only as SOLOCUT_* env vars.
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_NAMES = ['openai', 'gemini', 'decide', 'typesafe', 'youtube.clientId', 'youtube.clientSecret', 'youtube.refreshToken'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Secrets that are exported to child processes, and their variable names. */
export const SECRET_ENV: Partial<Record<SecretName, string>> = {
  openai: 'SOLOCUT_OPENAI_API_KEY',
  gemini: 'SOLOCUT_GEMINI_API_KEY',
  decide: 'SOLOCUT_DECIDE_API_KEY',
  typesafe: 'SOLOCUT_TYPESAFE_API_KEY',
};

export function isSecretName(n: unknown): n is SecretName {
  return typeof n === 'string' && (SECRET_NAMES as readonly string[]).includes(n);
}

const memory = new Map<SecretName, string>();
let cache: Record<string, string> | null = null;

function file(): string {
  return join(app.getPath('userData'), 'secrets.json');
}

/**
 * Whether secrets survive a restart. macOS / Windows always have a keychain; asking safeStorage there would touch
 * the keychain item, which shows a blocking "allow access" prompt after every ad-hoc-signed update — so we only
 * touch it when a secret is actually read or written. On Linux, plain-text fallback ("basic_text") does not count.
 */
export function persistent(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  try {
    return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  } catch {
    return false;
  }
}

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    const j = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as unknown) : {};
    cache = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(all: Record<string, string>): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(`${file()}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
  renameSync(`${file()}.tmp`, file());
  cache = all;
}

export function getSecret(name: SecretName): string | null {
  const m = memory.get(name);
  if (m !== undefined) return m;
  const enc = load()[name];
  if (!enc || !persistent() || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

/** Stores (or with an empty value, removes) a secret. Returns whether it is persisted across restarts. */
export function setSecret(name: SecretName, value: string | null): { persisted: boolean } {
  const all = { ...load() };
  const v = value?.trim() ?? '';
  if (!v) {
    memory.delete(name);
    delete all[name];
    save(all);
    return { persisted: true };
  }
  if (!persistent() || !safeStorage.isEncryptionAvailable()) {
    memory.set(name, v);
    return { persisted: false };
  }
  memory.delete(name);
  all[name] = safeStorage.encryptString(v).toString('base64');
  save(all);
  return { persisted: true };
}

/** Which secrets are set (never the values, and without decrypting: no keychain prompt just to open Settings). */
export function secretStatus(): Record<SecretName, { set: boolean; hint?: string }> {
  const out = {} as Record<SecretName, { set: boolean; hint?: string }>;
  const stored = load();
  for (const n of SECRET_NAMES) {
    const m = memory.get(n);
    out[n] = m ? { set: true, hint: maskHint(m) } : stored[n] ? { set: true, hint: '••••' } : { set: false };
  }
  return out;
}

export function maskHint(v: string): string {
  return v.length <= 8 ? '••••' : `${v.slice(0, 3)}…${v.slice(-4)}`;
}

/** SOLOCUT_* variables for CLI children and agent terminals. */
export function secretEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, varName] of Object.entries(SECRET_ENV)) {
    const v = getSecret(name as SecretName);
    if (v && varName) env[varName] = v;
  }
  return env;
}
