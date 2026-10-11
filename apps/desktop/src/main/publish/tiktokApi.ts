// Pure TikTok helpers (Login Kit for Desktop + Content Posting API, docs checked 2026-10):
// - authorize: https://www.tiktok.com/v2/auth/authorize/ with PKCE; TikTok's desktop flow wants the challenge as the
//   HEX-encoded SHA-256 of the verifier (not base64url); redirect to a registered http://127.0.0.1:<port>/callback/
//   (register `http://127.0.0.1:*/callback/` — the wildcard port allows a random loopback port).
// - token: POST https://open.tiktokapis.com/v2/oauth/token/ (form): client_key, client_secret, code, grant_type,
//   redirect_uri, code_verifier. Access tokens live 24 h, refresh tokens 365 days (the refresh may rotate it).
// - inbox upload (scope video.upload): POST /v2/post/publish/inbox/video/init/ → upload_url; PUT the chunks.
//   Direct Post (video.publish, audited apps): POST /v2/post/publish/video/init/ with post_info.
// - chunks: ≥5 MB and ≤64 MB each, total_chunk_count = floor(size / chunk_size), the remainder joins the last chunk
//   (≤128 MB); files under 5 MB go in one chunk; at most 1000 chunks.
import { createHash, randomBytes } from 'node:crypto';
import type { PublishSpec } from '../../shared/publish';

export const TIKTOK_AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_API = 'https://open.tiktokapis.com';
export const TIKTOK_REDIRECT_HOST = '127.0.0.1';
export const TIKTOK_REDIRECT_PORT = 47823;
export const TIKTOK_CALLBACK_PATH = '/tiktok/callback';
/** Registered in the TikTok developer portal exactly like this (also the localhost variant). */
export const TIKTOK_REDIRECT_URI = `http://${TIKTOK_REDIRECT_HOST}:${TIKTOK_REDIRECT_PORT}${TIKTOK_CALLBACK_PATH}`;
export const DEFAULT_TIKTOK_EXCHANGE = 'https://solocut.app/oauth/tiktok';

/** The exchange worker's endpoint: <base>/token, <base>/refresh, <base>/revoke. */
export function exchangeUrl(base: string, kind: 'token' | 'refresh' | 'revoke'): string {
  return `${base.replace(/\/+$/, '')}/${kind}`;
}

export function tiktokScopes(directPost: boolean): string[] {
  return ['user.info.basic', 'video.upload', ...(directPost ? ['video.publish'] : [])];
}

/** 43..128 characters of [A-Za-z0-9-._~]. */
export function tiktokVerifier(bytes = 48): string {
  return randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 128);
}

export function tiktokChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('hex');
}

export function tiktokAuthUrl(o: { clientKey: string; redirectUri: string; challenge: string; state: string; scopes: string[] }): string {
  const q = new URLSearchParams({
    client_key: o.clientKey,
    scope: o.scopes.join(','),
    redirect_uri: o.redirectUri,
    state: o.state,
    response_type: 'code',
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  });
  return `${TIKTOK_AUTH}?${q.toString()}`;
}

/** Form body for the exchange worker: client_key picks its sandbox / production secret; it adds client_secret. */
export function tiktokTokenBody(clientKey: string, o: { code: string; verifier: string; redirectUri: string } | { refreshToken: string }): URLSearchParams {
  if ('refreshToken' in o) return new URLSearchParams({ client_key: clientKey, refresh_token: o.refreshToken });
  return new URLSearchParams({ client_key: clientKey, code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri });
}

export interface TikTokTokens {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  openId: string;
  scope: string[];
}

/** Token endpoint response → tokens. Throws with TikTok's error text on failure. */
export function parseTikTokToken(j: unknown, nowMs: number): TikTokTokens {
  const o = (j ?? {}) as Record<string, unknown>;
  if (typeof o.access_token !== 'string' || !o.access_token || typeof o.refresh_token !== 'string') {
    const e = typeof o.error === 'string' ? o.error : (o.error as { code?: string } | undefined)?.code;
    const d = typeof o.error_description === 'string' ? o.error_description : (o.error as { message?: string } | undefined)?.message;
    throw new Error(`TikTok token: ${e ?? 'no access token'}${d ? ` ${d}` : ''}`);
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    accessToken: o.access_token,
    expiresAt: nowMs + num(o.expires_in, 86_400) * 1000,
    refreshToken: o.refresh_token,
    refreshExpiresAt: nowMs + num(o.refresh_expires_in, 365 * 86_400) * 1000,
    openId: typeof o.open_id === 'string' ? o.open_id : '',
    scope: typeof o.scope === 'string' ? o.scope.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

export function parseStoredTokens(text: string | null): TikTokTokens | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as Partial<TikTokTokens>;
    if (typeof o.accessToken !== 'string' || typeof o.refreshToken !== 'string' || typeof o.expiresAt !== 'number') return null;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: o.expiresAt,
      refreshExpiresAt: typeof o.refreshExpiresAt === 'number' ? o.refreshExpiresAt : o.expiresAt,
      openId: typeof o.openId === 'string' ? o.openId : '',
      scope: Array.isArray(o.scope) ? o.scope.filter((s): s is string => typeof s === 'string') : [],
    };
  } catch {
    return null;
  }
}

