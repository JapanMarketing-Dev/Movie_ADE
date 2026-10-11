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
- Dependencies: keep them minimal. Allowed now: `zod` (core, settings), `budoux` (core, captions), `yaml` (templates).
  Ask before adding others. Do not run `pnpm install` at the repo root concurrently with other workers; the
  orchestrator installs. If you need a dependency, add it to your package.json and say so in your report.
- No secrets in code. Paths: user data lives in `~/.solocut/` (override with env `SOLOCUT_HOME`, used by tests).
- Japanese UI copy follows the product's plain-language style; English identifiers in code.
- Every time value inside a timeline is an integer frame number at the timeline fps. No float seconds in timeline.json.

## @solocut/core  (pure; no fs, no child_process)

```ts
export const SCHEMA_VERSION = 1;
export type Frame = number;          // integer, timeline frames (canvas fps)
export type SourceFrame = number;    // integer, frames of a take's clock (see takeFps) or of a source's own clock
export interface Rational { num: number; den: number }
export interface Decided { by: 'human'|'agent'|'decision-model'|'rule'|'template'; agent?: string; reason: string;
  confidence?: number; ruleRef?: string; feedbackRef?: string; needsReview?: boolean }
export const TimelineSchema;   // zod v4, strict objects (unknown keys are errors); full shape from docs/15
export type Timeline = { schema: 1; meta: Meta; canvas: Canvas; sources: Record<string, Source>; transcript?: TranscriptRef;
  outline: Chapter[]; segments: Segment[]; scenes: Scene[]; captions: Caption[]; overlays: Overlay[]; audio: AudioPlan;
  masks: Mask[]; markers: Marker[]; outputs: Output[]; review: ReviewState };   // no `provenance` (history.jsonl is the index)
export type TimelineInput = z.input<typeof TimelineSchema>;   // defaults may be omitted (canvas.colorSpace)
export function emptyTimeline(init: { title; kind: 'tech'|'talk'; template: { id; version }; canvas: Canvas (colorSpace optional);
  language: 'ja'|'en'; targets: Target[] }): Timeline;   // voice defaults: denoise light, eq 'voice-default', -14 LUFS, -1 dBTP
export function timelineJsonSchema(): object;       // z.toJSONSchema(TimelineSchema, { io: 'input' })
export interface CheckFinding { check: CheckKind; status: 'pass'|'fail'|'needs-human'; note: string;
  ranges?: { start: number; end: number }[] /* seconds */; measured?: Record<string, number|string|null> }  // media.runMachineChecks
```

Schema details fixed by the implementation (docs/15 left them open):

- Ids: `^<kind>_[A-Za-z0-9][A-Za-z0-9_.-]*$` for seg, cap, ov, scn, mask, bgm, sfx, ch, take, arc, fb, chk (e.g. `seg_01`, `take_1`).
  Source ids (keys of `sources`) are free-form: `^[A-Za-z0-9][A-Za-z0-9_.:-]*$` (e.g. `t1.screen`, `cam`).
- `Canvas = { width, height (even), fps: Rational, colorSpace: 'bt709'|'bt2020' = 'bt709' }`, `Size = { width, height }`,
  `Point = { x, y }`, `Rect = { x, y, w, h }` (pixels, top-left), `Range = { start, end }` (half-open), `Corner = 'tl'|'tr'|'bl'|'br'`.
- **Time model.** `segment.src.from/to` count frames of the take's clock: `takeFps(t, take)` = fps of the take's screen
  source (first by id), else its first camera, else the canvas fps. A segment's timeline length is
  `max(1, round(srcLen · canvasFps / takeFps))`; ranges are re-packed contiguously from 0 after every segment op.
  A source's local time = `takeSec · drift + offset / rate` where `rate` = video fps, or the mic sample rate (mic `offset`
  is in samples). screen/camera have optional `durationFrames` (enables bounds checks) and `audio?: false` (never used as
  voice). Voice per segment: the take's mic → a shown camera → any camera of the take → the shown screen → silence.
- `segment.zoom` = `{ at: Frame relative to the segment start; value: { scale 1..8; focus: 'face'|'cursor'|Point(canvas px) };
  ease?: 'linear'|'hold' }[]`. `caption.position.y` is a fraction of the canvas height (0..1). Mask `track[].box` is a Rect in
  source pixels at source frames; a mask is active from its first to its last keyframe, boxes interpolated linearly.
  `Marker` kinds `ng` and `important` are separate union members. `scene.anchor?: { segment: seg id; offset: Frame }` keeps a
  scene at `segment.start + offset` (length kept): applyOp re-places anchored scenes after every segment change; a missing
  anchor segment leaves the last range (warning). `wipe.size?` = 0.15–0.5 of the short side (default 0.3); `wipe.style`:
  'ring-gradient' (orange→red ring) | 'shadow' | 'plain' (other values = plain). Camera `drift` ≠ 1: video re-timed with
  setpts, voice resampled (aresample 192 kHz → asetrate·drift → 48 kHz). `bgm.duckDb ≤ 0`. Voice `loudness`/`truePeak` are the
  render targets.

