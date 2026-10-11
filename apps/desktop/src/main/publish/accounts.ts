// Display names of the connected accounts (not secret; tokens stay in safeStorage). Kept in userData so showing
// Settings never decrypts a token (no keychain prompt just to open a screen).
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublishTargetId } from '../../shared/publish';

type Names = Partial<Record<PublishTargetId, { name?: string; username?: string }>>;

function file(): string {
  return join(app.getPath('userData'), 'publish-accounts.json');
}

export function readNames(): Names {
  try {
    const j = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as unknown) : {};
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Names) : {};
  } catch {
    return {};
  }
}

export function setName(target: PublishTargetId, v: { name?: string; username?: string } | null): void {
  const all = readNames();
  if (v) all[target] = v;
  else delete all[target];
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(`${file()}.tmp`, JSON.stringify(all, null, 2));
  renameSync(`${file()}.tmp`, file());
}
