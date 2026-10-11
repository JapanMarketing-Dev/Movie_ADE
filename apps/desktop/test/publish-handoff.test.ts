import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { PublishHandoff, PublishWatcher, readLog, readResult, type HandoffDeps, type UploadContext, type UploadOutcome } from '../src/main/publish/handoff';
import { loadView, projectRel, setThumbnail } from '../src/main/publish/publish';
import { listThumbnails } from '../src/main/services/thumbs';
import { mergeEnv, tiktokClientFrom, youtubeClientFrom } from '../src/main/publish/config';
import { dotenvValue, googleClientFromJson, publishDefines, tiktokEnvFileName } from '../src/main/publish/buildEnv';
import { loopbackAuthorize } from '../src/main/publish/loopback';
import {
  TT_MAX_CHUNK,
  TT_MIN_CHUNK,
  TIKTOK_REDIRECT_URI,
  contentTypeFor,
  exchangeUrl,
  directInitBody,
  inboxInitBody,
  interpretStatus,
  parseStoredTokens,
  parseTikTokToken,
  tiktokAuthUrl,
  tiktokChallenge,
  tiktokChunkPlan,
  tiktokData,
  tiktokScopes,
  tiktokTokenBody,
  tiktokVerifier,
  tiktokVideoUrl,
} from '../src/main/publish/tiktokApi';
import { parsePublishJson, REQUEST_TTL_MS } from '../src/shared/publish';

const NOW = Date.parse('2026-10-11T00:00:00Z');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solocut-pub-'));
  mkdirSync(join(dir, 'renders'), { recursive: true });
  mkdirSync(join(dir, '.solocut'), { recursive: true });
  writeFileSync(join(dir, 'renders', 'final.mp4'), Buffer.alloc(1000, 1));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ID = 'req-00000001';
const writeSpec = (o: unknown) => writeFileSync(join(dir, 'publish.json'), typeof o === 'string' ? o : JSON.stringify(o));
const writeReq = (o: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, '.solocut', 'publish-request.json'), JSON.stringify({ id: ID, targets: [], at: new Date(NOW).toISOString(), ...o }));
const spec = { video: 'renders/final.mp4', title: 'タイトル', description: 'd', tags: ['a'], youtube: { privacy: 'unlisted' } };

function deps(over: Partial<Record<'youtube' | 'tiktok', (c: UploadContext) => Promise<UploadOutcome>>> = {}) {
  const calls: { target: string; ctx: UploadContext }[] = [];
  const records: unknown[][] = [];
  const changes: string[] = [];
  const d: HandoffDeps = {
    upload: {
      youtube: over.youtube ?? (async (c) => (calls.push({ target: 'youtube', ctx: c }), c.onProgress('upload', 0.5), { url: 'https://youtu.be/abc', status: 'published', warnings: [] })),
      tiktok: over.tiktok ?? (async (c) => (calls.push({ target: 'tiktok', ctx: c }), { status: 'inbox', warnings: ['inbox'] })),
    },
    record: async (...a) => void records.push(a),
    now: () => NOW,
    onChange: (x) => void changes.push(x),
  };
  return { d, calls, records, changes };
}

