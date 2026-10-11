// Custom auto-updater (no electron-updater / Squirrel): checks latest.json, verifies the Ed25519-signed SHA256SUMS,
// downloads and hashes the file, and swaps it in when the app quits.
//
// Robustness ported from Ferret src/main/autoUpdate.ts / autoUpdateInstall.ts / updateDownload.ts (MIT):
// - scheduling lives in loop.ts (first-check delay, interval, wake-from-sleep delay, network backoff, busy postpone)
// - small documents are read with a byte limit (bounded.ts); the download must match the signed size and sha256
// - the file name must carry the offered version (a signed sums file cannot be replayed for another release)
// - a verified download survives a restart (userData/updates/ready.json) and is re-hashed before it is used, and
//   again synchronously right before the swap on quit (the file may have changed on disk since)
// - stale downloads (older versions, partial files) are removed at startup and after each download
// - installs on quit only when background updates are on or the user pressed "restart to update", never while a
//   recording or render is running
import { app, net } from 'electron';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, promises as fsp, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { UpdateState } from '../../shared/types';
import { readBoundedBytes, readBoundedJson, ResponseTooLargeError } from './bounded';
import { RELEASE_PUBLIC_KEY_PEM, UPDATE_BASE_URL } from './key';
import {
  MANIFEST_MAX_BYTES,
  READY_FILE,
  SIG_MAX_BYTES,
  STALE_CHECK_MS,
  SUMS_MAX_BYTES,
  UpdateError,
  appBundleOf,
  archOf,
  classifyUpdateError,
  expectedHash,
  fileMatchesVersion,
  isNewer,
  osOf,
  parseManifest,
  parseReadyRecord,
  parseSums,
  selectFile,
  staleUpdateEntries,
  verifySignature,
  type InstallFlavor,
  type ManifestFile,
  type ReadyRecord,
} from './logic';
import { UpdateLoop, type CheckOutcome } from './loop';

interface Ready {
  version: string;
  flavor: InstallFlavor;
  file: string;
  sha256: string;
}

export interface UpdaterDeps {
  onState: (s: UpdateState) => void;
  /** recording / rendering: do not check in the background, do not apply */
  isBusy: () => boolean;
  log: (msg: string) => void;
  /** unexpected failures (not network) go to Sentry */
  report?: (err: unknown, op: string) => void;
  // test seams (defaults: the real app)
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  userData?: string;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  packaged?: boolean;
  baseUrl?: string;
  publicKeyPem?: string;
  env?: Record<string, string | undefined>;
  spawn?: typeof nodeSpawn;
  quit?: () => void;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  now?: () => number;
}

export class Updater {
  private state: UpdateState;
  private ready: Ready | null = null;
  private relaunch = false;
  private autoInstall = false;
  private loop: UpdateLoop | null = null;
  private applied = false;

  constructor(private deps: UpdaterDeps) {
    this.state = { status: 'idle', current: this.version() };
  }

