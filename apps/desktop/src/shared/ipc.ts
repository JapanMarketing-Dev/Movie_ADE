// The single IPC channel registry. Every channel the renderer may use is declared here with its types;
// the preload exposes only these names and main registers a handler for every invoke channel.
import type { DisplayInfo, Rect, Region } from './region';
import type {
  AnalysisJob,
  AnalysisStatus,
  TakeCursorInfo,
  AgentStatus,
  AppInfo,
  CaptureSource,
  CliResult,
  FeedbackImport,
  FeedbackItem,
  FeedbackSession,
  MediaPermissionState,
  ProjectInfo,
  ProjectSnapshot,
  PromptButton,
  RecentProject,
  VideoList,
  ReviewItem,
  SettingsDoc,
  TakeMeta,
  ToolState,
  TrackOpen,
  UpdateState,
  ValidationResult,
  Variant,
} from './types';
import type { PublishAccounts, PublishTargetId, PublishView, ThumbFile } from './publish';
import type { AccountsEventChannel, AccountsEventMap, AccountsInvokeChannel, AccountsInvokeMap } from './ipc-accounts';
import { ACCOUNTS_EVENT_CHANNELS, ACCOUNTS_INVOKE_CHANNELS } from './ipc-accounts';
import type { BenchEventChannel, BenchEventMap, BenchInvokeChannel, BenchInvokeMap } from './ipc-bench';
import { BENCH_EVENT_CHANNELS, BENCH_INVOKE_CHANNELS } from './ipc-bench';
import type {
  AgentSendRequest,
  AgentSendResult,
  AgentStateInfo,
  AgentTabInfo,
  TerminalAttachInfo,
  TerminalCreateOptions,
  TerminalSessionInfo,
  TerminalSize,
  TerminalTabInfo,
} from './terminal';

/** renderer -> main, request/response (ipcRenderer.invoke / ipcMain.handle) */
export interface InvokeMap extends AccountsInvokeMap, BenchInvokeMap {
  'app:info': { args: []; result: AppInfo };
  'app:openExternal': { args: [url: string]; result: void };
  'app:showInFolder': { args: [path: string]; result: void };
  'app:chooseFolder': { args: [title?: string]; result: string | null };
  'app:permissions': { args: []; result: MediaPermissionState };
  'app:askMediaAccess': { args: [kind: 'camera' | 'microphone']; result: boolean };
  'app:openScreenSettings': { args: []; result: void };

  'project:recent': { args: []; result: RecentProject[] };
  /** a new video in the master folder (parentDir defaults to settings `videos.root`); template and language are fixed by the app */
  'project:create': { args: [opts?: { parentDir?: string; title?: string }]; result: CliResult<ProjectInfo> };
  /** the videos in the master folder, newest first */
  'videos:list': { args: []; result: VideoList };
  'project:open': { args: [dir: string]; result: ProjectInfo };
  'project:snapshot': { args: [dir: string, variant?: Variant]; result: ProjectSnapshot };
  'project:review': { args: [dir: string, item: ReviewItem, decision: 'accept' | 'reject', variant?: Variant]; result: CliResult };
  'project:cli': { args: [dir: string, args: string[]]; result: CliResult };

  'terminal:create': { args: [opts: TerminalCreateOptions]; result: TerminalTabInfo };
  'terminal:close': { args: [id: string]; result: void };
  'terminal:list': { args: []; result: TerminalSessionInfo[] };
  /** re-attach to a live terminal after a renderer reload (recent output + size); null when it has exited */
  'terminal:attach': { args: [id: string]; result: TerminalAttachInfo | null };
  /** the shell's current folder (a split pane starts there) */
  'terminal:cwd': { args: [id: string]; result: string | null };
  'terminal:agentState': { args: [id: string]; result: AgentStateInfo };
  'terminal:writeClipboard': { args: [text: string]; result: void };
  /** OSC 52 copy from a program in the terminal; written only while the window has focus */
  'terminal:programCopy': { args: [id: string, text: string]; result: boolean };
  /** Ctrl+V on Windows / Linux: main runs the OS paste into the focused terminal */
  'terminal:paste': { args: []; result: boolean };
  /** every terminal tab with its agent state (footer, tab dots) */
  'agent:tabs': { args: []; result: AgentTabInfo[] };
  /** paste text into an agent (bracketed paste, verify, Enter) */
  'agent:send': { args: [req: AgentSendRequest]; result: AgentSendResult };

  'agents:list': { args: []; result: AgentStatus[] };
  'prompts:list': { args: [dir?: string]; result: PromptButton[] };
  'prompts:render': { args: [id: string, dir?: string, vars?: Record<string, string>]; result: { text: string; agent?: string } };

  'tools:status': { args: []; result: ToolState[] };
  'tools:install': { args: [name: string]; result: { ok: boolean; path?: string; error?: string } };


  'settings:read': { args: []; result: SettingsDoc };
  'settings:set': { args: [key: string, value: unknown]; result: ValidationResult };

