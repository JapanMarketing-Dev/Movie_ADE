import { execFile } from 'node:child_process';
import { accessSync, constants as fsc, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Agent CLI catalog (docs/04 「エージェントCLIの管理」). Arguments change between versions, so the catalog can be
// replaced from the distribution manifest; keep everything data, not code.

export type HostOs = 'mac' | 'win' | 'linux';

export interface AgentDef {
  id: string;
  label: string;
  /** Executable to launch interactively. */
  command: string;
  /** Extra args for the interactive launch. */
  args?: string[];
  /** Executable names to look for on PATH. */
  detect: string[];
  install: Record<HostOs, string>;
  update?: string;
  versionArgs: string[];
  /** Non-interactive (print) mode: args after the command; the prompt is appended as the last argument. */
  printMode?: string[];
  canGenerateImages?: boolean;
  /** Regex sources (case-insensitive) that match a short usage-limit status line. */
  limitPatterns: string[];
  homepage?: string;
}

const npmInstall = (pkg: string): Record<HostOs, string> => ({
  mac: `npm install -g ${pkg}`,
  win: `npm install -g ${pkg}`,
  linux: `npm install -g ${pkg}`,
});

export const AGENTS: AgentDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    detect: ['claude'],
    install: {
      mac: 'curl -fsSL https://claude.ai/install.sh | bash',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash',
      win: 'irm https://claude.ai/install.ps1 | iex',
    },
    update: 'claude update',
    versionArgs: ['--version'],
    printMode: ['-p', '--output-format', 'json'],
    limitPatterns: [
      "^\\s*(?:claude(?: ai)? )?(?:usage )?limit reached\\b.{0,80}$",
      "^\\s*you'?ve (?:hit|reached) your (?:usage|session|weekly) limit\\b.{0,80}$",
      "^\\s*(?:5-hour|weekly|session) limit reached\\b.{0,80}$",
    ],
    homepage: 'https://docs.claude.com/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    detect: ['codex'],
    install: { ...npmInstall('@openai/codex'), mac: 'brew install --cask codex' },
    update: 'npm install -g @openai/codex@latest',
    versionArgs: ['--version'],
    printMode: ['exec', '--json'],
    canGenerateImages: true,
    limitPatterns: [
      "^\\s*(?:■\\s*)?you'?ve hit your usage limit\\b.{0,120}$",
      "^\\s*(?:error: )?rate limit reached\\b.{0,80}$",
    ],
    homepage: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    detect: ['gemini'],
    install: { ...npmInstall('@google/gemini-cli'), mac: 'brew install gemini-cli' },
    update: 'npm install -g @google/gemini-cli@latest',
    versionArgs: ['--version'],
    printMode: ['-p'],
    canGenerateImages: true,
    limitPatterns: [
      "^\\s*(?:✕\\s*)?quota exceeded\\b.{0,100}$",
      "^\\s*you have reached your daily .{0,40}quota\\b.{0,80}$",
      "^\\s*(?:\\[api error: )?resource_exhausted\\b.{0,80}$",
    ],
    homepage: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    detect: ['opencode'],
    install: { ...npmInstall('opencode-ai'), mac: 'brew install sst/tap/opencode' },
    update: 'opencode upgrade',
    versionArgs: ['--version'],
    printMode: ['run'],
    limitPatterns: ["^\\s*(?:error: )?rate limit (?:exceeded|reached)\\b.{0,80}$"],
    homepage: 'https://opencode.ai',
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    command: 'cursor-agent',
    detect: ['cursor-agent'],
    install: {
      mac: 'curl https://cursor.com/install -fsS | bash',
      linux: 'curl https://cursor.com/install -fsS | bash',
      win: 'irm https://cursor.com/install?win32=true | iex',
    },
    update: 'cursor-agent update',
    versionArgs: ['--version'],
    printMode: ['-p'],
    limitPatterns: ["^\\s*you'?ve hit your usage limit\\b.{0,100}$"],
    homepage: 'https://cursor.com/cli',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    command: 'copilot',
    detect: ['copilot'],
    install: npmInstall('@github/copilot'),
    update: 'npm install -g @github/copilot@latest',
    versionArgs: ['--version'],
    printMode: ['-p'],
    limitPatterns: [
      "^\\s*(?:error: )?you have (?:exceeded|reached) your .{0,30}(?:quota|limit)\\b.{0,80}$",
      "^\\s*(?:error: )?rate limit(?:ed| exceeded)\\b.{0,80}$",
    ],
    homepage: 'https://github.com/github/copilot-cli',
  },
];

export function getAgent(id: string, custom: { id: string; label: string; command: string; printMode?: string[] }[] = []): AgentDef | undefined {
  const builtin = AGENTS.find((a) => a.id === id);
  if (builtin) return builtin;
  const c = custom.find((x) => x.id === id);
  if (!c) return undefined;
  const [cmd = c.command, ...args] = splitCommandLine(c.command);
  return {
    id: c.id, label: c.label, command: cmd, ...(args.length ? { args } : {}), detect: [cmd],
    install: { mac: '', win: '', linux: '' }, versionArgs: ['--version'], ...(c.printMode ? { printMode: c.printMode } : {}), limitPatterns: [],
  };
}

