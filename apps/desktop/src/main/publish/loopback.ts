// Installed-app OAuth (RFC 8252): a one-shot HTTP server on 127.0.0.1 (random port) receives the redirect from
// the system browser. Shared by YouTube and TikTok. The browser opener is injected (electron's shell in the app).
import { createServer } from 'node:http';
import { parseCallback } from './oauth';

export interface LoopbackOptions {
  /** redirect path, e.g. '/' (Google) or '/tiktok/callback' (TikTok) */
  path: string;
  /** fixed port (TikTok's registered redirect URI); omitted: any free port (Google allows that) */
  port?: number;
  state: string;
  /** authorization URL for the redirect URI the server got */
  buildUrl: (redirectUri: string) => string;
  open: (url: string) => void | Promise<void>;
  /** shown in the browser tab */
  label: string;
  timeoutMs?: number;
}

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Solocut</title><body style="background:#0f1012;color:#e7e7ea;font-family:sans-serif;padding:40px">${text}</body>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function loopbackAuthorize(o: LoopbackOptions): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    let settled = false;
    const server = createServer((req, res) => {
      const r = parseCallback(req.url ?? '/', o.state, o.path === '/' ? ['/'] : [o.path]);
      if (r.ok === 'ignore') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(r.ok ? `Solocut: ${esc(o.label)} に接続しました。このタブを閉じてください。 / Connected. You can close this tab.` : `Solocut: ${esc(r.error)}`));
      finish(r.ok ? null : new Error(`authorization failed: ${r.error}`), r.ok ? r.code : '');
    });
    const finish = (err: Error | null, code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve({ code, redirectUri });
    };
    const timer = setTimeout(() => finish(new Error('authorization timed out'), ''), o.timeoutMs ?? 5 * 60_000);
    server.on('error', (e: NodeJS.ErrnoException) =>
      finish(
        e.code === 'EADDRINUSE' && o.port
          ? new Error(`ポート ${o.port} が他のアプリに使われています。そのアプリを閉じてからもう一度接続してください / port ${o.port} is in use by another app; close it and connect again`)
          : e,
        '',
      ),
    );
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}${o.path === '/' ? '' : o.path}`;
      Promise.resolve(o.open(o.buildUrl(redirectUri))).catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e)), ''));
    });
  });
}