  private version(): string {
    return this.deps.version ?? app.getVersion();
  }
  private userData(): string {
    return this.deps.userData ?? app.getPath('userData');
  }
  private updatesDir(): string {
    return join(this.userData(), 'updates');
  }
  private base(): string {
    return this.deps.baseUrl ?? UPDATE_BASE_URL;
  }
  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }
  private env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  getState(): UpdateState {
    return this.state;
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.state.installOnQuit = this.willInstallOnQuit();
    this.deps.onState(this.state);
  }

  /**
   * Restores a verified download from an earlier run, cleans stale downloads and starts the schedule.
   * `enabled` = settings updates.auto: background checks and install-on-quit. The user's check works either way.
   */
  start(enabled: boolean): void {
    const packaged = this.deps.packaged ?? app.isPackaged;
    this.autoInstall = enabled && packaged;
    void this.restoreReady().finally(() => {
      this.loop = new UpdateLoop({
        enabled: this.autoInstall,
        run: () => this.runCheck(),
        isBusy: this.deps.isBusy,
        onSchedule: (at) => this.set({ nextCheckAt: at ?? undefined }),
        timers: this.deps.timers,
        now: this.deps.now,
      });
      this.loop.start();
    });
  }

  stop(): void {
    this.loop?.stop();
  }

  /** powerMonitor 'resume' */
  resumed(): void {
    this.loop?.resumed();
  }

  /** a window got focus: check when the last check is old (sleep may have delayed the interval) */
  windowActivated(): void {
    void this.loop?.checkIfStale(STALE_CHECK_MS);
  }

  flavor(): InstallFlavor | null {
    switch (this.platform()) {
      case 'darwin':
        return 'mac-zip';
      case 'win32':
        return 'win-nsis';
      case 'linux':
        return this.env().APPIMAGE?.startsWith('/') ? 'linux-appimage' : 'linux-deb';
      default:
        return null;
    }
  }

  /** the user's "check for updates" (also used by the schedule through runCheck) */
  async check(): Promise<UpdateState> {
    if (this.loop) await this.loop.checkNow();
    else await this.runCheck();
    return this.state;
  }

  private willInstallOnQuit(): boolean {
    return this.ready !== null && !this.applied && (this.autoInstall || this.relaunch);
  }

  private async runCheck(): Promise<CheckOutcome> {
    try {
      this.set({ status: 'checking', error: undefined, errorKind: undefined });
      await this.checkOnce();
      this.set({ lastCheckedAt: this.now() });
      return 'ok';
    } catch (e) {
      const kind = classifyUpdateError(e);
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.log(`update check failed (${kind}): ${msg}`);
      if (kind !== 'network') this.deps.report?.(e, `update check (${kind})`);
      this.set({ status: 'error', error: msg, errorKind: kind, lastCheckedAt: this.now(), progress: undefined });
      return kind === 'network' ? 'network-error' : 'error';
    }
  }

  private async checkOnce(): Promise<void> {
    const os = osOf(this.platform());
    const arch = archOf(this.deps.arch ?? process.arch);
    const flavor = this.flavor();
    if (!os || !arch || !flavor) throw new UpdateError('unsupported', `unsupported platform ${this.platform()}/${this.deps.arch ?? process.arch}`);

    const manifest = parseManifest(await this.json(`${this.base()}/latest.json`));
    if (!isNewer(manifest.version, this.version())) {
      this.set({ status: 'up-to-date', latest: manifest.version, progress: undefined });
      return;
    }
    if (this.ready?.version === manifest.version) {
      this.set({ status: 'ready', latest: manifest.version, notes: manifest.notes, progress: 1 });
      return;
    }
    this.set({ status: 'available', latest: manifest.version, notes: manifest.notes });
    if (flavor === 'linux-deb') {
      this.set({ status: 'notify-only' });
      return;
    }
    const file = selectFile(manifest, os, arch, flavor);
    if (!file) throw new UpdateError('unsupported', `no ${flavor} file for ${os}/${arch} in ${manifest.version}`);
    if (!fileMatchesVersion(file, manifest.version)) throw new UpdateError('verify', `${file.name} is not a ${manifest.version} file`);

    const base = `${this.base()}/releases/${encodeURIComponent(manifest.version)}`;
    const [sumsBuf, sigBuf] = await Promise.all([this.bytes(`${base}/SHA256SUMS`, SUMS_MAX_BYTES), this.bytes(`${base}/SHA256SUMS.sig`, SIG_MAX_BYTES)]);
    if (!verifySignature(sumsBuf, sigBuf, this.deps.publicKeyPem ?? RELEASE_PUBLIC_KEY_PEM)) throw new UpdateError('verify', 'SHA256SUMS signature is invalid');
    let hash: string;
    try {
      hash = expectedHash(file, parseSums(sumsBuf.toString('utf8')));
    } catch (e) {
      throw new UpdateError('verify', e instanceof Error ? e.message : String(e));
    }

    const path = await this.download(manifest.version, file, hash);
    this.ready = { version: manifest.version, flavor, file: path, sha256: hash };
    await this.saveReady({ version: manifest.version, flavor, name: file.name, sha256: hash });
    this.set({ status: 'ready', progress: 1 });
  }

  private async get(url: string): Promise<Response> {
    const f = this.deps.fetch ?? ((u: string, i?: RequestInit) => net.fetch(u, i));
    const r = await f(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      throw new UpdateError(r.status >= 500 || r.status === 429 ? 'network' : 'http', `${new URL(url).pathname}: HTTP ${r.status}`);
    }
    return r;
  }

  private async json(url: string): Promise<unknown> {
    try {
      return await readBoundedJson(await this.get(url), MANIFEST_MAX_BYTES);
    } catch (e) {
      if (e instanceof ResponseTooLargeError) throw new UpdateError('too-large', `latest.json: ${e.message}`);
      if (e instanceof SyntaxError) throw new UpdateError('http', 'latest.json is not JSON');
      throw e;
    }
  }

  private async bytes(url: string, max: number): Promise<Buffer> {
    try {
      return await readBoundedBytes(await this.get(url), max);
    } catch (e) {
      if (e instanceof ResponseTooLargeError) throw new UpdateError('too-large', `${new URL(url).pathname}: ${e.message}`);
      throw e;
    }
  }

  private async download(version: string, file: ManifestFile, hash: string): Promise<string> {
    const dir = join(this.updatesDir(), version);
    await fsp.mkdir(dir, { recursive: true });
    await this.cleanStale(version);
    const dest = join(dir, file.name);
    if (existsSync(dest) && (await hashFile(dest)) === hash) return dest;

    this.set({ status: 'downloading', progress: 0 });
    const r = await this.get(`${this.base()}/${file.path}`);
    if (!r.body) throw new UpdateError('http', `${file.name}: empty body`);
    const declared = Number(r.headers.get('content-length') ?? NaN);
    // the manifest's size is not signed, but a mismatch with the server's length means a broken or swapped file
    if (file.size > 0 && Number.isFinite(declared) && declared !== file.size) {
      await r.body.cancel().catch(() => undefined);
      throw new UpdateError('verify', `${file.name}: size differs from the manifest`);
    }
    const total = file.size > 0 ? file.size : Number.isFinite(declared) ? declared : 0;
    const part = `${dest}.part`;
    const h = createHash('sha256');
    let received = 0;
    let lastReport = 0;
    const out = await fsp.open(part, 'w', flavorMode(file));
    let ok = false;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0 && received > total) {
          await reader.cancel().catch(() => undefined);
          throw new UpdateError('verify', `${file.name}: larger than the manifest says`);
        }
        h.update(value);
        await out.write(value);
        const now = Date.now();
        if (total > 0 && now - lastReport > 500) {
          lastReport = now;
          this.set({ progress: received / total });
        }
      }
      await out.close();
      if (h.digest('hex') !== hash) throw new UpdateError('verify', `${file.name}: sha256 mismatch`);
      await fsp.rename(part, dest);
      ok = true;
    } finally {
      if (!ok) {
        await out.close().catch(() => undefined);
        await fsp.rm(part, { force: true });
      }
    }
    return dest;
  }

  /** removes old version folders, partial files and a ready record of another version */
  private async cleanStale(keepVersion: string | null): Promise<void> {
    const root = this.updatesDir();
    const entries = await fsp.readdir(root).catch(() => [] as string[]);
    for (const e of staleUpdateEntries(entries, keepVersion)) await fsp.rm(join(root, e), { recursive: true, force: true }).catch(() => undefined);
  }

  private async saveReady(r: ReadyRecord): Promise<void> {
    await fsp.writeFile(join(this.updatesDir(), READY_FILE), JSON.stringify(r), 'utf8').catch((e) => this.deps.log(`update: cannot save ready state: ${String(e)}`));
  }

  /** a download verified in an earlier run, re-hashed now. Anything else in updates/ is removed. */
  private async restoreReady(): Promise<void> {
    let record: ReadyRecord | null = null;
    try {
      record = parseReadyRecord(JSON.parse(await fsp.readFile(join(this.updatesDir(), READY_FILE), 'utf8')));
    } catch {
      // nothing saved (usual)
    }
    const usable = record && isNewer(record.version, this.version()) && record.flavor === this.flavor() ? record : null;
    await this.cleanStale(usable?.version ?? null);
    if (!usable) return;
    const file = join(this.updatesDir(), usable.version, usable.name);
    if ((await hashFile(file)) !== usable.sha256) {
      await this.cleanStale(null);
      return;
    }
    this.ready = { version: usable.version, flavor: usable.flavor, file, sha256: usable.sha256 };
    this.set({ status: 'ready', latest: usable.version, progress: 1 });
  }

  /** "Restart" pill: quit now; the will-quit hook applies the update and relaunches. Not while recording. */
  restartToUpdate(): void {
    if (!this.ready) return;
    if (this.deps.isBusy()) {
      this.set({ blockedBy: 'busy' });
      return;
    }
    this.relaunch = true;
    this.set({ blockedBy: undefined });
    (this.deps.quit ?? (() => app.quit()))();
  }

  /**
   * Called from app 'will-quit'. Starts the detached swap if an update is ready, background updates are on (or the
   * user pressed restart), nothing is recording, and the file still has the verified hash. Returns whether it started.
   */
  applyOnQuit(): boolean {
    const ready = this.ready;
    if (!ready || this.applied || this.deps.isBusy() || !(this.autoInstall || this.relaunch)) return false;
    if (hashFileSync(ready.file) !== ready.sha256) {
      this.deps.log('update apply skipped: the downloaded file changed on disk');
      this.deps.report?.(new UpdateError('verify', 'update file changed before install'), 'update apply');
      this.ready = null;
      return false;
    }
    this.applied = true;
    try {
      const spawn = this.deps.spawn ?? nodeSpawn;
      switch (ready.flavor) {
        case 'mac-zip':
          this.applyMac(ready, spawn);
          break;
        case 'win-nsis':
          spawn(ready.file, ['/S', '--updated', ...(this.relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
          break;
        case 'linux-appimage':
          this.applyAppImage(ready, spawn);
          break;
        case 'linux-deb':
          return false;
      }
      return true;
    } catch (e) {
      this.deps.log(`update apply failed: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.report?.(e, `update apply (${ready.flavor})`);
      return false;
    }
  }

  private applyMac(r: Ready, spawn: typeof nodeSpawn): void {
    const bundle = appBundleOf(process.execPath);
    if (!bundle) throw new Error('not running from an .app bundle');
    const work = join(tmpdir(), `solocut-update-${r.version}-${process.pid}`);
    const script = join(tmpdir(), `solocut-update-${process.pid}.sh`);
    // ditto -x -k runs inside the detached script so quitting is not delayed
    const body = `#!/bin/sh
PID="$1"; ZIP="$2"; WORK="$3"; OLD="$4"; RELAUNCH="$5"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
rm -rf "$WORK"; mkdir -p "$WORK"
if ! /usr/bin/ditto -x -k "$ZIP" "$WORK"; then exit 1; fi
NEW="$(/usr/bin/find "$WORK" -maxdepth 1 -name '*.app' -type d | head -n 1)"
[ -n "$NEW" ] || exit 1
BAK="$OLD.solocut-old"
rm -rf "$BAK"
if /bin/mv "$OLD" "$BAK" && /usr/bin/ditto "$NEW" "$OLD"; then
  rm -rf "$BAK"
  /usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
else
  rm -rf "$OLD"; /bin/mv "$BAK" "$OLD"
fi
rm -rf "$WORK"
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$OLD"
rm -f "$0"
`;
    writeFileSync(script, body, { mode: 0o755 });
    spawn('/bin/sh', [script, String(process.pid), r.file, work, bundle, this.relaunch ? '1' : '0'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  private applyAppImage(r: Ready, spawn: typeof nodeSpawn): void {
    const target = this.env().APPIMAGE;
    if (!target?.startsWith('/')) return;
    const script = join(tmpdir(), `solocut-update-${process.pid}.sh`);
    const body = `#!/bin/sh
PID="$1"; NEW="$2"; OLD="$3"; RELAUNCH="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
cp "$NEW" "$OLD.new" && chmod +x "$OLD.new" && mv -f "$OLD.new" "$OLD"
[ "$RELAUNCH" = "1" ] && nohup "$OLD" >/dev/null 2>&1 &
rm -f "$0"
`;
    writeFileSync(script, body, { mode: 0o755 });
    spawn('/bin/sh', [script, String(process.pid), r.file, target, this.relaunch ? '1' : '0'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

function flavorMode(file: ManifestFile): number {
  return file.name.endsWith('.AppImage') ? 0o755 : 0o644;
}

/** sha256 of a file, or null when it is missing / unreadable */
export async function hashFile(path: string): Promise<string | null> {
  try {
    if (!(await fsp.stat(path)).isFile()) return null;
    const h = createHash('sha256');
    await pipeline(createReadStream(path), h);
    return h.digest('hex');
  } catch {
    return null;
  }
}

/** the same, synchronously (will-quit cannot wait). Ferret src/main/autoUpdateInstall.ts hashFileSync. */
export function hashFileSync(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const h = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) h.update(chunk.subarray(0, n));
    return h.digest('hex');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