```ts
export type Op =   // contract ops + extensions (marked *) so every op has an exact inverse
  | { op: 'addSource'; id: string; source: Source } | { op: 'removeSource'; id: string }*
  | { op: 'updateSource'; id: string; patch: Record<string, unknown> }*   // merge (undefined deletes); kind fixed; re-packs
  | { op: 'setTranscript'; transcript?: TranscriptRef | null }*           // null / undefined / omitted clears
  | { op: 'setDecided'; target: string; decided: Decided }*   // any element with `decided` (seg/scn/cap/ov/mask/bgm/sfx); review accept/reject
  | { op: 'addSegment'; segment: Segment; index?: number } | { op: 'removeSegment'; id: string; decided: Decided }
  | { op: 'trimSegment'; id: string; from?: SourceFrame; to?: SourceFrame; decided: Decided }
  | { op: 'splitSegment'; id: string; atSource: SourceFrame; newId: string }     // atSource strictly inside; zoom carried over
  | { op: 'moveSegment'; id: string; index: number } | { op: 'setSegments'; segments: Segment[] }*
  | { op: 'setVideo'; id: string; video: VideoChoice; decided: Decided }
  | { op: 'setCamera'; id: string; camera: string; decided: Decided }   // camera-full / wipe camera / split-v bottom
  | { op: 'cutText'; from: SourceFrame; to: SourceFrame; take: string; decided: Decided; kind?: RemovedKind* }
      // removes/trims/splits (new id `${id}_2`…) and records the cut in removedNeighbors (kind default 'off-topic')
  | { op: 'setCaptions'; captions: Caption[] } | { op: 'updateCaption'; id: string; patch: Partial<Caption> }  // undefined deletes a key
  | { op: 'addOverlay'; overlay: Overlay; index?: number } | { op: 'removeOverlay'; id: string }
  | { op: 'addScene'; scene: Scene; index?: number } | { op: 'removeScene'; id: string }
  | { op: 'addSfx'; sfx: Sfx; index?: number } | { op: 'removeSfx'; id: string } | { op: 'setBgm'; bgm: Bgm[] }
  | { op: 'setVoice'; patch: Partial<Voice> }*
  | { op: 'addMask'; mask: Mask; index?: number } | { op: 'removeMask'; id: string }
  | { op: 'setMeta'; patch: Partial<Meta> } | { op: 'setOutline'; outline: Chapter[] }
  | { op: 'addMarker'; marker: Marker } | { op: 'setMarkers'; markers: Marker[] }*
  | { op: 'setOutput'; output: Output } | { op: 'removeOutput'; target: Target }*
  | { op: 'setReview'; patch: Partial<ReviewState> };
export class OpError extends Error { op: OpName }
export function applyOp(t: Timeline, op: Op): { timeline: Timeline; inverse: Op[] };   // immutable; throws OpError; re-packs segments
export function applyOps(t: Timeline, ops: Op[]): { timeline: Timeline; inverse: Op[] };  // all-or-nothing; inverse in reverse order
export interface Issue { level: 'error'|'warning'; path: string; message: string }
export function validateTimeline(input: unknown, o?: { patterns?: Record<string, PatternDef> }):
  { ok: true; timeline: Timeline; issues: Issue[] } | { ok: false; issues: Issue[] };   // also validates scene slots
  // errors: schema; duplicate ids; segment ranges not contiguous from 0 / overlapping / gapped / not matching src length;
  // unknown or wrong-kind source/scene/chapter refs; src past a source's durationFrames; captions/overlays/scenes/bgm/sfx/
  // markers/outputs outside the timeline; mask source not screen/camera, track frames not increasing; duplicate outputs;
  // license limitKey over LICENSE_LIMITS (irasutoya: 20). warnings: unknown take, segment starting before a source
  // (black), overlapping captions, words outside their caption, mask box outside the frame / source not shown, overlapping
  // chapters, BY licenses without credit.
export function durationFrames(t: Timeline): Frame;
export function frameToTimecode(f: Frame, fps: Rational): string;   // "HH:MM:SS:FF" non-drop at the nominal rate (29.97 → 30)
export function timecodeToFrame(tc: string, fps: Rational): Frame;
  // "HH:MM:SS:FF" / "HH:MM:SS;FF" (nominal), "HH:MM:SS(.sss)", "MM:SS(.sss)", "SS(.sss)", "12.5s" (real seconds), "123f"
export function parseFrameRange(spec: string, fps: Rational): [Frame, Frame];   // "A-B"
// also: fpsValue, frameToSeconds, secondsToFrame, convertFrames, frameToClock, takeFps, sourceRate, segmentLength,
// repackSegments, sourceLocalSeconds, takeFrameToTimeline, timelineFrameToTake, videoSources, allIds, freshId
export function summarize(t: Timeline): TimelineSummary;   // title, template, canvas "WxH@fps", duration, counts, chapters,
                                                           // roles, needsReview (decided.needsReview), openItems, lastCheck, outputs
export function query(t: Timeline, q: { range?: [Frame, Frame]; kind?: string; id?: string; role?: string }):
  { kind: 'segment'|'caption'|'overlay'|'scene'|'mask'|'bgm'|'sfx'|'marker'|'chapter'|'source'; id?: string;
    range?: [Frame, Frame]; item: unknown }[];   // half-open overlap; [f, f] = frame f; plural kinds accepted; unknown kind throws

export interface RenderPlan { canvas: Canvas /* render size */; quality: 'preview'|'final'; target?: Target; preset: Target|'preview';
  durationFrames: Frame; inputs: { id: string; path: string }[];
  chunks: { id: string /* `${segId}.${k}` */; hash: string; range: [Frame, Frame]; args: string[] }[];
  concat: { listFile: string }; subtitles?: { assPath: string };
  audio: { hash: string; args: string[]; measure?: { args: string[]; target: { I: number; TP: number; LRA: number } } };
    // final quality = 2-pass loudness: `args` contains LOUDNORM_TOKEN ('{LOUDNORM}') in its filter graph; the executor runs
    // measure.args (loudnorm print_format=json → stderr) and substitutes a measured linear loudnorm. Preview = single pass.
  writes: { path: string; content: string }[];   // generated files (overlay ASS) the executor writes first
  final: { args: string[] }; warnings: string[] }
  // Args exclude global flags (-hide_banner -nostdin -y -progress); paths are relative to the project dir (cwd).
  // Placeholders: chunks/audio `{out}`; final `{concat}`, `{audio}`, `{out}`. One chunk per segment (split every
  // maxChunkFrames, default 30 s) so moving a segment keeps its cached chunk; hash = sha256(compiler version + args).
export interface CompileOptions { quality: 'preview'|'final'; target?: Target; projectDir: string; assPath?: string;
  fontsDir?: string; maxChunkFrames?: number; generatedDir?: string /* default derived/cache/generated */;
  patterns?: Record<string, PatternDef> /* custom patterns/<id>/pattern.json */ }
export function compile(t: Timeline, opts: CompileOptions): RenderPlan;   // pure; throws on an empty timeline / missing sources
  // video per chunk: masks on the source (source pixels) → fps → layout (camera-full cover, screen-full fit, screen-with-wipe
  // with geq circle/rounded alpha, split-v vstack, scene = neutral base) → zoom (static crop or zoompan) → fade/jump-zoom →
  // scene layers (scenes back ASS → scene images / video slots → scenes front ASS) → image/logo overlays → libass (captions ASS + generated overlay ASS for telop/keystroke/click-ring) only on overlapping
  // chunks. Audio: per-segment atrim (padded to the exact length, 5 ms fades) → concat → denoise/eq → bgm (looped, faded,
  // sidechain-ducked) + sfx (adelay) → amix → loudnorm (single pass) → WAV. Final: concat demuxer (copy) + AAC.
export const PRESETS: Record<Target | 'preview', ExportPreset>;   // docs/06: size (null = canvas), H.264 High yuv420p bt709,
  // bframes 2, closed GOP fps/2, bitrates (YT 8/12/40 Mbps, vertical 10 Mbps), AAC 384/256 kbps, -14 LUFS / -1 dBTP,
  // captions srt|burn, safe areas, max durations (TikTok 600 s, Shorts/Reels 180 s); preview = 540p short side, CRF 28
export function presetBitrate(p: ExportPreset, height: number, fps: number): number | undefined;
export function compileFrame(t: Timeline, frame: Frame, opts: Omit<CompileOptions, 'quality'|'maxChunkFrames'> & { quality?: 'preview'|'final' /* default final */ }):
  { frame: Frame; canvas: Canvas; args: string[] /* ends in {out}: an image, format from extension */; writes; warnings };
  // exactly one timeline frame through the same chunk graph (layout, masks, zoom, scenes, overlays, captions); RangeError outside [0, duration)
// Geometry for feedback (pen strokes → elements), pure:
export interface LayoutItem { kind: 'caption'|'overlay'|'scene-slot'|'scene'|'mask'|'wipe'|'video'; id: string; slot?: string;
  source?: string; segment?: string; rect: Rect }
export function layoutAt(t: Timeline, frame: Frame, o?: { canvas?: { width; height } /* rects in this size */;
  captionSize?: number /* × short side, default 0.06 */; patterns?: Record<string, PatternDef> }): LayoutItem[];
  // topmost first: captions, overlays (later on top), scene slots (media + text regions such as bubbles), scenes, masks
  // (source box → canvas via cover/fit + zoom), wipe, video regions. Caption/telop/logo rects are estimates.
export function hitTest(items: LayoutItem[], x: number, y: number): LayoutItem[];
// also: videoRegions(segment, canvas), sourceRectToCanvas(box, sourceSize, region, 'cover'|'fit'), maskBoxAt(mask, sourceFrame)
// Scene patterns (pure, rendered with ASS vector drawing + ffmpeg overlays for image/video slots; needs libass):
export interface SlotDef { kind: SlotValue['kind']; required?: boolean; maxChars?: number; maxItems?: number; hint?: string;
  default?: string /* text default; video "camera:<role>" = synced camera */ }
export interface PatternDef { id; version; name: { ja; en }; for: ('talk'|'tech')[]; aspect: ('16:9'|'9:16')[];
  slots: Record<string, SlotDef>; style: Record<string, string>; animation: { in: string[]; out: string[] };
  theme?: Partial<PatternTheme>; extends?: string /* chain must end at a built-in renderer */ }
export const PATTERNS: Record<string, PatternDef>;   // explain-illust-bubbles, title-card, bullet-points, compare-2col, ranking,
  // big-number, quote, code-focus, terminal-typing, screen-zoom-callout (slots screen/x/y/w/h/label), cta-subscribe
export function resolvePattern(id: string, custom?: Record<string, PatternDef>): { def; renderer; theme } | null;
export function validateSceneSlots(scene: Scene, t, path: string, custom?): Issue[];  // missing required / wrong kind /
  // unknown slot / bad refs / highlight out of range = error; maxChars / maxItems / unknown pattern / version = warning
export function renderScene(scene: Scene, t, custom?): { back: string[]; front: string[]; media: MediaPlacement[]; regions: { slot: string; rect: Rect }[] } | null;
export function renderScenes(t, custom?): { back: string | null; front: string | null; media: MediaPlacement[]; unknown: string[] };
  // Scenes are a full-frame layer over the timeline during scene.range (cta-subscribe has no background). Text slots
  // wrap by character width (no BudouX in core); put "\n" in a slot to force a break.
  // Text: Noto Sans JP (\b400/700/900), code: JetBrains Mono (bundled OFL fonts; pass fontsDir). Japanese slot text breaks
  // only between BudouX phrases (jaPhrases, wrapText, fitText exported).
// helpers: wipeGeometry, reanchor, sha256Hex (pure), ffFilterValue (filtergraph escaping), voiceSource, assTime, assEscape, assColor, assTagColor,
// assHeader, assStyleLine, assDialogue, overlaysToAss
```

