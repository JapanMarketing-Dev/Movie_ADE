import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { SCHEMA_VERSION, emptyTimeline, summarize, validateTimeline, type Timeline } from '@solocut/core';
import { AGENTS, detectAgents } from '@solocut/agents';
import {
  getSetting, loadPromptsWithErrors, loadSettings, loadSettingsWithErrors, parseCliValue, renderPrompt, setSetting,
  settingsJsonSchema, settingsPath, SettingsError,
} from '@solocut/settings';
import {
  CLAUDE_MD, STEP_IDS, builtinTemplatesDir, expandPipeline, generateAgentsMd, initialStatus, listTemplatesWithErrors, loadTemplate, nextStep, splitStep,
  type PipelineStep,
  type NextContext, type StepId, type StepState,
} from '@solocut/templates';
import { DEFAULT_MANIFEST, ensureTool, resolveToolSync, solocutHome, toolStatus, whichSync, type ToolName } from '@solocut/toolchain';
import { variantInfo } from './derive.js';
import { CLI_VERSION, CliError, emit, info, opts, progress, progressDone, t, type Ctx } from '../ctx.js';
import { cameraCount } from '../analysis.js';
import { termsFromTitle } from '../glossary.js';
import {
  listDirs, openProject, paths, projectTemplate, readStatus, readTimeline, readTimelineRaw, setStep, writeAtomic, writeStatus,
  writeTimeline, type Project, type ProjectFile,
} from '../project.js';

const PROJECT_DIRS = [
  'media/takes', 'media/imports', 'assets', 'derived/proxies', 'derived/transcripts', 'derived/analysis', 'derived/cache',
  'captions', 'checks', 'feedback', 'renders', '.solocut',
];

const GITIGNORE = `# solocut: original media, rebuildable files and renders stay out of git
media/
derived/
renders/
.solocut/lock
.DS_Store
`;

function newProjectId(now = new Date()): string {
  return `prj_${now.toISOString().slice(0, 10).replace(/-/g, '')}_${randomBytes(4).toString('hex')}`;
}

export async function cmdInit(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, {
    template: { type: 'string', short: 't' }, title: { type: 'string' }, lang: { type: 'string' }, 'no-git': { type: 'boolean' },
    force: { type: 'boolean' }, dir: { type: 'string' },
  }, { max: 1, usage: 'solocut init [dir | --dir <dir>] --template <id> [--title <title>] [--lang ja|en] [--no-git]' });
  if (values.dir && positionals[0] && resolve(ctx.io.cwd, values.dir) !== resolve(ctx.io.cwd, positionals[0])) throw new CliError('usage', 'give the folder either as an argument or with --dir');
  const dir = resolve(ctx.io.cwd, values.dir ?? positionals[0] ?? '.');
  const settings = loadSettings();
  const lang = (values.lang ?? settings.language) as 'ja' | 'en';
  if (lang !== 'ja' && lang !== 'en') throw new CliError('usage', '--lang must be ja or en');
  ctx.lang = lang;
  if (existsSync(join(dir, 'solocut.json')) && !values.force) {
    throw new CliError('exists', t(ctx, `すでにプロジェクトがあります: ${dir}`, `a project already exists in ${dir}`));
  }
  const tpl = loadTemplate(values.template ?? 'talk');
  const title = (values.title ?? basename(dir)).trim() || 'untitled';
  for (const d of PROJECT_DIRS) mkdirSync(join(dir, d), { recursive: true });
  const ff = resolveToolSync('ffmpeg');
  const file: ProjectFile = {
    schema: 1, id: newProjectId(), title, template: { id: tpl.id, version: tpl.version }, language: lang,
    created: new Date().toISOString(), tools: ff?.version ? { ffmpeg: ff.version } : {},
  };
  writeAtomic(join(dir, 'solocut.json'), JSON.stringify(file, null, 2) + '\n');
  const tl = emptyTimeline({ title, kind: tpl.kind, template: { id: tpl.id, version: tpl.version }, canvas: tpl.canvas, language: lang, targets: tpl.targets });
  // product names in the title ("Claude Code") seed the glossary: whisper hears them better and captions get fixed
  tl.meta.glossary = termsFromTitle(title).map((term) => ({ term }));
  writeTimeline(dir, tl);
  writeAtomic(join(dir, 'AGENTS.md'), generateAgentsMd(tpl, { dir, title, lang }));
  writeAtomic(join(dir, 'CLAUDE.md'), CLAUDE_MD);
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  for (const f of ['history.jsonl', 'decisions.jsonl']) if (!existsSync(join(dir, '.solocut', f))) writeFileSync(join(dir, '.solocut', f), '');
  const p: Project = { dir, file, variant: null };
  writeStatus(p, initialStatus(tpl));
  let git = false;
  if (!values['no-git'] && !existsSync(join(dir, '.git')) && whichSync('git')) {
    git = spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }).status === 0;
  }
  emit(ctx, { project: { dir, ...file }, git }, () => [
    t(ctx, `プロジェクトを作りました: ${dir}`, `Created project: ${dir}`),
    t(ctx, `テンプレート: ${tpl.id}（${tpl.name.ja}）`, `Template: ${tpl.id} (${tpl.name.en})`),
    t(ctx, '次: エージェントに「solocut next を見て進めて」と頼むか、`solocut next` を実行', 'Next: ask your agent to follow `solocut next`, or run it yourself'),
  ]);
}

