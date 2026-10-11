import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appBundleOf,
  compareVersions,
  decodeSignature,
  expectedHash,
  isNewer,
  isSafeRelPath,
  parseManifest,
  parseSums,
  parseVersion,
  selectFile,
  sha256Hex,
  verifySignature,
  type ManifestFile,
} from '../src/main/update/logic';
import { RELEASE_PUBLIC_KEY_PEM } from '../src/main/update/key';

const H = (c: string) => c.repeat(64);

describe('versions', () => {
  it('parses semver with optional v, prerelease and build', () => {
    expect(parseVersion('v1.2.3')?.main).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-beta.2+sha.1')?.pre).toEqual(['beta', 2]);
    for (const bad of ['', '1.2', '1.2.3.4', 'a.b.c', '1.2.3-', ' ']) expect(parseVersion(bad)).toBeNull();
  });
  it('orders versions', () => {
    const sorted = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '0.10.0', '1.0.0'];
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(compareVersions(sorted[i]!, sorted[i + 1]!)).toBe(-1);
      expect(compareVersions(sorted[i + 1]!, sorted[i]!)).toBe(1);
    }
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });
  it('isNewer only for valid, strictly greater versions', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0-rc.1', '0.1.0')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
  });
});

const files: ManifestFile[] = [
  { name: 'Solocut-0.2.0-mac-arm64.zip', path: 'releases/0.2.0/Solocut-0.2.0-mac-arm64.zip', size: 1, sha256: H('a'), os: 'mac', arch: 'arm64', kind: 'update' },
  { name: 'Solocut-0.2.0-mac-arm64.dmg', path: 'releases/0.2.0/Solocut-0.2.0-mac-arm64.dmg', size: 1, sha256: H('b'), os: 'mac', arch: 'arm64', kind: 'installer' },
  { name: 'Solocut-0.2.0-mac-x64.zip', path: 'releases/0.2.0/Solocut-0.2.0-mac-x64.zip', size: 1, sha256: H('c'), os: 'mac', arch: 'x64', kind: 'update' },
  { name: 'Solocut-0.2.0-win-x64.exe', path: 'releases/0.2.0/Solocut-0.2.0-win-x64.exe', size: 1, sha256: H('d'), os: 'win', arch: 'x64', kind: 'installer' },
  { name: 'Solocut-0.2.0-linux-x86_64.AppImage', path: 'releases/0.2.0/Solocut-0.2.0-linux-x86_64.AppImage', size: 1, sha256: H('e'), os: 'linux', arch: 'x64', kind: 'installer' },
  { name: 'Solocut-0.2.0-linux-amd64.deb', path: 'releases/0.2.0/Solocut-0.2.0-linux-amd64.deb', size: 1, sha256: H('f'), os: 'linux', arch: 'x64', kind: 'installer' },
];

describe('manifest', () => {
  it('parses and keeps only well-formed, safe entries', () => {
    const m = parseManifest({
      version: '0.2.0',
      notes: 'n',
      files: [
        ...files,
        { ...files[0], name: '../evil.zip' },
        { ...files[0], path: '../../etc/passwd' },
        { ...files[0], path: 'https://evil.example/x.zip' },
        { ...files[0], path: '/abs/x.zip' },
        { ...files[0], sha256: 'xyz' },
        { ...files[0], os: 'beos' },
        { ...files[0], kind: 'other' },
        null,
        7,
      ],
    });
    expect(m.files).toHaveLength(files.length);
    expect(m.notes).toBe('n');
  });
  it('rejects bad documents', () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({ version: 'x', files: [] })).toThrow(/version/);
    expect(() => parseManifest({ version: '1.0.0' })).toThrow(/files/);
  });
  it('selects the right file per os/arch/flavor', () => {
    const m = parseManifest({ version: '0.2.0', files });
    expect(selectFile(m, 'mac', 'arm64', 'mac-zip')?.name).toBe('Solocut-0.2.0-mac-arm64.zip');
    expect(selectFile(m, 'mac', 'x64', 'mac-zip')?.name).toBe('Solocut-0.2.0-mac-x64.zip');
    expect(selectFile(m, 'win', 'x64', 'win-nsis')?.name).toBe('Solocut-0.2.0-win-x64.exe');
    expect(selectFile(m, 'win', 'arm64', 'win-nsis')).toBeNull();
    expect(selectFile(m, 'linux', 'x64', 'linux-appimage')?.name).toMatch(/AppImage$/);
    expect(selectFile(m, 'linux', 'x64', 'linux-deb')).toBeNull();
    expect(selectFile(m, 'linux', 'arm64', 'linux-appimage')).toBeNull();
  });
  it('accepts universal builds and prefers exact arch', () => {
    const uni: ManifestFile = { ...files[0]!, name: 'Solocut-uni.zip', arch: 'universal' };
    const m = parseManifest({ version: '0.2.0', files: [uni, files[2]] });
    expect(selectFile(m, 'mac', 'x64', 'mac-zip')?.name).toBe('Solocut-0.2.0-mac-x64.zip');
    expect(selectFile(m, 'mac', 'arm64', 'mac-zip')?.name).toBe('Solocut-uni.zip');
  });
  it('isSafeRelPath', () => {
    expect(isSafeRelPath('releases/0.2.0/a.zip')).toBe(true);
    for (const p of ['', '/a', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'http://x/a']) expect(isSafeRelPath(p)).toBe(false);
  });
});