  'record:sources': { args: []; result: CaptureSource[] };
  'record:selectSource': { args: [id: string | null, systemAudio: boolean]; result: void };
  'record:begin': { args: [dir: string]; result: { takeId: string; takeDir: string } };
  'record:openTrack': { args: [t: TrackOpen]; result: void };
  'record:append': { args: [takeId: string, file: string, data: Uint8Array]; result: number };
  'record:closeTrack': { args: [takeId: string, file: string]; result: number };
  'record:writeMeta': { args: [takeId: string, meta: TakeMeta]; result: void };
  'record:end': { args: [takeId: string]; result: void };
  'record:cursorStart': { args: [takeId: string, sourceId: string | null, epochStartMs: number, region?: Region | null]; result: TakeCursorInfo };
  /** displays (DIP bounds + scaleFactor) for the region picker and the crop */
  'record:displays': { args: []; result: DisplayInfo[] };
  /** opens the drag-to-select overlay on a display; the picked region (display pixels) or null when cancelled */
  'record:pickRegion': { args: [displayId: string]; result: Region | null };
  /** the overlay's answer: the dragged rectangle in DIP relative to the display, or null (Esc) */
  'record:regionDone': { args: [rect: Rect | null]; result: void };

  'analysis:start': { args: [dir: string]; result: AnalysisStatus };
  'analysis:cancel': { args: []; result: AnalysisStatus };
  'analysis:status': { args: []; result: AnalysisStatus };
  'analysis:nextJob': { args: []; result: AnalysisJob | null };
  'analysis:result': { args: [jobId: string, result: unknown]; result: void };
  'analysis:fail': { args: [jobId: string, error: string]; result: void };

  'update:state': { args: []; result: UpdateState };
  'update:check': { args: []; result: UpdateState };
  'update:restart': { args: []; result: void };

  'feedback:begin': { args: [dir: string]; result: { id: string; dir: string } };
  'feedback:finish': { args: [dir: string, id: string, session: FeedbackSession, variant?: Variant]; result: CliResult<FeedbackImport> };
  'feedback:update': { args: [dir: string, id: string, items: FeedbackItem[], variant?: Variant]; result: CliResult<FeedbackImport> };

  'thumbs:list': { args: [dir: string]; result: ThumbFile[] };

  'publish:load': { args: [dir: string]; result: PublishView };
  'publish:setThumbnail': { args: [dir: string, path: string | null]; result: { ok: boolean; error?: string } };
  /** this video's youtube.privacy / tiktok.privacy in publish.json */
  'publish:setPrivacy': { args: [dir: string, target: PublishTargetId, value: string]; result: { ok: boolean; error?: string } };
  'publish:accounts': { args: []; result: PublishAccounts };
  'publish:connect': { args: [target: PublishTargetId]; result: { ok: boolean; name?: string; error?: string } };
  'publish:disconnect': { args: [target: PublishTargetId]; result: void };
  /** reveal the video and open TikTok's upload page (the path when the TikTok API is not available) */
  'publish:openTikTokUpload': { args: [dir: string]; result: void };
}

/** renderer -> main, fire and forget (ipcRenderer.send / ipcMain.on) */
export interface SendMap {
  'terminal:write': [id: string, data: string];
  'terminal:resize': [id: string, size: TerminalSize];
  /** characters of terminal:data the renderer has drawn (main's flow control) */
  'terminal:ack': [id: string, chars: number];
  /** terminals currently on screen (others flush output every 250 ms) */
  'terminal:visible': [ids: string[]];
  /** visible text of a terminal (agent state detection) */
  'terminal:screen': [id: string, text: string];
  'project:watch': [dir: string | null];
  'renderer:ready': [];
  'analysis:progress': [jobId: string, fraction: number];
}

/** main -> renderer events (webContents.send / ipcRenderer.on) */
export interface EventMap extends AccountsEventMap, BenchEventMap {
  /** a terminal opened by main (failover handover, account login): the pane adds a tab and attaches to it */
  'terminal:adopt': [info: TerminalAttachInfo];
  'terminal:data': [id: string, data: string];
  'terminal:exit': [id: string, code: number];
  /** a tab's agent / state / title changed */
  'agent:state': [info: AgentTabInfo];
  'project:changed': [dir: string, what: 'timeline' | 'status' | 'renders' | 'project' | 'takes'];
  'settings:changed': [];
  'tools:progress': [name: string, received: number, total?: number];
  'record:hotkey': [kind: 'ng' | 'important'];
  'update:state': [state: UpdateState];
  'app:navigate': [screen: string];
  'project:openRequest': [dir: string];
  /** publish.json, the hand-off request / result or thumbnails/ changed */
  'publish:changed': [dir: string];
  'analysis:state': [s: AnalysisStatus];
}

export type InvokeChannel = keyof InvokeMap;
export type SendChannel = keyof SendMap;
export type EventChannel = keyof EventMap;

