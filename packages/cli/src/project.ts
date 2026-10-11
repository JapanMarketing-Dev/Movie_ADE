import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { applyOps, validateTimeline, type Issue, type Op, type Timeline } from '@solocut/core';
import { initialStatus, loadTemplate, type StepId, type StepState, type Template } from '@solocut/templates';
import { CliError, type Ctx } from './ctx.js';

export interface ProjectFile {
  schema: 1;
  id: string;
  title: string;
  template: { id: string; version: string };
  language: 'ja' | 'en';
  created: string;
  tools?: Record<string, string>;
}

export interface Project { dir: string; file: ProjectFile }

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function readJsonFile<T>(path: string): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CliError('not-found', `file not found: ${path}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CliError('invalid-json', `${path}: ${(e as Error).message}`);
  }
}

/** Nearest ancestor (or self) with solocut.json. */
export function findProjectDir(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'solocut.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function openProject(ctx: Ctx): Project {
  const start = ctx.projectFlag ? resolve(ctx.io.cwd, ctx.projectFlag) : ctx.io.cwd;
  const dir = ctx.projectFlag ? (existsSync(join(start, 'solocut.json')) ? start : null) : findProjectDir(start);
  if (!dir) {
    throw new CliError('no-project', ctx.lang === 'ja'
      ? `solocut のプロジェクトが見つかりません（${start}）。\`solocut init --template <id>\` で作るか、--project で指定してください`
      : `no solocut project found from ${start}. Create one with \`solocut init --template <id>\` or pass --project`);
  }
  const file = readJsonFile<ProjectFile>(join(dir, 'solocut.json'));
  if (file.schema !== 1 || !file.template?.id) throw new CliError('invalid-project', `${join(dir, 'solocut.json')}: unsupported or incomplete`);
  if (file.language === 'ja' || file.language === 'en') ctx.lang = file.language;
  return { dir, file };
}

export const paths = (dir: string) => ({
  timeline: join(dir, 'timeline.json'),
  status: join(dir, '.solocut', 'status.json'),
  history: join(dir, '.solocut', 'history.jsonl'),
  decisions: join(dir, '.solocut', 'decisions.jsonl'),
  lock: join(dir, '.solocut', 'lock'),
  transcript: join(dir, 'derived', 'transcripts', 'main.json'),
  analysis: join(dir, 'derived', 'analysis'),
  cache: join(dir, 'derived', 'cache'),
  preview: join(dir, 'renders', 'preview.mp4'),
});

export function readTimelineRaw(dir: string): unknown {
  return readJsonFile(paths(dir).timeline);
}

export function readTimeline(dir: string): Timeline {
  const v = validateTimeline(readTimelineRaw(dir));
  if (!v.ok) {
    throw new CliError('invalid-timeline', `timeline.json is invalid (${v.issues.length} issue(s)); run \`solocut validate\``, v.issues);
  }
  return v.timeline;
}

export function writeTimeline(dir: string, t: Timeline): void {
  writeAtomic(paths(dir).timeline, JSON.stringify(t, null, 2) + '\n');
}

export function projectTemplate(p: Project): Template {
  return loadTemplate(p.file.template.id, { extraDirs: [join(p.dir, 'templates')] });
}

// ---------- status ----------

export function readStatus(p: Project, tpl?: Template): StepState[] {
  const f = paths(p.dir).status;
  let list: StepState[] = [];
  if (existsSync(f)) {
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown;
      if (Array.isArray(raw)) list = raw as StepState[];
    } catch {
      /* rebuilt below */
    }
  }
  if (tpl) {
    // keep the template's order; add missing steps as todo
    const byStep = new Map(list.map((s) => [s.step, s]));
    return initialStatus(tpl).map((s) => byStep.get(s.step) ?? s);
  }
  return list;
}

export function writeStatus(p: Project, list: StepState[]): void {
  writeAtomic(paths(p.dir).status, JSON.stringify(list, null, 2) + '\n');
}

