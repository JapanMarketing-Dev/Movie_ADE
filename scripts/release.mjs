#!/usr/bin/env node
// Publishes a built release to downloads.solocut.app (Cloudflare R2).
//
//   node scripts/release.mjs <version> [--from <dir>] [--notes <file>] [--promote-only] [--dry-run]
//
// 1. Takes the installers from the draft GitHub Release v<version> (or a local --from dir).
// 2. Checks them against the GitHub Release SHA256SUMS (built by CI), writes our own SHA256SUMS and signs it
//    with the Ed25519 key in ~/.solocut-release/release-ed25519.pem (never committed, never uploaded).
// 3. Uploads everything to releases/<version>/, then writes manifest.json, versions.json and finally latest.json
//    (the moment users see the new version).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const BUCKET = 'solocut-downloads';
const BASE = 'https://downloads.solocut.app/';
const KEY = join(homedir(), '.solocut-release', 'release-ed25519.pem');
const WRANGLER = ['-y', 'wrangler@4.149.0'];

const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(a));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dry = args.includes('--dry-run');
if (!version) { console.error('usage: node scripts/release.mjs <version> [--from dir] [--notes file] [--dry-run]'); process.exit(2); }

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Which OS/arch/kind a file is, from its name: Solocut-<ver>-<os>-<arch>.<ext> */
export function classify(name) {
  const m = name.match(/^Solocut-(.+?)-(mac|win|linux)-(x64|arm64|amd64|x86_64|aarch64)\.(dmg|zip|exe|AppImage|deb)$/);
  if (!m) return null;
  const arch = { amd64: 'x64', x86_64: 'x64', aarch64: 'arm64' }[m[3]] ?? m[3];
  const ext = m[4];
  const kind = ext === 'zip' ? 'update' : 'installer';
  return { version: m[1], os: m[2], arch, ext, kind };
}

function getFiles() {
  let dir = opt('--from');
  if (!dir) {
    dir = join(tmpdir(), `solocut-release-${version}`);
    mkdirSync(dir, { recursive: true });
    execFileSync('gh', ['release', 'download', `v${version}`, '-R', 'JapanMarketing-Dev/solocut', '-D', dir, '--clobber'], { stdio: 'inherit' });
  }
  const files = readdirSync(dir).filter((n) => classify(n)?.version === version).map((n) => join(dir, n));
  if (!files.length) throw new Error(`no Solocut-${version}-* files in ${dir}`);
  const ciSums = join(dir, 'SHA256SUMS');
  if (existsSync(ciSums)) {
    const expected = new Map(readFileSync(ciSums, 'utf8').trim().split('\n').map((l) => { const [h, n] = l.trim().split(/\s+/); return [n, h]; }));
    for (const f of files) {
      const want = expected.get(basename(f));
      if (want && want !== sha256(f)) throw new Error(`checksum mismatch with CI for ${basename(f)}`);
    }
    console.log('✓ matches the CI checksums');
  }
  return files;
}

function put(key, file, contentType, cache = 'public, max-age=31536000, immutable') {
  const a = [...WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote', '--cache-control', cache];
  if (contentType) a.push('--content-type', contentType);
  console.log(`↑ ${key}`);
  if (dry) return;
  const r = spawnSync('npx', a, { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`upload failed: ${key}`);
}

function main() {
  if (!existsSync(KEY)) throw new Error(`signing key not found: ${KEY}`);
  const files = getFiles();
  const work = join(tmpdir(), `solocut-publish-${version}`);
  mkdirSync(work, { recursive: true });

  const entries = files.map((f) => ({ name: basename(f), path: `releases/${version}/${basename(f)}`, size: statSync(f).size, sha256: sha256(f), ...classify(basename(f)) }))
    .map(({ version: _v, ext: _e, ...rest }) => rest);
  const sums = entries.map((e) => `${e.sha256}  ${e.name}`).join('\n') + '\n';
  const sumsFile = join(work, 'SHA256SUMS');
  writeFileSync(sumsFile, sums);
  const sig = sign(null, Buffer.from(sums), createPrivateKey(readFileSync(KEY))).toString('base64');
  writeFileSync(join(work, 'SHA256SUMS.sig'), sig + '\n');

  const notesFile = opt('--notes');
  const manifest = { schema: 1, product: 'Solocut', version, date: new Date().toISOString().slice(0, 10),
    notes: notesFile ? readFileSync(notesFile, 'utf8') : '', files: entries };
  writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (!args.includes('--promote-only')) {
    for (const f of files) put(`releases/${version}/${basename(f)}`, f);
    put(`releases/${version}/SHA256SUMS`, sumsFile, 'text/plain; charset=utf-8');
    put(`releases/${version}/SHA256SUMS.sig`, join(work, 'SHA256SUMS.sig'), 'text/plain; charset=utf-8');
    put(`releases/${version}/manifest.json`, join(work, 'manifest.json'), 'application/json');
  }

  // versions.json: newest first, up to 20.
  let versions = [];
  try { versions = JSON.parse(execFileSync('curl', ['-fsS', `${BASE}versions.json`], { encoding: 'utf8' })); } catch {}
  versions = [{ version, date: manifest.date }, ...versions.filter((v) => v.version !== version)].slice(0, 20);
  writeFileSync(join(work, 'versions.json'), JSON.stringify(versions, null, 2));
  put('versions.json', join(work, 'versions.json'), 'application/json', 'public, max-age=300');
  put('latest.json', join(work, 'manifest.json'), 'application/json', 'public, max-age=300');
  console.log(dry ? '(dry run) nothing uploaded' : `✓ Solocut ${version} is live: ${BASE}latest.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`✘ ${e.message}`); process.exit(1); }
}