## @solocut/media  (ffmpeg/ffprobe via child_process)

Tool paths: env `SOLOCUT_FFMPEG` / `SOLOCUT_FFPROBE` → `@solocut/toolchain` `resolveTool` → PATH; otherwise `MediaError`.
Tests use the same order (toolchain-managed builds include libass; libass-only tests skip on builds without it, and the
scene pixel tests skip on ffmpeg < 6). Fonts: `executeRenderPlan`/`renderFrame` add `fontsdir` to every libass pass that
has none, from `o.fontsDir` (false = never) or `defaultFontsDir()` = env `SOLOCUT_FONTS`, else
`$SOLOCUT_HOME|~/.solocut/tools/fonts` (the subfolder with the most .ttf/.otf/.ttc). Cancel: aborting kills the process
tree (`taskkill /T /F` on Windows, SIGKILL elsewhere) and rejects immediately (`killTree` exported).
Errors: `MediaError` (clear message), `FfmpegError extends MediaError` (`code`, `stderrTail`). Aborts reject with `name: 'AbortError'`.

```ts
export interface ProbeResult { durationSec: number; streams: { index: number; type: 'video'|'audio'|'subtitle'|'data';
  codec: string; width?: number; height?: number; fps?: Rational; sampleRate?: number; channels?: number; vfr?: boolean;
  pixFmt?: string; profile?: string; bitRate?: number; durationSec?: number }[]; timecode?: string; formatName: string; bitRate?: number }
export function probe(path: string): Promise<ProbeResult>;
export function runFfmpeg(args: string[], o?: { cwd?: string; onProgress?: (sec: number) => void; signal?: AbortSignal }): Promise<void>;
  // adds -hide_banner -nostdin -y -progress pipe:1 -nostats
export function detectSilence(path: string, o?: { noiseDb?: number /* -35 */; minMs?: number /* 400 */ }): Promise<{ start: number; end: number }[]>; // seconds
export function measureLoudness(path: string): Promise<{ integrated: number; truePeak: number; lra: number }>;  // -Infinity when silent
export function detectBlack(path: string, o?: { minSec?: number /* 0.1 */; pixelThreshold?: number }): Promise<{ start: number; end: number }[]>;
export function detectFreeze(path: string, o?: { minSec?: number /* 2 */; noiseDb?: number }): Promise<{ start: number; end: number }[]>;
export function extractAudioPcm(path: string, o: { sampleRate: number; mono: true; fromSec?: number; durSec?: number }): Promise<Float32Array>;
export function crossCorrelateOffset(ref: Float32Array, other: Float32Array, sampleRate: number, o?: { maxLagSec?: number /* 600 */ }):
  { offsetSec: number; confidence: number; ratio: number; correlation: number };
  // other = ref delayed by offsetSec. Onset envelopes (pre-emphasis, 2 ms smoothing, log, minus 100 ms mean); coarse FFT
  // search at ~500 Hz, fine search at full rate + parabolic interpolation. ratio = peak / best peak ≥ 0.5 s away (≤ 1000);
  // correlation = overlap-normalized; confidence = min(1,(ratio−1)/2)·min(1,correlation/0.5) (1 ⇔ auto-accept band).
export function syncFiles(refPath: string, otherPath: string, o?: { maxLagSec?: number; driftWindows?: boolean; windowSec?: number /* 60 */ }):
  Promise<{ offsetSec: number; confidence: number; ratio: number; correlation: number; drift?: number;
    windows?: { atSec: number; offsetSec: number; confidence: number }[]; method: 'xcorr' }>;
  // 8 kHz mono, up to 1 h each. Drift when driftWindows or other ≥ 10 min: per-window offsets, RANSAC line vs ref time;
  // then other = drift · ref + offsetSec (offsetSec at ref time 0).
export function makeCfrProxy(input: string, output: string, o: { fps: Rational; height?: number; gopSec?: number /* 1 */; crf?: number; signal?: AbortSignal }): Promise<void>;
export function extractFrame(input: string, atSec: number, output: string, o?: { width?: number }): Promise<void>;  // MediaError past the end
export function executeRenderPlan(plan: RenderPlan, o: { projectDir: string; cacheDir: string; output: string;
  onProgress?: (p: { chunk: string; done: number; total: number }) => void; concurrency?: number; signal?: AbortSignal }):
  Promise<{ output: string; reused: number; rendered: number }>;
  // cacheDir/output may be relative to projectDir. Chunk cache key = plan hash + (size, mtime) of each input + content of
  // the burned ASS files. Outputs are written to a temp file and renamed (never half-written).
export function renderFrame(plan: FramePlan /* from compileFrame */, o: { projectDir: string; output: string; signal?: AbortSignal }): Promise<{ output: string }>;
  // writes plan.writes, checks inputs exist (MediaError), atomic output
export function runMachineChecks(rendered: string, o?: { target?: Target }): Promise<CheckFinding[]>;
  // black-frames (≥0.5 s) and freeze (≥2 s): needs-human when found; loudness: fail outside ±1 LU or true peak > target+0.5;
  // spec: h264 / yuv420p / CFR / aac 48 kHz stereo / preset size / max duration
// also exported for tests and tools: measuredLoudnorm, parseProbe, parseRational, parse{Silence,Black,Freeze,Loudnorm}Log, parseProgressLine,
// fft, xcorr, nextPow2, onsetEnvelope, robustLine, specFinding, loudnessFinding, inputsOf, concatLine, toolPath
```

