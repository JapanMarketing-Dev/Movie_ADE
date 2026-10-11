import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENTS, detectAgents, detectUsageLimit, getAgent, handoffMessage, hostOs, launchCommand, parseVersion, quoteArg, spawnSpec, splitCommandLine, which,
} from '../src/index.js';

const WIN = process.platform === 'win32';

const posixEcho = (line: string): string[] => {
  // let a real sh parse the line and print each argv on its own line
  const out = execFileSync('sh', ['-c', `printf '%s\\n' ${line.split(' ').slice(1).join(' ')}`]).toString();
  return out.split('\n').slice(0, -1);
};

describe('catalog', () => {
  it('has the six agents with ids from docs/04', () => {
    expect(AGENTS.map((a) => a.id)).toEqual(['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot']);
    expect(getAgent('cursor')!.command).toBe('cursor-agent');
  });

  it('every agent has detect, install per OS, version args, print mode and limit patterns that compile', () => {
    for (const a of AGENTS) {
      expect(a.detect.length, a.id).toBeGreaterThan(0);
      for (const os of ['mac', 'win', 'linux'] as const) expect(a.install[os], `${a.id} ${os}`).toBeTruthy();
      expect(a.versionArgs).toEqual(['--version']);
      expect(a.printMode?.length, a.id).toBeGreaterThan(0);
      expect(a.limitPatterns.length, a.id).toBeGreaterThan(0);
      for (const p of a.limitPatterns) expect(() => new RegExp(p, 'i')).not.toThrow();
    }
  });

  it('print modes match docs/04', () => {
    expect(getAgent('claude')!.printMode).toEqual(['-p', '--output-format', 'json']);
    expect(getAgent('codex')!.printMode).toEqual(['exec', '--json']);
    expect(getAgent('opencode')!.printMode).toEqual(['run']);
  });

  it('marks image-capable agents', () => {
    expect(AGENTS.filter((a) => a.canGenerateImages).map((a) => a.id)).toEqual(['codex', 'gemini']);
  });

  it('custom agents from settings', () => {
    const c = getAgent('custom:mine', [{ id: 'custom:mine', label: 'Mine', command: '"/opt/my agent/bin/run" --fast' }]);
    expect(c).toMatchObject({ command: '/opt/my agent/bin/run', args: ['--fast'], detect: ['/opt/my agent/bin/run'] });
    expect(getAgent('custom:none')).toBeUndefined();
  });

  it('hostOs', () => {
    expect(hostOs('darwin')).toBe('mac');
    expect(hostOs('win32')).toBe('win');
    expect(hostOs('linux')).toBe('linux');
  });

  it('handoff message points to handoff.md and solocut next', () => {
    expect(handoffMessage('ja')).toContain('.solocut/handoff.md');
    expect(handoffMessage('en')).toContain('solocut next --json');
  });
});

describe('splitCommandLine', () => {
  it('handles quotes and escapes', () => {
    expect(splitCommandLine(`a "b c" 'd "e"' f\\ g`)).toEqual(['a', 'b c', 'd "e"', 'f\\', 'g']);
    expect(splitCommandLine(`x "" y`)).toEqual(['x', '', 'y']);
    expect(splitCommandLine(`"say \\"hi\\""`)).toEqual(['say "hi"']);
    expect(splitCommandLine('   ')).toEqual([]);
  });
});

describe('launchCommand quoting', () => {
  const claude = getAgent('claude')!;

  it('plain interactive launch', () => {
    expect(launchCommand(claude, 'posix')).toBe('claude');
    expect(launchCommand(claude, 'powershell')).toBe('claude');
    expect(launchCommand(claude, 'cmd')).toBe('claude');
  });

  it.skipIf(WIN)('posix: spaces, single quotes, $ and backticks survive a real shell', () => {
    const prompt = `it's "done" $HOME \`id\` & ; | * ? 日本語`;
    const line = launchCommand(claude, 'posix', { prompt });
    expect(line.startsWith("claude -p --output-format json '")).toBe(true);
    const argv = execFileSync('sh', ['-c', `printf '%s\\n' ${line.slice('claude '.length)}`]).toString().split('\n').slice(0, -1);
    expect(argv).toEqual(['-p', '--output-format', 'json', prompt]);
  });

  it.skipIf(WIN)('posix: empty argument and a command path with spaces', () => {
    const def = { ...claude, command: '/Applications/My Tools/claude', printMode: [] };
    expect(launchCommand(def, 'posix', { prompt: '' })).toBe(`'/Applications/My Tools/claude' ''`);
    expect(posixEcho(`x 'a b' ''`)).toEqual(['a b', '']);
  });

  it('powershell: single quotes doubled, call operator for quoted command', () => {
    expect(launchCommand(claude, 'powershell', { prompt: "it's $env:HOME" })).toBe(`claude -p --output-format json 'it''s $env:HOME'`);
    const def = { ...claude, command: 'C:\\Program Files\\Claude\\claude.exe' };
    expect(launchCommand(def, 'powershell')).toBe(`& 'C:\\Program Files\\Claude\\claude.exe'`);
  });

  it('cmd: double quotes doubled and percent broken out', () => {
    expect(quoteArg('say "hi"', 'cmd')).toBe('"say ""hi"""');
    expect(quoteArg('100%', 'cmd')).toBe('"100"^%""');
    expect(quoteArg('C:\\x\\y.exe', 'cmd')).toBe('C:\\x\\y.exe');
    expect(launchCommand(claude, 'cmd', { prompt: 'a & b' })).toBe('claude -p --output-format json "a & b"');
  });

  it('extra args go before the prompt', () => {
    expect(launchCommand(getAgent('codex')!, 'posix', { prompt: 'go', extraArgs: ['--model', 'gpt-5'] })).toBe('codex exec --json --model gpt-5 go');
  });
});

