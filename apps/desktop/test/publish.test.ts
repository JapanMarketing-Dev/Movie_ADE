import { describe, expect, it } from 'vitest';
import type { YouTubeForm } from '../src/shared/types';
import {
  announceLength,
  intentUrl,
  libNameFor,
  nextOffsetFromRange,
  parseProgress,
  parseTags,
  tagsLength,
  utf8Bytes,
  validateYouTube,
  xWeightedLength,
  youtubeVideoResource,
} from '../src/shared/publish';
import { authUrl, challengeS256, multipartRelated, newVerifier, parseCallback, refreshRequestBody, tokenRequestBody } from '../src/main/publish/oauth';

const form = (p: Partial<YouTubeForm> = {}): YouTubeForm => ({
  videoPath: '/p/renders/youtube/a.mp4',
  title: 'Claude Code の設定 3つのコツ',
  description: '説明',
  tags: ['claude', 'AI'],
  categoryId: '28',
  privacy: 'unlisted',
  madeForKids: false,
  containsSyntheticMedia: false,
  language: 'ja',
  ...p,
});

describe('YouTube form', () => {
  it('a complete form has no issues', () => {
    expect(validateYouTube(form())).toEqual([]);
  });
  it('requires video, title and an explicit made-for-kids answer', () => {
    const codes = validateYouTube(form({ videoPath: '', title: '  ', madeForKids: null })).map((i) => `${i.field}:${i.code}`);
    expect(codes).toEqual(['videoPath:required', 'title:required', 'madeForKids:required']);
  });
  it('title is 100 characters (code points), description 5000 bytes', () => {
    expect(validateYouTube(form({ title: 'あ'.repeat(100) }))).toEqual([]);
    expect(validateYouTube(form({ title: 'あ'.repeat(101) }))[0]).toMatchObject({ field: 'title', code: 'too-long' });
    expect(validateYouTube(form({ title: '😀'.repeat(100) }))).toEqual([]);
    expect(validateYouTube(form({ description: 'あ'.repeat(1666) }))).toEqual([]); // 4998 bytes
    expect(validateYouTube(form({ description: 'あ'.repeat(1667) }))[0]).toMatchObject({ field: 'description', code: 'too-long' });
  });
  it('rejects angle brackets and too many tags', () => {
    expect(validateYouTube(form({ title: 'a <b>' }))[0]?.code).toBe('angle-brackets');
    expect(validateYouTube(form({ tags: Array.from({ length: 80 }, (_, i) => `tag${i}xx`) }))[0]).toMatchObject({ field: 'tags' });
  });
  it('schedule must be in the future and forces private', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    expect(validateYouTube(form({ publishAt: '2026-10-10T00:00:00Z' }), now)[0]?.code).toBe('past');
    expect(validateYouTube(form({ publishAt: 'nope' }), now)[0]?.code).toBe('invalid');
    const r = youtubeVideoResource(form({ privacy: 'public', publishAt: '2026-10-12T09:00:00+09:00' })) as { status: Record<string, unknown> };
    expect(r.status).toEqual({ privacyStatus: 'private', publishAt: '2026-10-12T00:00:00.000Z', selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
  });
  it('builds the videos.insert resource', () => {
    const r = youtubeVideoResource(form({ title: ' t ', containsSyntheticMedia: true })) as { snippet: Record<string, unknown>; status: Record<string, unknown> };
    expect(r.snippet).toMatchObject({ title: 't', categoryId: '28', defaultLanguage: 'ja', tags: ['claude', 'AI'] });
    expect(r.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  });
  it('tags helpers', () => {
    expect(parseTags('#AI, claude、AI\n  動画 編集 ,')).toEqual(['AI', 'claude', '動画 編集']);
    expect(tagsLength(['ab', 'c d'])).toBe(2 + 1 + 3 + 2);
    expect(utf8Bytes('aあ😀')).toBe(1 + 3 + 4);
  });
  it('resumable upload offsets', () => {
    expect(nextOffsetFromRange('bytes=0-8388607')).toBe(8388608);
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(nextOffsetFromRange('garbage')).toBe(0);
  });
});

describe('announce', () => {
  it('weights CJK as 2 and URLs as 23 on X', () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('動画')).toBe(4);
    expect(xWeightedLength('見て https://youtu.be/abcdefghijk')).toBe(4 + 1 + 23);
    expect(announceLength('x', 'a', 'https://example.com/very/long/path?with=query')).toBe(1 + 1 + 23);
    expect(announceLength('threads', 'あい', 'https://x.y')).toBe(2 + 1 + 11);
  });
  it('builds intent URLs with encoded text', () => {
    expect(intentUrl('x', '新作 #AI', 'https://youtu.be/x')).toBe('https://x.com/intent/post?text=%E6%96%B0%E4%BD%9C%20%23AI&url=https%3A%2F%2Fyoutu.be%2Fx');
    expect(intentUrl('x', 'a', '')).toBe('https://x.com/intent/post?text=a');
    expect(intentUrl('threads', 'a&b', 'https://u')).toBe('https://www.threads.com/intent/post?text=a%26b%0Ahttps%3A%2F%2Fu');
    expect(intentUrl('facebook', 'ignored', 'https://u/?a=1')).toBe('https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fu%2F%3Fa%3D1');
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

describe('OAuth (installed app, PKCE)', () => {
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
  });
  it('parses the loopback callback', () => {
    expect(parseCallback('/?code=abc&state=s1', 's1')).toEqual({ ok: true, code: 'abc' });
    expect(parseCallback('/?code=abc&state=evil', 's1')).toEqual({ ok: false, error: 'state mismatch' });
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
  it('multipart/related body', () => {
    const m = multipartRelated({ snippet: { videoId: 'v' } }, Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nhi\n'), 'application/octet-stream', 'BND');
    expect(m.contentType).toBe('multipart/related; boundary=BND');
    const text = m.body.toString();
    expect(text.startsWith('--BND\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"snippet":{"videoId":"v"}}\r\n--BND\r\n')).toBe(true);
    expect(text.endsWith('\r\n--BND--\r\n')).toBe(true);
  });
});
