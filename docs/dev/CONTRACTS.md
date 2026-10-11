# Implementation contracts (v0.1)

Shared rules for everyone building Solocut. The design is in `docs/01..17` (Japanese). This file fixes the
package boundaries and the exported APIs so the packages can be built in parallel. If you need to change a
signature here, change this file in the same commit.

## Ground rules

- TypeScript, ESM, Node 22. Packages are consumed as TS source (`"main": "src/index.ts"`); no per-package build.
- The desktop app bundles packages through electron-vite. The CLI is bundled by `scripts/build-cli.mjs` (esbuild)
  into `apps/desktop/resources/cli/solocut.mjs`, run with Electron's Node (`ELECTRON_RUN_AS_NODE=1`).
- Tests: vitest, `packages/<p>/test/*.test.ts`. **No E2E.** Many fast unit/integration tests with boundaries and
  failure cases. Media tests generate synthetic media with ffmpeg `lavfi` at test time (skip with a clear message if
  ffmpeg is not found; CI installs ffmpeg). Never commit large media.
- Dependencies: keep them minimal. Allowed now: `zod` (core, settings), `budoux` (captions), `yaml` (templates).
  Ask before adding others. Do not run `pnpm install` at the repo root concurrently with other workers; the
  orchestrator installs. If you need a dependency, add it to your package.json and say so in your report.
- No secrets in code. Paths: user data lives in `~/.solocut/` (override with env `SOLOCUT_HOME`, used by tests).
- Japanese UI copy follows the product's plain-language style; English identifiers in code.
- Every time value inside a timeline is an integer frame number at the timeline fps. No float seconds in timeline.json.

## @solocut/core  (pure; no fs, no child_process)

```ts
export const SCHEMA_VERSION = 1;
export type Frame = number;          // integer, timeline frames
export type SourceFrame = number;    // integer, source frames (source fps)
export interface Rational { num: number; den: number }
export interface Decided { by: 'human'|'agent'|'decision-model'|'rule'|'template'; agent?: string; reason: string;
  confidence?: number; ruleRef?: string; feedbackRef?: string; needsReview?: boolean }
export const TimelineSchema: z.ZodType<Timeline>;   // full shape from docs/15_timeline_schema.md
export type Timeline = { schema: 1; meta: Meta; canvas: Canvas; sources: Record<string, Source>; transcript?: TranscriptRef;
  outline: Chapter[]; segments: Segment[]; scenes: Scene[]; captions: Caption[]; overlays: Overlay[]; audio: AudioPlan;
  masks: Mask[]; markers: Marker[]; outputs: Output[]; review: ReviewState };
export function emptyTimeline(init: { title: string; kind: 'tech'|'talk'; template: { id: string; version: string };
  canvas: Canvas; language: 'ja'|'en'; targets: Target[] }): Timeline;
export function timelineJsonSchema(): object;       // z.toJSONSchema(TimelineSchema)

export type Op =
  | { op: 'addSource'; id: string; source: Source }
  | { op: 'addSegment'; segment: Segment; index?: number }
  | { op: 'removeSegment'; id: string; decided: Decided }
  | { op: 'trimSegment'; id: string; from?: SourceFrame; to?: SourceFrame; decided: Decided }
  | { op: 'splitSegment'; id: string; atSource: SourceFrame; newId: string }
  | { op: 'moveSegment'; id: string; index: number }
  | { op: 'setVideo'; id: string; video: VideoChoice; decided: Decided }
  | { op: 'setCamera'; id: string; camera: string; decided: Decided }
  | { op: 'cutText'; from: SourceFrame; to: SourceFrame; take: string; decided: Decided }  // cut a source range everywhere
  | { op: 'setCaptions'; captions: Caption[] }
  | { op: 'updateCaption'; id: string; patch: Partial<Caption> }
  | { op: 'addOverlay'; overlay: Overlay } | { op: 'removeOverlay'; id: string }
  | { op: 'addScene'; scene: Scene } | { op: 'removeScene'; id: string }
  | { op: 'addSfx'; sfx: Sfx } | { op: 'removeSfx'; id: string } | { op: 'setBgm'; bgm: Bgm[] }
  | { op: 'addMask'; mask: Mask } | { op: 'removeMask'; id: string }
  | { op: 'setMeta'; patch: Partial<Meta> } | { op: 'setOutline'; outline: Chapter[] }
  | { op: 'addMarker'; marker: Marker } | { op: 'setOutput'; output: Output }
  | { op: 'setReview'; patch: Partial<ReviewState> };
export function applyOp(t: Timeline, op: Op): { timeline: Timeline; inverse: Op[] };   // immutable; re-packs segment ranges
export function applyOps(t: Timeline, ops: Op[]): { timeline: Timeline; inverse: Op[] };
export interface Issue { level: 'error'|'warning'; path: string; message: string }
export function validateTimeline(input: unknown): { ok: true; timeline: Timeline; issues: Issue[] } | { ok: false; issues: Issue[] };
  // schema + semantic: unique ids, refs exist, ranges contiguous & non-overlapping, src in bounds when duration known,
  // captions inside timeline, masks reference sources, etc.
export function durationFrames(t: Timeline): Frame;
export function frameToTimecode(f: Frame, fps: Rational): string;   // "HH:MM:SS:FF"
export function timecodeToFrame(tc: string, fps: Rational): Frame;   // accepts "HH:MM:SS:FF", "MM:SS", "SS.sss"
export function summarize(t: Timeline): TimelineSummary;              // for `solocut tl summary`
export function query(t: Timeline, q: { range?: [Frame, Frame]; kind?: string; id?: string; role?: string }): unknown[];
export interface RenderPlan { canvas: Canvas; inputs: { id: string; path: string }[];
  chunks: { id: string; hash: string; range: [Frame, Frame]; args: string[] }[];   // ffmpeg args per chunk (paths relative to project)
  concat: { listFile: string }; audio: { args: string[] }; subtitles?: { assPath: string };
  final: { args: string[] } }
export interface CompileOptions { quality: 'preview'|'final'; target?: Target; projectDir: string; assPath?: string;
  fontsDir?: string; maxChunkFrames?: number }
export function compile(t: Timeline, opts: CompileOptions): RenderPlan;   // pure: builds arg arrays only
export const PRESETS: Record<Target | 'preview', ExportPreset>;           // docs/06 export table
```

