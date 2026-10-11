// Project folder operations for the workspace: recent list, snapshot (status / next / timeline overview /
// preview), review decisions and file watching. Mutations go through the solocut CLI.
import { app } from 'electron';
import { existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CliResult, ProjectInfo, ProjectSnapshot, RecentProject, ReviewItem, Variant } from '../../shared/types';
import { isUnknownOpError, parseNext, parseSteps, previewCandidates, reviewOps, stepsForVariant, timelineOverview, variantArgs, variantTimelinePath } from '../../shared/project';
import { mediaUrl } from '../../shared/ipc';
import { runCli } from './cli';
import { allowMediaRoot } from './media-protocol';

const RECENT_MAX = 20;

function recentFile(): string {
  return join(app.getPath('userData'), 'recent-projects.json');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, 'solocut.json'));
}

export function readProject(dir: string): ProjectInfo {
  const j = readJson(join(dir, 'solocut.json'));
  const o = typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : {};
  const info: ProjectInfo = { dir, title: typeof o.title === 'string' ? o.title : basename(dir) };
  if (typeof o.id === 'string') info.id = o.id;
  const t = o.template as { id?: unknown; version?: unknown } | undefined;
  if (t && typeof t.id === 'string') info.template = { id: t.id, version: String(t.version ?? '1') };
  if (o.language === 'ja' || o.language === 'en') info.language = o.language;
  return info;
}

export function recentProjects(): RecentProject[] {
  const j = readJson(recentFile());
  const list = Array.isArray(j) ? (j as RecentProject[]) : [];
  return list
    .filter((r) => r && typeof r.dir === 'string')
    .map((r) => ({ dir: r.dir, title: String(r.title ?? basename(r.dir)), openedAt: String(r.openedAt ?? ''), exists: isProjectDir(r.dir) }));
}

export function touchRecent(p: ProjectInfo): void {
  const list = recentProjects().filter((r) => r.dir !== p.dir);
  list.unshift({ dir: p.dir, title: p.title, openedAt: new Date().toISOString(), exists: true });
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(recentFile(), JSON.stringify(list.slice(0, RECENT_MAX), null, 2));
}

export function openProject(dir: string): ProjectInfo {
  if (!isProjectDir(dir)) throw new Error(`solocut.json not found in ${dir}`);
  const p = readProject(dir);
  allowMediaRoot(dir);
  touchRecent(p);
  return p;
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return s.length > 0 && s !== '.' && s !== '..' ? s : `video-${Date.now()}`;
}

export async function createProject(o: { parentDir: string; title: string; template: string; language: 'ja' | 'en' }): Promise<CliResult<ProjectInfo>> {
  let dir = join(o.parentDir, slugify(o.title));
  for (let i = 2; existsSync(dir); i++) dir = join(o.parentDir, `${slugify(o.title)}-${i}`);
  mkdirSync(dir, { recursive: true });
  const r = await runCli(['init', '--template', o.template, '--title', o.title, '--lang', o.language], { cwd: dir });
  if (!r.ok || !isProjectDir(dir)) return { ...r, ok: false, data: undefined, error: r.error ?? 'solocut init did not create solocut.json' };
  return { ...r, data: openProject(dir) };
}

/** Newest playable render of a variant: its preview first, else (main only) the newest video under renders/. */
export function latestRender(dir: string, variant: Variant = 'main'): { path: string; mtimeMs: number } | null {
  for (const rel of previewCandidates(variant)) {
    const p = join(dir, rel);
    if (existsSync(p)) return { path: p, mtimeMs: statSync(p).mtimeMs };
  }
  const root = variant === 'main' ? join(dir, 'renders') : join(dir, 'renders', variant);
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (d: string, depth: number) => {
    if (depth > 2 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      // the main video never picks up a vertical variant's render
      if (e.isDirectory()) {
        if (variant === 'main' && (e.name === 'tiktok' || e.name === 'youtube-shorts' || e.name === 'thumbnails')) continue;
        walk(p, depth + 1);
      } else if (/\.(mp4|mov|webm)$/i.test(e.name) && !e.name.endsWith('.part')) {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: p, mtimeMs: m };
      }
    }
  };
  walk(root, 0);
  return best;
}

export function availableVariants(dir: string): Variant[] {
  const out: Variant[] = ['main'];
  for (const v of ['tiktok', 'youtube-shorts'] as const) if (existsSync(join(dir, variantTimelinePath(v)))) out.push(v);
  return out;
}

export async function snapshot(dir: string, variant: Variant = 'main'): Promise<ProjectSnapshot> {
  const errors: string[] = [];
  const project = readProject(dir);
  allowMediaRoot(dir);

  // `status --json` carries the steps of every variant and the next step (CONTRACTS.md)
  const status = await runCli(['status'], { cwd: dir, timeoutMs: 30_000 });
  let all = status.ok ? parseSteps(status.data) : [];
  if (all.length === 0) all = parseSteps(readJson(join(dir, '.solocut', 'status.json')));
  if (!status.ok && status.error) errors.push(`status: ${status.error}`);
  const sd = status.data as { timelineError?: unknown } | undefined;
  if (status.ok && typeof sd?.timelineError === 'string') errors.push(`timeline.json: ${sd.timelineError}`);

  const snap: ProjectSnapshot = { project, variant, variants: availableVariants(dir), steps: stepsForVariant(all, variant), errors };
  const n = status.ok ? parseNext(status.data) : undefined;
  if (n) snap.next = n;

  const tlPath = join(dir, variantTimelinePath(variant));
  if (existsSync(tlPath)) {
    const t = readJson(tlPath);
    if (t === undefined) errors.push(`${variantTimelinePath(variant)}: invalid JSON`);
    else {
      snap.overview = timelineOverview(t);
      const derived = (t as { meta?: { derivedFrom?: { mainHash?: unknown } } }).meta?.derivedFrom;
      const flag = (t as { meta?: { stale?: unknown } }).meta?.stale;
      if (derived && flag === true) snap.stale = true;
    }
  }
  const r = latestRender(dir, variant);
  if (r) snap.preview = { path: r.path, mtimeMs: r.mtimeMs, url: mediaUrl(r.path, r.mtimeMs) };
  return snap;
}

