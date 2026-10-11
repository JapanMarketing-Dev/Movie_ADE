import { loadSettings } from '@solocut/settings';
import { CliError, CLI_VERSION, type Ctx, type IO, type Lang } from './ctx.js';
import {
  cmdConfig, cmdDoctor, cmdInit, cmdLib, cmdNext, cmdPrompts, cmdStatus, cmdStep, cmdTemplates, cmdValidate, cmdVersion,
} from './commands/basic.js';
import { cmdEdit, cmdHistory, cmdTl, cmdUndo } from './commands/edit.js';
import {
  cmdAnalyze, cmdCaptions, cmdCheck, cmdFrame, cmdImport, cmdIngest, cmdPropose, cmdRender, cmdSync, cmdTakes, cmdTranscribe,
} from './commands/media.js';
import { cmdPast } from './commands/past.js';

export { CliError, CLI_VERSION } from './ctx.js';
export type { IO } from './ctx.js';

type Handler = (ctx: Ctx, args: string[]) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  init: cmdInit,
  status: cmdStatus,
  next: cmdNext,
  step: cmdStep,
  takes: cmdTakes,
  ingest: cmdIngest,
  import: cmdImport,
  sync: cmdSync,
  transcribe: cmdTranscribe,
  analyze: cmdAnalyze,
  propose: cmdPropose,
  edit: cmdEdit,
  undo: (c, a) => cmdUndo(c, a, false),
  redo: (c, a) => cmdUndo(c, a, true),
  history: cmdHistory,
  validate: cmdValidate,
  captions: cmdCaptions,
  render: cmdRender,
  frame: cmdFrame,
  check: cmdCheck,
  tl: cmdTl,
  past: cmdPast,
  config: cmdConfig,
  prompts: cmdPrompts,
  templates: cmdTemplates,
  lib: cmdLib,
  doctor: cmdDoctor,
  version: cmdVersion,
};

const HELP: Record<Lang, string> = {
  ja: `solocut ${CLI_VERSION} — テンプレートで動画を編集する CLI（エージェント向け。どのコマンドも --json 可）

はじめに
  init [dir] --template <id>     プロジェクトを作る（AGENTS.md / CLAUDE.md も生成）
  status / next                  進み具合 / 次にやること（まずこれ）
  step <step> done|skipped       手作業の手順を終えた印
素材
  ingest / takes                 収録したテイクを登録 / 一覧
  import <file> [--take] [--role]  別撮りの素材を取り込む
  sync / transcribe / analyze    同期 / 文字起こし / 解析
編集
  propose cuts [--replace]       カットの候補から区間を作る
  edit <op> --<field> <v> --reason "<なぜ>" | edit --ops <file|json|->
  undo / redo / history / validate
  captions build                 字幕を作る
  tl summary|show|range|query|why  timeline.json を必要な分だけ読む
書き出しと確認
  render --preview | --final [--target youtube]
  frame --at <frame|timecode>    1フレームの静止画
  check                          機械的チェック（checks/<run>/report.md）
そのほか
  past list|search|show|timeline|compare|register   過去の動画
  config get|set|schema   prompts list|show   templates   lib list|install   doctor   version

共通: --json（機械向けの出力） --project <dir>（プロジェクトの場所） --by human|agent --agent <名前>`,
  en: `solocut ${CLI_VERSION} — edit videos by template (built for agents; every command accepts --json)

Start
  init [dir] --template <id>     create a project (also AGENTS.md / CLAUDE.md)
  status / next                  progress / the next thing to do (start here)
  step <step> done|skipped       mark a manual step finished
Media
  ingest / takes                 register recorded takes / list them
  import <file> [--take] [--role]  import separately recorded media
  sync / transcribe / analyze
Edit
  propose cuts [--replace]       build segments from cut candidates
  edit <op> --<field> <v> --reason "<why>" | edit --ops <file|json|->
  undo / redo / history / validate
  captions build
  tl summary|show|range|query|why  read only what you need of timeline.json
Render and check
  render --preview | --final [--target youtube]
  frame --at <frame|timecode>
  check                          machine checks (checks/<run>/report.md)
More
  past list|search|show|timeline|compare|register
  config get|set|schema   prompts list|show   templates   lib list|install   doctor   version

Global: --json  --project <dir>  --by human|agent  --agent <name>`,
};

