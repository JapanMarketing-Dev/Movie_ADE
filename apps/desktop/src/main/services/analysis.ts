// Analysis producers (run after ingest): faces (MediaPipe) on camera sources and on-screen PII (tesseract.js OCR)
// on screen sources, in a hidden renderer window. Results go to derived/analysis/; PII becomes pixelate masks that
// need review. The engine reads these files for face / cursor-following zoom and vertical reframing.
import { BrowserWindow } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AnalysisJob, AnalysisJobState, AnalysisStatus } from '../../shared/types';
import { mediaUrl } from '../../shared/ipc';
import { piiMaskOps, type FacesFile, type PiiFile } from '../../shared/analysis';
import { allowMediaRoot } from './media-protocol';
import { MODELS, ensureModel, modelDir } from './models';
import { applyOps } from './project';

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

const FACE_FPS = 5;
const OCR_FPS = 1;

export interface AnalysisHost {
  emit(s: AnalysisStatus): void;
  createWindow(): BrowserWindow;
  rendererRoot(): string; // for packaged wasm / worker assets
  log(msg: string): void;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** derived/analysis/cursor.<takeId>.jsonl for every take that has a newer cursor.jsonl. */
export function copyCursorLogs(dir: string): number {
  const takes = join(dir, 'media', 'takes');
  if (!existsSync(takes)) return 0;
  let n = 0;
  for (const id of readdirSync(takes)) {
    const src = join(takes, id, 'cursor.jsonl');
    if (!existsSync(src)) continue;
    const dst = join(dir, 'derived', 'analysis', `cursor.${id}.jsonl`);
    if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    n++;
  }
  return n;
}

interface SourceLike {
  kind: string;
  path: string;
  fps?: { num: number; den: number };
  size?: { width: number; height: number };
}

/** Jobs for the sources in timeline.json: faces for cameras, OCR for screens. */
export type PlannedJob = Omit<AnalysisJob, 'url' | 'model' | 'langPath'> & { path: string };

export function planJobs(dir: string, timeline: unknown): PlannedJob[] {
  const sources = isObj(timeline) && isObj(timeline.sources) ? timeline.sources : {};
  const jobs: PlannedJob[] = [];
  for (const [id, raw] of Object.entries(sources)) {
    if (!isObj(raw)) continue;
    const s = raw as unknown as SourceLike;
    if (s.kind !== 'camera' && s.kind !== 'screen') continue;
    if (typeof s.path !== 'string') continue;
    const path = isAbsolute(s.path) ? s.path : resolve(dir, s.path);
    const fps = s.fps && s.fps.den ? s.fps.num / s.fps.den : 30;
    const kind = s.kind === 'camera' ? 'faces' : 'ocr';
    jobs.push({
      id: `${kind}:${id}`,
      kind,
      sourceId: id,
      path,
      sourceFps: fps,
      width: s.size?.width ?? 1920,
      height: s.size?.height ?? 1080,
      sampleFps: kind === 'faces' ? FACE_FPS : OCR_FPS,
      ...(kind === 'ocr' ? { langs: ['jpn', 'eng'] } : {}),
    });
  }
  return jobs;
}

const safeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, '_');

export class AnalysisRunner {
  private status: AnalysisStatus = { running: false, phase: 'idle', jobs: [] };
  private queue: AnalysisJob[] = [];
  private win: BrowserWindow | null = null;
  private abort: AbortController | null = null;

  constructor(private host: AnalysisHost) {}

  getStatus(): AnalysisStatus {
    return this.status;
  }

  private set(p: Partial<AnalysisStatus>): void {
    this.status = { ...this.status, ...p };
    this.host.emit(this.status);
  }

