// Types shared by main, preload and renderer. Kept free of imports from @solocut/* so the renderer
// (which never touches Node) type-checks on its own. Shapes mirror docs/dev/CONTRACTS.md loosely.

export type Lang = 'ja' | 'en';
/** docs/18: the main video (YouTube 16:9) and the two vertical variants derived from it. */
export type Variant = 'main' | 'tiktok' | 'youtube-shorts';
export const VARIANTS: Variant[] = ['main', 'tiktok', 'youtube-shorts'];
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
  crashReports: boolean;
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

/** Where a video in the master folder stands, from its files: 撮影前 / 編集中 / 完成 / 投稿済み. */
export type VideoStatus = 'new' | 'editing' | 'done' | 'posted';

export interface VideoEntry {
  dir: string;
  /** folder name, e.g. 2026-10-11-ネタ */
  name: string;
  title: string;
  status: VideoStatus;
  /** newest change of the project (ms) */
  updatedAt: number;
}

/** The videos in the master folder (settings `videos.root`), newest first. */
export interface VideoList {
  root: string;
  exists: boolean;
  videos: VideoEntry[];
  /** set when the folder could not be read (permissions, not a folder…) */
  error?: string;
}

export interface TemplateInfo {
  id: string;
  version: string;
  name: { ja: string; en: string };
  kind: 'tech' | 'talk';
  targets: string[];
  /** targets in the template's `outputs` map (docs/18), e.g. youtube, tiktok, youtube-shorts */
  outputs: string[];
  description?: string;
  alias?: boolean; // old id kept as an alias of a family template
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
/** Review items can also point at masks (source-frame tracks, not drawn as a lane). */
export type ReviewLane = LaneName | 'masks' | 'open';
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
  lane: ReviewLane;
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

/** One file of a raw take. `start` = where the file's t=0 sits on the take clock, in seconds, relative to `main`. */
export interface RawTakeFile {
  path: string;
  url: string;
  start: number;
}

/** A take played as recorded: the screen (or the camera when there is no screen), a camera as picture-in-picture, the mic. */
export interface RawTake {
  take: string;
  main: RawTakeFile & { kind: 'screen' | 'camera' };
  pip?: RawTakeFile;
  audio?: RawTakeFile;
}

export interface ProjectSnapshot {
  project: ProjectInfo;
  variant: Variant;
  /** variants that have a timeline (main always) */
  variants: Variant[];
  stale?: boolean; // the variant was derived from an older main timeline
  steps: StepState[];
  next?: NextStep;
  overview?: TimelineOverview;
  preview?: { path: string; url: string; mtimeMs: number };
  /** the newest recorded take as-is (shown until a preview is rendered) */
  raw?: RawTake;
  errors: string[];
}

// terminal and agent-state types: shared/terminal.ts

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
  /** 'finish' (sent by itself after a recording) or 'publish' (after the human's OK) */
  id: string;
  label: string;
  agent?: string;
  autopilot?: boolean;
  /** the current text before {{vars}} are filled (the user's override or the default), in the UI language */
  text?: string;
  /** the built-in text in the UI language (settings page:「既定に戻す」) */
  defaultText?: string;
  /** true when settings.json overrides the text (prompts.finish / prompts.publish) */
  overridden?: boolean;
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
  /** camera: 'main' = the camera that shows the person (frame the face from this one) */
  role?: 'main';
  /** screen: recorded region of the display (display pixels; settings record.region) and the captured stream size */
  crop?: { displayId: string; x: number; y: number; width: number; height: number; sourceWidth?: number; sourceHeight?: number };
}
export interface TakeCursorInfo {
  file: string;
  hz: number;
  displayId: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  window: boolean;
  /** recorded region (display pixels); when set, x/y in cursor.jsonl are normalized to it and bounds are its DIP rect */
  region?: { displayId: string; x: number; y: number; width: number; height: number };
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
  /** cursor.jsonl ({t_ms, x, y} at 30 Hz, normalized to the captured display) */
  cursor?: TakeCursorInfo;
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
  /** what kind of failure (network failures are retried with backoff; others are reported) */
  errorKind?: 'network' | 'http' | 'too-large' | 'verify' | 'unsupported' | 'other';
  /** epoch ms of the last finished check */
  lastCheckedAt?: number;
  /** epoch ms of the next scheduled background check (absent when background checks are off) */
  nextCheckAt?: number;
  /** a ready update will be installed when the app quits (background updates on, or restart pressed) */
  installOnQuit?: boolean;
  /** a ready update waits for this before restarting (never mid-take, never while an agent works) */
  blockedBy?: 'recording' | 'agent';
  /** the user pressed "restart to update": done as soon as nothing is recording / working */
  restartRequested?: boolean;
}

export interface MediaPermissionState {
  camera: string;
  microphone: string;
  screen: string;
}

// ---------- feedback ----------
export interface FeedbackTarget {
  kind: string;
  id: string;
  label?: string;
}
export interface FeedbackItem {
  n: number; // CLI items.json `index`
  frame: number;
  timecode: string;
  image?: string; // project-relative (feedback/<id>/NN.png)
  spoken: string; // CLI `speech`
  title?: string;
  request: string;
  notes: string[];
  targets: FeedbackTarget[];
}
export interface FeedbackImport {
  id: string;
  dir: string; // project-relative, e.g. feedback/<id>
  items: FeedbackItem[];
}
/** session.json read by `solocut feedback import` (CONTRACTS.md). Times are ms on the session clock (mic start = 0). */
export interface FeedbackSession {
  schema: 1;
  createdAt: string;
  audio?: string;
  audioStartMs?: number;
  playback: { atMs: number; state: 'playing' | 'paused'; frame: number }[];
  strokes: { startMs: number; endMs: number; frame: number; color: string; width: number; points: [number, number][] }[];
  notes: { atMs: number; text: string; frame: number }[];
  variant?: string;
}

// thumbnails / publish: see shared/publish.ts

// ---------- analysis producers ----------
export type AnalysisKind = 'faces' | 'ocr';
export interface AnalysisJob {
  id: string;
  kind: AnalysisKind;
  sourceId: string;
  url: string; // solocut-media URL of the source video
  sourceFps: number;
  width: number;
  height: number;
  sampleFps: number; // faces 5, ocr 1
  model?: Uint8Array; // face detector (.tflite)
  langPath?: string; // tesseract language data dir (solocut-media URL)
  langs?: string[];
}
export interface AnalysisJobState {
  id: string;
  kind: AnalysisKind;
  sourceId: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
}
export interface AnalysisStatus {
  running: boolean;
  dir?: string;
  phase: 'idle' | 'models' | 'analyzing' | 'masks' | 'done' | 'cancelled' | 'error';
  jobs: AnalysisJobState[];
  modelProgress?: number;
  masksAdded?: number;
  message?: string;
}
