// Drag-to-select overlay for the recording region (like macOS's screenshot selection): a transparent, frameless,
// always-on-top window covering one display. The overlay renderer (screens/RegionPicker.tsx, hash `region=<id>`)
// answers through record:regionDone with the dragged DIP rectangle; it is converted here to display pixels.
// Only one picker is open at a time; closing it (or opening another) resolves the pending pick with null.
import { BrowserWindow, screen, type WebContents } from 'electron';
import { regionFromDip, type DisplayInfo, type Rect, type Region } from '../../shared/region';

export interface PickerHost {
  webPreferences: () => Electron.WebPreferences;
  load: (win: BrowserWindow, hash: string) => void;
  lock: (win: BrowserWindow) => void;
  /** Hides the app's own window while the user drags; returns how to bring it back. */
  hideApp?: () => () => void;
}

interface Pending {
  win: BrowserWindow;
  display: DisplayInfo;
  resolve: (r: Region | null) => void;
  restore: () => void;
}

let pending: Pending | null = null;

export function listDisplays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor,
  }));
}

export function pickRegion(displayId: string, host: PickerHost, lang = 'ja'): Promise<Region | null> {
  finish(null);
  const display = listDisplays().find((d) => d.id === displayId);
  if (!display) return Promise.reject(new Error(`display not found: ${displayId}`));
  const b = display.bounds;
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true, // macOS: cover the menu bar too
    show: false,
    title: 'Solocut — Region',
    webPreferences: host.webPreferences(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  host.lock(win);
  const restore = host.hideApp?.() ?? (() => undefined);
  const p = new Promise<Region | null>((resolve) => {
    pending = { win, display, resolve, restore };
  });
  win.on('closed', () => {
    if (pending?.win === win) finish(null);
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.setBounds(b); // macOS places new windows below the menu bar; set the full display frame again
    win.show();
    win.focus();
  });
  host.load(win, `region=${encodeURIComponent(displayId)}&lang=${encodeURIComponent(lang)}`);
  return p;
}

/** The overlay's answer. Ignored unless it comes from the open overlay window. */
export function regionDone(sender: WebContents, rect: Rect | null): void {
  if (!pending || pending.win.isDestroyed() || pending.win.webContents !== sender) return;
  finish(rect);
}

function finish(rect: Rect | null): void {
  const p = pending;
  if (!p) return;
  pending = null;
  const region = rect ? regionFromDip(rect, p.display) : null;
  if (!p.win.isDestroyed()) p.win.close();
  p.restore();
  p.resolve(region);
}

export function cancelPick(): void {
  finish(null);
}