## @solocut/captions  (pure)

```ts
export interface Word { w: string; start: number; end: number; conf?: number; speaker?: string }  // seconds
export function wordsFromWhisperJson(json: unknown): Word[];
  // whisper.cpp -ojf object or JSON text; skips [_…_] tokens; " x" starts a word, Latin sub-words and punctuation attach;
  // U+FFFD tokens (split UTF-8) are re-filled from the segment text; without tokens (-oj) one word per segment
export function buildCaptions(words: Word[], o: { fps: Rational; maxCharsPerLine: number; maxLines: number; language: 'ja'|'en';
  minGapMs?: number /* 600 */; style: string; mapTime?: (sec: number) => Frame | null; minFrames?: number; idPrefix?: string;
  decided?: Decided }): Caption[];
  // groups at pauses / sentence ends, breaks only where a BudouX phrase and a word end coincide (ja), never overlaps,
  // bridges gaps < 0.25 s, min duration 0.6 s when there is room; ids cap_0001…; maxLines can be exceeded only by a single
  // word longer than a caption; position from CAPTION_STYLES[style]
export function layoutLines(text: string, maxChars: number, language: 'ja'|'en'): string[];  // fewest lines, balanced, no phrase split
export function toAss(captions: Caption[], style: CaptionStyle, canvas: Canvas, fps: Rational): string;
  // escapes { } \ and newlines; \an + \pos from position; karaoke \k per word (when words match the lines); emphasis color/scale/box
export function toSrt(captions: Caption[], fps: Rational): string;
export interface CaptionStyle { id; label: { ja; en }; font; size /* × canvas short side */; bold; weight? /* \b<weight>: tiktok-bold 900, youtube-clean 700 */; color; highlight; outline;
  outlineWidth /* × size */; shadow; box?; karaoke: boolean; emphasis: { color; scale; box }; position;
  maxCharsPerLine: { ja; en }; maxLines; spacing? }
export const CAPTION_STYLES: Record<string, CaptionStyle>;   // 'tiktok-bold', 'youtube-clean', 'boxed'
export const DEFAULT_FILLERS: Record<'ja'|'en', string[]>;
export function findFillers(words: Word[], fillers: string[]): { start: number; end: number; text: string }[];
  // NFKC, case/punctuation-insensitive, 〜 → ー, repeated ー collapsed; matches up to 4 consecutive words
export function findRetakes(words: Word[], o?: { windowSec?: number /* 20 */; similarity?: number /* 0.6 */ }): { first: [number, number]; second: [number, number]; score: number }[];
  // sentence pairs (next 2 sentences) by char-bigram Dice, also against the start of the second (cut-short first attempts)
```

## @solocut/toolchain