/** Minimal shell-like split for custom commands ("my agent" --flag 'x y'). */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Quote one argument for a shell. */
export function quoteArg(arg: string, shell: 'posix' | 'powershell' | 'cmd'): string {
  if (shell === 'posix') {
    if (arg !== '' && /^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(arg)) return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  if (shell === 'powershell') {
    if (arg !== '' && /^[A-Za-z0-9_\-+=.,/:\\]+$/.test(arg)) return arg;
    return `'${arg.replace(/'/g, "''")}'`;
  }
  // cmd.exe: double quotes; inner quotes doubled; escape cmd metacharacters outside of quotes is not needed inside "".
  // % cannot be escaped inside quotes in an interactive line, so break it out as ^%.
  if (arg !== '' && /^[A-Za-z0-9_\-+=.,/:\\]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
}

/**
 * The line typed into a terminal to start the agent (interactive), or with `prompt` in print mode.
 * PowerShell needs the call operator when the command itself is quoted.
 */
export function launchCommand(def: AgentDef, shell: 'posix' | 'powershell' | 'cmd', o: { prompt?: string; extraArgs?: string[] } = {}): string {
  const args = [...(def.args ?? []), ...(o.prompt !== undefined ? def.printMode ?? [] : []), ...(o.extraArgs ?? [])];
  if (o.prompt !== undefined) args.push(o.prompt);
  const cmd = quoteArg(def.command, shell);
  const head = shell === 'powershell' && cmd !== def.command ? `& ${cmd}` : cmd;
  return [head, ...args.map((a) => quoteArg(a, shell))].join(' ');
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Detect a usage-limit message in agent terminal output. Only short status lines count (≤ 160 chars after stripping
 * ANSI and box drawing), so code, logs or prose that merely mention "rate limit" do not trigger a failover.
 * Returns the matching line, or null.
 */
export function detectUsageLimit(output: string, defs: AgentDef[] = AGENTS): string | null {
  const patterns = defs.flatMap((d) => d.limitPatterns).map((p) => new RegExp(p, 'i'));
  const lines = output.replace(ANSI, '').split(/\r?\n|\r/);
  for (const raw of lines) {
    const line = raw.replace(/^[\s│┃|>*•─━╭╰╮╯]+|[\s│┃|─━╭╰╮╯]+$/g, '').trim();
    if (!line || line.length > 160) continue;
    if (/^(?:[-+]|\/\/|#|\d+[:|]|at\s)/.test(line)) continue; // diff, comments, line-numbered code, stack frames
    if (/[`{};=]|\b(?:if|const|let|function|return|def|throw|catch)\b/.test(line)) continue; // looks like code
    for (const re of patterns) if (re.test(line)) return line;
  }
  return null;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** Find a command on PATH; on Windows only PATHEXT names (claude.cmd from npm, codex.exe…), case-insensitive env. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const win = platform === 'win32';
  const dirs = (envValue(env, 'PATH') ?? '').split(win ? ';' : delimiter).filter(Boolean);
  // lower-case spelling first: the returned path matches the file, and case-sensitive file systems find it
  const exts = win ? [...new Set((envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).flatMap((e) => [e.toLowerCase(), e]))] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, cmd + ext);
      try {
        if (!statSync(p).isFile()) continue;
        if (!win) accessSync(p, fsc.X_OK);
        return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** .cmd/.bat shims need cmd.exe on Windows (Node refuses to spawn them directly). */
export function spawnSpec(file: string, args: string[], platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { command: envValue(env, 'COMSPEC') ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map((a) => quoteArg(a, 'cmd')).join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { command: file, args };
}

function runVersion(path: string, args: string[]): Promise<string | undefined> {
  const sp = spawnSpec(path, args);
  return new Promise((res) => {
    execFile(sp.command, sp.args, { timeout: 8000, windowsHide: true, ...(sp.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }, (err, stdout, stderr) => {
      if (err) return res(undefined);
      res(parseVersion(`${stdout}\n${stderr}`));
    });
  });
}

/** First semver-looking token in `--version` output. */
export function parseVersion(s: string): string | undefined {
  return /(?<![\d.])(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)/.exec(s)?.[1];
}

export async function detectAgents(o: { defs?: AgentDef[]; versions?: boolean } = {}): Promise<{ id: string; installed: boolean; version?: string; path?: string }[]> {
  const defs = o.defs ?? AGENTS;
  return Promise.all(
    defs.map(async (d) => {
      const path = d.detect.map((c) => which(c)).find((p): p is string => !!p);
      if (!path) return { id: d.id, installed: false };
      const version = o.versions === false ? undefined : await runVersion(path, d.versionArgs);
      return { id: d.id, installed: true, path, ...(version ? { version } : {}) };
    }),
  );
}

export function hostOs(p: string = process.platform): HostOs {
  return p === 'win32' ? 'win' : p === 'darwin' ? 'mac' : 'linux';
}

/** The handoff line sent to the next agent on failover (docs/04 「切り替えと引き継ぎ」). */
export function handoffMessage(lang: 'ja' | 'en'): string {
  return lang === 'ja'
    ? '.solocut/handoff.md と `solocut next --json` を見て、前のエージェントの続きから作業を進めてください。'
    : 'Read .solocut/handoff.md and `solocut next --json`, then continue where the previous agent stopped.';
}
