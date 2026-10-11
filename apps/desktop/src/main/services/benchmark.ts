// Reference videos ("お手本動画", docs/09), file side: saved profiles in ~/.solocut/benchmarks, which one is applied
// (every video: benchmarks/applied.json; one video: <project>/.solocut/benchmark.json), temp recordings of the
// reference window (deleted after analysis) and the `solocut bench analyze|apply` calls. No Electron here.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { solocutHome } from '@solocut/toolchain';
import {
  benchEntry, normalizeRange, parseBenchProgress,
  type BenchApplied, type BenchEntry, type BenchScope, type BenchState,
} from '../../shared/benchmark';
import type { BenchAnalyzeRequest } from '../../shared/ipc-bench';
import type { CliResult } from '../../shared/types';

export type RunCli = (args: string[], o: { cwd?: string; timeoutMs?: number; onLine?: (line: string, stream: 'stdout' | 'stderr') => void }) => Promise<CliResult>;

export function benchmarksDir(home = solocutHome()): string {
  return join(home, 'benchmarks');
}

const APPLIED = 'applied.json';

function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Profiles: benchmarks/<name>.json and benchmarks/<id>/profile.json (docs/09), newest first; other files are skipped. */
export function listProfiles(dir = benchmarksDir()): BenchEntry[] {
  if (!existsSync(dir)) return [];
  const out: BenchEntry[] = [];
  const add = (path: string, id?: string) => {
    let m: number;
    try {
      m = statSync(path).mtimeMs;
    } catch {
      return;
    }
    const e = benchEntry(readJson(path), path, m);
    if (e) out.push(id ? { ...e, id } : e);
  };
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    // bench analyze also writes <name>.samples.json next to the profile
    if (d.isFile() && d.name.endsWith('.json') && d.name !== APPLIED && !d.name.endsWith('.samples.json')) add(join(dir, d.name));
    else if (d.isDirectory() && existsSync(join(dir, d.name, 'profile.json'))) add(join(dir, d.name, 'profile.json'), d.name);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function parseApplied(v: unknown): BenchApplied | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.id !== 'string' || !o.id) return null;
  return { id: o.id, title: typeof o.title === 'string' && o.title ? o.title : o.id, at: typeof o.at === 'string' ? o.at : '' };
}

function appliedPath(scope: BenchScope, projectDir: string | undefined, dir: string): string | null {
  if (scope === 'global') return join(dir, APPLIED);
  return projectDir ? join(projectDir, '.solocut', 'benchmark.json') : null;
}

export function readApplied(scope: BenchScope, projectDir?: string, dir = benchmarksDir()): BenchApplied | null {
  const p = appliedPath(scope, projectDir, dir);
  if (!p) return null;
  const raw = readJson(p);
  // applied.json is { global: {...} } so it can grow; the project file is the record itself
  return parseApplied(scope === 'global' ? (raw as { global?: unknown } | undefined)?.global : raw);
}

export function writeApplied(scope: BenchScope, rec: BenchApplied, projectDir?: string, dir = benchmarksDir()): void {
  const p = appliedPath(scope, projectDir, dir);
  if (!p) throw new Error('a project is needed for this video’s reference');
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(scope === 'global' ? { global: rec } : rec, null, 2) + '\n');
}

/** Forget which reference is applied (the template override itself is removed by `bench unapply`). */
export function clearApplied(scope: BenchScope, projectDir?: string, dir = benchmarksDir()): void {
  const p = appliedPath(scope, projectDir, dir);
  if (!p || !existsSync(p)) return;
  if (scope === 'project') {
    unlinkSync(p);
    return;
  }
  const raw = readJson(p);
  const rest = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  delete rest.global;
  if (Object.keys(rest).length === 0) unlinkSync(p);
  else writeFileAtomic(p, JSON.stringify(rest, null, 2) + '\n');
}

export function benchState(projectDir?: string, dir = benchmarksDir()): BenchState {
  return { profiles: listProfiles(dir), applied: { global: readApplied('global', undefined, dir), project: projectDir ? readApplied('project', projectDir, dir) : null } };
}

// ---------- temp recordings ----------

const captures = new Map<string, { dir: string; file: string; bytes: number }>();

/** A private temp folder per recording (only the app reads it; removed after analysis). */
export function captureBegin(root = tmpdir()): { id: string } {
  const id = randomUUID();
  const dir = mkdtempSync(join(root, 'solocut-bench-'));
  captures.set(id, { dir, file: join(dir, 'reference.webm'), bytes: 0 });
  return { id };
}

function capture(id: unknown) {
  const c = typeof id === 'string' ? captures.get(id) : undefined;
  if (!c) throw new Error('unknown recording');
  return c;
}

export async function captureAppend(id: string, data: Uint8Array): Promise<number> {
  const c = capture(id);
  if (!(data instanceof Uint8Array)) throw new Error('bad chunk');
  await fsp.appendFile(c.file, data, { mode: 0o600 });
  c.bytes += data.byteLength;
  return c.bytes;
}

export function captureEnd(id: string): { bytes: number } {
  return { bytes: capture(id).bytes };
}

export function captureFile(id: string): string {
  return capture(id).file;
}

