// Pure parts of the custom auto-updater: version comparison, manifest selection, SHA256SUMS parsing and
// Ed25519 signature verification. No network, no fs.
import { createHash, createPublicKey, verify } from 'node:crypto';

export type UpdOs = 'mac' | 'win' | 'linux';
export type UpdArch = 'x64' | 'arm64';
export interface ManifestFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
  os: UpdOs;
  arch: UpdArch | 'universal';
  kind: 'installer' | 'update';
}
export interface LatestManifest {
  version: string;
  date?: string;
  notes?: string;
  files: ManifestFile[];
}

interface SemVer {
  main: [number, number, number];
  pre: (string | number)[];
}

export function parseVersion(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** semver ordering: -1 if a < b, 0 if equal, 1 if a > b. Invalid versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.main[i]! - pb.main[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    if (pa.pre.length === pb.pre.length) return 0;
    return pa.pre.length === 0 ? 1 : -1; // release > prerelease
  }
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  return parseVersion(latest) !== null && compareVersions(latest, current) > 0;
}

/** Validates the shape of latest.json; throws with a short reason. */
export function parseManifest(input: unknown): LatestManifest {
  if (typeof input !== 'object' || input === null) throw new Error('manifest: not an object');
  const o = input as Record<string, unknown>;
  if (typeof o.version !== 'string' || !parseVersion(o.version)) throw new Error('manifest: bad version');
  if (!Array.isArray(o.files)) throw new Error('manifest: files missing');
  const files: ManifestFile[] = [];
  for (const f of o.files) {
    if (typeof f !== 'object' || f === null) continue;
    const r = f as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.path !== 'string' || typeof r.sha256 !== 'string') continue;
    if (!/^[0-9a-f]{64}$/i.test(r.sha256)) continue;
    if (!['mac', 'win', 'linux'].includes(String(r.os))) continue;
    if (!['x64', 'arm64', 'universal'].includes(String(r.arch))) continue;
    if (r.kind !== 'installer' && r.kind !== 'update') continue;
    if (!isSafeRelPath(r.path) || !isSafeFileName(r.name)) continue;
    files.push({
      name: r.name,
      path: r.path,
      size: typeof r.size === 'number' ? r.size : 0,
      sha256: r.sha256.toLowerCase(),
      os: r.os as UpdOs,
      arch: r.arch as ManifestFile['arch'],
      kind: r.kind,
    });
  }
  const m: LatestManifest = { version: o.version, files };
  if (typeof o.date === 'string') m.date = o.date;
  if (typeof o.notes === 'string') m.notes = o.notes;
  return m;
}

export function isSafeFileName(n: string): boolean {
  return /^[A-Za-z0-9._ -]+$/.test(n) && n !== '.' && n !== '..';
}
export function isSafeRelPath(p: string): boolean {
  if (p.startsWith('/') || p.includes('\\') || p.includes('://')) return false;
  return p.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

export type InstallFlavor = 'mac-zip' | 'win-nsis' | 'linux-appimage' | 'linux-deb';

/**
 * Picks the file to download for this machine. mac uses the `update` zip, Windows the NSIS `installer`,
 * Linux AppImage the AppImage (`update` kind preferred, else an installer ending in .AppImage).
 * deb installs only get a notification (null).
 */
export function selectFile(m: LatestManifest, os: UpdOs, arch: UpdArch, flavor: InstallFlavor): ManifestFile | null {
  const forArch = (f: ManifestFile) => f.os === os && (f.arch === arch || f.arch === 'universal');
  const exact = (f: ManifestFile) => f.os === os && f.arch === arch;
  const pick = (pred: (f: ManifestFile) => boolean) => m.files.find((f) => exact(f) && pred(f)) ?? m.files.find((f) => forArch(f) && pred(f)) ?? null;
  switch (flavor) {
    case 'mac-zip':
      return pick((f) => f.kind === 'update' && f.name.toLowerCase().endsWith('.zip'));
    case 'win-nsis':
      return pick((f) => f.kind === 'installer' && f.name.toLowerCase().endsWith('.exe'));
    case 'linux-appimage':
      return (
        pick((f) => f.kind === 'update' && f.name.endsWith('.AppImage')) ??
        pick((f) => f.name.endsWith('.AppImage'))
      );
    case 'linux-deb':
      return null;
  }
}

/** Parses `sha256sum` output: "<hex>  <name>" or "<hex> *<name>". Later duplicates are rejected. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(l);
    if (!m) continue;
    const name = m[2]!.trim().replace(/^\.\//, '');
    if (out.has(name)) throw new Error(`SHA256SUMS: duplicate entry for ${name}`);
    out.set(name, m[1]!.toLowerCase());
  }
  return out;
}

/**
 * Decodes a detached Ed25519 signature: raw 64 bytes, or base64 / hex text (as written by
 * `openssl pkeyutl -sign -rawin` then optionally `base64`).
 */
export function decodeSignature(sig: Buffer): Buffer | null {
  if (sig.length === 64) return sig;
  const text = sig.toString('utf8').trim();
  if (/^[0-9a-fA-F]{128}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    const b = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    if (b.length === 64) return b;
  }
  return null;
}

/** Verifies an Ed25519 detached signature. Never throws; false on any malformed input. */
export function verifySignature(data: Buffer, sig: Buffer, publicKeyPem: string): boolean {
  try {
    const raw = decodeSignature(sig);
    if (!raw) return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, data, key, raw);
  } catch {
    return false;
  }
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The expected hash for a file must agree in the manifest and in the signed SHA256SUMS.
 * Returns the hash, or throws if they disagree / the file is absent from the sums.
 */
export function expectedHash(file: ManifestFile, sums: Map<string, string>): string {
  const fromSums = sums.get(file.name);
  if (!fromSums) throw new Error(`${file.name} is not listed in SHA256SUMS`);
  if (fromSums !== file.sha256.toLowerCase()) throw new Error(`${file.name}: manifest hash differs from SHA256SUMS`);
  return fromSums;
}

export function osOf(platform: string): UpdOs | null {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : null;
}
export function archOf(arch: string): UpdArch | null {
  return arch === 'x64' || arch === 'arm64' ? arch : null;
}

/** For macOS: the enclosing .app bundle of an executable path, or null. */
export function appBundleOf(execPath: string): string | null {
  const i = execPath.indexOf('.app/Contents/MacOS/');
  return i === -1 ? null : execPath.slice(0, i + 4);
}

export const CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
