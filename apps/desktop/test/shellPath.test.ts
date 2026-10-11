import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extraInstallDirs, loginShellPathFailure, mergeDirs, parseMarkedPath, resolveCommandsInDirs, usableShellPath } from '../src/main/shellPath';

describe('login shell PATH', () => {
  it('parses the marker even after rc banners, and only the last marker', () => {
    expect(parseMarkedPath('Welcome!\n__SOLOCUT_PATH__/a:/b')).toBe('/a:/b');
    expect(parseMarkedPath('__SOLOCUT_PATH__x\n__SOLOCUT_PATH__/real\n')).toBe('/real');
    expect(parseMarkedPath('no marker')).toBeNull();
    expect(parseMarkedPath(undefined)).toBeNull();
  });
  it('accepts only sane PATH values', () => {
    expect(usableShellPath('/usr/bin')).toBe(true);
    expect(usableShellPath('')).toBe(false);
    expect(usableShellPath('a\0b')).toBe(false);
    expect(usableShellPath('x'.repeat(70_000))).toBe(false);
    expect(usableShellPath(3)).toBe(false);
  });
  it('reports only real failures (timeouts are the user rc being slow)', () => {
    expect(loginShellPathFailure(Object.assign(new Error('t'), { killed: true }))).toBeNull();
    expect(loginShellPathFailure(Object.assign(new Error('t'), { signal: 'SIGTERM' }))).toBeNull();
    expect(loginShellPathFailure(Object.assign(new Error('x'), { code: 127 }))?.message).toBe('login shell PATH exit 127');
    expect(loginShellPathFailure(Object.assign(new Error('x'), { signal: 'SIGSEGV' }))?.message).toBe('login shell PATH signal SIGSEGV');
    expect(loginShellPathFailure(null)?.message).toBe('login shell PATH marker missing');
  });
  it('merges and dedupes dirs, keeping order', () => {
    expect(mergeDirs('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', ['/x', '/bin'], ':')).toEqual(['/usr/bin', '/bin', '/opt/homebrew/bin', '/x']);
  });
  it('includes the common install dirs (~/.local/bin, Homebrew…)', () => {
    const d = extraInstallDirs('/Users/u', 'darwin');
    for (const x of ['/Users/u/.local/bin', '/Users/u/.npm-global/bin', '/Users/u/.bun/bin', '/Users/u/.cargo/bin', '/Users/u/.volta/bin', '/opt/homebrew/bin', '/usr/local/bin']) expect(d).toContain(x);
    expect(extraInstallDirs('/home/u', 'linux')).toContain('/snap/bin');
  });
});

describe.skipIf(process.platform === 'win32')('resolveCommandsInDirs', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'solocut-bin-'));
    for (const d of ['a', 'b', 'home-bin']) mkdirSync(join(base, d));
    const exe = (p: string) => (writeFileSync(p, '#!/bin/sh\n'), chmodSync(p, 0o755));
    exe(join(base, 'b', 'claude'));
    exe(join(base, 'a', 'codex'));
    exe(join(base, 'b', 'codex'));
    writeFileSync(join(base, 'a', 'gemini'), 'not executable');
    symlinkSync(join(base, 'b', 'claude'), join(base, 'home-bin', 'claude-link')); // ~/bin/claude → …
    mkdirSync(join(base, 'a', 'opencode')); // a directory, not a command
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  it('finds the first executable per command, follows symlinks, skips non-executables and dirs', async () => {
    const found = await resolveCommandsInDirs(['claude', 'codex', 'gemini', 'opencode', 'claude-link', ''], [join(base, 'missing'), join(base, 'a'), join(base, 'b'), join(base, 'home-bin')]);
    expect(found.get('claude')).toBe(join(base, 'b', 'claude'));
    expect(found.get('codex')).toBe(join(base, 'a', 'codex'));
    expect(found.get('claude-link')).toBe(join(base, 'home-bin', 'claude-link'));
    expect(found.has('gemini')).toBe(false);
    expect(found.has('opencode')).toBe(false);
  });
  it('accepts absolute command paths', async () => {
    const p = join(base, 'b', 'claude');
    expect((await resolveCommandsInDirs([p], [])).get(p)).toBe(p);
  });
});