export function captureDiscard(id: string): void {
  const c = typeof id === 'string' ? captures.get(id) : undefined;
  if (!c) return;
  captures.delete(id);
  rmSync(c.dir, { recursive: true, force: true });
}

/** Test hook / app quit: remove every temp recording. */
export function discardAllCaptures(): void {
  for (const id of [...captures.keys()]) captureDiscard(id);
}

// ---------- CLI ----------

/** argv of `solocut bench analyze` for a request (the file is already resolved). */
export function analyzeArgs(file: string, req: Pick<BenchAnalyzeRequest, 'url' | 'range'>): string[] {
  const args = ['bench', 'analyze', file];
  if (req.url) args.push('--url', req.url);
  if (req.range) {
    const r = normalizeRange(req.range);
    args.push('--from', String(r.start), '--to', String(r.end));
  }
  return args;
}

/** The profile written by `bench analyze`: `profilePath` / `path` in its JSON, the profile inline or read from that file. */
export function entryFromAnalyze(data: unknown, readFile: (p: string) => unknown = readJson): BenchEntry | null {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (!d) return null;
  const path = typeof d.profilePath === 'string' ? d.profilePath : typeof d.path === 'string' ? d.path : null;
  if (!path || !isAbsolute(path)) return null;
  const profile = d.profile ?? readFile(path);
  let m = Date.now();
  try {
    m = statSync(path).mtimeMs;
  } catch {
    /* not on disk (tests) */
  }
  const e = benchEntry(profile, path, m);
  return e && typeof d.id === 'string' && d.id ? { ...e, id: d.id } : e;
}

export async function analyze(
  req: BenchAnalyzeRequest,
  run: RunCli,
  onProgress: (fraction: number, label: string) => void,
): Promise<{ ok: boolean; entry?: BenchEntry; error?: string }> {
  let file: string;
  try {
    if (req.captureId) file = captureFile(req.captureId);
    else if (req.file && isAbsolute(req.file) && existsSync(req.file) && statSync(req.file).isFile()) file = req.file;
    else return { ok: false, error: 'file not found' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const r = await run(analyzeArgs(file, req), {
      cwd: solocutHome(),
      timeoutMs: 60 * 60_000,
      onLine: (line, stream) => {
        if (stream !== 'stderr') return;
        const p = parseBenchProgress(line);
        if (p) onProgress(p.fraction, p.label);
      },
    });
    if (!r.ok) return { ok: false, error: r.error ?? 'bench analyze failed' };
    const entry = entryFromAnalyze(r.data);
    return entry ? { ok: true, entry } : { ok: false, error: 'bench analyze did not return a profile' };
  } finally {
    if (req.captureId) captureDiscard(req.captureId);
  }
}

/**
 * `solocut bench apply <profile> --template <id> [--global]`: inside the project for this video (project override),
 * `--global` for every video (user override in ~/.solocut/templates). Records what was applied.
 */
export async function apply(
  o: { id: string; scope: BenchScope; projectDir?: string; template: string },
  run: RunCli,
  dir = benchmarksDir(),
): Promise<{ ok: boolean; error?: string; state?: BenchState }> {
  const entry = listProfiles(dir).find((e) => e.id === o.id);
  if (!entry) return { ok: false, error: `no such reference: ${o.id}` };
  if (o.scope === 'project' && !o.projectDir) return { ok: false, error: 'open a video first' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.template)) return { ok: false, error: `invalid template id: ${o.template}` };
  const args = ['bench', 'apply', entry.profilePath, '--template', o.template, ...(o.scope === 'global' ? ['--global'] : [])];
  const r = await run(args, { cwd: o.scope === 'project' ? o.projectDir! : solocutHome(), timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: r.error ?? 'bench apply failed' };
  writeApplied(o.scope, { id: entry.id, title: entry.title, at: new Date().toISOString() }, o.projectDir, dir);
  return { ok: true, state: benchState(o.projectDir, dir) };
}

/** The `error.code` of a failed `--json` CLI call ({ ok: false, error: { code, message } }). */
export function cliErrorCode(data: unknown): string | undefined {
  const e = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** `solocut bench unapply [--global]`: stop using the reference for this video / for every video. */
export async function unapply(
  o: { scope: BenchScope; projectDir?: string; template: string },
  run: RunCli,
  dir = benchmarksDir(),
): Promise<{ ok: boolean; error?: string; state?: BenchState }> {
  if (o.scope === 'project' && !o.projectDir) return { ok: false, error: 'open a video first' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.template)) return { ok: false, error: `invalid template id: ${o.template}` };
  const args = ['bench', 'unapply', '--template', o.template, ...(o.scope === 'global' ? ['--global'] : [])];
  const r = await run(args, { cwd: o.scope === 'project' ? o.projectDir! : solocutHome(), timeoutMs: 60_000 });
  // nothing applied in that scope (removed by hand or by the agent): the app's record is stale, drop it too
  if (!r.ok && cliErrorCode(r.data) !== 'not-applied') return { ok: false, error: r.error ?? 'bench unapply failed' };
  clearApplied(o.scope, o.projectDir, dir);
  return { ok: true, state: benchState(o.projectDir, dir) };
}
