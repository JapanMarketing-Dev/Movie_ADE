import './env-setup';
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, Menu, session, shell, type WebContents } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import type { AppInfo, CaptureSource, SettingsDoc } from '../shared/types';
import { assertAllHandled, emit, handle, on, setTrustedOrigin } from './ipc';
import { cliScript, preloadPath, rendererUrl } from './paths';
import { cliAvailable, runCli } from './services/cli';
import { allowMediaRoot, handleMediaProtocol, registerMediaScheme } from './services/media-protocol';
import { askMediaAccess, openScreenRecordingSettings, permissionState } from './services/permissions';
import * as platform from './services/platform';
import * as project from './services/project';
import { PtyManager } from './services/pty';
import * as recorder from './services/recorder';
import { initSentry } from './services/sentry';
import { Updater } from './update/updater';

const log = (msg: string) => console.log(`[solocut] ${msg}`);

// ---- before ready ----
let crashReports = true;
try {
  crashReports = platform.crashReportsEnabled();
} catch (e) {
  log(`settings unavailable: ${e instanceof Error ? e.message : String(e)}`);
}
initSentry(crashReports);
registerMediaScheme();
app.setName('Solocut');
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let teleprompter: BrowserWindow | null = null;
let pendingCapture: { sourceId: string | null; systemAudio: boolean } = { sourceId: null, systemAudio: false };
let settingsWatcher: FSWatcher | null = null;

const mainWc = (): WebContents | null => mainWindow?.webContents ?? null;

const ptys = new PtyManager({
  data: (id, d) => emit(mainWc(), 'pty:data', id, d),
  exit: (id, code) => emit(mainWc(), 'pty:exit', id, code),
  activity: (id, a) => emit(mainWc(), 'pty:activity', id, a),
});
const watcher = new project.ProjectWatcher((dir, what) => emit(mainWc(), 'project:changed', dir, what));
const updater = new Updater({
  onState: (s) => emit(mainWc(), 'update:state', s),
  isBusy: () => recorder.activeTakes() > 0,
  log,
});

function isTrustedUrl(url: string): boolean {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && dev && url.startsWith(dev)) return true;
  return url.startsWith('file://');
}

function loadRenderer(win: BrowserWindow, hash = ''): void {
  const r = rendererUrl(hash);
  if (r.url) void win.loadURL(r.url);
  else if (r.file) void win.loadFile(r.file, hash ? { hash } : undefined);
}

function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    backgroundThrottling: false, // recording runs in the renderer; keep timers alive when hidden
  };
}

function lockNavigation(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1012',
    title: 'Solocut',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: secureWebPreferences(),
  });
  lockNavigation(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.once('did-finish-load', () => {
    const dir = projectArg(process.argv);
    if (dir) setTimeout(() => emit(mainWc(), 'project:openRequest', dir), 300);
    if (process.env.SOLOCUT_CAPTURE) void captureScreens(process.env.SOLOCUT_CAPTURE);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    teleprompter?.close();
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    log(`renderer gone: ${d.reason}`);
    recorder.endAll(); // keep what was written; files stay playable
    unregisterHotkeys();
  });
  loadRenderer(mainWindow);
}

