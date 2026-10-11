// solocut-media://file/<encoded absolute path> — serves local media to the renderer with Range support so
// <video> can seek. Only files under allowed roots (opened projects) are served.
import { protocol, session } from 'electron';
import { createReadStream, promises as fsp, realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { MEDIA_SCHEME, pathFromMediaUrl } from '../../shared/ipc';
import { contentTypeFor, parseRange } from './range';
import { appOrigins, corsOrigin } from './cors';

const roots = new Set<string>();

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function allowMediaRoot(dir: string): void {
  if (!dir || !isAbsolute(dir)) return;
  roots.add(real(dir));
}

/** Test hook. */
export function clearMediaRoots(): void {
  roots.clear();
}

/** True only for files under an allowed root after resolving symlinks (a link inside a project cannot escape it). */
export function isAllowed(path: string): boolean {
  const p = real(resolve(normalize(path)));
  for (const r of roots) {
    const rel = relative(r, p);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))) return true;
  }
  return false;
}

/** Must run before app 'ready'. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false } },
  ]);
}

/**
 * Registers the handler on the app's own session only. Remote pages (any future in-app browser, OAuth, webviews)
 * must use a separate partition, where this scheme does not exist.
 */
export function handleMediaProtocol(): void {
  const allowed = appOrigins(process.env.ELECTRON_RENDERER_URL);
  session.defaultSession.protocol.handle(MEDIA_SCHEME, async (req) => {
    const path = pathFromMediaUrl(req.url);
    if (!path || !isAbsolute(path) || !isAllowed(path)) return new Response('forbidden', { status: 403 });
    let size: number;
    try {
      const st = await fsp.stat(path);
      if (!st.isFile()) return new Response('not found', { status: 404 });
      size = st.size;
    } catch {
      return new Response('not found', { status: 404 });
    }
    const type = contentTypeFor(path);
    const r = parseRange(req.headers.get('range'), size);
    // CORS only for the app's own pages (the analysis window's workers fetch wasm and language data this way)
    const acao = corsOrigin(req.headers.get('origin'), allowed);
    const common: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (acao) {
      common['Access-Control-Allow-Origin'] = acao;
      common.Vary = 'Origin';
    }
    if (r.kind === 'invalid') {
      return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${size}` } });
    }
    if (r.kind === 'full') {
      const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
      return new Response(body, { status: 200, headers: { ...common, 'Content-Length': String(size) } });
    }
    const body = Readable.toWeb(createReadStream(path, { start: r.start, end: r.end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...common, 'Content-Length': String(r.end - r.start + 1), 'Content-Range': `bytes ${r.start}-${r.end}/${size}` },
    });
  });
}
