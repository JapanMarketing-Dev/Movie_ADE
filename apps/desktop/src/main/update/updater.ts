// Custom auto-updater (no electron-updater / Squirrel): checks latest.json, verifies the Ed25519-signed
// SHA256SUMS, downloads and hashes the file, and swaps it in when the app quits.
import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, promises as fsp, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateState } from '../../shared/types';
import { RELEASE_PUBLIC_KEY_PEM, UPDATE_BASE_URL } from './key';
import {
  CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  appBundleOf,
  archOf,
  expectedHash,
  isNewer,
  osOf,
  parseManifest,
  parseSums,
  selectFile,
  verifySignature,
  type InstallFlavor,
  type ManifestFile,
} from './logic';

interface Ready {
  version: string;
  flavor: InstallFlavor;
  file: string;
}

export interface UpdaterDeps {
  onState: (s: UpdateState) => void;
  isBusy: () => boolean; // recording / rendering: do not apply
  log: (msg: string) => void;
}

export class Updater {
  private state: UpdateState;
  private ready: Ready | null = null;
  private timer: NodeJS.Timeout | null = null;
  private relaunch = false;
  private checking = false;

  constructor(private deps: UpdaterDeps) {
    this.state = { status: 'idle', current: app.getVersion() };
  }

  getState(): UpdateState {
    return this.state;
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  start(enabled: boolean): void {
    if (!enabled || !app.isPackaged) return;
    setTimeout(() => void this.check(), CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  flavor(): InstallFlavor | null {
    switch (process.platform) {
      case 'darwin':
        return 'mac-zip';
      case 'win32':
        return 'win-nsis';
      case 'linux':
        return process.env.APPIMAGE ? 'linux-appimage' : 'linux-deb';
      default:
        return null;
    }
  }

  async check(): Promise<UpdateState> {
    if (this.checking || this.state.status === 'ready') return this.state;
    this.checking = true;
    try {
      this.set({ status: 'checking', error: undefined });
      const os = osOf(process.platform);
      const arch = archOf(process.arch);
      const flavor = this.flavor();
      if (!os || !arch || !flavor) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);

      const manifest = parseManifest(await this.json(`${UPDATE_BASE_URL}/latest.json`));
      if (!isNewer(manifest.version, app.getVersion())) {
        this.set({ status: 'up-to-date', latest: manifest.version });
        return this.state;
      }
      this.set({ status: 'available', latest: manifest.version, notes: manifest.notes });
      if (flavor === 'linux-deb') {
        this.set({ status: 'notify-only' });
        return this.state;
      }
      const file = selectFile(manifest, os, arch, flavor);
      if (!file) throw new Error(`no ${flavor} file for ${os}/${arch} in ${manifest.version}`);

      const base = `${UPDATE_BASE_URL}/releases/${encodeURIComponent(manifest.version)}`;
      const [sumsBuf, sigBuf] = await Promise.all([this.buffer(`${base}/SHA256SUMS`), this.buffer(`${base}/SHA256SUMS.sig`)]);
      if (!verifySignature(sumsBuf, sigBuf, RELEASE_PUBLIC_KEY_PEM)) throw new Error('SHA256SUMS signature is invalid');
      const hash = expectedHash(file, parseSums(sumsBuf.toString('utf8')));

      const path = await this.download(manifest.version, file, hash);
      this.ready = { version: manifest.version, flavor, file: path };
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.log(`update check failed: ${msg}`);
      this.set({ status: 'error', error: msg });
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  private async json(url: string): Promise<unknown> {
    const r = await net.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  private async buffer(url: string): Promise<Buffer> {
    const r = await net.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  private async download(version: string, file: ManifestFile, hash: string): Promise<string> {
    const dir = join(app.getPath('userData'), 'updates', version);
    await fsp.mkdir(dir, { recursive: true });
    const dest = join(dir, file.name);
    if (existsSync(dest) && (await hashFile(dest)) === hash) return dest;

    this.set({ status: 'downloading', progress: 0 });
    const url = `${UPDATE_BASE_URL}/${file.path}`;
    const r = await net.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || file.size || 0;
    const h = createHash('sha256');
    let received = 0;
    let lastReport = 0;
    const part = `${dest}.part`;
    const body = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      h.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (total > 0 && now - lastReport > 500) {
        lastReport = now;
        this.set({ progress: received / total });
      }
    });
    await pipeline(body, createWriteStream(part));
    const got = h.digest('hex');
    if (got !== hash) {
      await fsp.rm(part, { force: true });
      throw new Error(`${file.name}: sha256 mismatch`);
    }
    await fsp.rename(part, dest);
    // keep only this version's folder
    const root = join(app.getPath('userData'), 'updates');
    for (const d of readdirSync(root)) if (d !== version) await fsp.rm(join(root, d), { recursive: true, force: true });
    return dest;
  }

  /** "Restart" pill: quit now; the will-quit hook applies the update and relaunches. */
  restartToUpdate(): void {
    if (!this.ready) return;
    this.relaunch = true;
    app.quit();
  }

  /** Called from app 'will-quit'. Starts the detached swap if an update is ready and nothing is recording. */
  applyOnQuit(): void {
    const ready = this.ready;
    if (!ready || this.deps.isBusy()) return;
    this.ready = null;
    try {
      switch (ready.flavor) {
        case 'mac-zip':
          this.applyMac(ready);
          break;
        case 'win-nsis':
          spawn(ready.file, ['/S', '--updated', ...(this.relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
          break;
        case 'linux-appimage':
          this.applyAppImage(ready);
          break;
        case 'linux-deb':
          break;
      }
    } catch (e) {
      this.deps.log(`update apply failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private applyMac(r: Ready): void {
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

  private applyAppImage(r: Ready): void {
    const target = process.env.APPIMAGE;
    if (!target) return;
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

async function hashFile(path: string): Promise<string> {
  if (!statSync(path).isFile()) return '';
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}