```ts
export type ToolName = 'ffmpeg'|'ffprobe'|'whisper-cli'|'whisper-model'|'whisper-model-small';
export interface ToolAsset { os: 'mac'|'win'|'linux'; arch: 'x64'|'arm64'; url: string; sha256: string;
  kind: 'zip'|'tar.xz'|'tar.gz'|'file'; bin: Record<string, string>; size?: number }   // bin: tool name → path in archive
export interface ToolManifest { schema: 1; tools: Record<string, { version: string; license?: string; source?: string; assets: ToolAsset[] }> }
export function solocutHome(): string;                 // $SOLOCUT_HOME or ~/.solocut
export function toolsDir(): string;                    // <home>/tools; installs at tools/<toolKey>/<version>/ + .solocut-tool.json marker
export function resolveTool(name: ToolName, o?: { manifest?; platform? }): Promise<string | null>;
  // env SOLOCUT_FFMPEG|SOLOCUT_FFPROBE|SOLOCUT_WHISPER_CLI|SOLOCUT_WHISPER_MODEL[_SMALL] → managed install → PATH → null
export function resolveToolSync(name, o?): { path: string; source: 'env'|'managed'|'path'; version?: string } | null;
export function ensureTool(name: ToolName, o?: { onProgress?: (p: { received: number; total?: number }) => void;
  manifest?: ToolManifest; platform?: Platform; signal?: AbortSignal }): Promise<string>;
  // streaming download, sha256 verify, extract (zip: built-in extractor, so Linux needs no unzip; tar.*: system `tar`),
  // chmod +x, atomic rename. An asset whose sha256 is not 64 hex chars (e.g. "TBD") is refused before downloading.
  // No asset for the platform → PATH, else ToolchainError('no-asset'). whisper-cli comes from the Solocut CI builds
  // (downloads.solocut.app/tools/whisper/v1.9.5/, all 5 platforms; win arm64 uses win-x64). Errors: ToolchainError.code =
  // 'unsupported-platform'|'no-asset'|'download'|'checksum'|'extract'|'missing-bin'|'aborted'.
export function toolStatus(): Promise<Record<ToolName, { installed: boolean; path?: string; version?: string; source? }>>;
export function findAsset(m: ToolManifest, name: ToolName, p: Platform): { toolKey; version; asset } | null;
  // ffprobe on win/linux comes from the ffmpeg archive (one download)
export function currentPlatform(): Platform; export function whichSync(cmd: string): string | null;
export const DEFAULT_MANIFEST: ToolManifest;           // pinned URLs + sha256, verified 2026-10-11 (see manifest.ts)
```

## @solocut/settings

```ts
export const SettingsSchema;  export type Settings;   // docs/11 + autopilot; every field defaulted; decision.provider default 'off'
export function settingsPath(): string;               // ~/.solocut/settings.json
export function loadSettings(): Settings;             // defaults merged; jsonc comments allowed
export function loadSettingsWithErrors(): { settings: Settings; errors: { path: string; message: string }[] };
  // invalid JSON → defaults; an invalid section → that section's defaults, rest kept
export function saveSettings(s: Settings, o?: { by?: string }): void;  // validate, atomic write (+$schema), changes → settings.history.jsonl
export function getSetting(key: string): unknown;     // dot path, arrays by index ("agents.order.0"); unknown → undefined
export function setSetting(key: string, value: unknown, o?: { by?: string }): Settings;  // throws SettingsError (unknown key / invalid value, with issues)
export function applySetting(current: Settings, key: string, value: unknown): Settings;  // validate only
export function parseCliValue(s: string): unknown;    // JSON when possible, else string
export function settingsJsonSchema(): object;
export const PromptSchema, PromptPatchSchema, PromptsSchema;  export type Prompt = { id; label: {ja,en}; agent; body: {ja?,en?}; autopilot?; hidden? };
export function loadPrompts(projectDir?: string, o?: { includeHidden?: boolean }): Prompt[];  // default ⊕ ~/.solocut/prompts.json ⊕ <project>/.solocut/prompts.json
export function loadPromptsWithErrors(projectDir?, o?): { prompts: Prompt[]; errors: { file; message }[] };
export function mergePrompts(base: Prompt[], patches: PromptPatch[]): Prompt[];   // override by id / add (needs label+body) / hidden
export function renderPrompt(p: Prompt, vars: Record<string, string>, lang: 'ja'|'en'): string;  // {{var}}; missing → ""; {{date}} auto
export const DEFAULT_PROMPTS: Prompt[];               // docs/13 + docs/17 (16 prompts, ja+en)
```

## @solocut/templates

```ts
export interface Template { id; version: string; name: {ja,en}; description?; kind: 'tech'|'talk'; abstract: boolean;
  targets: Target[]; canvas: { width; height; fps: Rational }; record; layouts: { default; allowed; wipe? }; cut; captions;
  audio; decisions; multicam?; features; checks: CheckKind[]; pipeline: StepId[];
  dir: string; rules: string /* base first */; prompts: Record<string, string>; promptFiles: Record<string, string /* abs path */>; chain: string[] }
export const TemplateFileSchema;  export class TemplateError { file?; issues }
export function builtinTemplatesDir(): string;        // $SOLOCUT_TEMPLATES_DIR → <bundle>/../templates → repo /templates
export function listTemplates(o?: { extraDirs?: string[] }): Template[];   // extraDirs → ~/.solocut/templates → built-in; abstract bases hidden
export function loadTemplate(id: string, o?: { extraDirs?: string[] }): Template;  // `extends` (deep merge; arrays replace); id must equal folder name
export function generateAgentsMd(t: Template, project: { dir: string; title: string; lang: 'ja'|'en' }): string;
export const CLAUDE_MD = '@AGENTS.md\n';
export type StepId = 'ingest'|'sync'|'transcribe'|'rough-cut'|'multicam'|'captions'|'sfx'|'layout'|'preview'|'check'|'review'|'final'|'thumbnail'|'metadata';
export interface StepState { step: StepId; state: 'todo'|'running'|'done'|'needs-human'|'skipped'; note?: string; at?: string }
export interface NextStep { step: StepId | 'done'; state: 'ready'|'needs-human'|'done'; why: string; do: string;
  commands: string[]; prompt?: string; blocking?: string[]; meanwhile?: StepId }
export function nextStep(template: Template, status: StepState[], ctx: { hasTakes: boolean; hasTranscript: boolean;
  openItems: number; lastCheckFailed: number; openItemRefs?: string[]; autopilot?: boolean; stopBefore?: string[]; lang?: 'ja'|'en' }): NextStep;
  // pass conditions: ingest needs takes; transcribe needs the transcript file; rough-cut done needs openItems = 0;
  // check done needs lastCheckFailed = 0; review always waits for a human (autopilot skips it); autopilot never skips
  // needs-human sync and stops before stopBefore steps. While waiting, `meanwhile` names a later step whose deps passed.
export function initialStatus(t): StepState[]; export const STEP_DEPS; export function stepText(step, lang);
```

