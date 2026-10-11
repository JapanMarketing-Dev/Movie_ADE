import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIDEOS_ROOT, SettingsError, SettingsSchema, applySetting, defaultSettings, loadSettingsWithErrors, parseSettings, resolveVideosRoot, setSetting, settingsPath } from '../src/index.js';

let home: string;
const saved = process.env.SOLOCUT_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solocut-videos-'));
  process.env.SOLOCUT_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SOLOCUT_HOME;
  else process.env.SOLOCUT_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('videos.root defaults', () => {
  it('defaults to ~/Movies/Solocut', () => {
    expect(defaultSettings().videos).toEqual({ root: '~/Movies/Solocut' });
    expect(DEFAULT_VIDEOS_ROOT).toBe('~/Movies/Solocut');
  });

  it('a file without the section gets the default', () => {
    writeFileSync(settingsPath(), JSON.stringify({ language: 'en' }));
    const r = loadSettingsWithErrors();
    expect(r.errors).toEqual([]);
    expect(r.settings.videos.root).toBe('~/Movies/Solocut');
  });

  it('an empty section gets the default', () => {
    expect(SettingsSchema.parse({ videos: {} }).videos.root).toBe('~/Movies/Solocut');
  });

  it('keeps a valid absolute path', () => {
    expect(SettingsSchema.parse({ videos: { root: '/Volumes/SSD/動画' } }).videos.root).toBe('/Volumes/SSD/動画');
    expect(SettingsSchema.parse({ videos: { root: 'D:\\Videos' } }).videos.root).toBe('D:\\Videos');
    expect(SettingsSchema.parse({ videos: { root: '~' } }).videos.root).toBe('~');
  });

  it.each(['', 'Movies/Solocut', './x', '~user/x', 42, null])('rejects %j and falls back to the default (other sections kept)', (root) => {
    const r = parseSettings(JSON.stringify({ language: 'en', videos: { root } }));
    expect(r.errors.some((e) => e.path.startsWith('videos'))).toBe(true);
    expect(r.settings.videos.root).toBe('~/Movies/Solocut');
    expect(r.settings.language).toBe('en');
  });
});

describe('setting videos.root', () => {
  it('applySetting validates the value', () => {
    expect(applySetting(defaultSettings(), 'videos.root', '/tmp/v').videos.root).toBe('/tmp/v');
    expect(() => applySetting(defaultSettings(), 'videos.root', 'relative')).toThrow(SettingsError);
  });

  it('setSetting persists it', () => {
    setSetting('videos.root', '/tmp/solocut-videos');
    expect(loadSettingsWithErrors().settings.videos.root).toBe('/tmp/solocut-videos');
  });
});

describe('resolveVideosRoot', () => {
  it('expands ~', () => {
    expect(resolveVideosRoot('~/Movies/Solocut', '/Users/a')).toBe(join('/Users/a', 'Movies/Solocut'));
    expect(resolveVideosRoot('~', '/Users/a')).toBe('/Users/a');
    expect(resolveVideosRoot('~\\Videos', 'C:\\Users\\a')).toBe(join('C:\\Users\\a', 'Videos'));
  });

  it('keeps absolute paths and trims spaces', () => {
    expect(resolveVideosRoot('/Volumes/SSD/v', '/Users/a')).toBe('/Volumes/SSD/v');
    expect(resolveVideosRoot('  /x  ', '/Users/a')).toBe('/x');
  });

  it.each([undefined, null, '', '   ', 3])('falls back to the default for %j', (v) => {
    expect(resolveVideosRoot(v, '/Users/a')).toBe(join('/Users/a', 'Movies/Solocut'));
  });

  it('uses the real home by default', () => {
    expect(resolveVideosRoot('~/x')).toMatch(/[\\/]x$/);
  });
});