export function setStep(p: Project, step: StepId, state: StepState['state'], note?: string): StepState[] {
  let tpl: Template | undefined;
  try {
    tpl = projectTemplate(p);
  } catch {
    tpl = undefined;
  }
  const list = readStatus(p, tpl);
  const entry: StepState = { step, state, at: new Date().toISOString(), ...(note ? { note } : {}) };
  const i = list.findIndex((s) => s.step === step);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  writeStatus(p, list);
  return list;
}

// ---------- lock ----------

/** Exclusive lock on the project's timeline (stale after 60 s). */
export async function withLock<T>(p: Project, fn: () => Promise<T> | T, timeoutMs = 10_000): Promise<T> {
  const f = paths(p.dir).lock;
  mkdirSync(dirname(f), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(f, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(f).mtimeMs > 60_000) {
          rmSync(f, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new CliError('locked', `the project is locked by another solocut process (${f})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(f, { force: true });
  }
}

// ---------- history ----------

export interface HistoryEntry {
  at: string;
  by: string;
  agent?: string;
  kind: 'edit' | 'undo' | 'redo';
  /** For undo/redo: line index (0-based) of the edit it reverts / re-applies. */
  ref?: number;
  ops: Op[];
  inverse: Op[];
  note?: string;
}

export function readHistory(p: Project): HistoryEntry[] {
  const f = paths(p.dir).history;
  if (!existsSync(f)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HistoryEntry;
      out.push({ ...e, kind: e.kind ?? 'edit' });
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

function appendHistory(p: Project, e: HistoryEntry): void {
  mkdirSync(dirname(paths(p.dir).history), { recursive: true });
  appendFileSync(paths(p.dir).history, JSON.stringify(e) + '\n');
}

/** Replay the log into undo / redo stacks of edit indexes. */
export function historyStacks(h: HistoryEntry[]): { undo: number[]; redo: number[] } {
  const undo: number[] = [];
  let redo: number[] = [];
  h.forEach((e, i) => {
    if (e.kind === 'edit') {
      undo.push(i);
      redo = [];
    } else if (e.kind === 'undo') {
      const top = undo.pop();
      if (top !== undefined) redo.push(top);
    } else if (e.kind === 'redo') {
      const top = redo.pop();
      if (top !== undefined) undo.push(top);
    }
  });
  return { undo, redo };
}

export interface EditResult { timeline: Timeline; inverse: Op[]; issues: Issue[]; changed: boolean }

/** Apply ops atomically: validate the result, write timeline.json, log the history line. Nothing changes on error. */
export async function applyEdit(
  p: Project,
  ops: Op[],
  o: { by: string; agent?: string; kind?: HistoryEntry['kind']; ref?: number; dryRun?: boolean; note?: string },
): Promise<EditResult> {
  return withLock(p, () => {
    const before = readTimeline(p.dir);
    let r: { timeline: Timeline; inverse: Op[] };
    try {
      r = applyOps(before, ops);
    } catch (e) {
      throw new CliError('op-failed', (e as Error).message);
    }
    const v = validateTimeline(r.timeline);
    if (!v.ok) throw new CliError('invalid-result', `the edit would make timeline.json invalid: ${v.issues.filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`).slice(0, 5).join('; ')}`, v.issues);
    const changed = JSON.stringify(before) !== JSON.stringify(v.timeline);
    if (!o.dryRun && changed) {
      writeTimeline(p.dir, v.timeline);
      appendHistory(p, {
        at: new Date().toISOString(), by: o.by, ...(o.agent ? { agent: o.agent } : {}), kind: o.kind ?? 'edit',
        ...(o.ref !== undefined ? { ref: o.ref } : {}), ops, inverse: r.inverse, ...(o.note ? { note: o.note } : {}),
      });
    }
    return { timeline: v.timeline, inverse: r.inverse, issues: v.issues, changed };
  });
}

// ---------- takes ----------

export function listDirs(d: string): string[] {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