## @solocut/archive

```ts
export interface ArchiveEntry { id: 'arc_YYYY-MM-DD_<slug>'; projectId; title; kind; template; targets; language; durationSec;
  createdAt; registeredAt; reason; projectDir; goal; audience; chapters: { title; points; startSec }[]; tags; thumbnail?;
  renders: { target; path }[]; publish: { target; url?; status }[]; versions: number }
export interface ArchiveStats { durationSec; segments; avgSegmentSec; cutRatio; removedByKind; jumpCuts(+PerMin); zooms(+PerMin);
  captions(+PerMin); emphasisRatio; sfx(+PerMin); bgmTracks; bgmLevelDb; scenes; cameraSwitches; roles; chapters; layouts; needsReview; … }
export function registerProject(projectDir: string, o: { reason: 'export'|'publish'|'manual'; now?: Date }): Promise<ArchiveEntry>;
  // ~/.solocut/archive/<id>/{timeline.json,summary.json,stats.json,thumbnail.*,versions/<n>.json}; same project → same id
export function listArchive(o?: { kind?: string; template?: string; target?: string; limit?: number }): ArchiveEntry[];  // newest first
export function searchArchive(q: string, o?: { limit?: number }): ArchiveEntry[];
  // index.json inverted index (ASCII words + CJK bigrams) over title/goal/audience/chapters/captions/output metadata; AND; rebuilt if corrupt
export function getArchive(id: string): { entry: ArchiveEntry; timeline: Timeline; stats: ArchiveStats };
export function computeStats(t: Timeline): ArchiveStats;  export function compareStats(a, b): { key; a; b; diff }[];
```

## @solocut/agents

```ts
export interface AgentDef { id: string; label: string; command: string; args?: string[]; detect: string[];
  install: Record<'mac'|'win'|'linux', string>; update?: string; versionArgs: string[]; printMode?: string[];
  canGenerateImages?: boolean; limitPatterns: string[]; homepage?: string }
export const AGENTS: AgentDef[];   // claude, codex, gemini, opencode, cursor (command cursor-agent), copilot
export function getAgent(id: string, custom?: { id; label; command; printMode? }[]): AgentDef | undefined;  // custom:* from settings
export function detectAgents(o?: { defs?; versions?: boolean }): Promise<{ id: string; installed: boolean; version?: string; path?: string }[]>;
export function launchCommand(def: AgentDef, shell: 'posix'|'powershell'|'cmd', o?: { prompt?: string; extraArgs?: string[] }): string;
  // with `prompt`: print mode args + the prompt; every arg quoted for the shell (PowerShell `& 'cmd'` when quoted)
export function quoteArg(arg: string, shell): string;
export function detectUsageLimit(output: string, defs?: AgentDef[]): string | null;  // only short status lines (≤160 chars, not code/diff)
export function handoffMessage(lang): string;
```

## @solocut/decide

```ts
export type Question = { id: string; kind: 'yesno'; text: string } | { id: string; kind: 'choice'; text: string; options: string[] }
  | { id: string; kind: 'score'; text: string };
export interface DecisionRequest { state: Record<string, unknown>; questions: Question[]; images?: { id: string; path: string; note?: string }[] }
export interface DecisionAnswer { id: string; p?: number; choice?: Record<string, number> /* normalized */; score?: number }
export function decide(req: DecisionRequest, o: { provider: 'ollama'|'openai'|'typesafe'|'custom'|'off'; model: string;
  endpoint?: string; apiKey?: string; cacheDir: string; budget?: { remainingUsd: number };
  onUsage?: (u: { provider; model; cached: boolean; costUsd: number; tokensIn?; tokensOut?; key }) => void;
  fetch?: typeof fetch; timeoutMs?: number }): Promise<DecisionAnswer[]>;
  // ollama: POST /api/chat (images base64, format = JSON schema); openai: POST /v1/responses (json_schema strict);
  // custom: OpenAI-compatible /chat/completions; typesafe: stub POST <endpoint> { model, state, questions, images }.
  // Cache: <cacheDir>/<sha256(provider, model, endpoint, state, questions, image hashes)>.json.
  // Budget is checked (estimate) before sending. DecideError.code = 'off'|'budget'|'http'|'malformed'|'config'|'image'.
export function band(p: number, t: { autoAbove: number; autoBelow: number }): 'yes'|'no'|'ask';  // ≥ autoAbove yes, ≤ autoBelow no, NaN ask
export function parseAnswers(raw: unknown, q: Question[]): DecisionAnswer[];
```

## @solocut/cli

`solocut <command>`; every command supports `--json`: success `{ "ok": true, … }`, failure `{ "ok": false, "error":
{ code, message, details? } }`; exit 0 ok, 1 error, 2 usage. Global flags anywhere: `--json`, `--project <dir>`,
`--by human|agent`, `--agent <name>` (else env SOLOCUT_AGENT / CLAUDECODE / CODEX_SANDBOX / GEMINI_CLI → agent).
Project dir = nearest ancestor with `solocut.json` (or `--project`). Human output in the project language.
`main(argv: string[], io?: { cwd; stdout; stderr; env; readStdin? }): Promise<number>`; bin: `packages/cli/src/bin.ts`.

