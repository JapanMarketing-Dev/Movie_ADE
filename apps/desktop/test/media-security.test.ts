import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appOrigins, corsOrigin } from '../src/main/services/cors';
import { allowMediaRoot, clearMediaRoots, isAllowed } from '../src/main/services/media-protocol';

describe('solocut-media CORS', () => {
  it('app origins: file pages (null) and only a localhost dev server', () => {
    expect(appOrigins()).toEqual(['null', 'file://']);
    expect(appOrigins('http://localhost:5173/')).toEqual(['null', 'file://', 'http://localhost:5173']);
    expect(appOrigins('http://127.0.0.1:5173')).toContain('http://127.0.0.1:5173');
    expect(appOrigins('https://evil.example/')).toEqual(['null', 'file://']);
    expect(appOrigins('http://192.168.1.2:5173')).toEqual(['null', 'file://']);
    expect(appOrigins('not a url')).toEqual(['null', 'file://']);
  });
  it('echoes only allowed origins; omits the header otherwise', () => {
    const allowed = appOrigins('http://localhost:5173');
    expect(corsOrigin('null', allowed)).toBe('null');
    expect(corsOrigin('http://localhost:5173', allowed)).toBe('http://localhost:5173');
    expect(corsOrigin(undefined, allowed)).toBeNull();
    expect(corsOrigin(null, allowed)).toBeNull();
    for (const o of ['https://evil.example', 'http://localhost:5174', 'http://localhost', '*', '', 'NULL', 'https://youtube.com']) {
      expect(corsOrigin(o, allowed)).toBeNull();
    }
  });
});

describe('solocut-media path containment', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'solocut-media-'));
    mkdirSync(join(base, 'project', 'renders'), { recursive: true });
    mkdirSync(join(base, 'outside'), { recursive: true });
    writeFileSync(join(base, 'project', 'renders', 'preview.mp4'), 'x');
    writeFileSync(join(base, 'outside', 'secret.txt'), 'x');
    // creating symlinks needs extra privileges on Windows; the symlink case is covered on macOS / Linux
    if (process.platform !== 'win32') symlinkSync(join(base, 'outside'), join(base, 'project', 'escape'));
    clearMediaRoots();
    allowMediaRoot(join(base, 'project'));
  });
  afterAll(() => {
    clearMediaRoots();
    rmSync(base, { recursive: true, force: true });
  });
  it('serves files under an opened project', () => {
    expect(isAllowed(join(base, 'project', 'renders', 'preview.mp4'))).toBe(true);
  });
  it('rejects traversal, siblings with a common prefix, and symlinks pointing outside', () => {
    expect(isAllowed(join(base, 'project', '..', 'outside', 'secret.txt'))).toBe(false);
    expect(isAllowed(join(base, 'project-evil', 'x'))).toBe(false);
    if (process.platform !== 'win32') expect(isAllowed(join(base, 'project', 'escape', 'secret.txt'))).toBe(false);
    expect(isAllowed('/etc/passwd')).toBe(false);
  });
  it('ignores relative or empty roots', () => {
    clearMediaRoots();
    allowMediaRoot('');
    allowMediaRoot('relative/dir');
    expect(isAllowed(join(process.cwd(), 'relative', 'dir', 'x'))).toBe(false);
    allowMediaRoot(join(base, 'project'));
  });
});