describe('hand-off: request → upload → result', () => {
  it('nothing to do without a request; malformed request is reported as invalid', async () => {
    const { d } = deps();
    expect(await new PublishHandoff(d).check(dir)).toBe('none');
    writeFileSync(join(dir, '.solocut', 'publish-request.json'), '{not json');
    expect(await new PublishHandoff(d).check(dir)).toBe('invalid');
    writeFileSync(join(dir, '.solocut', 'publish-request.json'), JSON.stringify({ id: 'x', targets: [], at: 'now' }));
    expect(await new PublishHandoff(d).check(dir)).toBe('invalid');
    expect(existsSync(join(dir, '.solocut', 'publish-result.json'))).toBe(false);
  });

  it('uploads what publish.json turns on and writes the result with the same id', async () => {
    writeSpec(spec);
    writeReq();
    const { d, calls, records, changes } = deps();
    expect(await new PublishHandoff(d).check(dir)).toBe('processed');
    expect(calls.map((c) => c.target)).toEqual(['youtube']);
    expect(calls[0]!.ctx.videoPath).toBe(join(dir, 'renders', 'final.mp4'));
    expect(calls[0]!.ctx.thumbnailPath).toBeUndefined();
    const r = readResult(dir)!;
    expect(r).toMatchObject({ id: ID, state: 'done', results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/abc', status: 'published' }] });
    expect(records).toEqual([[dir, 'youtube', 'published', 'https://youtu.be/abc']]);
    expect(readLog(dir)).toEqual([expect.objectContaining({ target: 'youtube', video: 'renders/final.mp4', size: 1000, url: 'https://youtu.be/abc', requestId: ID })]);
    // running (start), progress, done → at least three writes
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });

  it('the same id is never run twice', async () => {
    writeSpec(spec);
    writeReq();
    const { d, calls } = deps();
    const h = new PublishHandoff(d);
    await h.check(dir);
    expect(await h.check(dir)).toBe('handled');
    expect(await new PublishHandoff(d).check(dir)).toBe('handled'); // also after an app restart
    expect(calls).toHaveLength(1);
  });

  it('a new request for the same file is answered from the log, not uploaded again', async () => {
    writeSpec(spec);
    writeReq();
    const { d, calls } = deps();
    await new PublishHandoff(d).check(dir);
    writeReq({ id: 'req-00000002' });
    await new PublishHandoff(d).check(dir);
    expect(calls).toHaveLength(1);
    expect(readResult(dir)).toMatchObject({ id: 'req-00000002', results: [{ target: 'youtube', ok: true, alreadyPublished: true, url: 'https://youtu.be/abc' }] });
  });

  it('force uploads again; a re-rendered file (other size) uploads again', async () => {
    writeSpec(spec);
    writeReq();
    const { d, calls } = deps();
    await new PublishHandoff(d).check(dir);
    writeReq({ id: 'req-00000002', force: true });
    await new PublishHandoff(d).check(dir);
    expect(calls).toHaveLength(2);
    writeFileSync(join(dir, 'renders', 'final.mp4'), Buffer.alloc(2000, 1));
    writeReq({ id: 'req-00000003' });
    await new PublishHandoff(d).check(dir);
    expect(calls).toHaveLength(3);
  });

  it('concurrent checks of one project run the upload once', async () => {
    writeSpec(spec);
    writeReq();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d } = deps({ youtube: async () => (await gate, { url: 'https://youtu.be/x', status: 'published', warnings: [] }) });
    const h = new PublishHandoff(d);
    const first = h.check(dir);
    await Promise.resolve();
    expect(await h.check(dir)).toBe('busy');
    expect(h.isBusy(dir)).toBe(true);
    // while running, the result says so (the CLI knows the app picked it up)
    expect(readResult(dir)).toMatchObject({ id: ID, state: 'running' });
    release();
    expect(await first).toBe('processed');
    expect(h.isBusy(dir)).toBe(false);
  });

  it('a request that arrives during an upload is picked up afterwards', async () => {
    writeSpec({ ...spec, tiktok: { enabled: false } });
    writeReq();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const { d } = deps({ youtube: async () => (n++ === 0 && (await gate), { url: `https://youtu.be/${n}`, status: 'published', warnings: [] }) });
    const h = new PublishHandoff(d);
    const first = h.check(dir);
    await Promise.resolve();
    writeReq({ id: 'req-00000002', force: true });
    release();
    await first;
    expect(n).toBe(2);
    expect(readResult(dir)?.id).toBe('req-00000002');
  });

  it('a running result left by a quit app is closed with an error, not re-uploaded', async () => {
    writeSpec(spec);
    writeReq();
    writeFileSync(join(dir, '.solocut', 'publish-result.json'), JSON.stringify({ id: ID, state: 'running', at: '', results: [] }));
    const { d, calls } = deps();
    expect(await new PublishHandoff(d).check(dir)).toBe('handled');
    expect(calls).toHaveLength(0);
    expect(readResult(dir)).toMatchObject({ id: ID, state: 'done', error: expect.stringContaining('interrupted') });
  });

  it('stale requests are ignored', async () => {
    writeSpec(spec);
    writeReq({ at: new Date(NOW - REQUEST_TTL_MS - 1).toISOString() });
    const { d, calls } = deps();
    expect(await new PublishHandoff(d).check(dir)).toBe('stale');
    expect(calls).toHaveLength(0);
    expect(readResult(dir)).toBeNull();
  });

  it('missing or broken publish.json → a done result with an error', async () => {
    writeReq();
    const { d } = deps();
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)).toMatchObject({ id: ID, state: 'done', results: [], error: expect.stringContaining('publish.json') });
    writeSpec('{broken');
    writeReq({ id: 'req-00000002' });
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)).toMatchObject({ id: 'req-00000002', results: [], error: expect.stringContaining('JSON') });
  });

  it('no target on → error; requested target turned off → error', async () => {
    writeSpec({ ...spec, youtube: { enabled: false } });
    writeReq();
    const { d, calls } = deps();
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)?.error).toMatch(/no target/);
    writeSpec(spec);
    writeReq({ id: 'req-00000002', targets: ['tiktok'] });
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)?.error).toMatch(/no target/);
    expect(calls).toHaveLength(0);
  });

  it('blocking issues fail only their target', async () => {
    writeSpec({ ...spec, title: 'a'.repeat(101), tiktok: { enabled: true, caption: 'ok' } });
    writeReq();
    const { d, calls, records } = deps();
    await new PublishHandoff(d).check(dir);
    const r = readResult(dir)!;
    expect(r.results).toEqual([
      { target: 'youtube', ok: false, error: expect.stringContaining('title') },
      { target: 'tiktok', ok: true, status: 'inbox', warnings: ['inbox'] },
    ]);
    expect(calls.map((c) => c.target)).toEqual(['tiktok']);
    expect(records).toEqual([[dir, 'tiktok', 'draft', undefined]]);
  });

  it('missing video fails every target without calling the uploader', async () => {
    writeSpec({ ...spec, video: 'renders/nope.mp4' });
    writeReq();
    const { d, calls } = deps();
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)?.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('renders/nope.mp4') });
    expect(calls).toHaveLength(0);
  });

  it('uploader failure → ok:false, recorded as failed, nothing logged', async () => {
    writeSpec(spec);
    writeReq();
    const { d, records } = deps({ youtube: async () => Promise.reject(new Error('YouTube 403 quotaExceeded')) });
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)?.results).toEqual([{ target: 'youtube', ok: false, error: 'YouTube 403 quotaExceeded' }]);
    expect(records).toEqual([[dir, 'youtube', 'failed']]);
    expect(readLog(dir)).toEqual([]);
  });

  it('a failing record call does not break the result', async () => {
    writeSpec(spec);
    writeReq();
    const { d } = deps();
    d.record = async () => Promise.reject(new Error('cli missing'));
    await new PublishHandoff(d).check(dir);
    expect(readResult(dir)?.results[0]?.ok).toBe(true);
  });

  it('thumbnail is passed when it exists; a missing one becomes a warning', async () => {
    mkdirSync(join(dir, 'thumbnails'));
    writeFileSync(join(dir, 'thumbnails', 't.png'), 'png');
    writeSpec({ ...spec, thumbnail: 'thumbnails/t.png' });
    writeReq();
    const a = deps();
    await new PublishHandoff(a.d).check(dir);
    expect(a.calls[0]!.ctx.thumbnailPath).toBe(join(dir, 'thumbnails', 't.png'));
    writeSpec({ ...spec, thumbnail: 'thumbnails/gone.png' });
    writeReq({ id: 'req-00000002', force: true });
    const b = deps();
    await new PublishHandoff(b.d).check(dir);
    expect(b.calls[0]!.ctx.thumbnailPath).toBeUndefined();
    expect(readResult(dir)?.results[0]?.warnings).toEqual(['thumbnail not found: thumbnails/gone.png']);
  });

  it('scheduled upload is recorded as scheduled; published without URL is recorded as draft', async () => {
    writeSpec({ ...spec, tiktok: { enabled: true, caption: 'c' } });
    writeReq();
    const { d, records } = deps({
      youtube: async () => ({ url: 'https://youtu.be/s', status: 'scheduled', warnings: [] }),
      tiktok: async () => ({ status: 'published', warnings: [] }),
    });
    await new PublishHandoff(d).check(dir);
    expect(records).toEqual([
      [dir, 'youtube', 'scheduled', 'https://youtu.be/s'],
      [dir, 'tiktok', 'draft', undefined],
    ]);
  });

  it('progress is throttled to about every 2 %', async () => {
    writeSpec(spec);
    writeReq();
    const { d, changes } = deps({
      youtube: async (c) => {
        for (let i = 0; i <= 1000; i++) c.onProgress('upload', i / 1000);
        return { url: 'https://youtu.be/p', status: 'published', warnings: [] };
      },
    });
    await new PublishHandoff(d).check(dir);
    expect(changes.length).toBeLessThan(60);
    expect(changes.length).toBeGreaterThan(40);
  });
});

