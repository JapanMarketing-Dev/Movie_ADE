// Which OAuth clients Solocut ships with. End users only press "connect": the client id / key is built in.
// Order: build time (MAIN_VITE_SOLOCUT_* when electron-vite builds main) → runtime env SOLOCUT_* (development)
// → for YouTube, a client id saved in secrets by a developer (old BYO setting).

export interface YouTubeClient {
  clientId: string;
  clientSecret?: string;
}

export interface TikTokClient {
  clientKey: string;
  /** Solocut's exchange worker (holds the client secret; the app never has it): <tokenUrl>/token | refresh | revoke */
  tokenUrl: string;
  /** the app passed TikTok's audit: Direct Post (video.publish) instead of sending drafts to the inbox */
  directPost: boolean;
}

export type EnvSource = Record<string, string | undefined>;

function buildEnv(): EnvSource {
  try {
    return {
      SOLOCUT_YOUTUBE_CLIENT_ID: import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_ID,
      SOLOCUT_YOUTUBE_CLIENT_SECRET: import.meta.env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_SECRET,
      SOLOCUT_TIKTOK_CLIENT_KEY: import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY,
      SOLOCUT_TIKTOK_TOKEN_URL: import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_TOKEN_URL,
      SOLOCUT_TIKTOK_DIRECT_POST: import.meta.env.MAIN_VITE_SOLOCUT_TIKTOK_DIRECT_POST,
    };
  } catch {
    return {};
  }
}

const val = (v: string | undefined | null) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** First non-empty value per key across the sources (earlier wins). */
export function mergeEnv(...sources: EnvSource[]): EnvSource {
  const out: EnvSource = {};
  for (const s of sources) for (const [k, v] of Object.entries(s)) if (out[k] === undefined && val(v)) out[k] = val(v);
  return out;
}

export function youtubeClientFrom(env: EnvSource, devClientId?: string | null, devClientSecret?: string | null): YouTubeClient | null {
  const id = val(env.SOLOCUT_YOUTUBE_CLIENT_ID);
  if (id) return { clientId: id, ...(val(env.SOLOCUT_YOUTUBE_CLIENT_SECRET) ? { clientSecret: val(env.SOLOCUT_YOUTUBE_CLIENT_SECRET)! } : {}) };
  const dev = val(devClientId);
  if (dev) return { clientId: dev, ...(val(devClientSecret) ? { clientSecret: val(devClientSecret)! } : {}) };
  return null;
}

export function tiktokClientFrom(env: EnvSource, defaultTokenUrl = 'https://solocut.app/oauth/tiktok'): TikTokClient | null {
  const key = val(env.SOLOCUT_TIKTOK_CLIENT_KEY);
  if (!key) return null;
  const tokenUrl = val(env.SOLOCUT_TIKTOK_TOKEN_URL) ?? defaultTokenUrl;
  // https only, except a local `wrangler dev` (http://127.0.0.1 / localhost) while developing
  if (!/^https:\/\//.test(tokenUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(tokenUrl)) return null;
  return { clientKey: key, tokenUrl, directPost: /^(1|true|yes)$/i.test(env.SOLOCUT_TIKTOK_DIRECT_POST ?? '') };
}

export function publishEnv(runtime: EnvSource = process.env): EnvSource {
  return mergeEnv(buildEnv(), runtime);
}
