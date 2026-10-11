// The single IPC channel registry. Every channel the renderer may use is declared here with its types;
// the preload exposes only these names and main registers a handler for every invoke channel.
import type {
  AnalysisJob,
  AnalysisStatus,
  TakeCursorInfo,
  AgentStatus,
  AppInfo,
  ArchiveDetail,
  ArchiveListItem,
  CaptureSource,
  CliResult,
  FeedbackImport,
  FeedbackItem,
  FeedbackSession,
  PublishDraft,
  SecretInfo,
  ThumbCandidate,
  ThumbImage,
  YouTubeForm,
  YouTubeProgress,
  MediaPermissionState,
  ProjectInfo,
  ProjectSnapshot,
  PromptButton,
  RecentProject,
  ReviewItem,
  SettingsDoc,
  TakeMeta,
  TemplateInfo,
  ToolState,
  TrackOpen,
  UpdateState,
  ValidationResult,
  Variant,
} from './types';
import type { AccountsEventChannel, AccountsEventMap, AccountsInvokeChannel, AccountsInvokeMap } from './ipc-accounts';
import { ACCOUNTS_EVENT_CHANNELS, ACCOUNTS_INVOKE_CHANNELS } from './ipc-accounts';
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
export interface InvokeMap extends AccountsInvokeMap {
  'app:info': { args: []; result: AppInfo };
  'app:openExternal': { args: [url: string]; result: void };
  'app:showInFolder': { args: [path: string]; result: void };
  'app:chooseFolder': { args: [title?: string]; result: string | null };
  'app:permissions': { args: []; result: MediaPermissionState };
  'app:askMediaAccess': { args: [kind: 'camera' | 'microphone']; result: boolean };
  'app:openScreenSettings': { args: []; result: void };

  'project:recent': { args: []; result: RecentProject[] };
  'project:create': { args: [opts: { parentDir: string; title: string; template: string; language: 'ja' | 'en' }]; result: CliResult<ProjectInfo> };
  'project:open': { args: [dir: string]; result: ProjectInfo };
  'project:snapshot': { args: [dir: string, variant?: Variant]; result: ProjectSnapshot };
  'project:review': { args: [dir: string, item: ReviewItem, decision: 'accept' | 'reject', variant?: Variant]; result: CliResult };
  'project:readScript': { args: [dir: string]; result: string | null };
  'project:cli': { args: [dir: string, args: string[]]; result: CliResult };

  'templates:list': { args: []; result: TemplateInfo[] };

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

  'archive:list': { args: [query?: string]; result: ArchiveListItem[] };
  'archive:get': { args: [id: string]; result: ArchiveDetail | null };
  'archive:useAsReference': { args: [dir: string, id: string]; result: CliResult };

  'settings:read': { args: []; result: SettingsDoc };
  'settings:validate': { args: [text: string]; result: ValidationResult };
  'settings:write': { args: [text: string]; result: ValidationResult };
  'settings:set': { args: [key: string, value: unknown]; result: ValidationResult };
  'prompts:readFile': { args: []; result: SettingsDoc };
  'prompts:validate': { args: [text: string]; result: ValidationResult };
  'prompts:writeFile': { args: [text: string]; result: ValidationResult };

  'record:sources': { args: []; result: CaptureSource[] };
  'record:selectSource': { args: [id: string | null, systemAudio: boolean]; result: void };
  'record:begin': { args: [dir: string]; result: { takeId: string; takeDir: string } };
  'record:openTrack': { args: [t: TrackOpen]; result: void };
  'record:append': { args: [takeId: string, file: string, data: Uint8Array]; result: number };
  'record:closeTrack': { args: [takeId: string, file: string]; result: number };
  'record:writeMeta': { args: [takeId: string, meta: TakeMeta]; result: void };
  'record:end': { args: [takeId: string]; result: void };
  'record:teleprompter': { args: [dir: string | null]; result: void };
  'record:cursorStart': { args: [takeId: string, sourceId: string | null, epochStartMs: number]; result: TakeCursorInfo };

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

  'thumbs:candidates': { args: [dir: string, variant?: Variant]; result: CliResult<ThumbCandidate[]> };
  'thumbs:existing': { args: [dir: string]; result: ThumbImage[] };
  'thumbs:generate': { args: [dir: string, o: { frame: number; n: number; provider?: string; title?: string; variant?: Variant }]; result: CliResult<ThumbImage[]> };
  'thumbs:favorite': { args: [dir: string, path: string, on: boolean, variant?: Variant]; result: string[] };
  'thumbs:providers': { args: []; result: string[] };

  'publish:draft': { args: [dir: string]; result: PublishDraft };
  'publish:youtubeStatus': { args: []; result: { clientSet: boolean; connected: boolean } };
  'publish:youtubeConnect': { args: []; result: { ok: boolean; error?: string } };
  'publish:youtubeDisconnect': { args: []; result: void };
  'publish:youtubeUpload': {
    args: [dir: string, form: YouTubeForm, target?: 'youtube' | 'youtube-shorts'];
    result: { ok: boolean; url?: string; videoId?: string; warnings: string[]; error?: string };
  };
  'publish:saveMeta': {
    args: [dir: string, target: 'youtube' | 'tiktok' | 'youtube-shorts', meta: { title: string; description: string; tags: string[] }];
    result: CliResult;
  };
  'publish:openIntent': { args: [dir: string, platform: 'x' | 'threads' | 'facebook', text: string, url: string]; result: void };
  'publish:manual': { args: [dir: string, target: 'tiktok' | 'instagram', file: string]; result: void };