const MB = 1024 * 1024;
export const TT_MIN_CHUNK = 5 * MB;
export const TT_MAX_CHUNK = 64 * MB;
export const TT_MAX_LAST_CHUNK = 128 * MB;

export interface ChunkPlan {
  chunkSize: number;
  count: number;
  /** [start, endInclusive] per chunk; the last one takes the remainder */
  ranges: [number, number][];
}

export function tiktokChunkPlan(size: number, preferred = 10 * MB): ChunkPlan {
  if (!Number.isFinite(size) || size <= 0) throw new Error('empty video');
  if (size < TT_MIN_CHUNK) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] };
  let chunk = Math.max(TT_MIN_CHUNK, Math.min(TT_MAX_CHUNK, Math.floor(preferred)));
  if (size <= TT_MAX_CHUNK) chunk = Math.min(chunk, size);
  let count = Math.floor(size / chunk);
  // keep within 1000 chunks by growing the chunk
  while (count > 1000 && chunk < TT_MAX_CHUNK) {
    chunk = Math.min(TT_MAX_CHUNK, chunk * 2);
    count = Math.floor(size / chunk);
  }
  if (count > 1000) throw new Error('video too large for TikTok (over 1000 chunks)');
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) ranges.push([i * chunk, i === count - 1 ? size - 1 : (i + 1) * chunk - 1]);
  const last = ranges[ranges.length - 1]!;
  if (last[1] - last[0] + 1 > TT_MAX_LAST_CHUNK) throw new Error('last chunk too large');
  return { chunkSize: chunk, count, ranges };
}

export function contentTypeFor(path: string): string {
  return /\.mov$/i.test(path) ? 'video/quicktime' : /\.webm$/i.test(path) ? 'video/webm' : 'video/mp4';
}

/** Inbox upload (draft in the TikTok app; the creator finishes the post there). */
export function inboxInitBody(plan: ChunkPlan, size: number): Record<string, unknown> {
  return { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count } };
}

/** Direct Post body. The privacy must be one of the creator's privacy_level_options (falls back to SELF_ONLY). */
export function directInitBody(spec: PublishSpec, plan: ChunkPlan, size: number, privacyOptions: string[]): Record<string, unknown> {
  const privacy = privacyOptions.includes(spec.tiktok.privacy) ? spec.tiktok.privacy : privacyOptions.includes('SELF_ONLY') || !privacyOptions.length ? 'SELF_ONLY' : privacyOptions[0]!;
  return {
    post_info: {
      title: spec.tiktok.caption,
      privacy_level: privacy,
      disable_comment: !spec.tiktok.allowComment,
      disable_duet: !spec.tiktok.allowDuet,
      disable_stitch: !spec.tiktok.allowStitch,
      is_aigc: spec.tiktok.isAigc,
      brand_content_toggle: false,
      brand_organic_toggle: false,
    },
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
  };
}

/** `{ data, error: { code, message } }` → data, or throws with TikTok's message. */
export function tiktokData<T = Record<string, unknown>>(j: unknown, what: string): T {
  const o = (j ?? {}) as { data?: T; error?: { code?: string; message?: string } };
  const code = o.error?.code;
  if (code && code !== 'ok') throw new Error(`TikTok ${what}: ${code}${o.error?.message ? ` ${o.error.message}` : ''}`);
  if (!o.data) throw new Error(`TikTok ${what}: no data`);
  return o.data;
}

export type TikTokStatus = { done: boolean; ok: boolean; status: string; postId?: string; reason?: string };

/** status/fetch → whether to keep polling. Inbox: SEND_TO_USER_INBOX is the end; direct: PUBLISH_COMPLETE. */
export function interpretStatus(data: Record<string, unknown>, mode: 'inbox' | 'direct'): TikTokStatus {
  const status = typeof data.status === 'string' ? data.status : '';
  const ids = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : [];
  const postId = ids.length ? String(ids[0]) : undefined;
  if (status === 'FAILED') return { done: true, ok: false, status, reason: typeof data.fail_reason === 'string' ? data.fail_reason : 'failed' };
  if (status === 'PUBLISH_COMPLETE') return { done: true, ok: true, status, ...(postId ? { postId } : {}) };
  if (status === 'SEND_TO_USER_INBOX' && mode === 'inbox') return { done: true, ok: true, status };
  return { done: false, ok: true, status };
}

export function tiktokVideoUrl(username: string | undefined, postId: string | undefined): string | undefined {
  if (!username || !postId || !/^[\w.]+$/.test(username) || !/^\d+$/.test(postId)) return undefined;
  return `https://www.tiktok.com/@${username}/video/${postId}`;
}
