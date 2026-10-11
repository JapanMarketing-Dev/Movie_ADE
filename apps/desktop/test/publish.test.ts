import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DEFAULTS,
  DEFAULT_VIDEO,
  publishDefaultsFrom,
  withPrivacy,
  alreadyPublished,
  fixRequestText,
  issueBlocks,
  issueText,
  isRequestId,
  libNameFor,
  nextOffsetFromRange,
  okState,
  parseProgress,
  parsePublishJson,
  parsePublishLog,
  parsePublishRequest,
  parsePublishResult,
  parseTags,
  requestIsStale,
  resultOk,
  safeRelPath,
  tagsLength,
  targetsToUpload,
  utf8Bytes,
  withThumbnail,
  youtubeVideoResource,
  REQUEST_TTL_MS,
  SENT_HOLD_MS,
  type PublishAccounts,
  type PublishSpec,
  type PublishView,
} from '../src/shared/publish';
import { authUrl, challengeS256, channelTitle, newVerifier, parseCallback, refreshRequestBody, tokenRequestBody } from '../src/main/publish/oauth';

const NOW = new Date('2026-10-11T00:00:00Z');
const parse = (o: unknown) => parsePublishJson(typeof o === 'string' ? o : JSON.stringify(o), NOW);
const codes = (o: unknown, level?: 'error' | 'warning') =>
  parse(o)
    .issues.filter((i) => !level || i.level === level)
    .map((i) => `${i.field}:${i.code}`);
const good = { video: 'renders/final.mp4', title: 'Claude Code の設定 3つのコツ', description: '説明', tags: ['claude', 'AI'], youtube: { privacy: 'unlisted' } };

describe('publish.json: never throws, shape errors', () => {
  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    ['{', 'invalid-json'],
    ['{"a":1,}', 'invalid-json'],
    ['null', 'not-object'],
    ['[]', 'not-object'],
    ['"text"', 'not-object'],
    ['42', 'not-object'],
  ])('%j → %s', (text, code) => {
    const r = parsePublishJson(text, NOW);
    expect(r.spec).toBeNull();
    expect(r.issues).toEqual([expect.objectContaining({ level: 'error', field: '$', code })]);
  });
  it('accepts a BOM and an already parsed object', () => {
    expect(parsePublishJson('\uFEFF' + JSON.stringify(good), NOW).spec?.title).toBe(good.title);
    expect(parsePublishJson(good, NOW).spec?.title).toBe(good.title);
  });
  it('a complete file has no errors and no warnings', () => {
    expect(parse(good).issues).toEqual([]);
  });
  it('fills safe defaults with warnings for a minimal file', () => {
    const r = parse({ title: 't' });
    expect(r.spec).toMatchObject({
      video: DEFAULT_VIDEO,
      description: '',
      tags: [],
      youtube: { enabled: true, categoryId: '28', privacy: 'private', madeForKids: false, containsSyntheticMedia: false, chapters: true, language: 'ja' },
      tiktok: { enabled: false, privacy: 'SELF_ONLY', allowComment: false, allowDuet: false, allowStitch: false, isAigc: false },
    });
    expect(codes({ title: 't' }, 'error')).toEqual([]);
    expect(codes({ title: 't' }, 'warning')).toEqual(['video:default', 'youtube.privacy:default']);
  });
  it('warns about unknown fields at every level but keeps going', () => {
    expect(codes({ ...good, extra: 1, youtube: { privacy: 'public', foo: 1 }, tiktok: { bar: 2 } }, 'warning')).toEqual([
      'extra:unknown-field',
      'youtube.foo:unknown-field',
      'tiktok.bar:unknown-field',
    ]);
  });
  it('wrong types are coerced or ignored, never thrown', () => {
    const r = parse({ ...good, title: 123, description: ['x'], tags: 'a, #b, a', youtube: { privacy: 'PUBLIC', madeForKids: 'true', chapters: 3 }, tiktok: 'yes' });
    expect(r.spec).toMatchObject({ title: '123', description: '', tags: ['a', 'b'], youtube: { privacy: 'public', madeForKids: true, chapters: true }, tiktok: { enabled: false } });
    expect(r.issues.map((i) => `${i.field}:${i.code}`)).toEqual(
      expect.arrayContaining(['title:coerced', 'description:wrong-type', 'tags:coerced', 'youtube.madeForKids:coerced', 'youtube.chapters:wrong-type', 'tiktok:wrong-type']),
    );
  });
  it('null sections are treated as missing', () => {
    expect(parse({ ...good, youtube: null, tiktok: null, thumbnail: null }).spec?.youtube.enabled).toBe(true);
  });
});

