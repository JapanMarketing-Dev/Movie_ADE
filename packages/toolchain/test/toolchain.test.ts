import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST, ToolchainError, currentPlatform, ensureTool, extractZip, findAsset, resolveTool, resolveToolSync, sha256File,
  solocutHome, toolStatus, toolsDir, whichSync, type ToolManifest,
} from '../src/index.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let tmp: string;
let server: Server;
let base: string;
const routes = new Map<string, (res: import('node:http').ServerResponse) => void>();
const hits = new Map<string, number>();
const saved = { ...process.env };

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.set(url, (hits.get(url) ?? 0) + 1);
    const r = routes.get(url);
    if (!r) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    r(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'solocut-tc-'));
  process.env.SOLOCUT_HOME = join(tmp, 'home');
  routes.clear();
  hits.clear();
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true });
});

function serve(path: string, body: Buffer, o: { lie?: number } = {}) {
  routes.set(path, (res) => {
    res.setHeader('content-length', String(o.lie ?? body.length));
    if (o.lie) {
      res.write(body.subarray(0, Math.min(10, body.length)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body);
  });
}

/** Builds a tar.gz with bin/fakeffmpeg (a shell script) and bin/fakeprobe. */
function makeArchive(): Buffer {
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'pkg', 'bin'), { recursive: true });
  writeFileSync(join(src, 'pkg', 'bin', 'ffmpeg'), '#!/bin/sh\necho "ffmpeg version 9.9.9-test"\n');
  writeFileSync(join(src, 'pkg', 'bin', 'ffprobe'), '#!/bin/sh\necho "ffprobe version 9.9.9-test"\n');
  const out = join(tmp, 'a.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, 'pkg']);
  return readFileSync(out);
}

const plat = { os: 'linux' as const, arch: 'x64' as const };

function manifestFor(url: string, sha256: string, kind: 'tar.gz' | 'file' = 'tar.gz', bin?: Record<string, string>): ToolManifest {
  return {
    schema: 1,
    tools: {
      ffmpeg: {
        version: '9.9.9',
        assets: [{ os: 'linux', arch: 'x64', url, sha256, kind, bin: bin ?? { ffmpeg: 'pkg/bin/ffmpeg', ffprobe: 'pkg/bin/ffprobe' } }],
      },
    },
  };
}

describe('paths and platform', () => {
  it('solocutHome honours SOLOCUT_HOME and falls back to ~/.solocut', () => {
    expect(solocutHome()).toBe(join(tmp, 'home'));
    expect(toolsDir()).toBe(join(tmp, 'home', 'tools'));
    process.env.SOLOCUT_HOME = '  ';
    expect(solocutHome().endsWith('.solocut')).toBe(true);
    delete process.env.SOLOCUT_HOME;
    expect(solocutHome().endsWith('.solocut')).toBe(true);
  });

  it('maps node platforms and rejects unknown ones', () => {
    expect(currentPlatform('darwin', 'arm64')).toEqual({ os: 'mac', arch: 'arm64' });
    expect(currentPlatform('win32', 'x64')).toEqual({ os: 'win', arch: 'x64' });
    expect(currentPlatform('linux', 'arm64')).toEqual({ os: 'linux', arch: 'arm64' });
    expect(() => currentPlatform('freebsd', 'x64')).toThrow(ToolchainError);
    expect(() => currentPlatform('linux', 'ia32')).toThrow(/unsupported platform/);
  });
});

describe('DEFAULT_MANIFEST', () => {
  it('has well-formed pinned entries', () => {
    for (const [key, tool] of Object.entries(DEFAULT_MANIFEST.tools)) {
      expect(tool.version, key).toBeTruthy();
      for (const a of tool.assets) {
        expect(a.sha256, a.url).toMatch(/^[0-9a-f]{64}$/);
        expect(a.url).toMatch(/^https:\/\//);
        expect(a.url).not.toMatch(/\/latest\//);
        expect(Object.keys(a.bin).length).toBeGreaterThan(0);
      }
    }
  });

  it('provides ffmpeg, ffprobe and models on every platform', () => {
    for (const os of ['mac', 'win', 'linux'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        for (const name of ['ffmpeg', 'ffprobe', 'whisper-model', 'whisper-model-small'] as const) {
          expect(findAsset(DEFAULT_MANIFEST, name, { os, arch }), `${name} ${os}/${arch}`).not.toBeNull();
        }
      }
    }
  });

  it('finds ffprobe inside the ffmpeg archive on win/linux and as its own zip on mac', () => {
    expect(findAsset(DEFAULT_MANIFEST, 'ffprobe', { os: 'linux', arch: 'x64' })?.toolKey).toBe('ffmpeg');
    expect(findAsset(DEFAULT_MANIFEST, 'ffprobe', { os: 'win', arch: 'arm64' })?.asset.bin.ffprobe).toMatch(/ffprobe\.exe$/);
    expect(findAsset(DEFAULT_MANIFEST, 'ffprobe', { os: 'mac', arch: 'arm64' })?.toolKey).toBe('ffprobe');
  });

  it('has a self-built whisper-cli v1.9.5 from downloads.solocut.app for every os/arch', () => {
    for (const os of ['mac', 'win', 'linux'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        const hit = findAsset(DEFAULT_MANIFEST, 'whisper-cli', { os, arch });
        expect(hit, `${os}/${arch}`).not.toBeNull();
        expect(hit!.asset.url).toMatch(/^https:\/\/downloads\.solocut\.app\/tools\/whisper\/v1\.9\.5\/whisper-cli-v1\.9\.5-/);
        expect(hit!.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(hit!.asset.bin['whisper-cli']).toBe(os === 'win' ? 'whisper/whisper-cli.exe' : 'whisper/whisper-cli');
      }
    }
  });
});

describe('ensureTool', () => {
  it('downloads, verifies, extracts, chmods and installs atomically', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    const progress: { received: number; total?: number }[] = [];
    const p = await ensureTool('ffmpeg', { manifest: m, platform: plat, onProgress: (x) => progress.push(x) });
    expect(p).toBe(join(toolsDir(), 'ffmpeg', '9.9.9', 'pkg/bin/ffmpeg'));
    expect(execFileSync(p).toString()).toContain('9.9.9-test');
    expect(progress.at(-1)).toEqual({ received: body.length, total: body.length });
    // staging is cleaned up
    expect(readdirSync(join(toolsDir(), '.staging'))).toEqual([]);
    // second call: already installed, no new request; ffprobe comes from the same archive
    const probe = await ensureTool('ffprobe', { manifest: m, platform: plat });
    expect(probe.endsWith('pkg/bin/ffprobe')).toBe(true);
    expect(hits.get('/ff.tar.gz')).toBe(1);
    expect(resolveToolSync('ffmpeg', { manifest: m, platform: plat })).toMatchObject({ source: 'managed', version: '9.9.9' });
  });

  it('dedupes concurrent installs of the same archive', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    const [a, b] = await Promise.all([ensureTool('ffmpeg', { manifest: m, platform: plat }), ensureTool('ffprobe', { manifest: m, platform: plat })]);
    expect(a).not.toBe(b);
    expect(hits.get('/ff.tar.gz')).toBe(1);
  });

  it('rejects a sha256 mismatch and leaves nothing installed', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, '0'.repeat(64));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'checksum' });
    expect(existsSync(join(toolsDir(), 'ffmpeg', '9.9.9'))).toBe(false);
    expect(readdirSync(join(toolsDir(), '.staging'))).toEqual([]);
  });

  it('rejects an interrupted download', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body, { lie: body.length + 1000 });
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'download' });
    expect(existsSync(join(toolsDir(), 'ffmpeg', '9.9.9'))).toBe(false);
  });

  it('rejects HTTP errors', async () => {
    const m = manifestFor(`${base}/missing.tar.gz`, '0'.repeat(64));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toThrow(/HTTP 404/);
  });

  it('rejects an unreachable host', async () => {
    const m = manifestFor('http://127.0.0.1:1/x.tar.gz', '0'.repeat(64));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'download' });
  });

  it('rejects an archive that lacks the declared binary', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body), 'tar.gz', { ffmpeg: 'pkg/bin/nothere' });
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'missing-bin' });
  });

  it('rejects a corrupt archive', async () => {
    const body = Buffer.from('this is not a tarball');
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'extract' });
  });

  it('stores plain files (models) without extraction', async () => {
    const body = Buffer.from('fake-model-bytes');
    serve('/model.bin', body);
    const m: ToolManifest = {
      schema: 1,
      tools: { 'whisper-model': { version: 'v1', assets: [{ ...plat, url: `${base}/model.bin`, sha256: sha(body), kind: 'file', bin: { 'whisper-model': 'm.bin' } }] } },
    };
    const p = await ensureTool('whisper-model', { manifest: m, platform: plat });
    expect(readFileSync(p, 'utf8')).toBe('fake-model-bytes');
    expect(await sha256File(p)).toBe(sha(body));
  });

  it('falls back to PATH when the platform has no build, else explains how to install', async () => {
    const m: ToolManifest = { schema: 1, tools: {} };
    process.env.PATH = join(tmp, 'emptybin');
    await expect(ensureTool('whisper-cli', { manifest: m, platform: { os: 'mac', arch: 'arm64' } })).rejects.toThrow(/brew install whisper-cpp/);
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'whisper-cli'), '#!/bin/sh\n');
    chmodSync(join(bin, 'whisper-cli'), 0o755);
    process.env.PATH = bin;
    expect(await ensureTool('whisper-cli', { manifest: m, platform: { os: 'mac', arch: 'arm64' } })).toBe(join(bin, 'whisper-cli'));
  });

  it('reports no-asset for a platform the manifest does not cover', async () => {
    process.env.PATH = join(tmp, 'emptybin');
    await expect(ensureTool('ffmpeg', { platform: { os: 'solaris' as never, arch: 'x64' } })).rejects.toMatchObject({ code: 'no-asset' });
  });
});