/** Dev aid: SOLOCUT_CAPTURE=<dir> saves a PNG of each screen, then quits (no screen-recording permission needed). */
async function captureScreens(outDir: string): Promise<void> {
  const wc = mainWc();
  if (!wc) return;
  mkdirSync(outDir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const screens = (process.env.SOLOCUT_CAPTURE_SCREENS ?? 'home,workspace,record,archive,library,settings').split(',');
  await wait(2500);
  for (const s of screens) {
    emit(wc, 'app:navigate', s);
    if (s === 'workspace' && process.env.SOLOCUT_CAPTURE_CMD) {
      await wait(1500);
      await wc.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('solocut:run-in-terminal', { detail: ${JSON.stringify(process.env.SOLOCUT_CAPTURE_CMD)} }))`,
      );
    }
    await wait(s === 'workspace' ? 4000 : 1800);
    const img = await wc.capturePage();
    writeFileSync(`${outDir}/${s}.png`, img.toPNG());
  }
  app.quit();
}

function openTeleprompter(dir: string | null): void {
  if (!dir) {
    teleprompter?.close();
    return;
  }
  if (teleprompter && !teleprompter.isDestroyed()) {
    teleprompter.focus();
    return;
  }
  teleprompter = new BrowserWindow({
    width: 520,
    height: 360,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    title: 'Solocut — Teleprompter',
    webPreferences: secureWebPreferences(),
  });
  lockNavigation(teleprompter);
  teleprompter.on('closed', () => (teleprompter = null));
  loadRenderer(teleprompter, `teleprompter=${encodeURIComponent(dir)}`);
}

// ---- recording hotkeys ----
let hotkeysOn = false;
function registerHotkeys(): void {
  if (hotkeysOn) return;
  const hk = platform.hotkeys();
  const ok1 = globalShortcut.register(hk.markNg, () => emit(mainWc(), 'record:hotkey', 'ng'));
  const ok2 = globalShortcut.register(hk.markImportant, () => emit(mainWc(), 'record:hotkey', 'important'));
  if (!ok1 || !ok2) log('some recording hotkeys could not be registered (in use by another app?)');
  hotkeysOn = true;
}
function unregisterHotkeys(): void {
  if (!hotkeysOn) return;
  const hk = platform.hotkeys();
  globalShortcut.unregister(hk.markNg);
  globalShortcut.unregister(hk.markImportant);
  hotkeysOn = false;
}

// ---- settings files ----
function readDoc(path: string, validate: (t: string) => { errors: string[] }): SettingsDoc {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { path, text, errors: text ? validate(text).errors : [] };
}
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
function watchSettings(): void {
  const path = platform.settingsFile();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  let t: NodeJS.Timeout | null = null;
  try {
    settingsWatcher = watch(dir, { persistent: false }, (_e, name) => {
      if (name !== 'settings.json' && name !== 'prompts.json') return;
      if (t) clearTimeout(t);
      t = setTimeout(() => emit(mainWc(), 'settings:changed'), 300);
    });
  } catch (e) {
    log(`cannot watch settings: ${String(e)}`);
  }
}

function registerIpc(): void {
  setTrustedOrigin(isTrustedUrl);

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    os: platform.osName(),
    arch: process.arch,
    packaged: app.isPackaged,
    language: safe(() => platform.language(), 'ja'),
    cliPath: cliScript(),
    cliAvailable: cliAvailable(),
  }));
  handle('app:openExternal', (_e, url) => {
    if (/^(https?:|mailto:)/.test(url)) void shell.openExternal(url);
  });
  handle('app:showInFolder', (_e, p) => shell.showItemInFolder(p));
  handle('app:chooseFolder', async (_e, title) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: title ?? 'Solocut', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('app:permissions', () => permissionState());
  handle('app:askMediaAccess', (_e, kind) => askMediaAccess(kind));
  handle('app:openScreenSettings', () => openScreenRecordingSettings());

  handle('project:recent', () => project.recentProjects());
  handle('project:create', (_e, o) => project.createProject(o));
  handle('project:open', (_e, dir) => project.openProject(dir));
  handle('project:snapshot', (_e, dir) => project.snapshot(dir));
  handle('project:review', (_e, dir, item, decision) => project.review(dir, item, decision));
  handle('project:readScript', (_e, dir) => project.readScript(dir));
  handle('project:cli', (_e, dir, args) => runCli(args, { cwd: dir }));

  handle('templates:list', () => safe(() => platform.templates(), []));

  handle('pty:spawn', (_e, o) => {
    let command = o.command;
    let title = 'shell';
    if (o.agentId) {
      const c = platform.agentCommand(o.agentId);
      if (c) {
        command = c;
        title = o.agentId;
      }
    }
    return ptys.spawn({ ...o, title, ...(command ? { command } : {}) });
  });
  handle('pty:kill', (_e, id) => ptys.kill(id));
  handle('pty:list', () => ptys.list());
  on('pty:write', (_e, id, data) => ptys.write(id, data));
  on('pty:resize', (_e, id, c, r) => ptys.resize(id, c, r));
  on('pty:paste', (_e, id, text) => ptys.paste(id, text));

  handle('agents:list', () => safeAsync(() => platform.agents(), []));
  handle('prompts:list', (_e, dir) => safe(() => platform.promptButtons(dir), []));
  handle('prompts:render', (_e, id, dir, vars) => platform.renderPromptText(id, dir, project.promptVars(dir, vars)));

  handle('tools:status', () => safeAsync(() => platform.tools(), []));
  handle('tools:install', async (_e, name) => {
    try {
      const path = await platform.installTool(name, (rec, total) => emit(mainWc(), 'tools:progress', name, rec, total));
      return { ok: true, path };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handle('archive:list', (_e, q) => {
    allowMediaRoot(safe(() => platform.archiveRoot(), ''));
    return safe(() => platform.archiveList(q), []);
  });
  handle('archive:get', (_e, id) => safe(() => platform.archiveGet(id), null));
  handle('archive:useAsReference', (_e, dir, id) => project.useAsReference(dir, id));

  handle('settings:read', () => readDoc(platform.settingsFile(), platform.validateSettingsText));
  handle('settings:validate', (_e, text) => platform.validateSettingsText(text));
  handle('settings:write', (_e, text) => {
    const v = platform.validateSettingsText(text);
    if (v.ok) platform.writeSettingsValue(v.value);
    return { ok: v.ok, errors: v.errors };
  });
  handle('settings:set', (_e, key, value) => platform.setSettingValue(key, value));
  handle('prompts:readFile', () => readDoc(platform.promptsFile(), platform.validatePromptsText));
  handle('prompts:validate', (_e, text) => platform.validatePromptsText(text));
  handle('prompts:writeFile', (_e, text) => {
    const v = platform.validatePromptsText(text);
    if (v.ok) atomicWrite(platform.promptsFile(), text.endsWith('\n') ? text : text + '\n');
    return v;
  });

  handle('record:sources', async (): Promise<CaptureSource[]> => {
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return list
      .filter((s) => !s.name.startsWith('Solocut'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
        ...(s.display_id ? { displayId: s.display_id } : {}),
      }));
  });
  handle('record:selectSource', (_e, id, systemAudio) => {
    pendingCapture = { sourceId: id, systemAudio };
  });
  handle('record:begin', (_e, dir) => {
    if (!project.isProjectDir(dir)) throw new Error('not a solocut project');
    const r = recorder.beginTake(dir);
    registerHotkeys();
    return r;
  });
  handle('record:openTrack', (_e, t) => recorder.openTrack(t));
  handle('record:append', (_e, takeId, file, data) => recorder.appendTrack(takeId, file, data));
  handle('record:closeTrack', (_e, takeId, file) => recorder.closeTrack(takeId, file));
  handle('record:writeMeta', (_e, takeId, meta) => recorder.writeTakeMeta(takeId, meta));
  handle('record:end', (_e, takeId) => {
    recorder.endTake(takeId);
    if (recorder.activeTakes() === 0) unregisterHotkeys();
  });
  handle('record:teleprompter', (_e, dir) => openTeleprompter(dir));

  handle('update:state', () => updater.getState());
  handle('update:check', () => updater.check());
  handle('update:restart', () => updater.restartToUpdate());

  on('project:watch', (_e, dir) => {
    if (dir) allowMediaRoot(dir);
    watcher.watch(dir);
  });
  on('renderer:ready', () => undefined);

  assertAllHandled();
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return fallback;
  }
}
async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return fallback;
  }
}

function setupSession(): void {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(isTrustedUrl(wc.getURL()) && allowed.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => (wc ? isTrustedUrl(wc.getURL()) : false) && allowed.has(permission));
  ses.setDisplayMediaRequestHandler(
    async (_req, cb) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find((s) => s.id === pendingCapture.sourceId) ?? sources.find((s) => s.id.startsWith('screen:'));
      if (!src) {
        cb({});
        return;
      }
      cb(pendingCapture.systemAudio && process.platform !== 'linux' ? { video: src, audio: 'loopback' } : { video: src });
    },
    { useSystemPicker: false },
  );
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'solocut.app', click: () => void shell.openExternal('https://solocut.app') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** A project folder passed on the command line (`Solocut /path/to/project`). */
function projectArg(argv: string[]): string | null {
  for (const a of argv.slice(1).reverse()) {
    if (a.startsWith('-') || !a.startsWith('/') && !/^[A-Za-z]:\\/.test(a)) continue;
    if (project.isProjectDir(a)) return a;
  }
  return null;
}

app.on('second-instance', (_e, argv) => {
  const dir = projectArg(argv);
  if (dir) emit(mainWc(), 'project:openRequest', dir);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  handleMediaProtocol();
  setupSession();
  registerIpc();
  buildMenu();
  createMainWindow();
  watchSettings();
  updater.start(safe(() => platform.updatesEnabled(), true));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ptys.killAll();
  watcher.close();
  settingsWatcher?.close();
  recorder.endAll();
  updater.stop();
  updater.applyOnQuit();
});