## @solocut/media  (ffmpeg/ffprobe via child_process; tool paths from @solocut/toolchain `resolveTool`)

```ts
export interface ProbeResult { durationSec: number; streams: { index: number; type: 'video'|'audio'|'subtitle'|'data';
  codec: string; width?: number; height?: number; fps?: Rational; sampleRate?: number; channels?: number; vfr?: boolean }[];
  timecode?: string; formatName: string }
export function probe(path: string): Promise<ProbeResult>;
export function runFfmpeg(args: string[], o?: { cwd?: string; onProgress?: (sec: number) => void; signal?: AbortSignal }): Promise<void>;
export function detectSilence(path: string, o?: { noiseDb?: number; minMs?: number }): Promise<{ start: number; end: number }[]>; // seconds
export function measureLoudness(path: string): Promise<{ integrated: number; truePeak: number; lra: number }>;
export function detectBlack(path: string, o?: { minSec?: number }): Promise<{ start: number; end: number }[]>;
export function detectFreeze(path: string, o?: { minSec?: number }): Promise<{ start: number; end: number }[]>;
export function extractAudioPcm(path: string, o: { sampleRate: number; mono: true; fromSec?: number; durSec?: number }): Promise<Float32Array>;
export function crossCorrelateOffset(ref: Float32Array, other: Float32Array, sampleRate: number,
  o?: { maxLagSec?: number }): { offsetSec: number; confidence: number; ratio: number };   // FFT-based; other = ref shifted by offsetSec
export function syncFiles(refPath: string, otherPath: string, o?: { maxLagSec?: number; driftWindows?: boolean }):
  Promise<{ offsetSec: number; confidence: number; drift?: number; method: 'xcorr' }>;
export function makeCfrProxy(input: string, output: string, o: { fps: Rational; height?: number; gopSec?: number }): Promise<void>;
export function extractFrame(input: string, atSec: number, output: string, o?: { width?: number }): Promise<void>;
export function executeRenderPlan(plan: RenderPlan, o: { projectDir: string; cacheDir: string; output: string;
  onProgress?: (p: { chunk: string; done: number; total: number }) => void; concurrency?: number }): Promise<{ output: string; reused: number; rendered: number }>;
export function runMachineChecks(rendered: string, o: { target?: Target }): Promise<CheckFinding[]>;  // black, freeze, loudness, spec
```

