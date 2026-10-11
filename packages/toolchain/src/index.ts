import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsc, createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractZip } from './zip.js';
import { ToolchainError } from './errors.js';

export { ToolchainError } from './errors.js';
export { extractZip } from './zip.js';
import { DEFAULT_MANIFEST, TOOL_NAMES, type ToolArch, type ToolAsset, type ToolManifest, type ToolName, type ToolOs } from './manifest.js';

export * from './manifest.js';

/** $SOLOCUT_HOME or ~/.solocut */
export function solocutHome(): string {
  const env = process.env.SOLOCUT_HOME;
  return env && env.trim() ? resolve(env) : join(homedir(), '.solocut');
}

export function toolsDir(): string {
  return join(solocutHome(), 'tools');
}

export interface Platform { os: ToolOs; arch: ToolArch }


/** The platform of this process; throws `unsupported-platform` for anything we have no builds for. */
export function currentPlatform(p: string = process.platform, a: string = process.arch): Platform {
  const os: ToolOs | undefined = p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : p === 'linux' ? 'linux' : undefined;
  const arch: ToolArch | undefined = a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : undefined;
  if (!os || !arch) throw new ToolchainError('unsupported-platform', `unsupported platform: ${p}/${a}`);
  return { os, arch };
}

const ENV_VARS: Record<ToolName, string> = {
  ffmpeg: 'SOLOCUT_FFMPEG',
  ffprobe: 'SOLOCUT_FFPROBE',
  'whisper-cli': 'SOLOCUT_WHISPER_CLI',
  'whisper-model': 'SOLOCUT_WHISPER_MODEL',
  'whisper-model-small': 'SOLOCUT_WHISPER_MODEL_SMALL',
  fonts: 'SOLOCUT_FONTS',
};

/** Executable names looked up on PATH (models are never on PATH). */
const PATH_NAMES: Record<ToolName, string[]> = {
  ffmpeg: ['ffmpeg'],
  ffprobe: ['ffprobe'],
  'whisper-cli': ['whisper-cli', 'whisper-cpp'],
  'whisper-model': [],
  'whisper-model-small': [],
  fonts: [],
};

export interface AssetMatch { toolKey: string; version: string; asset: ToolAsset }

/** The manifest entry that provides `name` on `plat`: the tool's own entry first, then any archive that bundles it. */
export function findAsset(manifest: ToolManifest, name: ToolName, plat: Platform): AssetMatch | null {
  const keys = [name, ...Object.keys(manifest.tools).filter((k) => k !== name)];
  for (const key of keys) {
    const tool = manifest.tools[key];
    if (!tool) continue;
    const asset = tool.assets.find((a) => a.os === plat.os && a.arch === plat.arch && a.bin[name]);
    if (asset) return { toolKey: key, version: tool.version, asset };
  }
  return null;
}

const MARKER = '.solocut-tool.json';
interface Marker { tool: string; version: string; url: string; sha256: string; bins: Record<string, string>; installedAt: string }

function readMarker(dir: string): Marker | null {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Marker;
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH from an env object, whatever its case ("Path" on Windows when the env is a plain copy). */
export function envPath(env: NodeJS.ProcessEnv = process.env): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key ? env[key] : '') ?? '';
}

/** Search PATH for an executable. On Windows only names with a PATHEXT extension count (as cmd.exe does). */
export function whichSync(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const dirs = envPath(env).split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const pathextKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  const exts = platform === 'win32' ? ((pathextKey ? env[pathextKey] : undefined) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  // a name that already has an extension (claude.cmd) is looked up as is
  const names = platform === 'win32' && /\.[A-Za-z0-9]+$/.test(cmd) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (platform === 'win32' ? isFile(p) && exts.some((e) => p.toUpperCase().endsWith(e.toUpperCase())) : isExecutable(p)) return p;
    }
  }
  return null;
}

