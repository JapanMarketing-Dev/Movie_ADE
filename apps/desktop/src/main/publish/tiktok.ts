// TikTok with Solocut's own client (Login Kit for Desktop + Content Posting API; endpoints in tiktokApi.ts).
// Default: the video goes to the creator's TikTok inbox as a draft (video.upload) and they finish the post in the
// TikTok app. After TikTok's audit (config directPost) it is posted directly (video.publish). Without a configured
// client the screen offers "open TikTok and upload" instead.
import { net, shell } from 'electron';
import { open as fsOpen, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getSecret, hasSecret, setSecret } from '../services/secrets';
import { publishEnv, tiktokClientFrom, type TikTokClient } from './config';
import { loopbackAuthorize } from './loopback';
import { readNames, setName } from './accounts';
import type { UploadContext, UploadOutcome } from './handoff';
import {
  TIKTOK_API,
  TIKTOK_CALLBACK_PATH,
  TIKTOK_REDIRECT_PORT,
  exchangeUrl,
  contentTypeFor,
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
  type TikTokTokens,
} from './tiktokApi';

export function tiktokClient(): TikTokClient | null {
  return tiktokClientFrom(publishEnv());
}

function client(): TikTokClient {
  const c = tiktokClient();
  if (!c) throw new Error('TikTok の接続は準備中です。「TikTok を開いてアップロード」を使ってください / TikTok connection is not available yet');
  return c;
}

export function tiktokStatus(): { configured: boolean; connected: boolean; name?: string; directPost?: boolean } {
  const c = tiktokClient();
  const connected = Boolean(c) && hasSecret('tiktok.tokens');
  const name = readNames().tiktok?.name;
  return { configured: Boolean(c), connected, ...(connected && name ? { name } : {}), ...(c ? { directPost: c.directPost } : {}) };
}