describe('SHA256SUMS', () => {
  it('parses text and binary mode lines, ignores comments and junk', () => {
    const m = parseSums(`# sums\n${H('a')}  Solocut-0.2.0-mac-arm64.zip\n${H('B')} *Solocut-0.2.0-win-x64.exe\r\nnot a line\n${H('c')}  ./Solocut With Space.AppImage\n`);
    expect(m.get('Solocut-0.2.0-mac-arm64.zip')).toBe(H('a'));
    expect(m.get('Solocut-0.2.0-win-x64.exe')).toBe(H('b'));
    expect(m.get('Solocut With Space.AppImage')).toBe(H('c'));
    expect(m.size).toBe(3);
  });
  it('rejects duplicate names', () => {
    expect(() => parseSums(`${H('a')}  x\n${H('b')}  x\n`)).toThrow(/duplicate/);
  });
  it('expectedHash requires agreement between manifest and sums', () => {
    const sums = parseSums(`${H('a')}  ${files[0]!.name}\n`);
    expect(expectedHash(files[0]!, sums)).toBe(H('a'));
    expect(() => expectedHash(files[2]!, sums)).toThrow(/not listed/);
    expect(() => expectedHash({ ...files[0]!, sha256: H('9') }, sums)).toThrow(/differs/);
  });
  it('sha256Hex', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Ed25519 signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const data = Buffer.from(`${H('a')}  Solocut-0.2.0-mac-arm64.zip\n`);
  const sig = sign(null, data, privateKey);

  it('verifies raw, base64 and hex encodings', () => {
    expect(sig.length).toBe(64);
    expect(verifySignature(data, sig, pem)).toBe(true);
    expect(verifySignature(data, Buffer.from(sig.toString('base64') + '\n'), pem)).toBe(true);
    expect(verifySignature(data, Buffer.from(sig.toString('hex')), pem)).toBe(true);
  });
  it('fails on tampered data, wrong key, junk signature or bad PEM', () => {
    expect(verifySignature(Buffer.concat([data, Buffer.from('x')]), sig, pem)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifySignature(data, sig, other)).toBe(false);
    expect(verifySignature(data, Buffer.alloc(64), pem)).toBe(false);
    expect(verifySignature(data, Buffer.from('nope'), pem)).toBe(false);
    expect(verifySignature(data, sig, 'not a pem')).toBe(false);
  });
  it('rejects non-Ed25519 keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifySignature(data, sig, rsa)).toBe(false);
  });
  it('the release key is a valid Ed25519 key and rejects signatures from other keys', () => {
    expect(createPublicKey(RELEASE_PUBLIC_KEY_PEM).asymmetricKeyType).toBe('ed25519');
    expect(verifySignature(data, Buffer.from(sig.toString('base64')), RELEASE_PUBLIC_KEY_PEM)).toBe(false);
  });
  it('decodeSignature', () => {
    expect(decodeSignature(Buffer.from('short'))).toBeNull();
    expect(decodeSignature(Buffer.from(Buffer.alloc(32).toString('base64')))).toBeNull();
  });
});

describe('appBundleOf', () => {
  it('finds the .app bundle of a mac executable', () => {
    expect(appBundleOf('/Applications/Solocut.app/Contents/MacOS/Solocut')).toBe('/Applications/Solocut.app');
    expect(appBundleOf('/Users/me/My Apps/Solocut.app/Contents/MacOS/Solocut')).toBe('/Users/me/My Apps/Solocut.app');
    expect(appBundleOf('/usr/bin/solocut')).toBeNull();
  });
});