/** Inputs of nextStep from the project files. */
export function nextContext(p: Project, tl: Timeline | null, o: { autopilot?: boolean; lang: 'ja' | 'en'; variants?: NextContext['variants'] }): NextContext {
  const takesDir = join(p.dir, 'media', 'takes');
  const importsDir = join(p.dir, 'media', 'imports');
  const hasSources = tl ? Object.values(tl.sources).some((s) => s.kind !== 'asset') : false;
  const hasTakes = hasSources || listDirs(takesDir).length > 0 || listDirs(importsDir).length > 0;
  const openItems = tl ? tl.review.openItems : [];
  const settings = loadSettings();
  return {
    hasTakes,
    hasTranscript: existsSync(paths(p.dir).transcript),
    openItems: openItems.length,
    openItemRefs: openItems.map((i) => i.ref),
    lastCheckFailed: tl?.review.lastCheck?.failed ?? 0,
    autopilot: !!o.autopilot,
    stopBefore: settings.autopilot.stopBefore,
    lang: o.lang,
    ...(o.variants ? { variants: o.variants } : {}),
    // known once media is registered: one camera (or none) → nothing to switch, multicam passes
    ...(tl && hasSources ? { cameras: cameraCount(tl) } : {}),
  };
}

function tryTimeline(p: Project): { tl: Timeline | null; error?: string } {
  try {
    return { tl: readTimeline(p) };
  } catch (e) {
    return { tl: null, error: (e as Error).message };
  }
}

/** Progress is project-wide: it follows the main timeline plus the state of each derived variant (docs/18). */
function progressOf(ctx: Ctx, p: Project, autopilot: boolean) {
  const main: Project = { ...p, variant: null };
  const tpl = projectTemplate(main);
  const { tl, error } = tryTimeline(main);
  // the desktop app adds PII masks itself after OCR: then the masks step has nothing left to run
  const steps = readStatus(main, tpl).map((s) => (s.step === 'masks' && s.state === 'todo' && tl?.masks.some((m) => m.id.startsWith('mask_pii_'))
    ? { ...s, state: 'done' as const, note: t(ctx, 'アプリがモザイクを入れ済み（要確認）', 'masks added by the app (review them)') } : s));
  const variants = variantInfo(main, tpl, tl);
  const next = nextStep(tpl, steps, nextContext(main, tl, { autopilot, lang: ctx.lang, variants }));
  return { tpl, steps, tl, error, variants, next };
}

