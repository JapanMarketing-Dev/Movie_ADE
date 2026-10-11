// Build time (electron.vite.config.ts): which OAuth client values get compiled into main. Never logs values.
// Order per key: env SOLOCUT_* → env MAIN_VITE_SOLOCUT_* → local release files so a plain `pnpm build` works:
//   YouTube: Google's installed-app JSON (~/.solocut-release/google-oauth-client.json, or SOLOCUT_GOOGLE_OAUTH_JSON)
//   TikTok:  TIKTOK_CLIENT_KEY from ~/.solocut-release/tiktok-<SOLOCUT_TIKTOK_ENV>.env (sandbox by default, production
//            for releases once TikTok approves the app), or SOLOCUT_TIKTOK_ENV_FILE.
// The TikTok client secret is never compiled in: it lives only in the exchange worker (tools/oauth-worker).

export const PUBLISH_BUILD_KEYS = [
  'SOLOCUT_YOUTUBE_CLIENT_ID',
  'SOLOCUT_YOUTUBE_CLIENT_SECRET',
  'SOLOCUT_TIKTOK_CLIENT_KEY',
  'SOLOCUT_TIKTOK_TOKEN_URL',
  'SOLOCUT_TIKTOK_DIRECT_POST',
] as const;

/** `{ installed: { client_id, client_secret } }` (or `web`) → the two values; junk → {}. */
export function googleClientFromJson(text: string | null): { id?: string; secret?: string } {
  if (!text) return {};
  try {
    const j = JSON.parse(text) as Record<string, { client_id?: unknown; client_secret?: unknown } | undefined>;
    const c = j.installed ?? j.web;
    return {
      ...(typeof c?.client_id === 'string' && c.client_id ? { id: c.client_id } : {}),
      ...(typeof c?.client_secret === 'string' && c.client_secret ? { secret: c.client_secret } : {}),
    };
  } catch {
    return {};
  }
}

export const TIKTOK_ENVS = ['sandbox', 'production'] as const;

/** `tiktok-sandbox.env` | `tiktok-production.env` from SOLOCUT_TIKTOK_ENV (default sandbox); throws on anything else. */
export function tiktokEnvFileName(env: Record<string, string | undefined>): string {
  const v = (env.SOLOCUT_TIKTOK_ENV ?? '').trim().toLowerCase() || 'sandbox';
  if (!(TIKTOK_ENVS as readonly string[]).includes(v)) throw new Error(`SOLOCUT_TIKTOK_ENV must be sandbox or production (got ${env.SOLOCUT_TIKTOK_ENV})`);
  return `tiktok-${v}.env`;
}

/** One value from a dotenv-style file (KEY=VALUE, optional quotes / `export`, # comments); never other keys. */
export function dotenvValue(text: string | null, key: string): string | undefined {
  if (!text) return undefined;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || m[1] !== key) continue;
    let v = m[2]!;
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    return v.trim() || undefined;
  }
  return undefined;
}

/** Vite `define` entries (`import.meta.env.MAIN_VITE_SOLOCUT_*`) for the values that were found. */
export function publishDefines(env: Record<string, string | undefined>, googleJson: string | null, tiktokEnvFile: string | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  const g = googleClientFromJson(googleJson);
  for (const k of PUBLISH_BUILD_KEYS) {
    let v = env[k]?.trim() || env[`MAIN_VITE_${k}`]?.trim();
    if (!v && k === 'SOLOCUT_YOUTUBE_CLIENT_ID') v = g.id;
    if (!v && k === 'SOLOCUT_TIKTOK_CLIENT_KEY') v = dotenvValue(tiktokEnvFile, 'TIKTOK_CLIENT_KEY');
    // the secret only from the same source as the id (never mix two clients)
    if (!v && k === 'SOLOCUT_YOUTUBE_CLIENT_SECRET' && !(env.SOLOCUT_YOUTUBE_CLIENT_ID?.trim() || env.MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_ID?.trim())) v = g.secret;
    if (v) out[`import.meta.env.MAIN_VITE_${k}`] = JSON.stringify(v);
  }
  return out;
}
