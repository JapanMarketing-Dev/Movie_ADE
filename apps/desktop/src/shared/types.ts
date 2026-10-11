// Types shared by main, preload and renderer. Kept free of imports from @solocut/* so the renderer
// (which never touches Node) type-checks on its own. Shapes mirror docs/dev/CONTRACTS.md loosely.

export type Lang = 'ja' | 'en';
export type OsName = 'mac' | 'win' | 'linux';

export interface AppInfo {
  version: string;
  platform: string;
  os: OsName;
  arch: string;
  packaged: boolean;
  language: Lang;
  cliPath: string;
  cliAvailable: boolean;
}

export interface ProjectInfo {
  dir: string;
  id?: string;
  title: string;
  template?: { id: string; version: string };
  language?: Lang;
}

export interface RecentProject {
  dir: string;
  title: string;
  openedAt: string;
  exists: boolean;
}

export interface TemplateInfo {
  id: string;
  version: string;
  name: { ja: string; en: string };
  kind: 'tech' | 'talk';
  targets: string[];
}

export type StepId = string;
export interface StepState {
  step: StepId;
  state: 'todo' | 'running' | 'done' | 'needs-human' | 'skipped';
  note?: string;
  at?: string;
}
export interface NextStep {
  step: StepId | 'done';
  state: 'ready' | 'needs-human' | 'done';
  why: string;
  do: string;
  commands: string[];
  prompt?: string;
  blocking?: string[];
}

export interface CliResult<T = unknown> {
  ok: boolean;
  code: number | null;
  data?: T;
  stdout: string;
  stderr: string;
  error?: string;
}

export type LaneName = 'segments' | 'captions' | 'scenes' | 'sfx' | 'markers';
export interface LaneItem {
  id: string;
  start: number;
  end: number;
  label: string;
  needsReview?: boolean;
  kind?: string;
}
export interface ReviewItem {
  id: string;
  lane: LaneName | 'open';
  start?: number;
  label: string;
  reason?: string;
  confidence?: number;
  by?: string;
}
export interface TimelineOverview {
  title: string;
  fpsNum: number;
  fpsDen: number;
  durationFrames: number;
  lanes: Record<LaneName, LaneItem[]>;
  review: ReviewItem[];
  lastCheck?: { passed: number; failed: number; needsHuman: number; at: string };
}

export interface ProjectSnapshot {
  project: ProjectInfo;
  steps: StepState[];
  next?: NextStep;
  overview?: TimelineOverview;
  preview?: { path: string; url: string; mtimeMs: number };
  errors: string[];
}

export interface PtySpawnOptions {
  cwd: string;
  agentId?: string;
  command?: string;
  cols: number;
  rows: number;
}
export interface PtyInfo {
  id: string;
  title: string;
  agentId?: string;
  pid: number;
}
export type AgentActivity = 'starting' | 'working' | 'waiting' | 'exited';

export interface AgentStatus {
  id: string;
  label: string;
  installed: boolean;
  version?: string;
  path?: string;
  install: string;
  update?: string;
  command: string;
}

export interface ToolState {
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
}

export interface PromptButton {
  id: string;
  label: string;
  agent?: string;
  autopilot?: boolean;
}

export interface ArchiveListItem {
  id: string;
  title: string;
  kind?: string;
  template?: string;
  createdAt?: string;
  durationSec?: number;
  thumbnailUrl?: string;
  projectDir?: string;
  raw: unknown;
}
export interface ArchiveDetail {
  entry: ArchiveListItem;
  stats: Record<string, unknown>;
  overview?: TimelineOverview;
}

export interface SettingsDoc {
  path: string;
  text: string;
  errors: string[];
}
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string; // data URL
  displayId?: string;
}

export type TrackKind = 'screen' | 'camera' | 'mic' | 'system';
export interface TrackOpen {
  takeId: string;
  file: string; // e.g. "screen.mp4", "camera-1.webm", "mic-1.wav"
  kind: TrackKind;
  wav?: { sampleRate: number; channels: number };
}
export interface TakeTrackMeta {
  file: string;
  kind: TrackKind;
  device?: string;
  label?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  recorderStartMs?: number; // performance.now() when MediaRecorder/worklet started
  firstFrameMs?: number; // performance.now() domain timestamp of the first frame/sample
  firstFrameTimestampUs?: number; // raw VideoFrame.timestamp if available
  bytes?: number;
}
export interface TakeMarker {
  kind: 'ng' | 'important';
  atMs: number; // performance.now() domain
  sinceStartMs: number;
}
export interface TakeMeta {
  schema: 1;
  id: string;
  createdAt: string;
  timeOrigin: number;
  startedAtMs: number;
  stoppedAtMs?: number;
  tracks: TakeTrackMeta[];
  markers: TakeMarker[];
  app: { version: string; os: string };
  complete: boolean;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'up-to-date' | 'notify-only';
  current: string;
  latest?: string;
  notes?: string;
  error?: string;
  progress?: number;
}

export interface MediaPermissionState {
  camera: string;
  microphone: string;
  screen: string;
}