Commands (v0.1): `init [dir] | --dir <dir> --template --title --lang --no-git` (no folder → cwd), `status`, `next [--autopilot] [--with-prompt]`,
`step <step> <state> [--note]`, `takes`, `ingest` (media/takes/*/take.json → sources with clock offsets + NG/important
markers; VFR/webm → CFR proxy in derived/proxies), `import <file> [--take] [--kind] [--role] [--id]`, `sync [--take]`,
`transcribe [--take] [--source] [--model]` (whisper-cli `-ml 1 -sow -ojf`; derived/transcripts/main.json, word times in
the take clock), `analyze`, `propose cuts [--replace] [--dry-run]`, `edit <op> --<field> <json|string> --reason …` /
`edit '<json>'` / `edit --ops <file|json|->` (ops needing `decided` get it from --reason), `undo`, `redo`, `history`,
`validate`, `captions build`, `render --preview|--final [--target] [--out]` (preview → renders/preview.mp4; final →
renders/<target>/<title>.mp4, sets outputs[].render, auto-registers in the archive), `frame --at <frame|timecode>`
(extracted from the up-to-date preview), `check [--only failed]` (checks/<run>/report.{md,json}, review.lastCheck),
`tl summary|show|range|query|why`, `past list|search|show|timeline|compare|reuse|register`, `config get|set|schema|path`,
`prompts list|show [--var k=v]`, `templates`, `lib list|install ffmpeg|whisper|whisper-small|all`, `doctor`, `version`,
`thumb candidates|gen`, `meta show|set|write`, `feedback import|list|show|done`, `mcp`.
Progress goes to stderr: one redrawn line on a TTY, otherwise at most one line per 10 % (silent with `--json`).

- `thumb candidates [--n 6] [--every 2]`: samples the (fresh) preview at segment middles and every N s, scores
  sharpness / exposure / contrast (+ the decision model's "eyes open, sharp, good expression" when configured), keeps the
  best ≥ 3 s apart → `checks/thumbs/cand-<frame>.jpg` + `candidates.json`.
- `thumb gen [--frame <frame|tc>] [--n 3] [--provider codex|openai|gemini|frame]… [--title "…"|--no-title]
  [--formats youtube,shorts] [--prompt …] [--reference img]`: the reference frame is extracted at full resolution from the
  original source; bases come from the providers in `settings.imageGen.order` (fail over in order; none → the frame
  itself): codex = `codex exec -i <frame> '$imagegen …'` + newest files in `$CODEX_HOME/generated_images`; openai =
  Images API edits (gpt-image-2, key `SOLOCUT_OPENAI_API_KEY`/`OPENAI_API_KEY`); gemini = generateContent with
  inline image (key `SOLOCUT_GEMINI_API_KEY`, model from `imageGen.providers.gemini.model`). The title is typeset by
  Solocut as its own layer: `renders/thumbnails/title-<format>.svg` is always written; it is composited directly when
  ffmpeg has an SVG decoder (librsvg), else the same layout is drawn with libass; neither → error `ffmpeg-features`.
  Output `renders/thumbnails/{youtube-N.jpg 1280×720, shorts-N.jpg 1080×1920}` (≤ 2 MB), bases `base-*.png`;
  `outputs[].thumbnail` is set (youtube → youtube-1, vertical targets → shorts-1). Fonts: libass/fontconfig by name
  ("Noto Sans JP"), or `SOLOCUT_FONTS_DIR`.
- `meta set [--target t]… --title … [--description …|--description-file f] [--tags a,b] [--candidates …]… |
  --file meta.json` (object, or keyed by target) → `outputs[].metadata`, `renders/<target>/metadata.md` (description +
  YouTube chapters from the outline when valid: ≥ 3, first at 00:00, each ≥ 10 s + credits) and `credits.txt` (unique
  `license.credit` of the asset sources used by bgm/sfx/overlays/scene images). `meta show`, `meta write`.
- `past reuse <id> --what pacing,scenes,captions,sfx,thumbnail-style [--apply] [--out ops.json]` → `{ ops,
  templatePatch, notes, skipped }`: scenes at the same relative positions, sfx per trigger (section → chapter starts,
  scene-in → scene starts, cut → segment starts) at the past rate, caption style, copied asset sources, and
  `meta.references`; added elements carry `decided.needsReview`. `--apply` applies the ops and merges `templatePatch`
  (e.g. `cut.silence.minMs`, `captions.style`) into `<project>/templates/<id>/template.yaml` (`extends` the same id).
- `feedback import <session-dir> [--organize claude|codex|auto] [--id fb_…]` reads the app's session folder:

  ```jsonc
  // session.json (written by the desktop app)
  { "schema": 1, "createdAt": "ISO",
    "audio": "mic.wav", "audioStartMs": 0,                  // voice, and its start on the session clock
    "playback": [{ "atMs": 0, "state": "playing" | "paused", "frame": 120 }],   // state changes and seeks
    "strokes": [{ "startMs": 2000, "endMs": 2600, "frame": 45, "color": "#FF3B30", "width": 0.005,
                  "points": [[0.31, 0.82], [0.5, 0.9]] }],  // normalized 0..1 to the video picture, origin top-left
    "notes": [{ "atMs": 9000, "text": "…", "frame": 200 }],
    "words": [{ "w": "…", "start": 1.6, "end": 2.0 }] }      // optional: already transcribed (s since audioStartMs)
  ```

  Speech is transcribed with whisper (unless `words`), split into remarks at pauses > 0.8 s / sentence ends; strokes and
  notes join the remark within 4 s (else their own item). Frame = stroke.frame ?? playback position. Targets = segment
  and scenes at the frame + captions/overlays whose (approximate) box intersects the strokes. Writes
  `feedback/<id>/{feedback.md, NN.png (frame with strokes via libass, else drawbox), items.json, session.json,
  voice.wav}`, `review.feedback[]` and a `feedback` open item. `--organize` asks the agent's print mode (claude -p /
  codex exec --output-schema) only for titles and requests; quotes always come from the transcript.
  `feedback list [--open] | show <id> | done <id>`.
- `mcp [--project dir]`: MCP server over stdio (newline-delimited JSON-RPC 2.0; protocol 2025-06-18 / 2025-03-26 /
  2024-11-05). Tools: status, next, step, tl_summary, tl_show, tl_range, tl_query, tl_why, edit, undo, redo, validate,
  propose_cuts, captions_build, render, check, frame (also returns the PNG), past_list, past_search, past_show,
  past_timeline, past_reuse, feedback_list, feedback_show, meta_set. Each runs the CLI command with `--json`; failures
  are `isError: true` results.
History: `.solocut/history.jsonl` lines `{ at, by, agent?, kind: 'edit'|'undo'|'redo', ref?, ops, inverse, note? }`
(append-only; undo/redo stacks are replayed from the log). Status: `.solocut/status.json` (StepState[]).
Timeline writes take `.solocut/lock` (stale after 60 s). Decision-model calls are logged to `.solocut/decisions.jsonl`.
`sync` writes results with `updateSource` (offset, drift, sync); `transcribe` sets `timeline.transcript` with `setTranscript`.

`--json` output shapes the app relies on (all objects also carry `"ok": true`):

```ts
// init
{ project: { dir: string } & ProjectFile; git: boolean }
// status
{ project: { dir } & ProjectFile; steps: StepState[]; next: NextStep; summary: TimelineSummary | null; timelineError?: string }
// next  (NextStep fields at the top level)
{ step; state; why; do; commands: string[]; prompt?: string; blocking?: string[]; meanwhile?: StepId; promptText?: string }
// step <step> <state>
{ steps: StepState[] }
// edit / undo / redo
{ applied: number; changed: boolean; dryRun: boolean; warnings: Issue[]; summary: { duration: string; segments: number; captions: number } }
{ undone | redone: { index: number; at: string; by: string; ops: string[] }; changed: boolean }
// history
{ entries: { index; at; by; agent?; kind; ref?; ops: string[]; reasons: string[] }[]; canUndo: boolean; canRedo: boolean }  // --full: raw ops
// tl summary  → { summary: TimelineSummary }  (core summarize(): title, kind, template "id@ver", language, targets,
//   canvas "WxH@fps", durationFrames, duration (timecode), counts{…}, chapters[{id,title,start,end,importance,points,segments}],
//   roles{role:{segments,frames}}, needsReview[{ref,reason}], openItems[], lastCheck?, outputs[]).
//   For per-element lanes with frame ranges use `tl query "<kind>"` / `tl range <a-b>` → { items: QueryResult[] }
//   (QueryResult = { kind, id?, range?: [start, end) in timeline frames, item }; needsReview is item.decided.needsReview).
// tl show <id>   → { element: QueryResult; around: QueryResult[] }
// tl why <id>    → { id; decided: Decided | null; removedNeighbors: []; history: […] }
// past list | past search  → { entries: ArchiveEntry[] }      past show → { entry: ArchiveEntry; stats: ArchiveStats }
// templates      → { templates: { id; version; name{ja,en}; kind; targets; canvas; dir; description? }[]; errors: string[] }
// render         → { output: string /* project-relative */; quality; target?; reused; rendered; seconds; warnings: string[] }
// check          → { run; passed; failed; needsHuman; report: string; findings: CheckFinding[] }
// failure (any command, exit 1, or 2 for usage) → { ok: false, error: { code: string; message: string; details?: unknown } }
```

Review accept/reject from the app: `solocut edit --ops <file.json> --json` with e.g.
`[{ "op": "setDecided", "target": "seg_014", "decided": { "by": "human", "reason": "…", "needsReview": false } }]`, or
`[{ "op": "removeSegment", "id": "seg_014", "decided": { "by": "human", "reason": "…" } }]`; single op inline:
`solocut edit '{"op":"setDecided",…}' --json`, or `solocut edit removeSegment --id seg_014 --reason "…" --by human --json`.

## Project folder

As in docs/02: `solocut.json`, `timeline.json`, `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `media/takes/<id>/…`,
`media/imports/<id>/…`, `assets/`, `derived/{proxies,transcripts,analysis,cache}`, `captions/`, `checks/<run>/`,
`feedback/<id>/`, `renders/<target>/`, `.solocut/{history.jsonl,status.json,decisions.jsonl,handoff.md,questions.md}`.