/** Quote one argument for cmd.exe (inside a /s /c "…" line). */
function cmdQuote(a: string): string {
  if (a !== '' && /^[A-Za-z0-9_\-+=.,/:\\]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
}

/**
 * How to spawn `file` with `args`: npm-installed CLIs on Windows are .cmd/.bat shims, which Node refuses to run
 * without a shell, so they go through `cmd.exe /d /s /c "…"` with each argument quoted.
 */
export function spawnSpec(file: string, args: string[], platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { command: file, args };
}

/** A managed install of `name` (the manifest version first, then any other installed version, newest first). */
function managedPath(name: ToolName, manifest: ToolManifest, plat: Platform | null): { path: string; version: string } | null {
  if (plat) {
    const m = findAsset(manifest, name, plat);
    if (m) {
      const dir = join(toolsDir(), m.toolKey, m.version);
      const marker = readMarker(dir);
      const rel = m.asset.bin[name]!;
      if (marker && isFile(join(dir, rel))) return { path: join(dir, rel), version: m.version };
    }
  }
  // any other installed version that provides `name`
  const root = toolsDir();
  let keys: string[] = [];
  try {
    keys = readdirSync(root).filter((k) => !k.startsWith('.'));
  } catch {
    return null;
  }
  for (const key of keys) {
    let versions: string[] = [];
    try {
      versions = readdirSync(join(root, key)).sort().reverse();
    } catch {
      continue;
    }
    for (const v of versions) {
      const marker = readMarker(join(root, key, v));
      const rel = marker?.bins[name];
      if (rel && isFile(join(root, key, v, rel))) return { path: join(root, key, v, rel), version: marker.version };
    }
  }
  return null;
}

export type ToolSource = 'env' | 'managed' | 'path';

export function resolveToolSync(
  name: ToolName,
  o: { manifest?: ToolManifest; platform?: Platform | null } = {},
): { path: string; source: ToolSource; version?: string } | null {
  const env = process.env[ENV_VARS[name]];
  if (env && (name === 'fonts' ? existsSync(env) : isFile(env))) return { path: env, source: 'env' };
  let plat: Platform | null = null;
  if (o.platform !== undefined) plat = o.platform;
  else {
    try {
      plat = currentPlatform();
    } catch {
      plat = null;
    }
  }
  const managed = managedPath(name, o.manifest ?? DEFAULT_MANIFEST, plat);
  if (managed) return { path: managed.path, source: 'managed', version: managed.version };
  for (const cmd of PATH_NAMES[name]) {
    const p = whichSync(cmd);
    if (p) return { path: p, source: 'path' };
  }
  return null;
}

/** env SOLOCUT_<TOOL> → ~/.solocut/tools/<tool>/<version>/ → PATH → null */
export async function resolveTool(name: ToolName, o: { manifest?: ToolManifest; platform?: Platform | null } = {}): Promise<string | null> {
  return resolveToolSync(name, o)?.path ?? null;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')));
  });
}

export interface EnsureOptions {
  onProgress?: (p: { received: number; total?: number }) => void;
  manifest?: ToolManifest;
  platform?: Platform;
  signal?: AbortSignal;
}

const inflight = new Map<string, Promise<string>>();

/** Make sure a managed copy of `name` exists: download, verify sha256, extract, chmod +x, atomic rename. Returns its path. */
export function ensureTool(name: ToolName, o: EnsureOptions = {}): Promise<string> {
  const manifest = o.manifest ?? DEFAULT_MANIFEST;
  const plat = o.platform ?? currentPlatform();
  const match = findAsset(manifest, name, plat);
  if (!match) {
    // no build for this platform (e.g. whisper-cli on macOS): fall back to PATH
    for (const cmd of PATH_NAMES[name]) {
      const p = whichSync(cmd);
      if (p) return Promise.resolve(p);
    }
    const hint = name === 'whisper-cli' && plat.os === 'mac' ? ' (install it with `brew install whisper-cpp`)' : '';
    return Promise.reject(new ToolchainError('no-asset', `no download of ${name} for ${plat.os}/${plat.arch}${hint}`));
  }
  const dir = join(toolsDir(), match.toolKey, match.version);
  const rel = match.asset.bin[name]!;
  if (readMarker(dir) && isFile(join(dir, rel))) return Promise.resolve(join(dir, rel));
  const hashes = match.asset.kind === 'bundle' ? (match.asset.parts ?? []).map((x) => [x.url, x.sha256] as const) : [[match.asset.url, match.asset.sha256] as const];
  const bad = hashes.find(([, h]) => !/^[0-9a-fA-F]{64}$/.test(h));
  if (bad || (match.asset.kind === 'bundle' && !hashes.length)) {
    return Promise.reject(new ToolchainError('checksum', `the manifest has no valid sha256 for ${bad?.[0] ?? match.asset.url} ("${bad?.[1] ?? ''}"); refusing to install`));
  }
  const key = dir;
  let p = inflight.get(key);
  if (!p) {
    p = install(match, dir, o).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p.then((d) => join(d, rel));
}

async function download(url: string, dest: string, o: EnsureOptions): Promise<{ sha256: string; received: number }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: o.signal, redirect: 'follow' });
  } catch (e) {
    if (o.signal?.aborted) throw new ToolchainError('aborted', 'download aborted');
    throw new ToolchainError('download', `download failed: ${url}: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new ToolchainError('download', `download failed: ${url}: HTTP ${res.status}`);
  const lenHeader = res.headers.get('content-length');
  const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : undefined;
  const h = createHash('sha256');
  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      h.update(chunk);
      const now = Date.now();
      if (o.onProgress && (now - lastReport > 100 || received === total)) {
        lastReport = now;
        o.onProgress(total === undefined ? { received } : { received, total });
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(dest));
  } catch (e) {
    if (o.signal?.aborted) throw new ToolchainError('aborted', 'download aborted');
    throw new ToolchainError('download', `download interrupted after ${received} bytes: ${(e as Error).message}`);
  }
  if (total !== undefined && received !== total) {
    throw new ToolchainError('download', `download incomplete: ${received} of ${total} bytes`);
  }
  o.onProgress?.(total === undefined ? { received } : { received, total });
  return { sha256: h.digest('hex'), received };
}

function runTar(archive: string, dest: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('tar', ['-xf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', (e) => rej(new ToolchainError('extract', `tar not available: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? res() : rej(new ToolchainError('extract', `tar exited ${code}: ${err.trim()}`))));
  });
}

