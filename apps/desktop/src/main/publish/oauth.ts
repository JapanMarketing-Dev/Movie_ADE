// Pure OAuth helpers for the installed-app flow (RFC 8252): PKCE (S256), the Google authorization URL and the
// loopback callback parsing.
import { createHash, randomBytes } from 'node:crypto';

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];

export function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 43..128 chars from the unreserved set. */
export function newVerifier(bytes = 48): string {
  return base64url(randomBytes(bytes));
}

export function challengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function authUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string; scopes?: string[] }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: (o.scopes ?? YOUTUBE_SCOPES).join(' '),
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH}?${q.toString()}`;
}

export type CallbackResult = { ok: true; code: string } | { ok: false; error: string } | { ok: 'ignore' };

/** Parses the loopback request URL. Ignores unrelated paths (favicon); rejects a wrong state. */
export function parseCallback(reqUrl: string, expectedState: string): CallbackResult {
  const u = new URL(reqUrl, 'http://127.0.0.1');
  if (u.pathname !== '/' && u.pathname !== '/callback') return { ok: 'ignore' };
  const err = u.searchParams.get('error');
  if (err) return { ok: false, error: err };
  if (u.searchParams.get('state') !== expectedState) return { ok: false, error: 'state mismatch' };
  const code = u.searchParams.get('code');
  return code ? { ok: true, code } : { ok: false, error: 'no code' };
}

export function tokenRequestBody(o: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string }): URLSearchParams {
  const b = new URLSearchParams({
    client_id: o.clientId,
    code: o.code,
    code_verifier: o.verifier,
    grant_type: 'authorization_code',
    redirect_uri: o.redirectUri,
  });
  if (o.clientSecret) b.set('client_secret', o.clientSecret);
  return b;
}

export function refreshRequestBody(o: { clientId: string; clientSecret?: string; refreshToken: string }): URLSearchParams {
  const b = new URLSearchParams({ client_id: o.clientId, refresh_token: o.refreshToken, grant_type: 'refresh_token' });
  if (o.clientSecret) b.set('client_secret', o.clientSecret);
  return b;
}

/** multipart/related body for captions.insert (JSON metadata + caption file). */
export function multipartRelated(meta: unknown, body: Buffer, bodyType: string, boundary = `solocut${Date.now().toString(36)}`): { body: Buffer; contentType: string } {
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${bodyType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return { body: Buffer.concat([Buffer.from(head), body, Buffer.from(tail)]), contentType: `multipart/related; boundary=${boundary}` };
}
