// The reference window (docs/09): the platform's own player in an in-app browser on its own persistent partition
// (sign-ins kept, no app IPC, no solocut-media). The user plays it; the app only reads the player's position and
// captures this window's picture and sound for the app window's next getDisplayMedia() call.
import { BrowserWindow, session, shell, type Streams, type WebContents } from 'electron';
import { allowedInReferenceWindow, parsePlayerSample, parseReferenceUrl, type PlayerSample } from '../../shared/benchmark';

const PARTITION = 'persist:solocut-reference';

let win: BrowserWindow | null = null;
let armed = false;
let sessionReady = false;

function setupSession(): void {
  if (sessionReady) return;
  sessionReady = true;
  const ses = session.fromPartition(PARTITION);
  // no camera / mic / notifications / screen capture for remote pages
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');
}

function lock(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (allowedInReferenceWindow(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (allowedInReferenceWindow(url)) void wc.loadURL(url);
    else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export function openReference(url: string, onClosed: () => void): { ok: boolean; error?: string } {
  const p = parseReferenceUrl(url);
  if (!p.ok) return { ok: false, error: p.error };
  setupSession();
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      title: 'Solocut — お手本動画',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // the user starts playback; the app never does
        autoplayPolicy: 'document-user-activation-required',
        backgroundThrottling: false,
      },
    });
    lock(win.webContents);
    win.on('closed', () => {
      win = null;
      armed = false;
      onClosed();
    });
  }
  void win.loadURL(p.url);
  win.show();
  win.focus();
  return { ok: true };
}

export function closeReference(): void {
  armed = false;
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

// Reads the main <video> (the playing one, else the largest) in an isolated world: page scripts are not touched.
const PLAYER_JS = `(() => {
  const vs = Array.from(document.querySelectorAll('video'));
  if (!vs.length) return null;
  const area = (v) => (v.videoWidth || 0) * (v.videoHeight || 0);
  const v = vs.filter((x) => !x.paused)[0] || vs.sort((a, b) => area(b) - area(a))[0];
  return { t: v.currentTime, paused: v.paused, rate: v.playbackRate, ended: v.ended, duration: Number.isFinite(v.duration) ? v.duration : undefined };
})()`;

export async function playerSample(): Promise<PlayerSample | null> {
  if (!win || win.isDestroyed()) return null;
  try {
    const r = await win.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: PLAYER_JS }]);
    return parsePlayerSample(r);
  } catch {
    return null;
  }
}

export function armCapture(): { ok: boolean; error?: string } {
  if (!win || win.isDestroyed()) return { ok: false, error: 'the reference window is not open' };
  armed = true;
  return { ok: true };
}

/**
 * For the app session's display-media handler: when armed, the reference window's frame as both video and audio
 * (tab capture; the user still hears it). One use per arm.
 */
export function takeReferenceCapture(): Streams | null {
  if (!armed) return null;
  armed = false;
  if (!win || win.isDestroyed()) return null;
  const frame = win.webContents.mainFrame;
  return { video: frame, audio: frame, enableLocalEcho: true };
}