async function install(m: AssetMatch, finalDir: string, o: EnsureOptions): Promise<string> {
  const staging = join(toolsDir(), '.staging', `${m.toolKey}-${randomBytes(6).toString('hex')}`);
  const root = join(staging, 'root');
  await mkdir(root, { recursive: true });
  try {
    const a = m.asset;
    if (a.kind === 'bundle') {
      // several archives → one flat folder of the listed files
      const parts = a.parts ?? [];
      const total = parts.every((x) => x.size) ? parts.reduce((n, x) => n + x.size!, 0) : undefined;
      let done = 0;
      for (const [i, part] of parts.entries()) {
        const file = join(staging, `part-${i}.${part.kind}`);
        const { sha256, received } = await download(part.url, file, {
          ...o, onProgress: o.onProgress ? (pr) => o.onProgress!(total === undefined ? { received: done + pr.received } : { received: done + pr.received, total }) : undefined,
        } as EnsureOptions);
        done += received;
        if (sha256 !== part.sha256.toLowerCase()) throw new ToolchainError('checksum', `sha256 mismatch for ${part.url}: expected ${part.sha256}, got ${sha256}`);
        const out = join(staging, `part-${i}`);
        await mkdir(out, { recursive: true });
        if (part.kind === 'zip') await extractZip(file, out);
        else await runTar(file, out);
        for (const [dest, src] of Object.entries(part.files)) {
          if (dest !== basename(dest) || dest.startsWith('.')) throw new ToolchainError('extract', `invalid bundle file name: ${dest}`);
          const from = join(out, src);
          if (!isFile(from)) throw new ToolchainError('missing-bin', `${src} not found in ${part.url}`);
          await copyFile(from, join(root, dest));
        }
      }
    } else {
      const file = a.kind === 'file' ? join(root, Object.values(a.bin)[0]!) : join(staging, `download.${a.kind}`);
      const { sha256 } = await download(a.url, file, o);
      if (sha256 !== a.sha256.toLowerCase()) {
        throw new ToolchainError('checksum', `sha256 mismatch for ${a.url}: expected ${a.sha256}, got ${sha256}`);
      }
      if (a.kind === 'zip') await extractZip(file, root);
      else if (a.kind !== 'file') await runTar(file, root);
    }
    for (const rel of Object.values(a.bin)) {
      const p = join(root, rel);
      if (!isFile(p)) throw new ToolchainError('missing-bin', `${rel} not found in ${a.url}`);
      if (a.kind !== 'file' && a.kind !== 'bundle' && process.platform !== 'win32') await chmod(p, 0o755);
    }
    const marker: Marker = { tool: m.toolKey, version: m.version, url: a.url, sha256: a.sha256, bins: a.bin, installedAt: new Date().toISOString() };
    await writeFile(join(root, MARKER), JSON.stringify(marker, null, 2));
    await mkdir(dirname(finalDir), { recursive: true });
    if (existsSync(finalDir)) {
      if (readMarker(finalDir)) return finalDir; // another process won the race
      await rm(finalDir, { recursive: true, force: true }); // half-installed leftovers
    }
    await rename(root, finalDir);
    return finalDir;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface ToolState { installed: boolean; path?: string; version?: string; source?: ToolSource }

function execVersion(bin: string): Promise<string | undefined> {
  const sp = spawnSpec(bin, ['-version']);
  return new Promise((res) => {
    execFile(sp.command, sp.args, { timeout: 5000, windowsHide: true, ...(sp.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }, (err, stdout) => {
      if (err) return res(undefined);
      const m = /version\s+(\S+)/.exec(String(stdout));
      res(m?.[1]);
    });
  });
}

/** Folder of the managed fonts (or $SOLOCUT_FONTS), or null when not installed. */
export function fontsDir(): string | null {
  const r = resolveToolSync('fonts');
  if (!r) return null;
  return r.source === 'env' ? r.path : dirname(r.path);
}

export async function toolStatus(o: { manifest?: ToolManifest; probeVersions?: boolean } = {}): Promise<Record<ToolName, ToolState>> {
  const out = {} as Record<ToolName, ToolState>;
  for (const name of TOOL_NAMES) {
    const r = resolveToolSync(name, o.manifest ? { manifest: o.manifest } : {});
    if (!r) {
      out[name] = { installed: false };
      continue;
    }
    let version = r.version;
    if (!version && o.probeVersions !== false && (name === 'ffmpeg' || name === 'ffprobe')) version = await execVersion(r.path);
    out[name] = { installed: true, path: r.path, source: r.source, ...(version ? { version } : {}) };
  }
  return out;
}

/** Remove a managed tool (all versions). */
export async function removeTool(toolKey: string): Promise<void> {
  const dir = join(toolsDir(), toolKey);
  if (!dir.startsWith(toolsDir() + sep)) throw new Error('invalid tool key');
  await rm(dir, { recursive: true, force: true });
}
