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
  variant: Variant;
  /** variants that have a timeline (main always) */
  variants: Variant[];
  stale?: boolean; // the variant was derived from an older main timeline
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
export interface TakeCursorInfo {
  file: string;
  hz: number;
  displayId: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  window: boolean;
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

// ---------- thumbnails / publish ----------
export interface ThumbCandidate {
  frame: number;
  timecode: string;
  image: string; // absolute path
  score?: number;
}
export interface ThumbImage {
  path: string; // absolute
  provider?: string;
  favorite?: boolean;
}
export interface PublishTarget {
  target: string;
  title: string;
  titleCandidates: string[];
  description: string;
  tags: string[];
  render?: string; // absolute
  thumbnail?: string; // absolute
  captions?: string; // absolute srt
}
export interface PublishDraft {
  targets: PublishTarget[];
  videos: string[];
  images: string[];
  captions: string[];
  history: PublishRecord[];
  metaSource: 'cli' | 'timeline';
}
export interface PublishRecord {
  at: string;
  project: string;
  target: string;
  method: 'api-byo' | 'api' | 'intent' | 'manual';
  status: 'published' | 'scheduled' | 'uploaded' | 'opened' | 'failed';
  url?: string;
  remoteId?: string;
  privacy?: string;
  disclosures?: Record<string, boolean>;
  error?: string;
}
export interface YouTubeForm {
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacy: 'public' | 'unlisted' | 'private';
  publishAt?: string; // ISO; requires private
  madeForKids: boolean | null; // must be chosen
  containsSyntheticMedia: boolean;
  language: string;
  thumbnailPath?: string;
  captionsPath?: string;
}
export interface YouTubeProgress {
  phase: 'auth' | 'upload' | 'thumbnail' | 'captions' | 'done' | 'error';
  sent?: number;
  total?: number;
  message?: string;
}
export interface SecretInfo {
  set: boolean;
  hint?: string;
}

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