```jsonc
// solocut.json
{ "schema": 1, "id": "prj_…", "title": "…", "template": { "id": "talk-youtube", "version": "1" }, "language": "ja",
  "created": "ISO", "tools": { "ffmpeg": "9.0.2" } }
```

## One take → three videos (docs/18) — added 2026-10-11, applies to everyone

- A project has a main timeline (`timeline.json`, YouTube 16:9) and derived variants in
  `variants/<target>/timeline.json` for `tiktok` and `youtube-shorts` (9:16). Same Timeline type.
  `meta.derivedFrom = { variantOf: 'main', at: ISO, mainHash: string, selection: { segment: id, from?: SourceFrame, to?: SourceFrame }[], rules: string }`.
- core (engine): `deriveVariant(main: Timeline, target: 'tiktok'|'youtube-shorts', opts: { selection: string[] /* main segment ids in order */,
  maxFrames?: number; captionStyle?: string; layoutMap?: Partial<Record<VideoChoice['layout'], VideoChoice['layout']>>;
  reframe?: 'face'|'center'; hookSegment?: string }) → Timeline` (pure): canvas 1080x1920 at main fps, selected segments copied with new ids,
  layouts converted (camera-full → camera-full with vertical crop focus 'face'; screen-with-wipe → split-v screen top / camera bottom;
  scene → same pattern in 9:16), captions rebuilt-able (keep words, re-wrap later via captions package), sfx/bgm re-timed,
  masks kept (source coords), outputs = [that target]. Plus `pickHighlights(main, { maxFrames, scores?: Record<segId, number> }) → string[]`
  (hook first, then highest-scoring core/summary segments, keep chronological order after the hook, fit maxFrames).
  `variantStale(main, variant) → boolean` (mainHash differs).
- cli (platform): `solocut derive --target tiktok|youtube-shorts [--max-sec N] [--selection id,id] [--json]`; global `--variant <target>`
  on every timeline command (edit/undo/redo/history per variant: `.solocut/history.<variant>.jsonl`); `render --all`, `check --all`,
  `thumb ... --variant`, `meta --variant`; `status`/`next` include per-variant steps
  (`derive:tiktok`, `check:tiktok`, `derive:youtube-shorts`, `check:youtube-shorts`, `final:*`, `publish`). Templates: replace the five
  templates with two families `tech` and `talk` whose `outputs` map lists youtube/tiktok/youtube-shorts with derive settings
  (keep the old ids as aliases that extend them). Add `prompts/vertical.md`. Default prompt `finish` must produce all three.
- desktop: workspace shows a variant switcher (YouTube / TikTok / Shorts) for preview, status and review; Publish screen lists the
  three posts in one approval screen, then announcements once URLs exist.
