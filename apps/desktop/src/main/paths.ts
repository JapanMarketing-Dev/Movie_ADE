// Where bundled resources live in dev vs. the packaged app.
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
}

export function cliScript(): string {
  return join(resourcesRoot(), 'cli', 'solocut.mjs');
}

/** Directory with the `solocut` / `solocut.cmd` wrappers; put first on PATH in agent terminals. */
export function cliBinDir(): string {
  return join(resourcesRoot(), 'cli', 'bin');
}

export function templatesDir(): string {
  const bundled = join(resourcesRoot(), 'templates');
  if (app.isPackaged || existsSync(bundled)) return bundled;
  return join(app.getAppPath(), '..', '..', 'templates'); // repo /templates in dev
}

export function preloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

export function rendererUrl(hash = ''): { url?: string; file?: string; hash: string } {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && dev) return { url: dev + (hash ? `#${hash}` : ''), hash };
  return { file: join(__dirname, '../renderer/index.html'), hash };
}