describe('publish.json: paths', () => {
  it.each([
    ['renders/final.mp4', 'renders/final.mp4'],
    ['./renders//final.mp4', 'renders/final.mp4'],
    ['renders\\final.mp4', 'renders/final.mp4'],
    ['a/../renders/final.mp4', 'renders/final.mp4'],
    ['../outside.mp4', null],
    ['a/../../x.mp4', null],
    ['/abs/final.mp4', null],
    ['C:/x.mp4', null],
    ['', null],
    ['.', null],
    ['a\0b', null],
  ])('safeRelPath(%j) = %j', (p, want) => {
    expect(safeRelPath(p)).toBe(want);
  });
  it('a video path outside the project is an error that blocks every target', () => {
    const r = parse({ ...good, video: '../../etc/passwd' });
    const issue = r.issues.find((i) => i.field === 'video')!;
    expect(issue).toMatchObject({ level: 'error', code: 'bad-path' });
    expect(issueBlocks(issue, 'youtube')).toBe(true);
    expect(issueBlocks(issue, 'tiktok')).toBe(true);
  });
  it('non-video extension is a warning', () => {
    expect(codes({ ...good, video: 'renders/final.gif' }, 'warning')).toEqual(['video:not-video']);
  });
  it('thumbnail: optional, png/jpg only, inside the project', () => {
    expect(parse({ ...good, thumbnail: 'thumbnails/thumb-1.png' }).spec?.thumbnail).toBe('thumbnails/thumb-1.png');
    expect(parse({ ...good, thumbnail: 'thumbnails/a.JPEG' }).spec?.thumbnail).toBe('thumbnails/a.JPEG');
    expect(parse({ ...good, thumbnail: '' }).spec?.thumbnail).toBeUndefined();
    expect(codes({ ...good, thumbnail: 'thumbnails/a.webp' }, 'warning')).toEqual(['thumbnail:not-image']);
    expect(codes({ ...good, thumbnail: '/tmp/a.png' }, 'warning')).toEqual(['thumbnail:bad-path']);
    expect(codes({ ...good, thumbnail: 5 }, 'warning')).toEqual(['thumbnail:bad-path']);
    expect(parse({ ...good, thumbnail: '../a.png' }).spec?.thumbnail).toBeUndefined();
  });
});