const AGENT_ENV: [string, string][] = [['CLAUDECODE', 'claude'], ['CODEX_SANDBOX', 'codex'], ['GEMINI_CLI', 'gemini']];

/** Split global flags (anywhere in argv) from the command's own args. */
function globals(argv: string[]): { json: boolean; help: boolean; project?: string; by?: string; agent?: string; rest: string[] } {
  const rest: string[] = [];
  let json = false;
  let help = false;
  let project: string | undefined;
  let by: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--project' || a === '--by' || a === '--agent') {
      const v = argv[++i];
      if (v === undefined) throw new CliError('usage', `${a} needs a value`);
      if (a === '--project') project = v;
      else if (a === '--by') by = v;
      else agent = v;
    } else if (a.startsWith('--project=')) project = a.slice(10);
    else if (a.startsWith('--by=')) by = a.slice(5);
    else if (a.startsWith('--agent=')) agent = a.slice(8);
    else rest.push(a);
  }
  return { json, help, ...(project ? { project } : {}), ...(by ? { by } : {}), ...(agent ? { agent } : {}), rest };
}

function defaultIO(): IO {
  return {
    cwd: process.cwd(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/** Entry point. Returns the exit code (0 ok, 1 error, 2 usage). */
export async function main(argv: string[], io: IO = defaultIO()): Promise<number> {
  let json = argv.includes('--json');
  let lang: Lang = 'ja';
  try {
    lang = loadSettings().language;
  } catch {
    /* defaults */
  }
  try {
    const g = globals(argv);
    json = g.json;
    const [name, ...args] = g.rest;
    if (!name || name === 'help' || (g.help && !name)) {
      if (json) io.stdout(JSON.stringify({ ok: true, version: CLI_VERSION, commands: Object.keys(COMMANDS) }) + '\n');
      else io.stdout(HELP[lang] + '\n');
      return 0;
    }
    if (name === '--version' || name === '-v') {
      io.stdout(json ? JSON.stringify({ ok: true, version: CLI_VERSION }) + '\n' : `solocut ${CLI_VERSION}\n`);
      return 0;
    }
    const handler = COMMANDS[name];
    if (!handler) throw new CliError('usage', lang === 'ja' ? `不明なコマンド: ${name}（solocut help）` : `unknown command: ${name} (see solocut help)`);
    if (g.help) {
      io.stdout(HELP[lang] + '\n');
      return 0;
    }
    const envAgent = io.env.SOLOCUT_AGENT ?? AGENT_ENV.find(([k]) => io.env[k])?.[1];
    const byRaw = g.by ?? io.env.SOLOCUT_BY ?? (g.agent || envAgent ? 'agent' : 'human');
    if (byRaw !== 'human' && byRaw !== 'agent') throw new CliError('usage', '--by must be human or agent');
    const agent = g.agent ?? envAgent;
    const ctx: Ctx = { io, json, lang, by: byRaw, ...(g.project ? { projectFlag: g.project } : {}), ...(agent ? { agent } : {}) };
    await handler(ctx, args);
    return 0;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError('error', (e as Error)?.message ?? String(e));
    if (json) {
      io.stdout(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, null, 2) + '\n');
    } else {
      io.stderr(`solocut: ${err.message}\n`);
      const issues = Array.isArray(err.details) ? err.details : (err.details as { issues?: unknown[] } | undefined)?.issues;
      if (Array.isArray(issues)) {
        for (const i of issues.slice(0, 20) as { level?: string; path?: string; message?: string }[]) io.stderr(`  ${i.level ?? 'error'}: ${i.path ?? ''}: ${i.message ?? ''}\n`);
      }
      if (!(e instanceof CliError) && io.env.SOLOCUT_DEBUG) io.stderr(`${(e as Error)?.stack ?? ''}\n`);
    }
    return err.code === 'usage' ? 2 : 1;
  }
}