## @solocut/captions  (pure)

```ts
export interface Word { w: string; start: number; end: number; conf?: number; speaker?: string }  // seconds
export function wordsFromWhisperJson(json: unknown): Word[];   // whisper.cpp -ojf output
export function buildCaptions(words: Word[], o: { fps: Rational; maxCharsPerLine: number; maxLines: number; language: 'ja'|'en';
  minGapMs?: number; style: string; mapTime?: (sec: number) => Frame | null }): Caption[];   // BudouX for ja
export function toAss(captions: Caption[], style: CaptionStyle, canvas: Canvas, fps: Rational): string;  // escape { } \ ; word highlight via \k
export function toSrt(captions: Caption[], fps: Rational): string;
export const CAPTION_STYLES: Record<string, CaptionStyle>;   // 'tiktok-bold', 'youtube-clean', ...
export function findFillers(words: Word[], fillers: string[]): { start: number; end: number; text: string }[];
export function findRetakes(words: Word[], o?: { windowSec?: number; similarity?: number }): { first: [number, number]; second: [number, number]; score: number }[];
```

## @solocut/toolchain

```ts
export type ToolName = 'ffmpeg'|'ffprobe'|'whisper-cli'|'whisper-model';
export interface ToolManifest { schema: 1; tools: Record<string, { version: string; assets: { os: 'mac'|'win'|'linux';
  arch: 'x64'|'arm64'; url: string; sha256: string; kind: 'zip'|'tar.xz'|'tar.gz'|'file'; bin: Record<string, string> }[] }> }
export function solocutHome(): string;                 // $SOLOCUT_HOME or ~/.solocut
export function resolveTool(name: ToolName): Promise<string | null>;   // installed in ~/.solocut/tools, else PATH, else null
export function ensureTool(name: ToolName, o?: { onProgress?: (p: { received: number; total?: number }) => void;
  manifest?: ToolManifest }): Promise<string>;         // download, verify sha256, extract, chmod; returns path
export function toolStatus(): Promise<Record<ToolName, { installed: boolean; path?: string; version?: string }>>;
export const DEFAULT_MANIFEST: ToolManifest;           // pinned URLs + sha256 (verified by the implementer)
```

## @solocut/settings

```ts
export const SettingsSchema: z.ZodType<Settings>;     // docs/11_settings.md
export function settingsPath(): string;               // ~/.solocut/settings.json
export function loadSettings(): Settings;             // defaults merged; invalid file -> defaults + error list
export function saveSettings(s: Settings): void;      // atomic write + history line in settings.history.jsonl
export function getSetting(key: string): unknown; export function setSetting(key: string, value: unknown): Settings;  // dot path
export function settingsJsonSchema(): object;
export const PromptsSchema; export function loadPrompts(projectDir?: string): Prompt[];  // default ⊕ ~/.solocut/prompts.json ⊕ project
export function renderPrompt(p: Prompt, vars: Record<string, string>, lang: 'ja'|'en'): string;
export const DEFAULT_PROMPTS: Prompt[];               // docs/13 list
```

## @solocut/templates

