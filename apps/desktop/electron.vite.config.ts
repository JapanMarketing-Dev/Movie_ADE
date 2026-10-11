import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { publishDefines, tiktokEnvFileName } from './src/main/publish/buildEnv';

// Platform packages are built concurrently by other workers. If one has no src/index.ts yet, bundle a stub
// whose functions throw "not available yet" so the app still builds and starts; main-process services catch it.
function missingWorkspaceStubs(): Plugin {
  const PREFIX = '\0solocut-stub:';
  return {
    name: 'solocut-missing-workspace-stubs',
    enforce: 'pre',
    resolveId(id) {
      const m = /^@solocut\/([a-z-]+)$/.exec(id);
      if (!m) return null;
      if (existsSync(resolve(__dirname, '../../packages', m[1]!, 'src/index.ts'))) return null;
      this.warn(`@solocut/${m[1]} has no src/index.ts yet; bundling a stub`);
      return { id: PREFIX + m[1], syntheticNamedExports: true };
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const name = id.slice(PREFIX.length);
      return `const fail = () => { throw new Error('@solocut/${name} is not available in this build'); };
export default new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : fail) });`;
    },
  };
}

// In dev, Vite injects an inline React Refresh preamble and talks to its server over ws://; relax the CSP
// meta tag for `electron-vite dev` only. Production builds keep the strict policy from index.html.
function devCsp(): Plugin {
  return {
    name: 'solocut-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline' http://localhost:*")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    },
  };
}

// OAuth clients compiled into main (docs/14): env SOLOCUT_YOUTUBE_CLIENT_ID / _SECRET and SOLOCUT_TIKTOK_CLIENT_KEY,
// else the local release files (Google client JSON; TIKTOK_CLIENT_KEY only from tiktok-<SOLOCUT_TIKTOK_ENV>.env — the TikTok
// secret stays in the exchange worker). Values are never logged or written anywhere but the bundle.
function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}
function oauthDefines(): Record<string, string> {
  const dir = resolve(homedir(), '.solocut-release');
  const google = readIfExists(process.env.SOLOCUT_GOOGLE_OAUTH_JSON ?? resolve(dir, 'google-oauth-client.json'));
  const tiktok = readIfExists(process.env.SOLOCUT_TIKTOK_ENV_FILE ?? resolve(dir, tiktokEnvFileName(process.env)));
  return publishDefines(process.env, google, tiktok);
}

// Workspace packages (@solocut/*) are devDependencies, so they are bundled into main.
// Of the `dependencies`, only node-pty stays external (native addon, shipped in app.asar.unpacked).
export default defineConfig({
  main: {
    plugins: [missingWorkspaceStubs()],
    define: oauthDefines(),
    build: {
      // Sentry is bundled too (its node_modules tree is ~35 MB); only node-pty stays external.
      externalizeDeps: { exclude: ['@sentry/electron'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs' },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCsp()],
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html'), analysis: resolve(__dirname, 'src/renderer/analysis.html') },
      },
    },
  },
});
