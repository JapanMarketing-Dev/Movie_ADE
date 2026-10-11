// OAuth tokens of the publishing accounts, encrypted with Electron safeStorage (Keychain / DPAPI / libsecret). Only
// the ciphertext touches disk (userData/secrets.json). Without OS encryption (bare Linux) values live in memory for
// this session only (docs/14). The app has no API keys: images and judgements run inside the agents' subscriptions.
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_NAMES = ['youtube.clientId', 'youtube.clientSecret', 'youtube.refreshToken', 'tiktok.tokens'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

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

/** Whether a secret is stored, without decrypting it (no keychain prompt just to show the account rows). */
export function hasSecret(name: SecretName): boolean {
  return memory.has(name) || Boolean(load()[name]);
}