  private setJob(id: string, p: Partial<AnalysisJobState>): void {
    this.set({ jobs: this.status.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) });
  }

  async start(dir: string): Promise<AnalysisStatus> {
    if (this.status.running) return this.status;
    copyCursorLogs(dir);
    let timeline: unknown;
    try {
      timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
    } catch (e) {
      this.set({ running: false, phase: 'error', dir, jobs: [], message: `timeline.json: ${String(e)}` });
      return this.status;
    }
    const planned = planJobs(dir, timeline).filter((j) => existsSync(j.path));
    if (planned.length === 0) {
      this.set({ running: false, phase: 'done', dir, jobs: [], message: 'no camera or screen sources' });
      return this.status;
    }
    this.abort = new AbortController();
    this.set({
      running: true,
      dir,
      phase: 'models',
      masksAdded: 0,
      message: undefined,
      jobs: planned.map((j) => ({ id: j.id, kind: j.kind, sourceId: j.sourceId, state: 'queued', progress: 0 })),
    });
    void this.run(dir, planned);
    return this.status;
  }

  private async run(dir: string, planned: PlannedJob[]): Promise<void> {
    try {
      const signal = this.abort!.signal;
      const needFaces = planned.some((j) => j.kind === 'faces');
      const needOcr = planned.some((j) => j.kind === 'ocr');
      const models = [...(needFaces ? [MODELS.face] : []), ...(needOcr ? [MODELS.jpn, MODELS.eng] : [])];
      const total = models.reduce((s, m) => s + m.size, 0);
      let done = 0;
      let facePath = '';
      for (const m of models) {
        const p = await ensureModel(m, (rec) => this.set({ modelProgress: Math.min(1, (done + rec) / total) }), signal);
        done += m.size;
        if (m.id === 'face') facePath = p;
      }
      if (signal.aborted) return;
      allowMediaRoot(dir);
      allowMediaRoot(modelDir('tesseract'));
      allowMediaRoot(this.host.rendererRoot());
      const faceModel = facePath ? new Uint8Array(readFileSync(facePath)) : undefined;
      this.queue = planned.map((j) => {
        const { path, ...rest } = j;
        const job: AnalysisJob = { ...rest, url: mediaUrl(path) };
        if (j.kind === 'faces' && faceModel) job.model = faceModel;
        if (j.kind === 'ocr') job.langPath = mediaUrl(modelDir('tesseract'));
        return job;
      });
      this.set({ phase: 'analyzing', modelProgress: 1 });
      this.win = this.host.createWindow();
      this.win.on('closed', () => {
        this.win = null;
        if (this.status.running && this.status.phase === 'analyzing') this.finish(dir, 'error', 'analysis window closed');
      });
    } catch (e) {
      if (this.abort?.signal.aborted) return;
      this.finish(dir, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /** Called by the analysis window. */
  nextJob(): AnalysisJob | null {
    const job = this.queue.shift() ?? null;
    if (job) this.setJob(job.id, { state: 'running', progress: 0 });
    else if (this.status.running && this.status.phase === 'analyzing') void this.afterJobs();
    return job;
  }

  progress(jobId: string, fraction: number): void {
    this.setJob(jobId, { progress: Math.max(0, Math.min(1, fraction)) });
  }

  async result(jobId: string, data: unknown): Promise<void> {
    const dir = this.status.dir;
    const job = this.status.jobs.find((j) => j.id === jobId);
    if (!dir || !job) return;
    const out = join(dir, 'derived', 'analysis', `${job.kind === 'faces' ? 'faces' : 'pii'}.${safeId(job.sourceId)}.json`);
    writeAtomic(out, JSON.stringify(data) + '\n');
    this.setJob(jobId, { state: 'done', progress: 1 });
  }

  fail(jobId: string, error: string): void {
    this.host.log(`analysis ${jobId} failed: ${error}`);
    this.setJob(jobId, { state: 'failed', error });
  }

  private async afterJobs(): Promise<void> {
    const dir = this.status.dir!;
    this.set({ phase: 'masks' });
    let added = 0;
    try {
      const tl = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { masks?: { id?: string }[] };
      const existing = new Set((tl.masks ?? []).map((m) => String(m.id)));
      const ops: Record<string, unknown>[] = [];
      for (const j of this.status.jobs.filter((x) => x.kind === 'ocr' && x.state === 'done')) {
        const file = JSON.parse(readFileSync(join(dir, 'derived', 'analysis', `pii.${safeId(j.sourceId)}.json`), 'utf8')) as PiiFile;
        ops.push(...piiMaskOps(file, j.sourceId, existing));
      }
      if (ops.length > 0) {
        const r = await applyOps(dir, ops, 'main', 'agent');
        if (r.ok) added = ops.length;
        else this.host.log(`adding masks failed: ${r.error}`);
      }
    } catch (e) {
      this.host.log(`masks: ${String(e)}`);
    }
    this.set({ masksAdded: added });
    this.finish(dir, 'done');
  }

  private finish(dir: string, phase: AnalysisStatus['phase'], message?: string): void {
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
    this.queue = [];
    this.set({
      running: false,
      dir,
      phase,
      ...(message ? { message } : {}),
      jobs: this.status.jobs.map((j) => (j.state === 'queued' || j.state === 'running' ? { ...j, state: phase === 'cancelled' ? 'cancelled' : 'failed' } : j)),
    });
  }

  cancel(): AnalysisStatus {
    if (!this.status.running) return this.status;
    this.abort?.abort();
    this.finish(this.status.dir ?? '', 'cancelled');
    return this.status;
  }
}

export type { FacesFile, PiiFile };