  'secrets:status': { args: []; result: { persistent: boolean; items: Record<string, SecretInfo> } };
  'secrets:set': { args: [name: string, value: string | null]; result: { persisted: boolean } };
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
export interface EventMap extends AccountsEventMap {
  /** a terminal opened by main (failover handover, account login): the pane adds a tab and attaches to it */
  'terminal:adopt': [info: TerminalAttachInfo];
  'terminal:data': [id: string, data: string];
  'terminal:exit': [id: string, code: number];
  /** a tab's agent / state / title changed */
  'agent:state': [info: AgentTabInfo];
  'project:changed': [dir: string, what: 'timeline' | 'status' | 'renders' | 'project'];
  'settings:changed': [];
  'tools:progress': [name: string, received: number, total?: number];
  'record:hotkey': [kind: 'ng' | 'important'];
  'update:state': [state: UpdateState];
  'app:navigate': [screen: string];
  'project:openRequest': [dir: string];
  'publish:progress': [p: YouTubeProgress];
  'analysis:state': [s: AnalysisStatus];
}

export type InvokeChannel = keyof InvokeMap;
export type SendChannel = keyof SendMap;
export type EventChannel = keyof EventMap;

// Records keyed by the maps above: the compiler fails if a channel is declared but missing here (or vice versa).
const accountsInvoke = Object.fromEntries(ACCOUNTS_INVOKE_CHANNELS.map((c) => [c, true])) as Record<AccountsInvokeChannel, true>;
const accountsEvents = Object.fromEntries(ACCOUNTS_EVENT_CHANNELS.map((c) => [c, true])) as Record<AccountsEventChannel, true>;

const invoke: Record<InvokeChannel, true> = {
  ...accountsInvoke,
  'app:info': true, 'app:openExternal': true, 'app:showInFolder': true, 'app:chooseFolder': true,
  'app:permissions': true, 'app:askMediaAccess': true, 'app:openScreenSettings': true,
  'project:recent': true, 'project:create': true, 'project:open': true, 'project:snapshot': true,
  'project:review': true, 'project:readScript': true, 'project:cli': true,
  'templates:list': true,
  'terminal:create': true, 'terminal:close': true, 'terminal:list': true, 'terminal:attach': true, 'terminal:cwd': true,
  'terminal:agentState': true, 'terminal:writeClipboard': true, 'terminal:programCopy': true, 'terminal:paste': true,
  'agent:tabs': true, 'agent:send': true,
  'agents:list': true, 'prompts:list': true, 'prompts:render': true,
  'tools:status': true, 'tools:install': true,
  'archive:list': true, 'archive:get': true, 'archive:useAsReference': true,
  'settings:read': true, 'settings:validate': true, 'settings:write': true, 'settings:set': true,
  'prompts:readFile': true, 'prompts:validate': true, 'prompts:writeFile': true,
  'record:sources': true, 'record:selectSource': true, 'record:begin': true, 'record:openTrack': true,
  'record:append': true, 'record:closeTrack': true, 'record:writeMeta': true, 'record:end': true,
  'record:teleprompter': true, 'record:cursorStart': true,
  'analysis:start': true, 'analysis:cancel': true, 'analysis:status': true, 'analysis:nextJob': true, 'analysis:result': true, 'analysis:fail': true,
  'update:state': true, 'update:check': true, 'update:restart': true,
  'feedback:begin': true, 'feedback:finish': true, 'feedback:update': true,
  'thumbs:candidates': true, 'thumbs:existing': true, 'thumbs:generate': true, 'thumbs:favorite': true, 'thumbs:providers': true,
  'publish:draft': true, 'publish:youtubeStatus': true, 'publish:youtubeConnect': true, 'publish:youtubeDisconnect': true,
  'publish:youtubeUpload': true, 'publish:openIntent': true, 'publish:saveMeta': true, 'publish:manual': true,
  'secrets:status': true, 'secrets:set': true,
};
const send: Record<SendChannel, true> = {
  'terminal:write': true, 'terminal:resize': true, 'terminal:ack': true, 'terminal:visible': true, 'terminal:screen': true,
  'project:watch': true, 'renderer:ready': true, 'analysis:progress': true,
};
const events: Record<EventChannel, true> = {
  ...accountsEvents,
  'terminal:adopt': true,
  'terminal:data': true, 'terminal:exit': true, 'agent:state': true, 'project:changed': true, 'settings:changed': true,
  'tools:progress': true, 'record:hotkey': true, 'update:state': true, 'app:navigate': true, 'project:openRequest': true, 'publish:progress': true, 'analysis:state': true,
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
