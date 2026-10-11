// CORS for solocut-media:// (pure). The header is echoed only for the app's own pages: file:// renderers send
// "null" (also their blob workers), and in development the Vite dev server origin. Anything else gets no header,
// so no other origin can read local media through a cross-origin fetch.

/** Origins of the app's own pages. `devUrl` is ELECTRON_RENDERER_URL in development. */
export function appOrigins(devUrl?: string): string[] {
  const out = ['null', 'file://'];
  if (devUrl) {
    try {
      const u = new URL(devUrl);
      if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) out.push(u.origin);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

/** The value for Access-Control-Allow-Origin, or null to omit the header. */
export function corsOrigin(origin: string | null | undefined, allowed: string[]): string | null {
  if (origin === null || origin === undefined) return null; // same-origin / no-cors requests (e.g. <video>) need none
  const o = origin.trim();
  return allowed.includes(o) ? o : null;
}