describe('publish.json: YouTube limits', () => {
  it('title: required, 100 code points, no < >', () => {
    expect(codes({ ...good, title: '  ' }, 'error')).toEqual(['title:required']);
    expect(codes({ ...good, title: 'あ'.repeat(100) }, 'error')).toEqual([]);
    expect(codes({ ...good, title: '😀'.repeat(100) }, 'error')).toEqual([]);
    expect(codes({ ...good, title: 'a'.repeat(101) }, 'error')).toEqual(['title:too-long']);
    expect(codes({ ...good, title: 'a <b>' }, 'error')).toEqual(['title:angle-brackets']);
    expect(codes({ ...good, title: 'a > b' }, 'error')).toEqual(['title:angle-brackets']);
  });
  it('title is trimmed before counting', () => {
    expect(codes({ ...good, title: `  ${'a'.repeat(100)}  ` }, 'error')).toEqual([]);
  });
  it('description: 5000 UTF-8 bytes, no < >', () => {
    expect(codes({ ...good, description: 'a'.repeat(5000) }, 'error')).toEqual([]);
    expect(codes({ ...good, description: 'a'.repeat(5001) }, 'error')).toEqual(['description:too-long']);
    expect(codes({ ...good, description: 'あ'.repeat(1666) + 'aa' }, 'error')).toEqual([]); // 5000 bytes
    expect(codes({ ...good, description: 'あ'.repeat(1667) }, 'error')).toEqual(['description:too-long']); // 5001
    expect(codes({ ...good, description: '<script>' }, 'error')).toEqual(['description:angle-brackets']);
  });
  it('description CRLF is normalized (byte count of what is sent)', () => {
    expect(parse({ ...good, description: 'a\r\nb' }).spec?.description).toBe('a\nb');
  });
  it('tags: 500 characters total, YouTube counting', () => {
    expect(tagsLength(['ab', 'c d'])).toBe(2 + 1 + 3 + 2);
    const fits = Array.from({ length: 50 }, (_, i) => `t${String(i).padStart(7, '0')}`); // 50*8 + 49 commas = 449
    expect(codes({ ...good, tags: fits }, 'error')).toEqual([]);
    const at500 = ['a'.repeat(500)];
    expect(codes({ ...good, tags: at500 }, 'error')).toEqual([]);
    expect(codes({ ...good, tags: ['a'.repeat(501)] }, 'error')).toEqual(['tags:too-long']);
    expect(codes({ ...good, tags: ['a'.repeat(497) + ' b'] }, 'error')).toEqual(['tags:too-long']); // 499 + 2 quotes
    expect(codes({ ...good, tags: ['<x>'] }, 'error')).toEqual(['tags:angle-brackets']);
  });
  it('tags are trimmed, de-duplicated case-insensitively, # removed, non-strings dropped', () => {
    const r = parse({ ...good, tags: [' AI ', 'ai', '#動画', '##x', '', 3, null] });
    expect(r.spec?.tags).toEqual(['AI', '動画', 'x']);
    expect(codes({ ...good, tags: ['a', 3] }, 'warning')).toEqual(['tags:wrong-type']);
    expect(parseTags('#AI, claude、AI\n  動画 編集 ,')).toEqual(['AI', 'claude', '動画 編集']);
  });
  it('YouTube limits do not apply when YouTube is off', () => {
    expect(codes({ ...good, title: '', youtube: { enabled: false }, tiktok: { enabled: true, caption: 'c' } }, 'error')).toEqual([]);
  });
  it('privacy: unknown value → private with a warning', () => {
    const r = parse({ ...good, youtube: { privacy: 'friends' } });
    expect(r.spec?.youtube.privacy).toBe('private');
    expect(r.issues.map((i) => i.code)).toEqual(['invalid']);
  });
  it('categoryId: digits only (numbers accepted), else 28', () => {
    expect(parse({ ...good, youtube: { privacy: 'public', categoryId: 27 } }).spec?.youtube.categoryId).toBe('27');
    expect(parse({ ...good, youtube: { privacy: 'public', categoryId: 'Education' } }).spec?.youtube.categoryId).toBe('28');
    expect(parse({ ...good, youtube: { privacy: 'public', categoryId: '1234' } }).spec?.youtube.categoryId).toBe('28');
  });
  it('schedule: future ISO forces private; past or invalid is an error', () => {
    const r = parse({ ...good, youtube: { privacy: 'public', publishAt: '2026-10-12T09:00:00+09:00' } });
    expect(r.spec?.youtube).toMatchObject({ privacy: 'private', publishAt: '2026-10-12T00:00:00.000Z' });
    expect(r.issues.map((i) => `${i.field}:${i.code}`)).toEqual(['youtube.privacy:scheduled-private']);
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: '2026-10-10T00:00:00Z' } }, 'error')).toEqual(['youtube.publishAt:past']);
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: NOW.toISOString() } }, 'error')).toEqual(['youtube.publishAt:past']);
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: 'tomorrow' } }, 'error')).toEqual(['youtube.publishAt:invalid']);
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: 12 } }, 'error')).toEqual(['youtube.publishAt:invalid']);
    expect(parse({ ...good, youtube: { privacy: 'private', publishAt: '' } }).spec?.youtube.publishAt).toBeUndefined();
  });
  it('builds the videos.insert resource', () => {
    const spec = parse({ ...good, youtube: { privacy: 'unlisted', containsSyntheticMedia: true, language: 'en' } }).spec!;
    expect(youtubeVideoResource(spec)).toEqual({
      snippet: { title: good.title, description: '説明', tags: ['claude', 'AI'], categoryId: '28', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    });
    const sched = parse({ ...good, youtube: { publishAt: '2026-11-01T00:00:00Z' } }).spec!;
    expect(youtubeVideoResource(sched).status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false, publishAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('publish.json: TikTok', () => {
  it('caption 2200 UTF-16 units', () => {
    const on = (caption: string) => ({ ...good, tiktok: { enabled: true, caption } });
    expect(codes(on('a'.repeat(2200)), 'error')).toEqual([]);
    expect(codes(on('a'.repeat(2201)), 'error')).toEqual(['tiktok.caption:too-long']);
    expect(codes(on('😀'.repeat(1100)), 'error')).toEqual([]); // 2200 units
    expect(codes(on('😀'.repeat(1101)), 'error')).toEqual(['tiktok.caption:too-long']);
  });
  it('a long caption does not matter while TikTok is off', () => {
    expect(codes({ ...good, tiktok: { enabled: false, caption: 'a'.repeat(3000) } }, 'error')).toEqual([]);
  });
  it('missing caption → title + hashtags with a warning', () => {
    const r = parse({ ...good, tags: ['AI', '動画 編集'], tiktok: { enabled: true } });
    expect(r.spec?.tiktok.caption).toBe(`${good.title}\n#AI #動画編集`);
    expect(r.issues.map((i) => `${i.field}:${i.code}`)).toEqual(['tiktok.caption:default']);
  });
  it('privacy: case-insensitive; unknown → SELF_ONLY', () => {
    expect(parse({ ...good, tiktok: { privacy: 'public_to_everyone' } }).spec?.tiktok.privacy).toBe('PUBLIC_TO_EVERYONE');
    expect(parse({ ...good, tiktok: { privacy: 'everyone' } }).spec?.tiktok.privacy).toBe('SELF_ONLY');
  });
  it('TikTok errors block only TikTok; YouTube errors only YouTube', () => {
    const r = parse({ ...good, title: '', tiktok: { enabled: true, caption: 'a'.repeat(2201) } });
    const tt = r.issues.find((i) => i.field === 'tiktok.caption')!;
    const yt = r.issues.find((i) => i.field === 'title')!;
    expect([issueBlocks(tt, 'tiktok'), issueBlocks(tt, 'youtube')]).toEqual([true, false]);
    expect([issueBlocks(yt, 'tiktok'), issueBlocks(yt, 'youtube')]).toEqual([false, true]);
    expect(issueBlocks({ level: 'warning', field: 'video', code: 'x' }, 'youtube')).toBe(false);
  });
  it('both targets off is a warning', () => {
    expect(codes({ ...good, youtube: { enabled: false } }, 'warning')).toEqual(['$:no-target']);
  });
});

describe('targets and helpers', () => {
  const spec = (yt: boolean, tt: boolean) => parse({ ...good, youtube: { privacy: 'public', enabled: yt }, tiktok: { enabled: tt, caption: 'c' } }).spec!;
  it('targetsToUpload: publish.json decides; a request narrows', () => {
    expect(targetsToUpload(spec(true, true))).toEqual(['youtube', 'tiktok']);
    expect(targetsToUpload(spec(true, false))).toEqual(['youtube']);
    expect(targetsToUpload(spec(true, true), ['tiktok'])).toEqual(['tiktok']);
    expect(targetsToUpload(spec(true, false), ['tiktok'])).toEqual([]); // requested but turned off
    expect(targetsToUpload(spec(false, false))).toEqual([]);
  });
  it('withThumbnail keeps unknown fields', () => {
    expect(withThumbnail({ title: 'x', custom: 1 }, 'thumbnails/a.png')).toEqual({ title: 'x', custom: 1, thumbnail: 'thumbnails/a.png' });
    expect(withThumbnail({ title: 'x', thumbnail: 'a.png' }, null)).toEqual({ title: 'x' });
    expect(withThumbnail(null, 'a.png')).toEqual({ thumbnail: 'a.png' });
    expect(withThumbnail([1], 'a.png')).toEqual({ thumbnail: 'a.png' });
  });
  it('issueText in both languages', () => {
    expect(issueText({ level: 'error', field: 'title', code: 'too-long', detail: '101/100' })).toBe('title: 長すぎます (101/100)');
    expect(issueText({ level: 'error', field: '$', code: 'invalid-json' }, 'en')).toBe('publish.json: Not valid JSON');
    expect(issueText({ level: 'error', field: 'x', code: 'weird' }, 'en')).toBe('x: weird');
  });
  it('fixRequestText', () => {
    expect(fixRequestText('タイトルを短く')).toBe('publish.json を「タイトルを短く」に直して');
    expect(fixRequestText('  a \n  b ')).toBe('publish.json を「a b」に直して');
    expect(fixRequestText('')).toBe('publish.json を見直して、問題があれば直して');
    expect(fixRequestText('x'.repeat(900)).length).toBeLessThan(530);
  });
  it('utf8 and offsets', () => {
    expect(utf8Bytes('aあ😀')).toBe(1 + 3 + 4);
    expect(nextOffsetFromRange('bytes=0-8388607')).toBe(8388608);
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(nextOffsetFromRange('garbage')).toBe(0);
  });
});

describe('hand-off request / result parsing', () => {
  const id = 'a1b2c3d4-0000-4000-8000-000000000000';
  it('request ids', () => {
    expect(isRequestId(id)).toBe(true);
    expect(isRequestId('short')).toBe(false);
    expect(isRequestId('../../etc')).toBe(false);
    expect(isRequestId('x'.repeat(65))).toBe(false);
    expect(isRequestId(5)).toBe(false);
  });
  it('parses a request; rejects malformed ones', () => {
    expect(parsePublishRequest({ id, targets: ['youtube', 'youtube', 'x'], at: NOW.toISOString() })).toEqual({ id, targets: ['youtube'], at: NOW.toISOString() });
    expect(parsePublishRequest(JSON.stringify({ id, targets: [], at: NOW.toISOString(), force: true }))).toEqual({ id, targets: [], at: NOW.toISOString(), force: true });
    expect(parsePublishRequest({ id, at: NOW.toISOString(), force: 'yes' })).toEqual({ id, targets: [], at: NOW.toISOString() });
    expect(parsePublishRequest({ id, targets: ['instagram'], at: NOW.toISOString() })).toBeNull();
    expect(parsePublishRequest({ id, targets: [] })).toBeNull();
    expect(parsePublishRequest({ id, targets: [], at: 'never' })).toBeNull();
    expect(parsePublishRequest({ id: 'bad id', targets: [], at: NOW.toISOString() })).toBeNull();
    expect(parsePublishRequest('{broken')).toBeNull();
    expect(parsePublishRequest(null)).toBeNull();
    expect(parsePublishRequest([])).toBeNull();
  });
  it('stale requests', () => {
    const req = { id, targets: [], at: NOW.toISOString() };
    expect(requestIsStale(req, NOW.getTime() + REQUEST_TTL_MS)).toBe(false);
    expect(requestIsStale(req, NOW.getTime() + REQUEST_TTL_MS + 1)).toBe(true);
    expect(requestIsStale({ ...req, at: 'x' }, NOW.getTime())).toBe(true);
  });
  it('parses results; the SPEC minimal shape counts as done', () => {
    expect(parsePublishResult({ id, results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/x' }] })).toEqual({
      id,
      state: 'done',
      at: '',
      results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/x' }],
    });
    const r = parsePublishResult({ id, state: 'running', at: 'a', progress: { target: 'tiktok', phase: 'upload', fraction: 1.7 }, results: [{ target: 'x', ok: true }, { target: 'youtube' }, 5] });
    expect(r).toEqual({ id, state: 'running', at: 'a', progress: { target: 'tiktok', phase: 'upload', fraction: 1 }, results: [] });
    expect(parsePublishResult({ id, results: 'no' })?.results).toEqual([]);
    expect(parsePublishResult({ id: 'no', results: [] })).toBeNull();
    expect(parsePublishResult('}{')).toBeNull();
    expect(parsePublishResult({ id, error: 'x', results: [{ target: 'tiktok', ok: false, error: 'e', status: 'bogus', alreadyPublished: 'yes', warnings: ['w', 1] }] })).toEqual({
      id,
      state: 'done',
      at: '',
      error: 'x',
      results: [{ target: 'tiktok', ok: false, error: 'e', warnings: ['w'] }],
    });
  });
  it('resultOk', () => {
    const base = { id, at: '', results: [] };
    expect(resultOk({ ...base, state: 'done' })).toBe(false);
    expect(resultOk({ ...base, state: 'running', results: [{ target: 'youtube', ok: true }] })).toBe(false);
    expect(resultOk({ ...base, state: 'done', results: [{ target: 'youtube', ok: true }, { target: 'tiktok', ok: false }] })).toBe(false);
    expect(resultOk({ ...base, state: 'done', results: [{ target: 'youtube', ok: true }] })).toBe(true);
  });
  it('publish log and the double-upload match (path and size)', () => {
    const log = parsePublishLog({
      entries: [
        { target: 'youtube', video: 'renders/final.mp4', size: 10, url: 'u1', requestId: 'r', at: '', status: 'published' },
        { target: 'youtube', video: 'renders/final.mp4', size: 10, url: 'u2', requestId: 'r', at: '', status: 'published' },
        { target: 'nope', video: 'x', size: 1, requestId: 'r' },
        'junk',
      ],
    });
    expect(log).toHaveLength(2);
    expect(alreadyPublished(log, 'youtube', 'renders/final.mp4', 10)?.url).toBe('u2'); // latest
    expect(alreadyPublished(log, 'youtube', 'renders/final.mp4', 11)).toBeNull(); // re-rendered
    expect(alreadyPublished(log, 'tiktok', 'renders/final.mp4', 10)).toBeNull();
    expect(parsePublishLog('{oops')).toEqual([]);
    expect(parsePublishLog({ entries: 3 })).toEqual([]);
  });
});

describe('OK button state', () => {
  const spec = (tt = false): PublishSpec => parse({ ...good, tiktok: { enabled: tt, caption: 'c' } }).spec!;
  const view = (p: Partial<PublishView> = {}): PublishView => ({
    exists: true,
    spec: spec(),
    issues: [],
    videoPath: '/p/renders/final.mp4',
    request: null,
    result: null,
    log: [],
    published: {},
    ...p,
  });
  const acc = (yt: boolean, tt: { configured: boolean; connected: boolean } = { configured: false, connected: false }): PublishAccounts => ({
    youtube: { configured: true, connected: yt },
    tiktok: tt,
  });
  const now = NOW.getTime();
  it('ready', () => {
    expect(okState(view(), acc(true), null, now)).toEqual({ kind: 'ready', targets: ['youtube'] });
  });
  it('issues do not block (the agent fixes them first)', () => {
    expect(okState(view({ issues: [{ level: 'error', field: 'title', code: 'too-long' }] }), acc(true), null, now).kind).toBe('ready');
  });
  it('no file / no spec / no video / no target', () => {
    expect(okState(null, acc(true), null, now).kind).toBe('no-file');
    expect(okState(view({ exists: false, spec: null }), acc(true), null, now).kind).toBe('no-file');
    expect(okState(view({ spec: null }), acc(true), null, now).kind).toBe('no-file');
    const { videoPath: _v, ...noVideo } = view();
    expect(okState(noVideo as PublishView, acc(true), null, now).kind).toBe('no-video');
    expect(okState(view({ spec: { ...spec(), youtube: { ...spec().youtube, enabled: false } } }), acc(true), null, now).kind).toBe('no-target');
  });
  it('needs the YouTube account; TikTok only when it can connect', () => {
    expect(okState(view(), acc(false), null, now)).toEqual({ kind: 'connect', target: 'youtube' });
    expect(okState(view({ spec: spec(true) }), acc(true, { configured: true, connected: false }), null, now)).toEqual({ kind: 'connect', target: 'tiktok' });
    // TikTok not available in this build: not blocking (manual upload button instead)
    expect(okState(view({ spec: spec(true) }), acc(true), null, now)).toEqual({ kind: 'ready', targets: ['youtube', 'tiktok'] });
    // accounts not loaded yet: do not block
    expect(okState(view(), null, null, now).kind).toBe('ready');
  });
  it('holds after sending, then releases', () => {
    expect(okState(view(), acc(true), now - 1000, now).kind).toBe('sent');
    expect(okState(view(), acc(true), now - SENT_HOLD_MS, now).kind).toBe('ready');
  });
  it('running upload (fresh) blocks; a stale running result does not', () => {
    const running = { id: 'abcdefgh1', state: 'running' as const, at: NOW.toISOString(), results: [] };
    expect(okState(view({ result: running }), acc(true), null, now).kind).toBe('running');
    expect(okState(view({ result: running }), acc(true), null, now + 31 * 60_000).kind).toBe('ready');
    // a newer request than the running result: not this run
    expect(okState(view({ result: running, request: { id: 'zzzzzzzz9', targets: [], at: '' } }), acc(true), null, now).kind).toBe('ready');
  });
  it('already published targets are not offered again', () => {
    const e = { target: 'youtube' as const, video: 'renders/final.mp4', size: 1, requestId: 'r', at: '', status: 'published' as const };
    expect(okState(view({ published: { youtube: e } }), acc(false), null, now).kind).toBe('published');
    expect(okState(view({ spec: spec(true), published: { youtube: e } }), acc(false), null, now)).toEqual({ kind: 'ready', targets: ['tiktok'] });
  });
});

describe('library', () => {
  it('maps tools to lib install names', () => {
    expect(['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-model', 'whisper-model-small', 'x'].map(libNameFor)).toEqual(['ffmpeg', 'ffmpeg', 'whisper', 'whisper', 'whisper-small', null]);
  });
  it('parses progress lines', () => {
    expect(parseProgress('{"progress":{"tool":"ffmpeg","received":50,"total":200}}')).toBe(0.25);
    expect(parseProgress('{"progress":{"fraction":2}}')).toBe(1);
    expect(parseProgress('downloading ffmpeg  42.5%')).toBe(0.425);
    expect(parseProgress('done')).toBeNull();
    expect(parseProgress('150%')).toBeNull();
    expect(parseProgress('{"progress":{"received":1,"total":0}}')).toBeNull();
  });
});

describe('Google OAuth (installed app, PKCE)', () => {
  it('verifier and S256 challenge', () => {
    const v = newVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // RFC 7636 appendix B
    expect(challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('auth URL carries PKCE, offline access and the loopback redirect', () => {
    const u = new URL(authUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', challenge: 'ch', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'cid', redirect_uri: 'http://127.0.0.1:5555', response_type: 'code', code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', access_type: 'offline',
    });
    expect(u.searchParams.get('scope')).toContain('youtube.upload');
    expect(u.searchParams.get('scope')).toContain('youtube.force-ssl');
  });
  it('parses the loopback callback', () => {
    expect(parseCallback('/?code=abc&state=s1', 's1')).toEqual({ ok: true, code: 'abc' });
    expect(parseCallback('/callback/?code=abc&state=s1', 's1')).toEqual({ ok: true, code: 'abc' });
    expect(parseCallback('/?code=abc&state=evil', 's1')).toEqual({ ok: false, error: 'state mismatch' });
    expect(parseCallback('/?code=abc', 's1')).toEqual({ ok: false, error: 'state mismatch' });
    expect(parseCallback('/?error=access_denied&state=s1', 's1')).toEqual({ ok: false, error: 'access_denied' });
    expect(parseCallback('/favicon.ico', 's1')).toEqual({ ok: 'ignore' });
    expect(parseCallback('/?state=s1', 's1')).toEqual({ ok: false, error: 'no code' });
  });
  it('token request bodies', () => {
    const b = tokenRequestBody({ clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1' });
    expect(b.get('grant_type')).toBe('authorization_code');
    expect(b.has('client_secret')).toBe(false);
    expect(refreshRequestBody({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }).toString()).toBe('client_id=c&refresh_token=r&grant_type=refresh_token&client_secret=s');
  });
  it('channel title from channels.list', () => {
    expect(channelTitle({ items: [{ snippet: { title: 'My Channel' } }] })).toBe('My Channel');
    expect(channelTitle({ items: [] })).toBeNull();
    expect(channelTitle({ items: [{ snippet: { title: '' } }] })).toBeNull();
    expect(channelTitle(null)).toBeNull();
    expect(channelTitle({ items: 'x' })).toBeNull();
  });
});

describe('default visibility from settings', () => {
  const D = { youtubePrivacy: 'unlisted', tiktokPrivacy: 'FOLLOWER_OF_CREATOR' } as const;
  it('publishDefaultsFrom reads settings defensively', () => {
    expect(publishDefaultsFrom({ publish: { youtube: { privacy: 'public' }, tiktok: { privacy: 'PUBLIC_TO_EVERYONE' } } })).toEqual({ youtubePrivacy: 'public', tiktokPrivacy: 'PUBLIC_TO_EVERYONE' });
    expect(publishDefaultsFrom({})).toEqual(BUILTIN_DEFAULTS);
    expect(publishDefaultsFrom(null)).toEqual({ youtubePrivacy: 'private', tiktokPrivacy: 'SELF_ONLY' });
    expect(publishDefaultsFrom({ publish: { youtube: { privacy: 'friends' }, tiktok: { privacy: 'self_only' } } })).toEqual(BUILTIN_DEFAULTS);
    expect(publishDefaultsFrom({ publish: 'x' })).toEqual(BUILTIN_DEFAULTS);
  });
  it('missing privacy in publish.json → the setting, marked as defaulted', () => {
    const r = parsePublishJson({ title: 't', tiktok: { enabled: true, caption: 'c' } }, NOW, D);
    expect(r.spec?.youtube).toMatchObject({ privacy: 'unlisted', privacyDefaulted: true });
    expect(r.spec?.tiktok).toMatchObject({ privacy: 'FOLLOWER_OF_CREATOR', privacyDefaulted: true });
    expect(r.issues).toContainEqual({ level: 'warning', field: 'youtube.privacy', code: 'default', detail: 'unlisted' });
  });
  it('publish.json wins over the setting', () => {
    const r = parsePublishJson({ title: 't', youtube: { privacy: 'public' }, tiktok: { privacy: 'SELF_ONLY' } }, NOW, D);
    expect(r.spec?.youtube).toMatchObject({ privacy: 'public', privacyDefaulted: false });
    expect(r.spec?.tiktok).toMatchObject({ privacy: 'SELF_ONLY', privacyDefaulted: false });
  });
  it('an invalid value in publish.json falls back to the setting (not to public)', () => {
    const r = parsePublishJson({ title: 't', youtube: { privacy: 'everyone' }, tiktok: { privacy: 7 } }, NOW, D);
    expect(r.spec?.youtube).toMatchObject({ privacy: 'unlisted', privacyDefaulted: true });
    expect(r.spec?.tiktok).toMatchObject({ privacy: 'FOLLOWER_OF_CREATOR', privacyDefaulted: true });
  });
  it('a schedule still forces private whatever the setting says', () => {
    const r = parsePublishJson({ title: 't', youtube: { publishAt: '2026-11-01T00:00:00Z' } }, NOW, { ...D, youtubePrivacy: 'public' });
    expect(r.spec?.youtube.privacy).toBe('private');
  });
  it('withPrivacy writes one target and keeps the rest', () => {
    expect(withPrivacy({ title: 'x', youtube: { categoryId: '27' }, extra: 1 }, 'youtube', 'public')).toEqual({ title: 'x', youtube: { categoryId: '27', privacy: 'public' }, extra: 1 });
    expect(withPrivacy({ tiktok: 'bad' }, 'tiktok', 'MUTUAL_FOLLOW_FRIENDS')).toEqual({ tiktok: { privacy: 'MUTUAL_FOLLOW_FRIENDS' } });
    expect(withPrivacy({}, 'youtube', 'SELF_ONLY')).toBeNull();
    expect(withPrivacy({}, 'tiktok', 'public')).toBeNull();
    expect(withPrivacy(null, 'youtube', 'private')).toEqual({ youtube: { privacy: 'private' } });
  });
});