describe('PublishWatcher', () => {
  it('reports an existing request at watch time and polls for new ones', async () => {
    writeReq();
    const seen: string[] = [];
    const w = new PublishWatcher((_d, what) => void seen.push(what), 20);
    w.watch([dir]);
    expect(seen).toEqual(['request']);
    writeReq({ id: 'req-00000002' });
    const t = new Date(Date.now() + 5000);
    utimesSync(join(dir, '.solocut', 'publish-request.json'), t, t);
    await vi.waitFor(() => expect(seen.filter((x) => x === 'request').length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    w.close();
  });
  it('watching the same set again is a no-op; close stops it', () => {
    const seen: string[] = [];
    const w = new PublishWatcher(() => void seen.push('x'), 20);
    w.watch([dir, dir]);
    w.watch([dir]);
    w.close();
    w.watch([]);
    expect(seen).toEqual([]);
  });
});

describe('screen data', () => {
  it('loadView: no publish.json', () => {
    expect(loadView(dir)).toMatchObject({ exists: false, spec: null, issues: [], request: null, result: null, log: [], published: {} });
  });
  it('loadView: files, missing thumbnail warning, published map', async () => {
    writeSpec({ ...spec, thumbnail: 'thumbnails/x.png' });
    writeReq();
    await new PublishHandoff(deps().d).check(dir);
    const v = loadView(dir, new Date(NOW));
    expect(v.videoPath).toBe(join(dir, 'renders', 'final.mp4'));
    expect(v.thumbnailPath).toBeUndefined();
    expect(v.issues).toEqual([{ level: 'warning', field: 'thumbnail', code: 'missing', detail: 'thumbnails/x.png' }]);
    expect(v.published.youtube?.url).toBe('https://youtu.be/abc');
    expect(v.request?.id).toBe(ID);
    expect(v.result?.state).toBe('done');
  });
  it('loadView: missing video is an error', () => {
    writeSpec({ ...spec, video: 'renders/none.mp4' });
    expect(loadView(dir).issues).toContainEqual({ level: 'error', field: 'video', code: 'missing', detail: 'renders/none.mp4' });
  });
  it('projectRel', () => {
    expect(projectRel(dir, join(dir, 'thumbnails', 'a.png'))).toBe('thumbnails/a.png');
    expect(projectRel(dir, 'thumbnails/a.png')).toBe('thumbnails/a.png');
    expect(projectRel(dir, join(dir, '..', 'x.png'))).toBeNull();
    expect(projectRel(dir, dir)).toBeNull();
  });
  it('setThumbnail writes publish.json and keeps other fields', () => {
    mkdirSync(join(dir, 'thumbnails'));
    writeFileSync(join(dir, 'thumbnails', 'a.png'), 'x');
    writeSpec({ ...spec, custom: { keep: true } });
    expect(setThumbnail(dir, join(dir, 'thumbnails', 'a.png'))).toEqual({ ok: true });
    const j = JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));
    expect(j).toMatchObject({ title: 'タイトル', custom: { keep: true }, thumbnail: 'thumbnails/a.png' });
    expect(parsePublishJson(JSON.stringify(j)).spec?.thumbnail).toBe('thumbnails/a.png');
    expect(setThumbnail(dir, null)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8')).thumbnail).toBeUndefined();
  });
  it('setThumbnail creates publish.json when there is none', () => {
    mkdirSync(join(dir, 'thumbnails'));
    writeFileSync(join(dir, 'thumbnails', 'a.jpg'), 'x');
    expect(setThumbnail(dir, 'thumbnails/a.jpg')).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'))).toEqual({ thumbnail: 'thumbnails/a.jpg' });
  });
  it('setThumbnail refuses outside, non-images, missing files and broken JSON', () => {
    writeFileSync(join(dir, 'a.webp'), 'x');
    expect(setThumbnail(dir, '/etc/hosts').ok).toBe(false);
    expect(setThumbnail(dir, '../x.png').ok).toBe(false);
    expect(setThumbnail(dir, 'a.webp').ok).toBe(false);
    expect(setThumbnail(dir, 'thumbnails/none.png').ok).toBe(false);
    mkdirSync(join(dir, 'thumbnails'));
    writeFileSync(join(dir, 'thumbnails', 'a.png'), 'x');
    writeSpec('{broken');
    expect(setThumbnail(dir, 'thumbnails/a.png')).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
    expect(readFileSync(join(dir, 'publish.json'), 'utf8')).toBe('{broken');
  });
  it('listThumbnails: png/jpg under thumbnails/ (one sub level), newest first', () => {
    expect(listThumbnails(dir)).toEqual([]);
    mkdirSync(join(dir, 'thumbnails', 'v2', 'deep'), { recursive: true });
    const f = (rel: string, t: number) => {
      writeFileSync(join(dir, rel), 'x');
      utimesSync(join(dir, rel), t, t);
    };
    f('thumbnails/old.png', 1000);
    f('thumbnails/new.JPG', 3000);
    f('thumbnails/v2/b.jpeg', 2000);
    f('thumbnails/v2/deep/c.png', 4000);
    f('thumbnails/skip.webp', 5000);
    f('thumbnails/.hidden.png', 5000);
    f('thumbnails/notes.txt', 5000);
    expect(listThumbnails(dir).map((x) => x.rel)).toEqual(['thumbnails/new.JPG', 'thumbnails/v2/b.jpeg', 'thumbnails/old.png']);
  });
});

describe('build-time client config', () => {
  it('mergeEnv: earlier non-empty wins', () => {
    expect(mergeEnv({ A: '', B: ' b ' }, { A: 'a', B: 'x' }, { C: undefined })).toEqual({ A: 'a', B: 'b' });
  });
  it('YouTube: built-in id, else the dev secret, else null', () => {
    expect(youtubeClientFrom({ SOLOCUT_YOUTUBE_CLIENT_ID: 'id', SOLOCUT_YOUTUBE_CLIENT_SECRET: 's' })).toEqual({ clientId: 'id', clientSecret: 's' });
    expect(youtubeClientFrom({ SOLOCUT_YOUTUBE_CLIENT_ID: 'id' }, 'dev')).toEqual({ clientId: 'id' });
    expect(youtubeClientFrom({}, 'dev', 'sec')).toEqual({ clientId: 'dev', clientSecret: 'sec' });
    expect(youtubeClientFrom({}, ' ', null)).toBeNull();
    expect(youtubeClientFrom({})).toBeNull();
  });
  it('TikTok: a client key is enough; tokens go through the exchange worker (https, or local wrangler dev)', () => {
    expect(tiktokClientFrom({})).toBeNull();
    expect(tiktokClientFrom({ SOLOCUT_TIKTOK_CLIENT_KEY: 'k' })).toEqual({ clientKey: 'k', tokenUrl: 'https://solocut.app/oauth/tiktok', directPost: false });
    expect(tiktokClientFrom({ SOLOCUT_TIKTOK_CLIENT_KEY: 'k', SOLOCUT_TIKTOK_TOKEN_URL: 'https://x.example/t', SOLOCUT_TIKTOK_DIRECT_POST: 'true' })).toEqual({
      clientKey: 'k',
      tokenUrl: 'https://x.example/t',
      directPost: true,
    });
    expect(tiktokClientFrom({ SOLOCUT_TIKTOK_CLIENT_KEY: 'k', SOLOCUT_TIKTOK_TOKEN_URL: 'http://127.0.0.1:8787/oauth/tiktok' })?.tokenUrl).toBe('http://127.0.0.1:8787/oauth/tiktok');
    expect(tiktokClientFrom({ SOLOCUT_TIKTOK_CLIENT_KEY: 'k', SOLOCUT_TIKTOK_TOKEN_URL: 'http://evil.example/t' })).toBeNull();
    // a secret in the environment is ignored: the app never uses it
    expect(tiktokClientFrom({ SOLOCUT_TIKTOK_CLIENT_KEY: 'k', SOLOCUT_TIKTOK_CLIENT_SECRET: 's' } as Record<string, string>)).not.toHaveProperty('clientSecret');
  });
});

describe('TikTok Login Kit (desktop) and Content Posting', () => {
  it('verifier is 43..128 unreserved characters; challenge is hex SHA-256', () => {
    for (let i = 0; i < 20; i++) expect(tiktokVerifier()).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(tiktokChallenge('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(tiktokVerifier(200).length).toBe(128);
  });
  it('authorize URL', () => {
    const u = new URL(tiktokAuthUrl({ clientKey: 'ck', redirectUri: TIKTOK_REDIRECT_URI, challenge: 'ch', state: 'st', scopes: tiktokScopes(false) }));
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_key: 'ck',
      scope: 'user.info.basic,video.upload',
      redirect_uri: 'http://127.0.0.1:47823/tiktok/callback',
      state: 'st',
      response_type: 'code',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
    expect(tiktokScopes(true)).toContain('video.publish');
  });
  it('token bodies for the exchange worker: client_key (picks sandbox / production), never a secret', () => {
    const code = tiktokTokenBody('ck', { code: 'c', verifier: 'v', redirectUri: TIKTOK_REDIRECT_URI });
    expect(Object.fromEntries(code)).toEqual({ client_key: 'ck', code: 'c', code_verifier: 'v', redirect_uri: 'http://127.0.0.1:47823/tiktok/callback' });
    expect(Object.fromEntries(tiktokTokenBody('ck', { refreshToken: 'r' }))).toEqual({ client_key: 'ck', refresh_token: 'r' });
    expect(exchangeUrl('https://solocut.app/oauth/tiktok', 'token')).toBe('https://solocut.app/oauth/tiktok/token');
    expect(exchangeUrl('https://solocut.app/oauth/tiktok//', 'revoke')).toBe('https://solocut.app/oauth/tiktok/revoke');
  });
  it('token response parsing', () => {
    const t = parseTikTokToken({ access_token: 'a', expires_in: 86400, refresh_token: 'r', refresh_expires_in: 100, open_id: 'o', scope: 'user.info.basic, video.upload' }, 1000);
    expect(t).toEqual({ accessToken: 'a', expiresAt: 1000 + 86_400_000, refreshToken: 'r', refreshExpiresAt: 1000 + 100_000, openId: 'o', scope: ['user.info.basic', 'video.upload'] });
    expect(parseTikTokToken({ access_token: 'a', refresh_token: 'r', expires_in: -5 }, 0).expiresAt).toBe(86_400_000);
    expect(() => parseTikTokToken({ error: 'invalid_grant', error_description: 'expired' }, 0)).toThrow('TikTok token: invalid_grant expired');
    expect(() => parseTikTokToken({ error: { code: 'access_token_invalid', message: 'x' } }, 0)).toThrow('access_token_invalid');
    expect(() => parseTikTokToken(null, 0)).toThrow('no access token');
  });
  it('stored tokens round-trip; junk is null', () => {
    const t = parseTikTokToken({ access_token: 'a', refresh_token: 'r' }, 5);
    expect(parseStoredTokens(JSON.stringify(t))).toEqual(t);
    expect(parseStoredTokens(null)).toBeNull();
    expect(parseStoredTokens('{')).toBeNull();
    expect(parseStoredTokens('{"accessToken":1}')).toBeNull();
  });
  it('chunk plan follows the media transfer rules', () => {
    const MB = 1024 * 1024;
    const check = (size: number) => {
      const p = tiktokChunkPlan(size);
      expect(p.count).toBe(p.ranges.length);
      expect(p.ranges[0]![0]).toBe(0);
      expect(p.ranges.at(-1)![1]).toBe(size - 1);
      for (let i = 1; i < p.ranges.length; i++) expect(p.ranges[i]![0]).toBe(p.ranges[i - 1]![1] + 1);
      if (size >= TT_MIN_CHUNK) for (const [a, b] of p.ranges.slice(0, -1)) expect(b - a + 1).toBe(p.chunkSize);
      if (size >= TT_MIN_CHUNK) expect(p.chunkSize).toBeGreaterThanOrEqual(TT_MIN_CHUNK);
      expect(p.chunkSize).toBeLessThanOrEqual(TT_MAX_CHUNK);
      expect(p.count).toBe(size < TT_MIN_CHUNK ? 1 : Math.floor(size / p.chunkSize));
      expect(p.count).toBeLessThanOrEqual(1000);
      return p;
    };
    expect(check(1)).toEqual({ chunkSize: 1, count: 1, ranges: [[0, 0]] });
    expect(check(5 * MB - 1).count).toBe(1);
    expect(check(5 * MB).count).toBe(1);
    expect(check(7 * MB).count).toBe(1);
    expect(check(10 * MB).count).toBe(1);
    expect(check(50_000_123).count).toBe(4); // 10 MiB chunks, remainder merged
    expect(check(64 * MB + 1).count).toBe(6);
    expect(check(4 * 1024 * MB).count).toBeLessThanOrEqual(1000);
    expect(() => tiktokChunkPlan(0)).toThrow();
    expect(() => tiktokChunkPlan(Number.NaN)).toThrow();
    expect(() => tiktokChunkPlan(70 * 1024 * MB)).toThrow(/too large/);
  });
  it('init bodies', () => {
    const plan = tiktokChunkPlan(1000);
    expect(inboxInitBody(plan, 1000)).toEqual({ source_info: { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 } });
    const s = parsePublishJson({ title: 't', tiktok: { enabled: true, caption: 'cap', privacy: 'PUBLIC_TO_EVERYONE', allowComment: true, isAigc: true } }).spec!;
    const d = directInitBody(s, plan, 1000, ['SELF_ONLY', 'PUBLIC_TO_EVERYONE']) as { post_info: Record<string, unknown> };
    expect(d.post_info).toEqual({
      title: 'cap', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true, is_aigc: true, brand_content_toggle: false, brand_organic_toggle: false,
    });
    // a privacy the account does not offer (unaudited / private account) falls back to SELF_ONLY
    expect((directInitBody(s, plan, 1000, ['SELF_ONLY']) as { post_info: { privacy_level: string } }).post_info.privacy_level).toBe('SELF_ONLY');
    expect((directInitBody(s, plan, 1000, ['FOLLOWER_OF_CREATOR']) as { post_info: { privacy_level: string } }).post_info.privacy_level).toBe('FOLLOWER_OF_CREATOR');
    expect((directInitBody(s, plan, 1000, []) as { post_info: { privacy_level: string } }).post_info.privacy_level).toBe('SELF_ONLY');
  });
  it('API envelope and status', () => {
    expect(tiktokData({ data: { a: 1 }, error: { code: 'ok' } }, 'x')).toEqual({ a: 1 });
    expect(() => tiktokData({ error: { code: 'spam_risk_too_many_posts', message: 'slow down' } }, 'init')).toThrow('TikTok init: spam_risk_too_many_posts slow down');
    expect(() => tiktokData({}, 'x')).toThrow('no data');
    expect(interpretStatus({ status: 'PROCESSING_UPLOAD' }, 'inbox')).toEqual({ done: false, ok: true, status: 'PROCESSING_UPLOAD' });
    expect(interpretStatus({ status: 'SEND_TO_USER_INBOX' }, 'inbox')).toEqual({ done: true, ok: true, status: 'SEND_TO_USER_INBOX' });
    expect(interpretStatus({ status: 'SEND_TO_USER_INBOX' }, 'direct').done).toBe(false);
    expect(interpretStatus({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, 'direct')).toEqual({ done: true, ok: true, status: 'PUBLISH_COMPLETE', postId: '7123' });
    expect(interpretStatus({ status: 'FAILED', fail_reason: 'file_format_check_failed' }, 'direct')).toEqual({ done: true, ok: false, status: 'FAILED', reason: 'file_format_check_failed' });
    expect(tiktokVideoUrl('me.name', '7123')).toBe('https://www.tiktok.com/@me.name/video/7123');
    expect(tiktokVideoUrl(undefined, '7')).toBeUndefined();
    expect(tiktokVideoUrl('a/b', '7')).toBeUndefined();
    expect(contentTypeFor('a.MOV')).toBe('video/quicktime');
    expect(contentTypeFor('a.webm')).toBe('video/webm');
    expect(contentTypeFor('a.mp4')).toBe('video/mp4');
  });
});

describe('loopback authorization', () => {
  const hit = (url: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(url, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  it('fixed port and path (TikTok): exact redirect URI, other paths ignored', async () => {
    const port = 47000 + Math.floor(Math.random() * 900);
    let opened = '';
    const p = loopbackAuthorize({
      path: '/tiktok/callback',
      port,
      state: 'S',
      label: 'TikTok',
      buildUrl: (r) => `https://auth.example/?redirect=${encodeURIComponent(r)}`,
      open: (u) => void (opened = u),
    });
    await vi.waitFor(() => expect(opened).not.toBe(''));
    const redirect = decodeURIComponent(opened.split('redirect=')[1]!);
    expect(redirect).toBe(`http://127.0.0.1:${port}/tiktok/callback`);
    expect(await hit(`http://127.0.0.1:${port}/favicon.ico`)).toBe(404);
    expect(await hit(`http://127.0.0.1:${port}/?code=X&state=S`)).toBe(404); // only the registered path
    expect(await hit(`${redirect}?code=CODE&state=S`)).toBe(200);
    await expect(p).resolves.toEqual({ code: 'CODE', redirectUri: redirect });
  });

  it('a busy fixed port gives a clear error', async () => {
    const port = 47000 + Math.floor(Math.random() * 900);
    const first = loopbackAuthorize({ path: '/tiktok/callback', port, state: 'S', label: 'x', buildUrl: (r) => r, open: () => undefined, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    await expect(loopbackAuthorize({ path: '/tiktok/callback', port, state: 'S', label: 'x', buildUrl: (r) => r, open: () => undefined })).rejects.toThrow(/in use/);
    await hit(`http://127.0.0.1:${port}/tiktok/callback?code=c&state=S`);
    await first;
  });

  it('any free port (Google): redirect is the bare origin', async () => {
    let opened = '';
    const p = loopbackAuthorize({ path: '/', state: 'S', label: 'YouTube', buildUrl: (r) => r, open: (u) => void (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(''));
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await hit(`${opened}/tiktok/callback?code=c&state=S`)).toBe(404);
    expect(await hit(`${opened}/?code=c&state=S`)).toBe(200);
    await expect(p).resolves.toMatchObject({ code: 'c' });
  });

  it('rejects a state mismatch and times out', async () => {
    let opened = '';
    const p = loopbackAuthorize({ path: '/', state: 'S', label: 'YouTube', buildUrl: (r) => r, open: (u) => void (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(''));
    const done = expect(p).rejects.toThrow('state mismatch');
    await hit(`${opened}/?code=x&state=evil`);
    await done;
    await expect(loopbackAuthorize({ path: '/', state: 'S', label: 'x', buildUrl: (r) => r, open: () => undefined, timeoutMs: 30 })).rejects.toThrow('timed out');
  });

  it('a failing browser opener rejects', async () => {
    await expect(loopbackAuthorize({ path: '/', state: 'S', label: 'x', buildUrl: (r) => r, open: () => Promise.reject(new Error('no browser')) })).rejects.toThrow('no browser');
  });
});

describe('build-time OAuth defines (electron.vite.config.ts)', () => {
  const json = JSON.stringify({ installed: { client_id: 'json-id.apps.googleusercontent.com', client_secret: 'json-secret' } });
  it('reads Google installed-app JSON (and web), junk → {}', () => {
    expect(googleClientFromJson(json)).toEqual({ id: 'json-id.apps.googleusercontent.com', secret: 'json-secret' });
    expect(googleClientFromJson(JSON.stringify({ web: { client_id: 'w' } }))).toEqual({ id: 'w' });
    expect(googleClientFromJson('{')).toEqual({});
    expect(googleClientFromJson(null)).toEqual({});
    expect(googleClientFromJson('{"installed":{"client_id":5}}')).toEqual({});
  });
  it('env wins over the JSON; the secret never mixes two clients', () => {
    expect(publishDefines({}, json)).toEqual({
      'import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_ID': '"json-id.apps.googleusercontent.com"',
      'import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_SECRET': '"json-secret"',
    });
    expect(publishDefines({ SOLOCUT_YOUTUBE_CLIENT_ID: 'env-id' }, json)).toEqual({ 'import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_ID': '"env-id"' });
    expect(publishDefines({ SOLOCUT_YOUTUBE_CLIENT_ID: 'env-id', SOLOCUT_YOUTUBE_CLIENT_SECRET: 's' }, json)).toEqual({
      'import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_ID': '"env-id"',
      'import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_SECRET': '"s"',
    });
    expect(publishDefines({ MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY: ' k ', SOLOCUT_TIKTOK_DIRECT_POST: '1' }, null)).toEqual({
      'import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY': '"k"',
      'import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_DIRECT_POST': '"1"',
    });
    expect(publishDefines({ SOLOCUT_YOUTUBE_CLIENT_ID: '  ' }, null)).toEqual({});
  });
});

describe('TikTok client key from the release env file', () => {
  it('dotenvValue reads one key only', () => {
    const text = '# comment\nexport TIKTOK_CLIENT_KEY="key-1"\nTIKTOK_CLIENT_SECRET=never\n';
    expect(dotenvValue(text, 'TIKTOK_CLIENT_KEY')).toBe('key-1');
    expect(dotenvValue("TIKTOK_CLIENT_KEY='k2'", 'TIKTOK_CLIENT_KEY')).toBe('k2');
    expect(dotenvValue('TIKTOK_CLIENT_KEY=k3 # note', 'TIKTOK_CLIENT_KEY')).toBe('k3');
    expect(dotenvValue('TIKTOK_CLIENT_KEY=', 'TIKTOK_CLIENT_KEY')).toBeUndefined();
    expect(dotenvValue(null, 'TIKTOK_CLIENT_KEY')).toBeUndefined();
    expect(dotenvValue('OTHER=1', 'TIKTOK_CLIENT_KEY')).toBeUndefined();
  });
  it('SOLOCUT_TIKTOK_ENV picks the file (sandbox by default)', () => {
    expect(tiktokEnvFileName({})).toBe('tiktok-sandbox.env');
    expect(tiktokEnvFileName({ SOLOCUT_TIKTOK_ENV: ' ' })).toBe('tiktok-sandbox.env');
    expect(tiktokEnvFileName({ SOLOCUT_TIKTOK_ENV: 'Production' })).toBe('tiktok-production.env');
    expect(() => tiktokEnvFileName({ SOLOCUT_TIKTOK_ENV: 'prod' })).toThrow(/sandbox or production/);
    expect(() => tiktokEnvFileName({ SOLOCUT_TIKTOK_ENV: '../x' })).toThrow();
  });
  it('the key is compiled in; the secret never is', () => {
    const file = 'TIKTOK_CLIENT_KEY=sandbox-key\nTIKTOK_CLIENT_SECRET=sandbox-secret\n';
    const d = publishDefines({ SOLOCUT_TIKTOK_CLIENT_SECRET: 'env-secret', MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_SECRET: 'x' }, null, file);
    expect(d).toEqual({ 'import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY': '"sandbox-key"' });
    expect(JSON.stringify(d)).not.toMatch(/secret/);
    expect(publishDefines({ SOLOCUT_TIKTOK_CLIENT_KEY: 'env-key' }, null, file)).toEqual({ 'import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY': '"env-key"' });
  });
});