describe('resolveTool', () => {
  it('prefers the env override when the file exists', async () => {
    const f = join(tmp, 'myffmpeg');
    writeFileSync(f, '');
    process.env.SOLOCUT_FFMPEG = f;
    expect(await resolveTool('ffmpeg')).toBe(f);
    process.env.SOLOCUT_FFMPEG = join(tmp, 'does-not-exist');
    process.env.PATH = join(tmp, 'emptybin');
    expect(await resolveTool('ffmpeg', { platform: null })).toBeNull();
  });

  it('finds executables on PATH (and the old whisper-cpp name)', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'whisper-cpp'), '#!/bin/sh\n');
    chmodSync(join(bin, 'whisper-cpp'), 0o755);
    writeFileSync(join(bin, 'ffprobe'), 'not executable');
    process.env.PATH = bin;
    expect(await resolveTool('whisper-cli', { platform: null })).toBe(join(bin, 'whisper-cpp'));
    expect(await resolveTool('ffprobe', { platform: null })).toBeNull();
    expect(whichSync('whisper-cpp')).toBe(join(bin, 'whisper-cpp'));
  });

  it('never looks for models on PATH', async () => {
    expect(await resolveTool('whisper-model', { platform: null })).toBeNull();
  });

  it('finds another installed version when the manifest moved on', async () => {
    const dir = join(toolsDir(), 'ffmpeg', '8.0.0');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'ffmpeg'), '');
    writeFileSync(join(dir, '.solocut-tool.json'), JSON.stringify({ tool: 'ffmpeg', version: '8.0.0', bins: { ffmpeg: 'bin/ffmpeg' } }));
    expect(resolveToolSync('ffmpeg', { platform: plat })).toMatchObject({ source: 'managed', version: '8.0.0' });
  });

  it('ignores a half-installed directory without a marker', async () => {
    const dir = join(toolsDir(), 'ffmpeg', DEFAULT_MANIFEST.tools.ffmpeg!.version);
    mkdirSync(dir, { recursive: true });
    process.env.PATH = join(tmp, 'emptybin');
    expect(await resolveTool('ffmpeg', { platform: plat })).toBeNull();
  });
});