describe('detectUsageLimit', () => {
  it.each([
    'Claude AI usage limit reached|1760000000',
    '5-hour limit reached ∙ resets 3pm',
    'Session limit reached ∙ resets 7pm (Asia/Tokyo)',
    "You've hit your weekly limit · resets Oct 14",
    "■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing), or try again in 2 days 3 hours 4 minutes.",
    '✕ Quota exceeded for quota metric \'Gemini 2.5 Pro Requests\' and limit',
    'You have reached your daily gemini-2.5-pro quota limit',
    "You've hit your usage limit for Cursor",
    'Error: rate limit exceeded, retry later',
  ])('detects: %s', (line) => {
    expect(detectUsageLimit(`some output\n${line}\n> `)).not.toBeNull();
  });

  it('strips ANSI and box drawing around the status line', () => {
    const out = '\u001b[31m│ \u001b[1mClaude usage limit reached. Your limit will reset at 5pm.\u001b[0m │\r\n';
    expect(detectUsageLimit(out)).toBe('Claude usage limit reached. Your limit will reset at 5pm.');
  });

  it.each([
    'We should handle the case where the rate limit is reached by the client before retrying the request, according to the design docs and the RFC.',
    '  if (usage > limit) throw new Error("limit reached");',
    '- usage limit reached',
    '+ Session limit reached',
    '// limit reached when quota exceeded',
    '42: rate limit exceeded',
    'The test asserts that "rate limit exceeded" is logged',
    'const msg = `Quota exceeded`;',
    'quota exceeded = true',
    'at RateLimiter.check (rate limit exceeded.js:10:3)',
    'I implemented detection for when the usage limit reached state occurs.',
    '',
  ])('ignores: %s', (line) => {
    expect(detectUsageLimit(line)).toBeNull();
  });

  it('ignores lines longer than a status line', () => {
    expect(detectUsageLimit(`Claude usage limit reached ${'x'.repeat(200)}`)).toBeNull();
  });
});

describe('detectAgents', () => {
  let dir: string;
  const savedPath = process.env.PATH;
  const savedPathext = process.env.PATHEXT;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solocut-ag-'));
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedPathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = savedPathext;
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds installed agents on PATH and reads their version', async () => {
    mkdirSync(join(dir, 'bin'));
    // npm installs .cmd shims on Windows; elsewhere plain executables
    const exe = (name: string, body: string) => {
      const p = join(dir, 'bin', WIN ? `${name}.cmd` : name);
      writeFileSync(p, WIN ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`);
      if (!WIN) chmodSync(p, 0o755);
      return p;
    };
    const claude = exe('claude', WIN ? 'echo 2.1.4 (Claude Code)' : 'echo "2.1.4 (Claude Code)"');
    const codex = exe('codex', 'exit 3');
    writeFileSync(join(dir, 'bin', 'gemini'), 'not executable');
    process.env.PATH = join(dir, 'bin');
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    const r = await detectAgents();
    expect(r.find((x) => x.id === 'claude')).toEqual({ id: 'claude', installed: true, path: claude, version: '2.1.4' });
    expect(r.find((x) => x.id === 'codex')).toEqual({ id: 'codex', installed: true, path: codex });
    expect(r.find((x) => x.id === 'gemini')!.installed).toBe(false);
    expect(r).toHaveLength(6);
  });

  it('Windows: finds .cmd shims under a "Path" env key and runs them via cmd.exe', () => {
    mkdirSync(join(dir, 'w'));
    writeFileSync(join(dir, 'w', 'claude.cmd'), '');
    writeFileSync(join(dir, 'w', 'claude'), '');
    const found = which('claude', { Path: `C:\\x;${join(dir, 'w')}`, PATHEXT: '.EXE;.CMD' }, 'win32');
    expect(found).toBe(join(dir, 'w', 'claude.cmd'));
    const sp = spawnSpec('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', ['--version'], 'win32', { COMSPEC: 'cmd.exe' });
    expect(sp).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd --version"'], windowsVerbatimArguments: true });
    expect(spawnSpec('/usr/local/bin/claude', ['--version'], 'linux')).toEqual({ command: '/usr/local/bin/claude', args: ['--version'] });
  });

  it('parseVersion', () => {
    expect(parseVersion('codex-cli 0.46.0')).toBe('0.46.0');
    expect(parseVersion('v1.2')).toBe('1.2');
    expect(parseVersion('1.0.0-beta.3 build')).toBe('1.0.0-beta.3');
    expect(parseVersion('no version')).toBeUndefined();
  });
});