export async function cmdStatus(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { autopilot: { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const { tpl, steps, tl: mainTl, error, variants, next } = progressOf(ctx, p, !!values.autopilot || ctx.io.env.SOLOCUT_AUTOPILOT === '1');
  const tl = p.variant ? tryTimeline(p).tl : mainTl;
  const summary = tl ? summarize(tl) : null;
  emit(ctx, { project: { dir: p.dir, ...p.file }, variant: p.variant ?? 'main', steps, next, summary, variants, ...(error ? { timelineError: error } : {}) }, () => {
    const mark = (s: StepState) => ({ done: '✓', skipped: '–', running: '●', 'needs-human': '!', todo: '·' })[s.state];
    const lines = [`${p.file.title}  [${tpl.id}]  ${p.dir}`, steps.map((s) => `${mark(s)} ${s.step}`).join('  ')];
    if (summary) lines.push(t(ctx, `長さ ${summary.duration}・区間 ${summary.counts.segments}・字幕 ${summary.counts.captions}・要確認 ${summary.needsReview.length + summary.openItems.length}`, `length ${summary.duration} · ${summary.counts.segments} segments · ${summary.counts.captions} captions · ${summary.needsReview.length + summary.openItems.length} to review`));
    if (error) lines.push(`! ${error}`);
    for (const [v, i] of Object.entries(variants)) lines.push(`  ${v}: ${i.exists ? (i.stale ? t(ctx, '本編が変わったので作り直しが必要', 'stale (main changed)') : t(ctx, 'あり', 'ready')) : t(ctx, 'まだ', 'not yet')}`);
    lines.push(t(ctx, `次: ${next.step} — ${next.why}`, `Next: ${next.step} — ${next.why}`));
    return lines;
  });
}

export async function cmdNext(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { autopilot: { type: 'boolean' }, 'with-prompt': { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const { tpl, next } = progressOf(ctx, p, !!values.autopilot || ctx.io.env.SOLOCUT_AUTOPILOT === '1');
  const base = splitStep(next.step).base;
  const promptText = values['with-prompt'] && next.step !== 'done' ? tpl.prompts[base === 'derive' ? 'vertical' : next.step] : undefined;
  emit(ctx, { ...next, ...(promptText ? { promptText } : {}) }, () => {
    const lines = [`${next.step} (${next.state})`, `${t(ctx, 'なぜ', 'why')}: ${next.why}`, `${t(ctx, 'やること', 'do')}: ${next.do}`];
    if (next.commands.length) lines.push(...next.commands.map((c) => `  $ ${c}`));
    if (next.prompt) lines.push(`${t(ctx, 'プロンプト', 'prompt')}: ${next.prompt}`);
    if (next.blocking?.length) lines.push(`${t(ctx, '要確認', 'blocking')}: ${next.blocking.join(', ')}`);
    if (promptText) lines.push('', promptText);
    return lines;
  });
}

const STATES = ['todo', 'running', 'done', 'needs-human', 'skipped'] as const;

export async function cmdStep(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { note: { type: 'string' } }, { min: 2, max: 2, usage: 'solocut step <step> todo|running|done|needs-human|skipped [--note <text>]' });
  const [step, state] = positionals as [string, string];
  if (!(STATES as readonly string[]).includes(state)) throw new CliError('usage', `unknown state: ${state} (${STATES.join(', ')})`);
  const p = openProject(ctx);
  const known = expandPipeline(projectTemplate(p));
  if (!(STEP_IDS as readonly string[]).includes(step) && !known.includes(step as PipelineStep)) throw new CliError('usage', `unknown step: ${step} (${known.join(', ')})`);
  const steps = setStep(p, step as PipelineStep, state as StepState['state'], values.note);
  emit(ctx, { steps }, () => t(ctx, `${step} を ${state} にしました`, `${step} → ${state}`));
}

export async function cmdValidate(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  const p = openProject(ctx);
  const v = validateTimeline(readTimelineRaw(p));
  let templateError: string | undefined;
  try {
    projectTemplate(p);
  } catch (e) {
    templateError = (e as Error).message;
  }
  const ok = v.ok && !templateError;
  if (!ok) {
    throw new CliError('invalid', t(ctx, `検証に失敗しました（${v.issues.filter((i) => i.level === 'error').length} 件）`, `validation failed (${v.issues.filter((i) => i.level === 'error').length} error(s))`), { issues: v.issues, ...(templateError ? { templateError } : {}) });
  }
  emit(ctx, { valid: true, issues: v.issues }, () => [
    t(ctx, 'timeline.json は有効です', 'timeline.json is valid'),
    ...v.issues.map((i) => `  ${i.level}: ${i.path}: ${i.message}`),
  ]);
}

export async function cmdVersion(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  emit(ctx, { version: CLI_VERSION, timelineSchema: SCHEMA_VERSION, node: process.version, templatesDir: builtinTemplatesDir() }, () => `solocut ${CLI_VERSION}`);
}

export async function cmdDoctor(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  // the 47-agent catalog: list what is installed plus the popular ones (the CLI's PATH: the app passes the login shell's)
  const pathKey = Object.keys(ctx.io.env).find((k) => k.toUpperCase() === 'PATH');
  const [tools, detected] = await Promise.all([toolStatus(), detectAgents(pathKey ? { path: ctx.io.env[pathKey] ?? '' } : {})]);
  const popular = new Set(AGENTS.filter((a) => a.popular).map((a) => a.id));
  const agents = detected.filter((a) => a.installed || popular.has(a.id));
  const settings = loadSettingsWithErrors();
  const prompts = loadPromptsWithErrors();
  const templates = listTemplatesWithErrors();
  let project: Record<string, unknown> | undefined;
  try {
    const p = openProject(ctx);
    const v = validateTimeline(readTimelineRaw(p));
    project = { dir: p.dir, timelineValid: v.ok, issues: v.issues.length };
  } catch {
    project = undefined;
  }
  const problems: string[] = [];
  if (!tools.ffmpeg.installed) problems.push(t(ctx, 'ffmpeg がありません: `solocut lib install ffmpeg`', 'ffmpeg is missing: `solocut lib install ffmpeg`'));
  if (!tools.ffprobe.installed) problems.push(t(ctx, 'ffprobe がありません: `solocut lib install ffmpeg`', 'ffprobe is missing: `solocut lib install ffmpeg`'));
  if (!tools['whisper-cli'].installed) problems.push(t(ctx, 'whisper-cli がありません: `solocut lib install whisper`（macOS は `brew install whisper-cpp`）', 'whisper-cli is missing: `solocut lib install whisper` (macOS: `brew install whisper-cpp`)'));
  if (!tools['whisper-model'].installed && !tools['whisper-model-small'].installed) problems.push(t(ctx, '文字起こしのモデルがありません: `solocut lib install whisper`', 'no whisper model: `solocut lib install whisper`'));
  if (!agents.some((a) => a.installed)) problems.push(t(ctx, 'エージェントの CLI が見つかりません（claude / codex / gemini など）', 'no agent CLI found (claude / codex / gemini …)'));
  for (const e of settings.errors) problems.push(`settings.json ${e.path}: ${e.message}`);
  for (const e of prompts.errors) problems.push(`${e.file}: ${e.message}`);
  for (const e of templates.errors) problems.push(e.message);
  emit(ctx, {
    node: process.version, platform: `${process.platform}/${process.arch}`, home: solocutHome(), tools, agents,
    settingsErrors: settings.errors, templates: templates.templates.map((x) => x.id), project, problems,
  }, () => [
    `solocut ${CLI_VERSION}  node ${process.version}  ${process.platform}/${process.arch}`,
    ...Object.entries(tools).map(([k, v]) => `${v.installed ? '✓' : '✗'} ${k}${v.version ? ` ${v.version}` : ''}${v.path ? `  ${v.path}` : ''}`),
    ...agents.map((a) => `${a.installed ? '✓' : '·'} ${a.id}${a.version ? ` ${a.version}` : ''}`),
    ...(problems.length ? ['', ...problems.map((x) => `! ${x}`)] : ['', t(ctx, '問題はありません', 'No problems found')]),
  ]);
}

export async function cmdConfig(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'get') {
    const { positionals } = opts(rest, {}, { max: 1, usage: 'solocut config get [key]' });
    const key = positionals[0];
    const value = key ? getSetting(key) : loadSettings();
    if (key && value === undefined) throw new CliError('unknown-key', t(ctx, `設定がありません: ${key}`, `unknown setting: ${key}`));
    emit(ctx, { key: key ?? null, value }, () => (typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)));
    return;
  }
  if (sub === 'set') {
    const { positionals } = opts(rest, {}, { min: 2, max: 2, usage: 'solocut config set <key> <value>' });
    const [key, raw] = positionals as [string, string];
    try {
      setSetting(key, parseCliValue(raw), { by: ctx.by === 'agent' ? (ctx.agent ?? 'agent') : 'user' });
    } catch (e) {
      if (e instanceof SettingsError) throw new CliError('invalid-setting', e.message, e.issues);
      throw e;
    }
    emit(ctx, { key, value: getSetting(key) }, () => t(ctx, `${key} を変更しました`, `${key} updated`));
    return;
  }
  if (sub === 'schema') {
    opts(rest, {}, { max: 0 });
    const schema = settingsJsonSchema();
    if (ctx.json) emit(ctx, { schema }, () => '');
    else ctx.io.stdout(JSON.stringify(schema, null, 2) + '\n');
    return;
  }
  if (sub === 'path') {
    emit(ctx, { path: settingsPath() }, () => settingsPath());
    return;
  }
  throw new CliError('usage', 'usage: solocut config get [key] | set <key> <value> | schema | path');
}

export async function cmdPrompts(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  let projectDir: string | undefined;
  let vars: Record<string, string> = {};
  try {
    const p = openProject(ctx);
    projectDir = p.dir;
    vars = { project: p.file.title, template: p.file.template.id };
  } catch {
    ctx.lang = loadSettings().language;
  }
  if (sub === 'list' || sub === undefined) {
    const { values } = opts(rest, { all: { type: 'boolean' } }, { max: 0 });
    const r = loadPromptsWithErrors(projectDir, { includeHidden: !!values.all });
    emit(ctx, { prompts: r.prompts.map((x) => ({ id: x.id, label: x.label, agent: x.agent, ...(x.hidden ? { hidden: true } : {}), ...(x.autopilot ? { autopilot: true } : {}) })), errors: r.errors }, () =>
      r.prompts.map((x) => `${x.id.padEnd(16)} ${ctx.lang === 'ja' ? x.label.ja : x.label.en}${x.agent !== 'default' ? `  (${x.agent})` : ''}`));
    return;
  }
  if (sub === 'show') {
    const { values, positionals } = opts(rest, { var: { type: 'string', multiple: true } }, { min: 1, max: 1, usage: 'solocut prompts show <id> [--var key=value]' });
    const prompt = loadPromptsWithErrors(projectDir, { includeHidden: true }).prompts.find((x) => x.id === positionals[0]);
    if (!prompt) throw new CliError('not-found', t(ctx, `プロンプトがありません: ${positionals[0]}`, `no such prompt: ${positionals[0]}`));
    for (const kv of values.var ?? []) {
      const i = kv.indexOf('=');
      if (i <= 0) throw new CliError('usage', `--var must be key=value: ${kv}`);
      vars[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = renderPrompt(prompt, vars, ctx.lang);
    emit(ctx, { prompt, text }, () => text);
    return;
  }
  throw new CliError('usage', 'usage: solocut prompts list [--all] | show <id> [--var key=value]');
}

const LIB_TOOLS: Record<string, ToolName[]> = {
  ffmpeg: ['ffmpeg', 'ffprobe'],
  whisper: ['whisper-cli', 'whisper-model'],
  'whisper-small': ['whisper-cli', 'whisper-model-small'],
  fonts: ['fonts'],
};

export async function cmdLib(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  ctx.lang = loadSettings().language;
  if (sub === 'list' || sub === undefined) {
    opts(rest, {}, { max: 0 });
    const status = await toolStatus();
    const manifest = Object.fromEntries(Object.entries(DEFAULT_MANIFEST.tools).map(([k, v]) => [k, { version: v.version, license: v.license, source: v.source }]));
    emit(ctx, { tools: status, manifest }, () =>
      Object.entries(status).map(([k, v]) => `${v.installed ? '✓' : '✗'} ${k.padEnd(20)} ${v.version ?? ''} ${v.source ? `(${v.source})` : ''}`));
    return;
  }
  if (sub === 'install') {
    const { positionals } = opts(rest, {}, { min: 1, usage: `solocut lib install ${Object.keys(LIB_TOOLS).join('|')}|all` });
    const names = positionals.includes('all') ? ['ffmpeg', 'whisper', 'fonts'] : positionals;
    const installed: Record<string, string> = {};
    for (const n of names) {
      const tools = LIB_TOOLS[n];
      if (!tools) throw new CliError('usage', `unknown library: ${n} (${Object.keys(LIB_TOOLS).join(', ')})`);
      for (const tool of tools) {
        const mb = (x: number) => (x / 1e6).toFixed(1);
        const path = await ensureTool(tool, {
          onProgress: ({ received, total }) => progress(ctx, `lib:${tool}`, total ? received / total : 0, total ? `${tool} ${mb(received)}/${mb(total)} MB` : `${tool} ${mb(received)} MB`, { tool, received, ...(total ? { total } : {}) }),
        });
        progressDone(ctx, `lib:${tool}`);
        installed[tool] = path;
      }
    }
    emit(ctx, { installed }, () => Object.entries(installed).map(([k, v]) => `✓ ${k}  ${v}`));
    return;
  }
  throw new CliError('usage', 'usage: solocut lib list | install ffmpeg|whisper|whisper-small|fonts|all');
}

/** `solocut templates`: list usable templates (helper for the app and agents). */
export async function cmdTemplates(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  ctx.lang = loadSettings().language;
  const r = listTemplatesWithErrors();
  emit(ctx, {
    templates: r.templates.map((x) => ({ id: x.id, version: x.version, name: x.name, kind: x.kind, targets: x.targets, canvas: x.canvas, dir: x.dir, ...(x.description ? { description: x.description } : {}) })),
    errors: r.errors.map((e) => e.message),
  }, () => r.templates.map((x) => `${x.id.padEnd(18)} ${ctx.lang === 'ja' ? x.name.ja : x.name.en}`));
}