export async function applyOps(dir: string, ops: unknown[], variant: Variant = 'main'): Promise<CliResult> {
  if (ops.length === 0) return { ok: false, code: null, stdout: '', stderr: '', error: 'nothing to change' };
  const file = join(tmpdir(), `solocut-ops-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(ops));
  try {
    return await runCli(['edit', '--ops', file, '--by', 'human', ...variantArgs(variant)], { cwd: dir });
  } finally {
    await fsp.rm(file, { force: true });
  }
}

export async function review(dir: string, item: ReviewItem, decision: 'accept' | 'reject', variant: Variant = 'main'): Promise<CliResult> {
  const t = readJson(join(dir, variantTimelinePath(variant)));
  const r = await applyOps(dir, reviewOps(t, item, decision, 'setDecided'), variant);
  if (!r.ok && isUnknownOpError(r.data ?? r.error)) return applyOps(dir, reviewOps(t, item, decision, 'legacy'), variant);
  return r;
}

export async function useAsReference(dir: string, archiveId: string): Promise<CliResult> {
  const t = readJson(join(dir, 'timeline.json')) as { meta?: { references?: unknown[] } } | undefined;
  const refs = Array.isArray(t?.meta?.references) ? [...t!.meta!.references!] : [];
  if (!refs.some((r) => typeof r === 'object' && r !== null && (r as { archive?: unknown }).archive === archiveId)) {
    refs.push({ archive: archiveId, use: ['pacing', 'scenes', 'captions', 'sfx'] });
  }
  return applyOps(dir, [{ op: 'setMeta', patch: { references: refs } }]);
}

export function readScript(dir: string): string | null {
  const p = join(dir, 'script.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ---------- watching ----------

export type ChangeKind = 'timeline' | 'status' | 'renders' | 'project';

export class ProjectWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<ChangeKind, NodeJS.Timeout>();
  private dir: string | null = null;

  constructor(private onChange: (dir: string, what: ChangeKind) => void, private debounceMs = 300) {}

  watch(dir: string | null): void {
    if (dir === this.dir) return;
    this.close();
    this.dir = dir;
    if (!dir) return;
    const add = (path: string, fn: (name: string | null) => ChangeKind | null, recursive = false) => {
      if (!existsSync(path)) return;
      try {
        // recursive watching is native on macOS / Windows; on Linux it falls back to the top level only
        const w = watch(path, { persistent: false, recursive: recursive && process.platform !== 'linux' }, (_e, name) => {
          const kind = fn(name ? String(name) : null);
          if (kind) this.fire(kind);
        });
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        /* unsupported fs */
      }
    };
    add(dir, (name) => (name === 'timeline.json' ? 'timeline' : name === 'solocut.json' ? 'project' : null));
    mkdirSync(join(dir, '.solocut'), { recursive: true });
    add(join(dir, '.solocut'), (name) => (name === 'status.json' || name === 'history.jsonl' ? 'status' : null));
    mkdirSync(join(dir, 'renders'), { recursive: true });
    add(join(dir, 'renders'), () => 'renders', true);
    // variants/<target>/timeline.json (docs/18)
    mkdirSync(join(dir, 'variants'), { recursive: true });
    add(join(dir, 'variants'), (name) => (name && /timeline\.json$/.test(name) ? 'timeline' : null), true);
  }

  private fire(kind: ChangeKind): void {
    const dir = this.dir;
    if (!dir) return;
    const prev = this.timers.get(kind);
    if (prev) clearTimeout(prev);
    this.timers.set(
      kind,
      setTimeout(() => {
        this.timers.delete(kind);
        if (this.dir === dir) this.onChange(dir, kind);
      }, this.debounceMs),
    );
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Variables for prompt templates (docs/13): project, template, targets, latestFeedback, latestCheck, date. */
export function promptVars(dir: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const vars: Record<string, string> = { date: new Date().toISOString().slice(0, 10) };
  if (dir && isProjectDir(dir)) {
    const p = readProject(dir);
    vars.project = p.title;
    if (p.template) vars.template = p.template.id;
    const t = readJson(join(dir, 'timeline.json')) as { meta?: { targets?: unknown } } | undefined;
    if (Array.isArray(t?.meta?.targets)) vars.targets = (t!.meta!.targets as unknown[]).map(String).join(', ');
    const fb = newestChild(join(dir, 'feedback'), 'feedback.md');
    if (fb) vars.latestFeedback = fb;
    const ck = newestChild(join(dir, 'checks'), 'report.md');
    if (ck) vars.latestCheck = ck;
  }
  return { ...vars, ...extra };
}

function newestChild(root: string, file: string): string | null {
  if (!existsSync(root)) return null;
  let best: { p: string; m: number } | null = null;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name, file);
    if (!existsSync(p)) continue;
    const m = statSync(p).mtimeMs;
    if (!best || m > best.m) best = { p, m };
  }
  return best ? best.p.slice(root.length - basename(root).length) : null;
}