/** Through Solocut's exchange worker: the client secret never ships in the app. */
async function tokenCall(c: TikTokClient, kind: 'token' | 'refresh', body: URLSearchParams): Promise<TikTokTokens> {
  const r = await net.fetch(exchangeUrl(c.tokenUrl, kind), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: body.toString(),
  }).catch((e: unknown) => {
    throw new Error(`TikTok: Solocut のサーバーにつながりません / cannot reach the token server (${e instanceof Error ? e.message : String(e)})`);
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return parseTikTokToken(j, Date.now());
}

function save(t: TikTokTokens): void {
  setSecret('tiktok.tokens', JSON.stringify(t));
}

async function tokens(): Promise<TikTokTokens> {
  const c = client();
  const t = parseStoredTokens(getSecret('tiktok.tokens'));
  if (!t) throw new Error('TikTok に接続していません（設定 → アカウント） / TikTok is not connected');
  if (t.expiresAt - 60_000 > Date.now()) return t;
  if (t.refreshExpiresAt <= Date.now()) throw new Error('TikTok の接続が切れました。もう一度接続してください / TikTok login expired; connect again');
  const fresh = await tokenCall(c, 'refresh', tiktokTokenBody(c.clientKey, { refreshToken: t.refreshToken }));
  save(fresh);
  return fresh;
}

async function api<T = Record<string, unknown>>(path: string, body: unknown, what: string, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  const t = await tokens();
  const r = await net.fetch(`${TIKTOK_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t.accessToken}`, ...(method === 'POST' ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const j = await r.json().catch(() => ({ error: { code: `http_${r.status}`, message: r.statusText } }));
  return tiktokData<T>(j, what);
}

export async function connectTikTok(): Promise<{ name?: string }> {
  const c = client();
  const verifier = tiktokVerifier();
  const state = randomBytes(16).toString('hex');
  const got = await loopbackAuthorize({
    path: TIKTOK_CALLBACK_PATH,
    port: TIKTOK_REDIRECT_PORT,
    state,
    label: 'TikTok',
    buildUrl: (redirectUri) => tiktokAuthUrl({ clientKey: c.clientKey, redirectUri, challenge: tiktokChallenge(verifier), state, scopes: tiktokScopes(c.directPost) }),
    open: (url) => shell.openExternal(url),
  });
  const t = await tokenCall(c, 'token', tiktokTokenBody(c.clientKey, { code: got.code, verifier, redirectUri: got.redirectUri }));
  save(t);
  const user = await api<{ user?: { display_name?: string } }>('/v2/user/info/?fields=open_id,display_name', null, 'user info', 'GET').catch(() => null);
  const name = user?.user?.display_name;
  setName('tiktok', name ? { name } : {});
  return name ? { name } : {};
}

export async function disconnectTikTok(): Promise<void> {
  const c = tiktokClient();
  const t = parseStoredTokens(getSecret('tiktok.tokens'));
  if (c && t) {
    const b = new URLSearchParams({ client_key: c.clientKey, token: t.accessToken });
    await net.fetch(exchangeUrl(c.tokenUrl, 'revoke'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() }).catch(() => undefined);
  }
  setSecret('tiktok.tokens', null);
  setName('tiktok', null);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The hand-off uploader: inbox draft by default, Direct Post when the app is audited and the scope was granted. */
export async function uploadToTikTok(c: UploadContext): Promise<UploadOutcome> {
  const cl = client();
  const t = await tokens();
  const direct = cl.directPost && t.scope.includes('video.publish');
  const size = (await stat(c.videoPath)).size;
  const plan = tiktokChunkPlan(size);
  const warnings: string[] = [];
  c.onProgress('auth');
  let username: string | undefined;
  let init: { publish_id?: string; upload_url?: string };
  if (direct) {
    const info = await api<{ privacy_level_options?: string[]; creator_username?: string; max_video_post_duration_sec?: number }>('/v2/post/publish/creator_info/query/', {}, 'creator info');
    username = info.creator_username;
    const options = Array.isArray(info.privacy_level_options) ? info.privacy_level_options : [];
    if (!options.includes(c.spec.tiktok.privacy)) warnings.push(`privacy ${c.spec.tiktok.privacy} is not available for this account; used ${options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0]}`);
    init = await api('/v2/post/publish/video/init/', directInitBody(c.spec, plan, size, options), 'post init');
  } else {
    init = await api('/v2/post/publish/inbox/video/init/', inboxInitBody(plan, size), 'upload init');
  }
  if (!init.upload_url || !init.publish_id) throw new Error('TikTok: no upload URL');
  const fh = await fsOpen(c.videoPath, 'r');
  try {
    for (const [start, end] of plan.ranges) {
      c.onProgress('upload', start / size);
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const r = await net.fetch(init.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentTypeFor(c.videoPath), 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${end}/${size}` },
        body: buf,
      });
      if (!r.ok && r.status !== 206) throw new Error(`TikTok upload ${r.status}: ${r.statusText}`);
    }
  } finally {
    await fh.close();
  }
  c.onProgress('processing', 1);
  // wait for TikTok to take it (inbox) or publish it (direct); give up politely after ~3 minutes
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const s = interpretStatus(await api('/v2/post/publish/status/fetch/', { publish_id: init.publish_id }, 'status'), direct ? 'direct' : 'inbox');
    if (!s.done) continue;
    if (!s.ok) throw new Error(`TikTok: ${s.reason ?? s.status}`);
    if (!direct) return { status: 'inbox', warnings: [...warnings, 'TikTok アプリの受信トレイに届きました。アプリで投稿を仕上げてください / sent to your TikTok inbox: finish the post in the TikTok app'] };
    const url = tiktokVideoUrl(username, s.postId);
    return { ...(url ? { url } : {}), status: 'published', warnings };
  }
  return { status: direct ? 'published' : 'inbox', warnings: [...warnings, 'TikTok is still processing the video'] };
}

export function openTikTokUpload(videoPath: string | undefined, uploadPage: string): void {
  if (videoPath) shell.showItemInFolder(videoPath);
  void shell.openExternal(uploadPage);
}
