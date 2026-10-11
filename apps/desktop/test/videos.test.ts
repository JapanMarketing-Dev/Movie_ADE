import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SLUG_MAX, folderSlug, videoFolderName } from '../src/shared/videoName';
import { finalCandidates, latestRender, takeChange, listVideos, readVideo, uniqueChild, videoStatus } from '../src/main/services/videos';
import { DEFAULT_VIDEOS_ROOT, videosRootChosen } from '../src/renderer/src/onboarding/flow';

const at = (y: number, mo: number, d: number, h = 9, mi = 5) => new Date(y, mo - 1, d, h, mi);

describe('folderSlug', () => {
  it('keeps Japanese titles as they are', () => {
    expect(folderSlug('Claude Codeの設定')).toBe('Claude-Codeの設定');
    expect(folderSlug('ネタ帳')).toBe('ネタ帳');
  });

  it('turns any run of spaces (incl. full-width) into one dash', () => {
    expect(folderSlug('a  b\tc')).toBe('a-b-c');
    expect(folderSlug('設定　3つの　コツ')).toBe('設定-3つの-コツ');
  });

  it('normalises full-width letters and digits (NFKC)', () => {
    expect(folderSlug('ＡＢＣ１２３')).toBe('ABC123');
  });

  it.each([
    ['a/b', 'a-b'],
    ['a\\b', 'a-b'],
    ['a:b*c?d"e<f>g|h', 'a-b-c-d-e-f-g-h'],
    ['tab\u0000null\u001fend\u007f', 'tab-null-end'],
    ['what?', 'what'],
  ])('replaces invalid characters: %j → %j', (input, out) => {
    expect(folderSlug(input)).toBe(out);
  });

  it.each(['', '   ', '...', '..', '.', '///', '???', '- - -', '\u0000'])('is empty when nothing usable is left: %j', (input) => {
    expect(folderSlug(input)).toBe('');
  });

  it('never starts or ends with a dot or dash (no hidden folders)', () => {
    expect(folderSlug('.env の話')).toBe('env-の話');
    expect(folderSlug('-- 話 --')).toBe('話');
    expect(folderSlug('v1.2.')).toBe('v1.2');
  });

  it('collapses repeated dashes', () => {
    expect(folderSlug('a - / - b')).toBe('a-b');
  });

  it('cuts very long titles by code points', () => {
    const long = 'あ'.repeat(200);
    expect(Array.from(folderSlug(long))).toHaveLength(SLUG_MAX);
    expect(folderSlug('x'.repeat(1000), 10)).toBe('x'.repeat(10));
  });

  it('does not split emoji (surrogate pairs) at the cut', () => {
    const s = folderSlug('🎬'.repeat(50), 5);
    expect(s).toBe('🎬'.repeat(5));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(folderSlug('a🎬b', 2))).toBe(false);
  });

  it('does not end with a dash after the cut', () => {
    expect(folderSlug('abcd efgh', 5)).toBe('abcd');
  });
});

describe('videoFolderName', () => {
  it('is <date>-<slug>', () => {
    expect(videoFolderName('Claude Code の設定', at(2026, 10, 11))).toBe('2026-10-11-Claude-Code-の設定');
  });

  it('uses HHMM without a title', () => {
    expect(videoFolderName('', at(2026, 1, 2, 7, 3))).toBe('2026-01-02-0703');
    expect(videoFolderName('   ', at(2026, 12, 31, 23, 59))).toBe('2026-12-31-2359');
    expect(videoFolderName('///', at(2026, 12, 31, 0, 0))).toBe('2026-12-31-0000');
  });

  it('uses local time', () => {
    expect(videoFolderName('x', at(2027, 1, 1, 0, 0))).toBe('2027-01-01-x');
  });

  it('is never longer than date + SLUG_MAX code points', () => {
    expect(Array.from(videoFolderName('長'.repeat(500), at(2026, 10, 11))).length).toBe(11 + SLUG_MAX);
  });

  it('defaults to now', () => {
    expect(videoFolderName('a')).toMatch(/^\d{4}-\d{2}-\d{2}-a$/);
  });
});

