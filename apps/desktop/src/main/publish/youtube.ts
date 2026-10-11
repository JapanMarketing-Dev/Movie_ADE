// YouTube upload with the user's own (BYO) Google OAuth client: system browser + PKCE + loopback redirect,
// resumable videos.insert, then thumbnails.set and captions.insert. Tokens live in safeStorage only.
import { net, shell } from 'electron';
import { createServer } from 'node:http';
import { open as fsOpen, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { YouTubeForm, YouTubeProgress } from '../../shared/types';
import { UPLOAD_CHUNK, nextOffsetFromRange, youtubeVideoResource } from '../../shared/publish';
import { getSecret, setSecret } from '../services/secrets';
import { GOOGLE_REVOKE, GOOGLE_TOKEN, authUrl, challengeS256, multipartRelated, newVerifier, parseCallback, refreshRequestBody, tokenRequestBody } from './oauth';

const API = 'https://www.googleapis.com';
const AUTH_TIMEOUT_MS = 5 * 60_000;

let access: { token: string; expiresAt: number } | null = null;

function client(): { clientId: string; clientSecret?: string } {
  const clientId = getSecret('youtube.clientId');
  if (!clientId) throw new Error('youtube-client-missing');
  const clientSecret = getSecret('youtube.clientSecret') ?? undefined;
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

export function youtubeConnected(): boolean {
  return Boolean(getSecret('youtube.refreshToken'));
}

async function tokenCall(body: URLSearchParams): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const r = await net.fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`token: ${j.error ?? r.status} ${j.error_description ?? ''}`.trim());
  return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}) };
}

/** Opens the system browser for consent and waits for the loopback redirect. */
export async function connectYouTube(): Promise<void> {
  const c = client();
  const verifier = newVerifier();
  const state = randomBytes(16).toString('hex');
  const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const r = parseCallback(req.url ?? '/', state);
      if (r.ok === 'ignore') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="background:#0f1012;color:#e7e7ea;font-family:sans-serif;padding:40px">` +
          (r.ok ? 'Solocut: YouTube に接続しました。このタブを閉じてください。 / Connected. You can close this tab.' : `Solocut: ${r.error}`) +
          `</body>`,
      );
      clearTimeout(timer);
      server.close();
      if (r.ok) resolve({ code: r.code, redirectUri });
      else reject(new Error(`authorization failed: ${r.error}`));
    });
    let redirectUri = '';
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('authorization timed out'));
    }, AUTH_TIMEOUT_MS);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}`;
      void shell.openExternal(authUrl({ clientId: c.clientId, redirectUri, challenge: challengeS256(verifier), state }));
    });
  });
  const tok = await tokenCall(tokenRequestBody({ ...c, code: code.code, verifier, redirectUri: code.redirectUri }));
  if (!tok.refresh_token) throw new Error('no refresh token returned (remove the app from your Google account and try again)');
  setSecret('youtube.refreshToken', tok.refresh_token);
  access = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
}

export async function disconnectYouTube(): Promise<void> {
  const rt = getSecret('youtube.refreshToken');
  if (rt) await net.fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => undefined);
  setSecret('youtube.refreshToken', null);
  access = null;
}

async function token(): Promise<string> {
  if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
  const refreshToken = getSecret('youtube.refreshToken');
  if (!refreshToken) throw new Error('youtube-not-connected');
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

export async function uploadToYouTube(f: YouTubeForm, onProgress: (p: YouTubeProgress) => void): Promise<{ videoId: string; url: string; warnings: string[] }> {
  const size = (await stat(f.videoPath)).size;
  const warnings: string[] = [];
  onProgress({ phase: 'auth' });
  // 1) start a resumable session
  const init = await net.fetch(`${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify(youtubeVideoResource(f)),
  });
  if (!init.ok) throw await apiError(init);
  const session = init.headers.get('location');
  if (!session) throw new Error('YouTube: no upload session URL');

  // 2) upload in chunks, resuming after transient errors
  const fh = await fsOpen(f.videoPath, 'r');
  let offset = 0;
  let videoId = '';
  let attempt = 0;
  try {
    while (!videoId) {
      const len = Math.min(UPLOAD_CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      onProgress({ phase: 'upload', sent: offset, total: size });
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
  onProgress({ phase: 'upload', sent: size, total: size });

  // 3) thumbnail and captions: failures are reported, the video stays uploaded (never re-upload)
  if (f.thumbnailPath) {
    onProgress({ phase: 'thumbnail' });
    const img = await readFile(f.thumbnailPath);
    const type = /\.png$/i.test(f.thumbnailPath) ? 'image/png' : 'image/jpeg';
    const r = await net.fetch(`${API}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': type },
      body: img,
    });
    if (!r.ok) warnings.push((await apiError(r)).message);
  }
  if (f.captionsPath) {
    onProgress({ phase: 'captions' });
    const srt = await readFile(f.captionsPath);
    const mp = multipartRelated({ snippet: { videoId, language: f.language, name: '' } }, srt, 'application/octet-stream');
    const r = await net.fetch(`${API}/upload/youtube/v3/captions?uploadType=multipart&part=snippet`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': mp.contentType },
      body: mp.body,
    });
    if (!r.ok) warnings.push((await apiError(r)).message);
  }
  onProgress({ phase: 'done' });
  return { videoId, url: `https://youtu.be/${videoId}`, warnings };
}