describe('toolStatus', () => {
  it('reports every tool with its source and version', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\necho "ffmpeg version 7.1-test Copyright"\n');
    chmodSync(join(bin, 'ffmpeg'), 0o755);
    process.env.PATH = bin;
    const s = await toolStatus();
    expect(Object.keys(s).sort()).toEqual(['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-model', 'whisper-model-small']);
    expect(s.ffmpeg).toEqual({ installed: true, path: join(bin, 'ffmpeg'), source: 'path', version: '7.1-test' });
    expect(s.ffprobe.installed).toBe(false);
  });
});

/** Minimal zip writer for tests: entries stored (method 0) or deflated (8). */
function makeZip(entries: { name: string; data?: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(e.deflate ? 8 : 0, 8);
    h.writeUInt32LE(crc32(raw), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, name, body);
    centrals.push(c, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('zip', () => {
  it('extracts stored and deflated entries with folders', async () => {
    const zip = join(tmp, 'a.zip');
    writeFileSync(zip, makeZip([{ name: 'whisper/' }, { name: 'whisper/whisper-cli', data: '#!/bin/sh\necho ok\n', deflate: true }, { name: 'whisper/LICENSE.txt', data: 'MIT' }]));
    const out = join(tmp, 'out');
    mkdirSync(out);
    await extractZip(zip, out);
    expect(readFileSync(join(out, 'whisper', 'whisper-cli'), 'utf8')).toContain('echo ok');
    expect(readFileSync(join(out, 'whisper', 'LICENSE.txt'), 'utf8')).toBe('MIT');
  });

  it('rejects path traversal, corrupt and non-zip files', async () => {
    const out = join(tmp, 'out');
    mkdirSync(out);
    writeFileSync(join(tmp, 'evil.zip'), makeZip([{ name: '../evil.txt', data: 'x' }]));
    await expect(extractZip(join(tmp, 'evil.zip'), out)).rejects.toThrow(/escapes/);
    expect(existsSync(join(tmp, 'evil.txt'))).toBe(false);
    writeFileSync(join(tmp, 'not.zip'), 'hello');
    await expect(extractZip(join(tmp, 'not.zip'), out)).rejects.toMatchObject({ code: 'extract' });
    const bad = makeZip([{ name: 'f', data: 'abcdef', deflate: true }]);
    bad[31] = 0xff; bad[32] = 0xff; // damage the compressed data
    writeFileSync(join(tmp, 'bad.zip'), bad);
    await expect(extractZip(join(tmp, 'bad.zip'), out)).rejects.toMatchObject({ code: 'extract' });
  });

  it('ensureTool installs a zip asset (whisper-cli layout) and makes it executable', async () => {
    const body = makeZip([{ name: 'whisper/whisper-cli', data: '#!/bin/sh\necho whisper\n', deflate: true }]);
    serve('/w.zip', body);
    const m: ToolManifest = { schema: 1, tools: { 'whisper-cli': { version: '1.9.5', assets: [{ ...plat, url: `${base}/w.zip`, sha256: sha(body), kind: 'zip', bin: { 'whisper-cli': 'whisper/whisper-cli' } }] } } };
    const p = await ensureTool('whisper-cli', { manifest: m, platform: plat });
    expect(execFileSync(p).toString()).toBe('whisper\n');
  });

  it('refuses an asset whose sha256 is not 64 hex characters (e.g. "TBD")', async () => {
    const m: ToolManifest = { schema: 1, tools: { 'whisper-cli': { version: '1', assets: [{ ...plat, url: `${base}/w.zip`, sha256: 'TBD', kind: 'zip', bin: { 'whisper-cli': 'w' } }] } } };
    await expect(ensureTool('whisper-cli', { manifest: m, platform: plat })).rejects.toThrow(/no valid sha256/);
    expect(hits.get('/w.zip')).toBeUndefined();
  });
});
