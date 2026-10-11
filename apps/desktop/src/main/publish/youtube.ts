// YouTube with Solocut's own Google OAuth client (built in, see config.ts): one button → system browser + PKCE +
// loopback redirect. Resumable videos.insert from publish.json, then thumbnails.set. Tokens live in safeStorage only.
import { net, shell } from 'electron';
import { open as fsOpen, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { UPLOAD_CHUNK, nextOffsetFromRange, youtubeVideoResource } from '../../shared/publish';
import { getSecret, hasSecret, setSecret } from '../services/secrets';
import { GOOGLE_REVOKE, GOOGLE_TOKEN, authUrl, challengeS256, channelTitle, newVerifier, refreshRequestBody, tokenRequestBody } from './oauth';
import { publishEnv, youtubeClientFrom, type YouTubeClient } from './config';
import { loopbackAuthorize } from './loopback';
import { readNames, setName } from './accounts';
import type { UploadContext, UploadOutcome } from './handoff';

const API = 'https://www.googleapis.com';

let access: { token: string; expiresAt: number } | null = null;

/** The built-in client; for development a client id saved in secrets (youtube.clientId) still works. */
export function youtubeClient(): YouTubeClient | null {
  const env = publishEnv();
  if (env.SOLOCUT_YOUTUBE_CLIENT_ID) return youtubeClientFrom(env);
  return youtubeClientFrom(env, getSecret('youtube.clientId'), getSecret('youtube.clientSecret'));
}

function client(): YouTubeClient {
  const c = youtubeClient();
  if (!c) throw new Error('youtube-client-missing');
  return c;
}

/** Without decrypting anything (no keychain prompt): a stored refresh token and the saved channel name. */
export function youtubeStatus(): { configured: boolean; connected: boolean; name?: string } {
  const env = publishEnv();
  const configured = Boolean(env.SOLOCUT_YOUTUBE_CLIENT_ID) || hasSecret('youtube.clientId');
  const connected = hasSecret('youtube.refreshToken');
  const name = readNames().youtube?.name;
  return { configured, connected, ...(connected && name ? { name } : {}) };
}

async function tokenCall(body: URLSearchParams): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const r = await net.fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`token: ${j.error ?? r.status} ${j.error_description ?? ''}`.trim());
  return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}) };
}

/** Opens the system browser for consent, waits for the loopback redirect, then reads the channel name. */
export async function connectYouTube(): Promise<{ name?: string }> {
  const c = client();
  const verifier = newVerifier();
  const state = randomBytes(16).toString('hex');
  const got = await loopbackAuthorize({
    path: '/',
    state,
    label: 'YouTube',
    buildUrl: (redirectUri) => authUrl({ clientId: c.clientId, redirectUri, challenge: challengeS256(verifier), state }),
    open: (url) => shell.openExternal(url),
  });
  const tok = await tokenCall(tokenRequestBody({ ...c, code: got.code, verifier, redirectUri: got.redirectUri }));
  if (!tok.refresh_token) throw new Error('no refresh token returned (remove Solocut from your Google account and try again)');
  setSecret('youtube.refreshToken', tok.refresh_token);
  access = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
  const name = await fetchChannelName().catch(() => null);
  setName('youtube', name ? { name } : {});
  return name ? { name } : {};
}

async function fetchChannelName(): Promise<string | null> {
  const r = await net.fetch(`${API}/youtube/v3/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!r.ok) return null;
  return channelTitle(await r.json().catch(() => null));
}

export async function disconnectYouTube(): Promise<void> {
  const rt = getSecret('youtube.refreshToken');
  if (rt) await net.fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => undefined);
  setSecret('youtube.refreshToken', null);
  setName('youtube', null);
  access = null;
}

async function token(): Promise<string> {
  if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
  const refreshToken = getSecret('youtube.refreshToken');
  if (!refreshToken) throw new Error('YouTube に接続していません（設定 → アカウント） / YouTube is not connected');
  const tok = await tokenCall(refreshRequestBody({ ...client(), refreshToken }));
  access = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
  return access.token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

async function apiError(r: Response): Promise<Error> {
  const j = (await r.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
  const reason = j?.error?.errors?.[0]?.reason;
  return new Error(`YouTube ${r.status}${reason ? ` ${reason}` : ''}: ${j?.error?.message ?? r.statusText}`);
}

/** The hand-off uploader: publish.json → resumable upload → thumbnail. */
export async function uploadToYouTube(c: UploadContext): Promise<UploadOutcome> {
  const size = (await stat(c.videoPath)).size;
  const warnings: string[] = [];
  c.onProgress('auth');
  // 1) start a resumable session
  const init = await net.fetch(`${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify(youtubeVideoResource(c.spec)),
  });
  if (!init.ok) throw await apiError(init);
  const session = init.headers.get('location');
  if (!session) throw new Error('YouTube: no upload session URL');

  // 2) upload in chunks, resuming after transient errors
  const fh = await fsOpen(c.videoPath, 'r');
  let offset = 0;
  let videoId = '';
  let attempt = 0;
  try {
    while (!videoId) {
      const len = Math.min(UPLOAD_CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      c.onProgress('upload', size ? offset / size : 0);
      let r: Response;
      try {
        r = await net.fetch(session, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${await token()}`, 'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
          body: buf,
        });
      } catch (e) {
        r = new Response(null, { status: 599, statusText: e instanceof Error ? e.message : 'network error' });
      }
      if (r.status === 308) {
        offset = nextOffsetFromRange(r.headers.get('range'));
        attempt = 0;
        continue;
      }
      if (r.ok) {
        const j = (await r.json()) as { id?: string };
        if (!j.id) throw new Error('YouTube: upload finished without a video id');
        videoId = j.id;
        break;
      }
      if (!retryable(r.status) || ++attempt > 5) throw await apiError(r);
      await sleep(Math.min(32_000, 1000 * 2 ** attempt));
      // ask where to resume
      const q = await net.fetch(session, { method: 'PUT', headers: { Authorization: `Bearer ${await token()}`, 'Content-Range': `bytes */${size}` } }).catch(() => null);
      if (q?.status === 308) offset = nextOffsetFromRange(q.headers.get('range'));
      else if (q?.ok) {
        const j = (await q.json()) as { id?: string };
        if (j.id) videoId = j.id;
      }
    }
  } finally {
    await fh.close();
  }
  c.onProgress('upload', 1);

  // 3) thumbnail: a failure is reported, the video stays uploaded (never re-upload)
  if (c.thumbnailPath) {
    c.onProgress('thumbnail');
    const img = await readFile(c.thumbnailPath);
    if (img.length > 2 * 1024 * 1024) warnings.push('thumbnail is over 2 MB (YouTube limit); not set');
    else {
      const type = /\.png$/i.test(c.thumbnailPath) ? 'image/png' : 'image/jpeg';
      const r = await net.fetch(`${API}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': type },
        body: img,
      });
      if (!r.ok) warnings.push((await apiError(r)).message);
    }
  }
  c.onProgress('done', 1);
  return { url: `https://youtu.be/${videoId}`, status: c.spec.youtube.publishAt ? 'scheduled' : 'published', warnings };
}
