// The upload hand-off (docs/14): `solocut publish upload` writes .solocut/publish-request.json and waits; the app
// (which holds the OAuth tokens) uploads what publish.json says and writes .solocut/publish-result.json with the same
// id — first `state: running` (picked up, with progress), then `state: done`. Uploads are logged in
// .solocut/publish-log.json so the same file is never posted twice to a target (unless the request says force).
// No electron here: the uploaders and the `publish record` call are injected (tests use fakes).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  PUBLISH_FILE,
  PUBLISH_LOG_FILE,
  REQUEST_FILE,
  RESULT_FILE,
  alreadyPublished,
  issueBlocks,
  issueText,
  parsePublishJson,
  parsePublishLog,
  parsePublishRequest,
  parsePublishResult,
  requestIsStale,
  targetsToUpload,
  type PublishLogEntry,
  type PublishRequest,
  type PublishResult,
  type PublishSpec,
  type PublishTargetId,
  type PublishTargetResult,
} from '../../shared/publish';

export interface UploadContext {
  dir: string;
  spec: PublishSpec;
  videoPath: string;
  thumbnailPath?: string;
  onProgress: (phase: string, fraction?: number) => void;
}

export interface UploadOutcome {
  url?: string;
  status: 'published' | 'scheduled' | 'inbox';
  warnings: string[];
}

export type RecordStatus = 'published' | 'scheduled' | 'draft' | 'failed';

export interface HandoffDeps {
  upload: Record<PublishTargetId, (c: UploadContext) => Promise<UploadOutcome>>;
  /** `solocut publish record` (best effort; must not throw). */
  record?: (dir: string, target: PublishTargetId, status: RecordStatus, url?: string) => Promise<void>;
  now?: () => number;
  /** request / result files changed (the screen reloads) */
  onChange?: (dir: string) => void;
}

export type CheckOutcome = 'none' | 'invalid' | 'handled' | 'stale' | 'busy' | 'processed';

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

export function readRequest(dir: string): PublishRequest | null {
  return parsePublishRequest(readText(join(dir, REQUEST_FILE)));
}

export function readResult(dir: string): PublishResult | null {
  return parsePublishResult(readText(join(dir, RESULT_FILE)));
}

export function readLog(dir: string): PublishLogEntry[] {
  return parsePublishLog(readText(join(dir, PUBLISH_LOG_FILE)));
}

