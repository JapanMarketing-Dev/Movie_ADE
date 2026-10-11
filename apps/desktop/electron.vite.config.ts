import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

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
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    },
  };
}

// Workspace packages (@solocut/*) are devDependencies, so they are bundled into main.
// Of the `dependencies`, only node-pty stays external (native addon, shipped in app.asar.unpacked).
export default defineConfig({
  main: {
    plugins: [missingWorkspaceStubs()],
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
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