// Records keyed by the maps above: the compiler fails if a channel is declared but missing here (or vice versa).
const accountsInvoke = Object.fromEntries(ACCOUNTS_INVOKE_CHANNELS.map((c) => [c, true])) as Record<AccountsInvokeChannel, true>;
const accountsEvents = Object.fromEntries(ACCOUNTS_EVENT_CHANNELS.map((c) => [c, true])) as Record<AccountsEventChannel, true>;
const benchInvoke = Object.fromEntries(BENCH_INVOKE_CHANNELS.map((c) => [c, true])) as Record<BenchInvokeChannel, true>;
const benchEvents = Object.fromEntries(BENCH_EVENT_CHANNELS.map((c) => [c, true])) as Record<BenchEventChannel, true>;

const invoke: Record<InvokeChannel, true> = {
  ...accountsInvoke,
  ...benchInvoke,
  'app:info': true, 'app:openExternal': true, 'app:showInFolder': true, 'app:chooseFolder': true,
  'app:permissions': true, 'app:askMediaAccess': true, 'app:openScreenSettings': true,
  'project:recent': true, 'project:create': true, 'project:open': true, 'project:snapshot': true,
  'project:review': true, 'project:cli': true,
  'videos:list': true,
  'terminal:create': true, 'terminal:close': true, 'terminal:list': true, 'terminal:attach': true, 'terminal:cwd': true,
  'terminal:agentState': true, 'terminal:writeClipboard': true, 'terminal:programCopy': true, 'terminal:paste': true,
  'agent:tabs': true, 'agent:send': true,
  'agents:list': true, 'prompts:list': true, 'prompts:render': true,
  'tools:status': true, 'tools:install': true,
  'settings:read': true, 'settings:set': true,
  'record:sources': true, 'record:selectSource': true, 'record:begin': true, 'record:openTrack': true,
  'record:append': true, 'record:closeTrack': true, 'record:writeMeta': true, 'record:end': true,
  'record:cursorStart': true, 'record:displays': true, 'record:pickRegion': true, 'record:regionDone': true,
  'analysis:start': true, 'analysis:cancel': true, 'analysis:status': true, 'analysis:nextJob': true, 'analysis:result': true, 'analysis:fail': true,
  'update:state': true, 'update:check': true, 'update:restart': true,
  'feedback:begin': true, 'feedback:finish': true, 'feedback:update': true,
  'thumbs:list': true,
  'publish:load': true, 'publish:setThumbnail': true, 'publish:setPrivacy': true, 'publish:accounts': true, 'publish:connect': true, 'publish:disconnect': true,
  'publish:openTikTokUpload': true,
};
const send: Record<SendChannel, true> = {
  'terminal:write': true, 'terminal:resize': true, 'terminal:ack': true, 'terminal:visible': true, 'terminal:screen': true,
  'project:watch': true, 'renderer:ready': true, 'analysis:progress': true,
};
const events: Record<EventChannel, true> = {
  ...accountsEvents,
  ...benchEvents,
  'terminal:adopt': true,
  'terminal:data': true, 'terminal:exit': true, 'agent:state': true, 'project:changed': true, 'settings:changed': true,
  'tools:progress': true, 'record:hotkey': true, 'update:state': true, 'app:navigate': true, 'project:openRequest': true, 'publish:changed': true, 'analysis:state': true,
};

export const INVOKE_CHANNELS = Object.freeze(Object.keys(invoke) as InvokeChannel[]);
export const SEND_CHANNELS = Object.freeze(Object.keys(send) as SendChannel[]);
export const EVENT_CHANNELS = Object.freeze(Object.keys(events) as EventChannel[]);

export function isInvokeChannel(c: unknown): c is InvokeChannel {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(invoke, c);
}
export function isSendChannel(c: unknown): c is SendChannel {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(send, c);
}
export function isEventChannel(c: unknown): c is EventChannel {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(events, c);
}

/** The API the preload exposes as `window.solocut`. */
export interface SolocutApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeMap[C]['args']): Promise<InvokeMap[C]['result']>;
  send<C extends SendChannel>(channel: C, ...args: SendMap[C]): void;
  on<C extends EventChannel>(channel: C, listener: (...args: EventMap[C]) => void): () => void;
  /** Media URL for a local file, served by the solocut-media:// protocol (Range supported). */
  mediaUrl(path: string, version?: number): string;
}

export const MEDIA_SCHEME = 'solocut-media';

export function mediaUrl(path: string, version?: number): string {
  const v = version === undefined ? '' : `?v=${Math.floor(version)}`;
  return `${MEDIA_SCHEME}://file/${encodeURIComponent(path)}${v}`;
}

/** Inverse of mediaUrl. Returns null for URLs that are not ours. */
export function pathFromMediaUrl(url: string): string | null {
  const prefix = `${MEDIA_SCHEME}://file/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const q = rest.indexOf('?');
  const enc = q === -1 ? rest : rest.slice(0, q);
  try {
    const p = decodeURIComponent(enc);
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}