function appendLog(dir: string, e: PublishLogEntry): void {
  writeJsonAtomic(join(dir, PUBLISH_LOG_FILE), { entries: [...readLog(dir), e] });
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PublishHandoff {
  private busy = new Set<string>();
  private now: () => number;

  constructor(private deps: HandoffDeps) {
    this.now = deps.now ?? Date.now;
  }

  isBusy(dir: string): boolean {
    return this.busy.has(resolve(dir));
  }

  /**
   * Looks at the project's request and runs it when it is new. A request whose id already has a result (running
   * or done) is never run again; a request older than REQUEST_TTL_MS that was never picked up is ignored. After a
   * run, a request that arrived meanwhile is picked up.
   */
  async check(dir: string): Promise<CheckOutcome> {
    const key = resolve(dir);
    if (this.busy.has(key)) return 'busy';
    const text = readText(join(dir, REQUEST_FILE));
    if (text === null) return 'none';
    const req = parsePublishRequest(text);
    if (!req) return 'invalid';
    const prev = readResult(dir);
    if (prev && prev.id === req.id) {
      // "running" without a run in this process: the app quit mid-upload. Never resume blindly (a duplicate post
      // is worse than asking again); close it so the waiting CLI gets an answer.
      if (prev.state === 'running') {
        this.write(dir, { ...prev, state: 'done', at: new Date(this.now()).toISOString(), error: 'アップロードが中断されました。もう一度 `solocut publish upload` を実行してください / the upload was interrupted; run it again' });
      }
      return 'handled';
    }
    if (requestIsStale(req, this.now())) return 'stale';
    this.busy.add(key);
    try {
      await this.run(dir, req);
    } finally {
      this.busy.delete(key);
    }
    await this.check(dir);
    return 'processed';
  }

  private write(dir: string, r: PublishResult): void {
    writeJsonAtomic(join(dir, RESULT_FILE), r);
    this.deps.onChange?.(dir);
  }

  private async run(dir: string, req: PublishRequest): Promise<void> {
    const iso = () => new Date(this.now()).toISOString();
    const results: PublishTargetResult[] = [];
    const running = (progress?: PublishResult['progress']) =>
      this.write(dir, { id: req.id, state: 'running', at: iso(), ...(progress ? { progress } : {}), results: [...results] });
    const done = (error?: string) => this.write(dir, { id: req.id, state: 'done', at: iso(), results, ...(error ? { error } : {}) });
    running();

    const text = readText(join(dir, PUBLISH_FILE));
    if (text === null) return done('publish.json がありません / publish.json not found');
    const { spec, issues } = parsePublishJson(text, new Date(this.now()));
    if (!spec) return done(issues.map((i) => issueText(i)).join('; '));
    const targets = targetsToUpload(spec, req.targets);
    if (!targets.length) return done('publish.json で投稿先がオフです / no target is turned on in publish.json');

    const videoPath = resolve(dir, spec.video);
    const size = existsSync(videoPath) ? statSync(videoPath).size : -1;
    const thumbPath = spec.thumbnail ? resolve(dir, spec.thumbnail) : undefined;
    const thumbOk = thumbPath !== undefined && existsSync(thumbPath);

    for (const target of targets) {
      const blocking = issues.filter((i) => issueBlocks(i, target));
      if (blocking.length) {
        results.push({ target, ok: false, error: blocking.map((i) => issueText(i)).join('; ') });
        continue;
      }
      if (size <= 0) {
        results.push({ target, ok: false, error: `動画がありません / video not found: ${spec.video}` });
        continue;
      }
      const prior = alreadyPublished(readLog(dir), target, spec.video, size);
      if (prior && !req.force) {
        results.push({ target, ok: true, alreadyPublished: true, ...(prior.url ? { url: prior.url } : {}), ...(prior.status ? { status: prior.status } : {}) });
        continue;
      }
      let last = { phase: '', pct: -1 };
      running({ target, phase: 'start' });
      try {
        const out = await this.deps.upload[target]({
          dir,
          spec,
          videoPath,
          ...(thumbOk ? { thumbnailPath: thumbPath } : {}),
          onProgress: (phase, fraction) => {
            const pct = fraction === undefined ? -1 : Math.floor(fraction * 50); // every 2 %
            if (phase === last.phase && pct === last.pct) return;
            last = { phase, pct };
            running({ target, phase, ...(fraction !== undefined ? { fraction } : {}) });
          },
        });
        const warnings = [...out.warnings, ...(spec.thumbnail && !thumbOk && target === 'youtube' ? [`thumbnail not found: ${spec.thumbnail}`] : [])];
        results.push({ target, ok: true, status: out.status, ...(out.url ? { url: out.url } : {}), ...(warnings.length ? { warnings } : {}) });
        appendLog(dir, { target, video: spec.video, size, status: out.status, requestId: req.id, at: iso(), ...(out.url ? { url: out.url } : {}) });
        const recStatus: RecordStatus = out.status === 'inbox' ? 'draft' : out.url ? out.status : 'draft';
        await this.deps.record?.(dir, target, recStatus, out.url).catch(() => undefined);
      } catch (e) {
        results.push({ target, ok: false, error: msg(e) });
        await this.deps.record?.(dir, target, 'failed').catch(() => undefined);
      }
    }
    done();
  }
}

export type WatchWhat = 'request' | 'result' | 'spec' | 'thumbnails';

/**
 * Watches projects for the hand-off files, publish.json and thumbnails/. fs.watch is not reliable everywhere
 * (network drives, a .solocut folder created later), so the request file is also polled.
 */
export class PublishWatcher {
  private watchers: FSWatcher[] = [];
  private dirs: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastReq = new Map<string, number>();

  constructor(private onEvent: (dir: string, what: WatchWhat) => void, private pollMs = 2000) {}

  watch(dirs: string[]): void {
    const next = [...new Set(dirs.filter(Boolean).map((d) => resolve(d)))];
    if (next.join('\n') === this.dirs.join('\n')) return;
    this.close();
    this.dirs = next;
    for (const dir of next) {
      this.add(dir, dir, (n) => (n === PUBLISH_FILE ? 'spec' : null));
      try {
        mkdirSync(join(dir, '.solocut'), { recursive: true });
      } catch {
        /* read-only folder: polling only */
      }
      this.add(dir, join(dir, '.solocut'), (n) => (n === 'publish-request.json' ? 'request' : n === 'publish-result.json' ? 'result' : null));
      this.add(dir, join(dir, 'thumbnails'), () => 'thumbnails');
      this.lastReq.set(dir, this.mtime(dir));
      // a request written while the app was closed (and still fresh) is picked up now
      if (existsSync(join(dir, REQUEST_FILE))) this.onEvent(dir, 'request');
    }
    if (next.length) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  private mtime(dir: string): number {
    try {
      return statSync(join(dir, REQUEST_FILE)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private poll(): void {
    for (const dir of this.dirs) {
      const m = this.mtime(dir);
      if (m && m !== this.lastReq.get(dir)) {
        this.lastReq.set(dir, m);
        this.onEvent(dir, 'request');
      }
    }
  }

  private add(dir: string, path: string, fn: (name: string | null) => WatchWhat | null): void {
    if (!existsSync(path)) return;
    try {
      const w = watch(path, { persistent: false }, (_e, name) => {
        const what = fn(name ? String(name) : null);
        if (!what) return;
        if (what === 'request') this.lastReq.set(dir, this.mtime(dir));
        this.onEvent(dir, what);
      });
      w.on('error', () => undefined);
      this.watchers.push(w);
    } catch {
      /* unsupported fs: polling still works for requests */
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.dirs = [];
  }
}
