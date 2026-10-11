// Tells which Claude Code account Claude in Chrome connects to.
//
// Ported from Ferret src/main/accounts/chromePairing.ts (MIT).
// The Claude in Chrome extension only connects to a Claude Code signed in to the same claude.ai account. When an
// agent runs under another CLAUDE_CONFIG_DIR, Chrome does not connect in that tab. A config that has paired writes
// chromeExtension.pairedDeviceId into .claude.json; such accounts are "Chrome accounts". The device id itself is
// never returned or sent.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractJsonObject } from './identity';

/** Whether a .claude.json text carries the Claude in Chrome pairing marker (chromeExtension.pairedDeviceId). */
export function hasChromePairing(text: string): boolean {
  const slice = extractJsonObject(text, 'chromeExtension');
  if (!slice) return false;
  try {
    const value = JSON.parse(slice) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const id = (value as { pairedDeviceId?: unknown }).pairedDeviceId;
    return typeof id === 'string' && id.trim().length > 0;
  } catch {
    // broken config counts as "not paired" (expected)
    return false;
  }
}

async function anyPaired(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => null); // not launched yet is expected
    if (text !== null) return hasChromePairing(text);
  }
  return false;
}

/** Whether a managed account's config folder (CLAUDE_CONFIG_DIR) has paired with Claude in Chrome. */
export function managedClaudeChromePaired(configDir: string): Promise<boolean> {
  return anyPaired([join(configDir, '.claude.json'), join(configDir, '.config.json')]);
}

/** The system default account: the inherited CLAUDE_CONFIG_DIR, else ~/.claude/.claude.json or ~/.claude.json. */
export function systemClaudeChromePaired(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<boolean> {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim();
  if (inherited) return managedClaudeChromePaired(inherited);
  return anyPaired([join(home, '.claude', '.claude.json'), join(home, '.claude.json')]);
}