```ts
export interface Template { id: string; version: string; name: { ja: string; en: string }; kind: 'tech'|'talk';
  targets: Target[]; canvas: Canvas; record: {...}; layouts: {...}; cut: {...}; captions: {...}; audio: {...};
  decisions: {...}; checks: string[]; pipeline: StepId[]; dir: string; rules: string; prompts: Record<string, string> }
export function listTemplates(): Template[];           // built-ins in repo /templates + ~/.solocut/templates
export function loadTemplate(id: string): Template;   // supports `extends`
export function generateAgentsMd(t: Template, project: { dir: string; title: string; lang: 'ja'|'en' }): string;
export type StepId = 'ingest'|'sync'|'transcribe'|'rough-cut'|'multicam'|'captions'|'sfx'|'layout'|'preview'|'check'|'review'|'final'|'thumbnail'|'metadata';
export interface StepState { step: StepId; state: 'todo'|'running'|'done'|'needs-human'|'skipped'; note?: string; at?: string }
export interface NextStep { step: StepId | 'done'; state: 'ready'|'needs-human'|'done'; why: string; do: string;
  commands: string[]; prompt?: string; blocking?: string[] }
export function nextStep(template: Template, status: StepState[], ctx: { hasTakes: boolean; hasTranscript: boolean;
  openItems: number; lastCheckFailed: number }): NextStep;
```

## @solocut/archive

```ts
export function registerProject(projectDir: string, o: { reason: 'export'|'publish'|'manual' }): Promise<ArchiveEntry>;
export function listArchive(o?: { kind?: string; template?: string; limit?: number }): ArchiveEntry[];
export function searchArchive(q: string): ArchiveEntry[];   // simple inverted index in JSON (no native sqlite)
export function getArchive(id: string): { entry: ArchiveEntry; timeline: Timeline; stats: ArchiveStats };
export function computeStats(t: Timeline): ArchiveStats;
```

## @solocut/agents

```ts
export interface AgentDef { id: string; label: string; command: string; detect: string[]; install: Record<'mac'|'win'|'linux', string>;
  update?: string; versionArgs: string[]; printMode?: string[]; canGenerateImages?: boolean; limitPatterns: string[] }
export const AGENTS: AgentDef[];   // claude, codex, gemini, opencode, cursor, copilot
export function detectAgents(): Promise<{ id: string; installed: boolean; version?: string; path?: string }[]>;
export function launchCommand(def: AgentDef, shell: 'posix'|'powershell'|'cmd'): string;
export function detectUsageLimit(output: string): string | null;
```

## @solocut/decide

```ts
export type Question = { id: string; kind: 'yesno'; text: string } | { id: string; kind: 'choice'; text: string; options: string[] }
  | { id: string; kind: 'score'; text: string };
export interface DecisionRequest { state: Record<string, unknown>; questions: Question[]; images?: { id: string; path: string }[] }
export interface DecisionAnswer { id: string; p?: number; choice?: Record<string, number>; score?: number }
export function decide(req: DecisionRequest, o: { provider: 'ollama'|'openai'|'typesafe'|'custom'|'off'; model: string;
  endpoint?: string; apiKey?: string; cacheDir: string; budget?: { remainingUsd: number } }): Promise<DecisionAnswer[]>;
export function band(p: number, t: { autoAbove: number; autoBelow: number }): 'yes'|'no'|'ask';
```

## @solocut/cli

`solocut <command>`; every command supports `--json`. Project dir = nearest ancestor with `solocut.json` (or `--project`).
Commands for v0.1: `init`, `status`, `next`, `takes`, `import`, `sync`, `transcribe`, `analyze`, `propose cuts`,
`edit <op> ...` / `edit --ops file.json`, `undo`, `redo`, `history`, `validate`, `captions build`, `render --preview|--final [--target]`,
`frame --at`, `check`, `tl summary|show|range|query|why`, `past list|search|show|timeline`, `config get|set|schema`,
`prompts list|show`, `lib list|install`, `doctor`, `version`. History: `.solocut/history.jsonl` lines
`{ at, by, agent?, ops, inverse }`. Status: `.solocut/status.json` (StepState[]).

## Project folder

As in docs/02: `solocut.json`, `timeline.json`, `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `media/takes/<id>/…`,
`media/imports/<id>/…`, `assets/`, `derived/{proxies,transcripts,analysis,cache}`, `captions/`, `checks/<run>/`,
`feedback/<id>/`, `renders/<target>/`, `.solocut/{history.jsonl,status.json,decisions.jsonl,handoff.md,questions.md}`.

```jsonc
// solocut.json
{ "schema": 1, "id": "prj_…", "title": "…", "template": { "id": "talk-youtube", "version": "1" }, "language": "ja",
  "created": "ISO", "tools": { "ffmpeg": "9.0.2" } }
```