describe('uniqueChild', () => {
  it('returns the plain name when free', () => {
    expect(uniqueChild('/r', 'n', () => false)).toBe(join('/r', 'n'));
  });

  it('adds -2, -3 on collisions', () => {
    const taken = new Set([join('/r', 'n'), join('/r', 'n-2')]);
    expect(uniqueChild('/r', 'n', (p) => taken.has(p))).toBe(join('/r', 'n-3'));
  });

  it('gives up instead of looping forever', () => {
    expect(() => uniqueChild('/r', 'n', () => true)).toThrow(/too many/);
  });

  it('checks the real disk by default', () => {
    const d = mkdtempSync(join(tmpdir(), 'solocut-uc-'));
    try {
      mkdirSync(join(d, 'x'));
      expect(uniqueChild(d, 'x')).toBe(join(d, 'x-2'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('listing the master folder', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solocut-videos-'));
  });
  afterEach(() => {
    try {
      chmodSync(root, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const project = (name: string, json: unknown = { title: name }, when?: number) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'solocut.json'), typeof json === 'string' ? json : JSON.stringify(json));
    if (when !== undefined) {
      const t = new Date(when);
      utimesSync(join(dir, 'solocut.json'), t, t);
      utimesSync(dir, t, t);
    }
    return dir;
  };

  it('a missing root is not an error', () => {
    expect(listVideos(join(root, 'nope'))).toEqual({ root: join(root, 'nope'), exists: false, videos: [] });
  });

  it('an empty root lists nothing', () => {
    expect(listVideos(root)).toEqual({ root, exists: true, videos: [] });
  });

  it('ignores folders without solocut.json, files and hidden folders', () => {
    mkdirSync(join(root, 'not-a-project'));
    writeFileSync(join(root, 'notes.txt'), 'x');
    writeFileSync(join(root, 'solocut.json'), '{}');
    project('.hidden');
    project('2026-10-11-a');
    expect(listVideos(root).videos.map((v) => v.name)).toEqual(['2026-10-11-a']);
  });

  it('reads the title, falls back to the folder name', () => {
    project('a', { title: '本当のタイトル' });
    project('b', { title: '   ' });
    project('c', 'not json');
    project('d', { title: 42 });
    const titles = Object.fromEntries(listVideos(root).videos.map((v) => [v.name, v.title]));
    expect(titles).toEqual({ a: '本当のタイトル', b: 'b', c: 'c', d: 'd' });
  });

  it('lists newest first', () => {
    project('old', undefined, Date.UTC(2026, 0, 1));
    project('new', undefined, Date.UTC(2026, 9, 1));
    project('mid', undefined, Date.UTC(2026, 5, 1));
    expect(listVideos(root).videos.map((v) => v.name)).toEqual(['new', 'mid', 'old']);
  });

  it('a root that is a file reports an error', () => {
    const f = join(root, 'file');
    writeFileSync(f, 'x');
    const r = listVideos(f);
    expect(r.videos).toEqual([]);
    expect(r.error).toBe('notDir');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable root reports a permission error', () => {
    project('a');
    chmodSync(root, 0o000);
    const r = listVideos(root);
    expect(r).toMatchObject({ root, exists: true, videos: [], error: 'permission' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable project folder is skipped, the rest listed', () => {
    project('ok');
    const bad = project('bad');
    chmodSync(bad, 0o000);
    try {
      expect(listVideos(root).videos.map((v) => v.name)).toEqual(['ok']);
    } finally {
      chmodSync(bad, 0o755);
    }
  });
});

describe('videoStatus', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solocut-vs-'));
    writeFileSync(join(dir, 'solocut.json'), '{}');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, content = 'x') => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };

  it('new: nothing recorded (empty folders do not count)', () => {
    mkdirSync(join(dir, 'media', 'takes'), { recursive: true });
    mkdirSync(join(dir, 'renders'), { recursive: true });
    put('media/takes/.DS_Store');
    expect(videoStatus(dir)).toBe('new');
  });

  it('editing: a take or an import exists', () => {
    put('media/takes/take-1/screen.mov');
    // a take folder alone is not a file at the top level; a file is needed
    expect(videoStatus(dir)).toBe('new');
    put('media/takes/take-1.mov');
    expect(videoStatus(dir)).toBe('editing');
  });

  it('editing: imported media', () => {
    put('media/imports/a.mp4');
    expect(videoStatus(dir)).toBe('editing');
  });

  it('done: renders/final.mp4 or any finished render', () => {
    put('media/takes/a.mov');
    put('renders/final.mp4');
    expect(videoStatus(dir)).toBe('done');
  });

  it('done: renders/youtube/final.mp4 (the one output)', () => {
    put('media/takes/a.mov');
    put('renders/youtube/final.mp4');
    expect(videoStatus(dir)).toBe('done');
  });

  it('posted: a published or scheduled output in timeline.json', () => {
    put('renders/youtube/final.mp4');
    put('timeline.json', JSON.stringify({ outputs: [{ target: 'youtube', publish: { status: 'draft' } }] }));
    expect(videoStatus(dir)).toBe('done');
    put('timeline.json', JSON.stringify({ outputs: [{ target: 'youtube', publish: { status: 'published', url: 'https://youtu.be/x' } }] }));
    expect(videoStatus(dir)).toBe('posted');
    put('timeline.json', JSON.stringify({ outputs: [{ target: 'tiktok', publish: { status: 'scheduled' } }] }));
    expect(videoStatus(dir)).toBe('posted');
    put('timeline.json', JSON.stringify({ outputs: [{ target: 'youtube', publish: { status: 'failed' } }] }));
    expect(videoStatus(dir)).toBe('done');
  });

  it('a partial render is not done', () => {
    put('media/takes/a.mov');
    put('renders/out.mp4.part');
    expect(videoStatus(dir)).toBe('editing');
    put('renders/preview.MOV');
    expect(videoStatus(dir)).toBe('done');
  });

  it('posted: a successful publish result', () => {
    put('renders/final.mp4');
    put('.solocut/publish-result.json', JSON.stringify({ id: '1', results: [{ target: 'youtube', ok: false }, { target: 'tiktok', ok: true }] }));
    expect(videoStatus(dir)).toBe('posted');
  });

  it('a failed publish result is not posted', () => {
    put('renders/final.mp4');
    put('.solocut/publish-result.json', JSON.stringify({ id: '1', results: [{ target: 'youtube', ok: false, error: 'x' }] }));
    expect(videoStatus(dir)).toBe('done');
  });

  it('posted: the publish step is done in status.json (object or array form)', () => {
    put('.solocut/status.json', JSON.stringify({ steps: [{ step: 'publish', state: 'done' }] }));
    expect(videoStatus(dir)).toBe('posted');
    put('.solocut/status.json', JSON.stringify([{ step: 'publish', state: 'done' }]));
    expect(videoStatus(dir)).toBe('posted');
    put('.solocut/status.json', JSON.stringify({ steps: [{ step: 'publish', state: 'todo' }] }));
    expect(videoStatus(dir)).toBe('new');
  });

  it.each(['not json', 'null', '[]', '{"results":"x"}', '{"results":[null,1,"a"]}'])('broken publish files are ignored: %s', (txt) => {
    put('.solocut/publish-result.json', txt);
    put('.solocut/status.json', txt);
    put('timeline.json', txt);
    expect(videoStatus(dir)).toBe('new');
  });

  it('readVideo carries status and a time', () => {
    put('renders/final.mp4');
    const v = readVideo(dir, 'name');
    expect(v).toMatchObject({ dir, name: 'name', title: 'name', status: 'done' });
    expect(v.updatedAt).toBeGreaterThan(0);
  });
});

describe('videosRootChosen (first-run question)', () => {
  it('false until videos.root is in settings.json', () => {
    expect(videosRootChosen({})).toBe(false);
    expect(videosRootChosen(null)).toBe(false);
    expect(videosRootChosen('x')).toBe(false);
    expect(videosRootChosen({ videos: null })).toBe(false);
    expect(videosRootChosen({ videos: {} })).toBe(false);
    expect(videosRootChosen({ videos: { root: '' } })).toBe(false);
    expect(videosRootChosen({ videos: { root: '  ' } })).toBe(false);
    expect(videosRootChosen({ videos: { root: 3 } })).toBe(false);
  });

  it('true once chosen (the default counts when it was saved)', () => {
    expect(videosRootChosen({ videos: { root: '/Volumes/SSD/v' } })).toBe(true);
    expect(videosRootChosen({ videos: { root: DEFAULT_VIDEOS_ROOT } })).toBe(true);
  });
});

describe('latestRender (preview vs final)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solocut-lr-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, when: number) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x');
    utimesSync(p, new Date(when), new Date(when));
    return p;
  };

  it('nothing rendered → null', () => {
    expect(latestRender(dir)).toBeNull();
  });

  it('a final.mp4 newer than the preview wins', () => {
    put('renders/youtube/preview.mp4', 1_000_000);
    const fin = put('renders/youtube/final.mp4', 2_000_000);
    expect(latestRender(dir)?.path).toBe(fin);
  });

  it('a preview newer than the final wins (re-edited after finishing)', () => {
    put('renders/youtube/final.mp4', 1_000_000);
    const prev = put('renders/preview.mp4', 2_000_000);
    expect(latestRender(dir)).toEqual({ path: prev, mtimeMs: 2_000_000 });
  });

  it('on a tie the final wins', () => {
    put('renders/youtube/preview.mp4', 1_000_000);
    const fin = put('renders/youtube/final.mp4', 1_000_000);
    expect(latestRender(dir)?.path).toBe(fin);
  });

  it('only a preview, or only a final', () => {
    const prev = put('renders/preview/preview.mp4', 1_000_000);
    expect(latestRender(dir)?.path).toBe(prev);
    rmSync(join(dir, 'renders'), { recursive: true });
    const fin = put('renders/final.mp4', 1_000_000);
    expect(latestRender(dir)?.path).toBe(fin);
  });

  it('falls back to the newest video under renders/, skipping vertical variants and partial files', () => {
    put('renders/a.mp4', 1_000_000);
    const b = put('renders/sub/b.mov', 2_000_000);
    put('renders/tiktok/c.mp4', 3_000_000);
    put('renders/d.mp4.part', 4_000_000);
    expect(latestRender(dir)?.path).toBe(b);
  });

  it('a variant uses its own preview and final', () => {
    put('renders/youtube/final.mp4', 9_000_000);
    put('renders/tiktok/preview.mp4', 1_000_000);
    const fin = put('renders/tiktok/final.mp4', 2_000_000);
    expect(latestRender(dir, 'tiktok')?.path).toBe(fin);
    expect(finalCandidates('tiktok')).toContain('renders/tiktok/final.mp4');
  });
});

describe('takeChange (media/takes watcher filter)', () => {
  it.each([
    ['take-2026-10-11-0905', 'takes'],
    ['take-1/take.json', 'takes'],
    ['take-1\\take.json', 'takes'],
    ['take.json', 'takes'],
    ['a/b/take.json', 'takes'],
  ])('%s → takes', (name, out) => {
    expect(takeChange(name)).toBe(out);
  });

  it.each([null, '', '/', 'take-1/screen.mov', 'take-1/camera-1.mp4', 'take-1/mic.wav', 'screen.mov', 'take-1/take.json.tmp', '.DS_Store', 'take-1/.take.json.swp', '.tmp/take.json'])(
    'ignores %j',
    (name) => {
      expect(takeChange(name)).toBeNull();
    },
  );
});
