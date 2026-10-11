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
    // fast?: FastAudio — preview only: { stems: { id /* segment id */, hash, durationSec, args }[], args, target: { I, TP } }.
    //   One stem per segment (input-seeked `-ss/-t`, voice chain, exact length, 5 ms fades, ebur128 at the end; no voice →
    //   lavfi anullsrc), so editing a segment changes only its stem hash. `args` = master over the stem concat list
    //   (placeholder `{voice}`) + bgm/sfx, with LOUDNORM_TOKEN replaced by `volume=<gain>dB,alimiter=limit=<TP>:level=0`.
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
// Tracking (pure; callers read derived/analysis/*): faces.<sourceId>.json = FaceTrack { fps, frames: [{ f, faces: [{x,y,w,h,score}] }] }
// (normalized), cursor.<takeId>.jsonl = CursorEvent { t_ms, x, y, click? }, keys.<takeId>.jsonl = KeyEvent { t_ms, keys }.
export interface Tracks { faces?: Record<sourceId, FaceTrack>; cursor?: Record<takeId, CursorEvent[]>; keys?: Record<takeId, KeyEvent[]>;
  cuts?: Record<sourceId, number[] /* source seconds */> }
export function parseJsonl<T>(text): T[]; faceSamples(track, o?): TrackSample[]; cursorSamples(events): TrackSample[];
export function focusPath(samples, { fromSec, toSec, fps, cuts?, minCutoff? = 0.4, beta? = 0.6, deadZone? = 0.04, tolerance? = 0.01, fallback? }):
  { at: Frame /* from fromSec */; x; y }[];   // dead zone → one-euro smoothing (restarts at cuts: hard jump) → keyframe reduction
export function focusForPoint(p, sourceSize, regionSize): Focus;   // cover-crop focus that centres a normalized point
export function segmentFocus(t, seg, sourceId, 'face'|'cursor', tracks, region, smoothing?): FocusValue | null;
export function applyTracks(t, tracks, { followClicks?: boolean | { scale = 1.6, holdSec = 1.5, rampSec = 0.35 }, smoothing? }): Segment[];
  // zoom keyframes with focus 'face'/'cursor' become moving canvas points along the track; followClicks (template
  // zoom.followClicks) adds punch-ins toward clicks on screen segments without a hand-made zoom. Record with setSegments.
export function clickZoom(t, seg, tracks, o?): ZoomKeyframe[];
export function cursorFocusForSegments(t, cursorLog: CursorEvent[] | Record<takeId, CursorEvent[]>, o?: { region? /* default 1080×960 */ }):
  Record<segId, Focus>;   // static crop focus from the median cursor per screen segment → deriveVariant({ screenFocus })
export function overlaysFromInputLogs(t, { cursor?, keys? }, { shortcutsOnly? = true, keyHoldSec? = 1.2, clicks? = true, keys? = true }): Overlay[];
  // click-ring at the mapped frame/position (layout-aware, incl. vertical crops) and keystroke badges for shortcuts
  // (repeats merged), only while the take's screen is shown; ids ov_click_N / ov_key_N, unique. Add with addOverlay ops.
// Focus fields (camera-full focus, split-v topFocus/bottomFocus) accept a static { x, y } or keyframes { at, x, y }[]
// (segment-relative frames) → per-frame crop expressions in compile; layoutAt evaluates them. deriveVariant takes
// `tracks` + `smoothing`: faces drive camera crops (unless reframe 'center'), the cursor drives the split-v screen crop.
// Bubbles: fitBubble(label, base, max, maxSize, minSize, maxLines = 3) — the largest size (explain-illust-bubbles:
// frame height / 14) with ≤ 3 BudouX lines; the bubble grows up to max.
// Voice: voiceChain(voice, quality) — high-pass → afftdn (light/strong; final tracks the noise floor) → [final:
// acompressor 2.5:1 → de-ess EQ −3 dB @6.5 kHz → preset EQ]; eq 'off' drops the EQ stages. Loudness still 2-pass on the mix.
// SFX rules (docs/09): sfxFromRules(t, { rules: { on: 'emphasis'|'section'|'cut'|'scene-in'|'caption-in', kind /* 'none' = off */,
//   probability?, gainDb? }[], maxPerMin?, gainDb? (−8), minSpacingMs? (400), seed? }, library: { id, kind, durationMs, path?, license? }[],
//   { words?: { start, end }[] /* timeline frames; default caption words */ }) → Op[] (addSource for missing library files + addSfx).
//   Deterministic (seeded hash for probability and pick). Priority section > scene-in > emphasis > caption-in > cut for the
//   per-60 s cap (existing sfx count) and spacing. With words, section/cut/scene sfx move ≤ 250 ms earlier to end before a speech
//   onset, else −6 dB. Sfx trigger enum gains 'caption-in'. sfxEvents(t) lists the candidate moments.
// Multicam (docs/04): cameraMaterial(t, tracks, words? /* take seconds, array or by take */) → per segment { segment, take,
//   durationSec, current, speaking, speechRatio, words, emphasisWords, cameras: { id, role, faceVisible|null, faceArea|null, lookingAtCamera?,
//   sharp? }[] } (FaceTrack faces may carry gaze 0..1, frames sharp 0..1). splitForSwitch(t, segmentId, atSourceFrames) or
//   splitForSwitch(segment, atSourceFrames, { taken? }) → chained splitSegment ops (ids `${id}_s1…`); takenIds(t). checkCameraSwitches(t, { words?, maxShotSec = 8, minShotSec = 1 })
//   → CheckFinding: fail on a shot held too long or a switch inside a word; very short shots → needs-human.
// CheckFinding gains `items?: { frame, note, ref? }[]`. Track checks: checkCaptionFaceOverlap(t, tracks, { minOverlap = 0.15 })
//   (needs-human), checkCaptionSafeArea(t, target) using safeRect(target, outputSize) (fail), checkMosaicTracking(t, pii:
//   Record<sourceId, PiiAnalysis>) (fail when visible PII is not inside a mask; crops count as not visible).
//   PiiAnalysis = derived/analysis/pii.<sourceId>.json { frames: [{ f, boxes: [{ x, y, w, h, kind, text? }] }], fps? } (normalized).
//   masksFromPii(analysis, sourceId, { size, sourceFps?, pad = 0.15, maxGapFrames = 15, kinds?, kind = 'pixelate', taken? }) →
//   addMask ops (tracks linked by kind/text/overlap, padded, keyframes reduced, needsReview). sourceBoxToCanvasAt(t, frame,
//   sourceId, box) maps a source box onto the canvas (layout, focus, zoom).
// Benchmark (docs/09): benchmarkProfile(samples: BenchmarkSample[] /* per second: captionBoxes, captionColors?, cutTimes,
//   loudness, speechLufs?, bgmRelDb?, sfxOnsets, sfxKinds?, charsPerMin, punchIn? */, { source? }) → StyleProfile (shape of
//   docs/09 + durationSec, captions.present); profileToTemplatePatch(profile) → TemplatePatch { captions { style, highlight,
//   maxCharsPerLine, maxLines, position, emphasis }, cut.jumpZoom, audio { bgm.gainDb, sfx { maxPerMinute, gainDb } },
//   sfx { rules, maxPerMin }, captionLook } — a structural subset of the templates Template (core does not import templates);
//   the templates package deep-merges it.
// Export to other editors (docs/12), pure; ExportOptions { projectDir? (absolute → file:// URLs), srtPath?, name? }:
//   toOtio(t, o) → OpenTimelineIO JSON object (Timeline.1 → Stack.1 → Track.1 V1 main picture / V2 insets (wipe camera,
//   split-v bottom) / A1 voice; Clip.2 + ExternalReference.1 (available_range when durationFrames is known) + Gap.1;
//   chapters/markers as Marker.2 on the stack; metadata.solocut.captions = srtPath).
//   toFcpxml(t, o) → FCPXML 1.11 string (format, assets with media-rep src + duration for Resolve, sequence/spine with
//   asset-clips, insets as lane 1 and voice as lane −1 connected clips, scene segments as gaps, chapter-marker/marker).
//   toEdl(t, o) → CMX3600 (V1 events, A events when the voice is another file, B when the same; BL for scenes;
//   `* FROM CLIP NAME`, `* LOC:` for chapters/markers, `* CAPTIONS:` when srtPath). exportClips(t), fcpTime(frames, fps).
// chaptersForDescription(t, { minSec = 10 }) → { ok, text: "0:00 Title" lines (h:mm:ss ≥ 1 h), chapters, notes }:
//   outline (else chapter markers); first snapped to 0:00; chapters < 10 s merged; ok false when < 3 remain.
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
// Speed: preview plans render with a hardware H.264 encoder when available (executeRenderPlan({ encoder: 'auto' (default)
//   | 'x264' | HwEncoder })); final plans always x264. detectHwEncoder({ refresh?, platform? }) → 'h264_videotoolbox'
//   (mac) | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' (win/linux) | null — listed in `ffmpeg -encoders` AND a 1-frame probe
//   encode succeeds; cached per ffmpeg binary in memory + ~/.solocut/cache/hwenc.json; env SOLOCUT_HWENC=off|<encoder>.
//   Hardware chunks have their own cache keys. Concurrency default renderConcurrency({ hardware }): ≈ cores/3 chunks
//   (max 6; hardware max 3) with x264 `-threads` = cores/chunks. Result gains `encoder`. Abort: every worker's ffmpeg
//   is killed, the promise rejects (AbortError) only after temp files are removed; only complete chunks are cached.
// Fast preview audio (default; executeRenderPlan({ fastAudio: false }) = the full single-graph mix): missing stems render in
//   parallel into <cache>/audio/stem-<key>.wav (+ .json { lufs } sidecar written after the stem; a stem without its
//   sidecar renders again), then the master mix-<key>.wav keyed by the stem list + gain + inputs. Gain =
//   previewGainFilter(stems, target): duration-weighted energy of the stems' integrated loudness (silent / ≤ −70 LUFS
//   ignored) → target.I, clamped ±30 dB, limiter at target.TP. Final plans keep 2-pass loudnorm on the full graph.
//   Also exported: parseEbur128Integrated(log) → LUFS | null, previewGainFilter. inputsOf skips `-f lavfi` inputs.
// Benchmark (not in pnpm test / CI): SOLOCUT_BENCH=1 [SOLOCUT_BENCH_DIR=…] [SOLOCUT_BENCH_FINAL=0] pnpm exec vitest run
//   packages/media/test/zz-bench.test.ts — synthetic 20-min 1080p30 timeline, appends timings to <dir>/log.txt.
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
export type ToolName = 'ffmpeg'|'ffprobe'|'whisper-cli'|'whisper-model'|'whisper-model-small'|'fonts';
export interface ToolAsset { os: 'mac'|'win'|'linux'; arch: 'x64'|'arm64'; url: string; sha256: string;
  kind: 'zip'|'tar.xz'|'tar.gz'|'file'|'bundle'; bin: Record<string, string>; size?: number;   // bin: tool name → path in archive
  parts?: { url; sha256; kind: 'zip'|'tar.xz'|'tar.gz'|'file'; size?; files: Record<string /* dest */, string /* path in archive */> }[] }
  // 'bundle': every part is downloaded, sha-verified and its listed files copied flat into the install dir
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
export function currentPlatform(): Platform;
export function envPath(env?): string;                 // PATH read case-insensitively (Windows "Path")
export function whichSync(cmd: string, env?, platform?): string | null;
  // Windows: tries PATHEXT extensions only (lower-case spelling first, so the path matches the file), `;` separator, case-insensitive PATH key
export function spawnSpec(file: string, args: string[], platform?, env?): { file; args; options: { windowsVerbatimArguments? } };
  // .cmd/.bat on Windows → `%ComSpec% /d /s /c "<quoted cmd>"` (Node refuses to spawn them directly)
export function fontsDir(o?): string | null;           // env SOLOCUT_FONTS (a directory) → managed tools/fonts/<ver>/ → null
// fonts tool (version noto-sans-jp-2.004+jetbrains-mono-2.304, all platforms, one flat dir with the OFL licenses):
//   NotoSansJP-{Regular,Medium,Bold,Black}.otf + LICENSE-NotoSansJP.txt from notofonts/noto-cjk Sans2.004 16_NotoSansJP.zip
//   (sha256 2bbdd2c20f30670b39ca735c96d75f1fdabdb348103e43b820cf17701fd22b18);
//   JetBrainsMono-{Regular,Bold}.ttf + OFL-JetBrainsMono.txt from JetBrains/JetBrainsMono v2.304 JetBrainsMono-2.304.zip
//   (sha256 6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf). resolveTool('fonts') returns the directory.
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
export interface Template { id; version: string; name: {ja,en}; description?; kind: 'tech'|'talk'; abstract: boolean; alias: boolean;
  targets: Target[]; canvas: { width; height; fps: Rational }; record; layouts: { default; allowed; wipe? }; cut; captions;
  audio; decisions; multicam?; features; checks: CheckKind[]; pipeline: StepId[];
  outputs: Partial<Record<Target, { enabled: boolean /* default true */; derive?: 'vertical'; sameAs?: Target; maxSec?: number;
    captions?: string; layout?: string; hook?: 'default'|'shorts' }>>;
  dir: string; rules: string /* base first */; prompts: Record<string, string>; promptFiles: Record<string, string /* abs path */>; chain: string[] }
export const TemplateFileSchema;  export class TemplateError { file?; issues }
export function builtinTemplatesDir(): string;        // $SOLOCUT_TEMPLATES_DIR → <bundle>/../templates → repo /templates
export function listTemplates(o?: { extraDirs?: string[] }): Template[];   // extraDirs → ~/.solocut/templates → built-in; abstract bases and aliases hidden
// built-in families: `tech`, `talk` (youtube + tiktok + youtube-shorts derived). Old ids tech-tutorial, tech-short,
// talk-youtube, talk-tiktok, shorts-from-long are `alias: true` templates that `extends` a family (loadable, not listed).
export function loadTemplate(id: string, o?: { extraDirs?: string[] }): Template;  // `extends` (deep merge; arrays replace); id must equal folder name
export function generateAgentsMd(t: Template, project: { dir: string; title: string; lang: 'ja'|'en' }): string;
export const CLAUDE_MD = '@AGENTS.md\n';
export type StepId = 'ingest'|'sync'|'transcribe'|'rough-cut'|'multicam'|'captions'|'sfx'|'layout'|'preview'|'check'|'review'|'final'|'thumbnail'|'metadata'
  |'analyze'|'masks';   // round 5: analyze (deps ingest, sync), masks (deps rough-cut, analyze; preview depends on it)
// Families: tech pipeline [ingest, sync, analyze, transcribe, rough-cut, multicam, captions, sfx, layout, masks, preview, check,
// thumbnail, metadata, review, final]; talk the same without masks. Template fields added: `sfx { rules: { on: emphasis|section|cut|
// scene-in|caption-in, kind, probability?, gainDb? }[], maxPerMin?, gainDb?, minSpacingMs? }`, `zoom { followClicks: boolean |
// { scale?, holdSec?, rampSec? } }`, `captionLook` (core TemplatePatch shape). A same-id override chains project → ~/.solocut → built-in.
export interface StepState { step: StepId; state: 'todo'|'running'|'done'|'needs-human'|'skipped'; note?: string; at?: string }
export type PipelineStep = StepId | 'publish' | `derive:${Variant}` | `check:${Variant}` | `final:${Variant}`;   // Variant = 'tiktok'|'youtube-shorts'
export function derivedTargets(t): Variant[];          // outputs with derive + enabled
export function expandPipeline(t): PipelineStep[];      // after check: derive:<v>, check:<v>; after final: final:<v>; then publish
export function splitStep(s): { step: StepId|'derive'|'publish'; variant?: Variant }; export function depsOf(t, s): PipelineStep[];
export interface NextStep { step: PipelineStep | 'done'; variant?: Variant; state: 'ready'|'needs-human'|'done'; why: string; do: string;
  commands: string[]; prompt?: string; blocking?: string[]; meanwhile?: StepId }
export function nextStep(template: Template, status: StepState[], ctx: { hasTakes: boolean; hasTranscript: boolean;
  openItems: number; lastCheckFailed: number; openItemRefs?: string[]; autopilot?: boolean; stopBefore?: string[]; lang?: 'ja'|'en';
  variants?: Partial<Record<Variant, { exists: boolean; stale: boolean; lastCheckFailed: number }>> }): NextStep;
  // derive:<v> passes only when the variant exists and is not stale (main changed → back to derive:<v>, prompt 'vertical');
  // check:<v> needs that variant's lastCheckFailed = 0; publish always waits for a human, even on autopilot.
  // pass conditions: ingest needs takes; transcribe needs the transcript file; rough-cut done needs openItems = 0;
  // check done needs lastCheckFailed = 0; review always waits for a human (autopilot skips it); autopilot never skips
  // needs-human sync and stops before stopBefore steps. While waiting, `meanwhile` names a later step whose deps passed.
export function initialStatus(t): StepState[] /* expanded pipeline */; export const STEP_DEPS; export function stepText(step, lang, variants?);
// NextContext.cameras?: number — with fewer than 2 camera sources multicam counts as passed (undefined = unknown → asked).
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
export function decide(req: DecisionRequest, o: { provider: 'claude-cli'|'codex-cli'|'gemini-cli'|'ollama'|'openai'|'typesafe'|'custom'|'off';
  model: string; endpoint?: string; apiKey?: string; cacheDir: string; budget?: { remainingUsd: number };
  callBudget?: { remaining: number } /* CLI providers: calls */; command?: string; runCli?: CliRunner; env?;
  onUsage?: (u: { provider; model; cached: boolean; costUsd: number; tokensIn?; tokensOut?; key; calls? }) => void;
  fetch?: typeof fetch; timeoutMs?: number }): Promise<DecisionAnswer[]>;
  // Agent CLIs = the user's own subscription (no key, cost 0, budget in calls; send many questions per call):
  //   claude-cli: `claude -p --output-format json --strict-mcp-config --allowedTools Read --disallowedTools Bash Edit Write
  //     NotebookEdit WebFetch WebSearch Task --max-turns N [--model m]`, prompt (with the JSON schema) on stdin, run in an
  //     empty temp dir holding only the images (img_N.ext); result text → last JSON object.
  //   codex-cli: `codex exec --skip-git-repo-check --sandbox read-only --output-schema schema.json --output-last-message
  //     answer.json [--model m] --image=img_1.png … -`.   gemini-cli: `gemini --output-format json [--model m] -p "… @img_1.png"`.
  //   `model` is passed only when it names that CLI's family (claude/opus/sonnet/haiku, gpt/o*/codex, gemini*).
  //   claude-cli runs without ANTHROPIC_API_KEY first (the subscription login) and retries with it only when that fails.
export const CLI_PROVIDERS: readonly ['claude-cli','codex-cli','gemini-cli']; export function isCliProvider(p): boolean;
export function resolveProvider(setting: string, which: (cmd) => string | null): Provider;  // 'auto' → first installed of claude → codex → gemini, else 'off'
export const defaultCliRunner: CliRunner;   // spawn, prompt on stdin, .cmd/.bat via cmd.exe on Windows; exit 127 = not runnable
  // ollama: POST /api/chat (images base64, format = JSON schema); openai: POST /v1/responses (json_schema strict);
  // custom: OpenAI-compatible /chat/completions; typesafe: stub POST <endpoint> { model, state, questions, images }.
  // Cache: <cacheDir>/<sha256(provider, model, endpoint, state, questions, image hashes)>.json.
  // Budget is checked (estimate) before sending. DecideError.code = 'off'|'budget'|'http'|'malformed'|'config'|'image'|'cli'.
export function band(p: number, t: { autoAbove: number; autoBelow: number }): 'yes'|'no'|'ask';  // ≥ autoAbove yes, ≤ autoBelow no, NaN ask
export function parseAnswers(raw: unknown, q: Question[]): DecisionAnswer[];
```

## @solocut/cli

`solocut <command>`; every command supports `--json`: success `{ "ok": true, … }`, failure `{ "ok": false, "error":
{ code, message, details? } }`; exit 0 ok, 1 error, 2 usage. Global flags anywhere: `--json`, `--project <dir>`,
`--by human|agent`, `--agent <name>` (else env SOLOCUT_AGENT / CLAUDECODE / CODEX_SANDBOX / GEMINI_CLI → agent).
Project dir = nearest ancestor with `solocut.json` (or `--project`). Human output in the project language.
`main(argv: string[], io?: { cwd; stdout; stderr; env; readStdin? }): Promise<number>`; bin: `packages/cli/src/bin.ts`.

Commands (v0.1; `--variant tiktok|youtube-shorts` is global, see the docs/18 section): `init [dir] | --dir <dir> --template --title --lang --no-git` (no folder → cwd), `status`, `next [--autopilot] [--with-prompt]`,
`step <step> <state> [--note]`, `takes`, `ingest` (media/takes/*/take.json → sources with clock offsets + NG/important
markers; VFR/webm → CFR proxy in derived/proxies), `import <file> [--take] [--kind] [--role] [--id]`, `sync [--take]`,
`transcribe [--take] [--source] [--model]` (whisper-cli `-ml 1 -sow -ojf`; derived/transcripts/main.json, word times in
the take clock), `analyze`, `propose cuts [--replace] [--dry-run]`, `edit <op> --<field> <json|string> --reason …` /
`edit '<json>'` / `edit --ops <file|json|->` (ops needing `decided` get it from --reason), `undo`, `redo`, `history`,
`validate`, `captions build`, `render --preview|--final [--target] [--out]` (main: renders/youtube/{preview,final}.mp4,
plus a compatibility copy renders/preview.mp4 of the main preview; variants: renders/<variant>/{preview,final}.mp4;
`--target` other than youtube on the main → renders/<target>/final.mp4; final sets outputs[].render and auto-registers
the main video in the archive), `frame --at <frame|timecode>`
(extracted from the up-to-date preview), `check [--only failed]` (checks/<run>/report.{md,json}, review.lastCheck),
`tl summary|show|range|query|why`, `past list|search|show|timeline|compare|reuse|register`, `config get|set|schema|path`,
`prompts list|show [--var k=v]`, `templates`, `lib list|install ffmpeg|whisper|whisper-small|fonts|all` (all = ffmpeg, whisper,
fonts), `doctor`, `version`, `derive`, `thumb candidates|gen|pick`, `meta [show]|set|write`, `feedback import|set|update|list|show|done`,
`publish record`, `sfx apply`, `masks from-analysis`, `multicam material`, `edit split-for-switch`, `tracks apply`,
`bench profile|apply`, `mcp`.
Progress goes to stderr: one redrawn line (`\r`) on a TTY, otherwise at most one line per 10 %. With `--json` it is NDJSON on
stderr, one line per whole percent: `{"progress":{"task":"ffmpeg"|"whisper"|"render"|…,"fraction":0.42,"label":"…", …extra}}`;
the final result is still the single JSON object on stdout.
API keys: env `SOLOCUT_<REF>_API_KEY` where REF is the settings key ref upper-cased (`SOLOCUT_OPENAI_API_KEY`,
`SOLOCUT_GEMINI_API_KEY`, `SOLOCUT_DECIDE_API_KEY`, `SOLOCUT_TYPESAFE_API_KEY`), then the provider's own env (`OPENAI_API_KEY`, …).
Fonts: render (when captions/scenes/telops/keystrokes exist) and thumb call `ensureTool('fonts')` (env `SOLOCUT_FONTS` dir →
managed → download; `SOLOCUT_OFFLINE=1` skips the download with a warning) and pass the directory to libass.

- `thumb candidates [--n 6] [--every 2]`: samples the (fresh) preview at segment middles and every N s, scores
  sharpness / exposure / contrast (+ the decision model's "eyes open, sharp, good expression" when configured), keeps the
  best ≥ 3 s apart → `checks/thumbs/cand-<frame>.jpg` + `candidates.json`.
- `thumb gen [--frame <frame|tc>] [--n 3] [--provider codex|openai|gemini|frame]… [--title "…"|--no-title]
  [--formats youtube,shorts] [--prompt …] [--reference img]`: the reference frame is extracted at full resolution from the
  original source; bases come from the providers in `settings.imageGen.order` (fail over in order; none → the frame
  itself): codex = `codex exec -i <frame> '$imagegen …'` + newest files in `$CODEX_HOME/generated_images`; openai =
  Images API edits (gpt-image-2, key `SOLOCUT_OPENAI_API_KEY`/`OPENAI_API_KEY`); gemini = generateContent with
  inline image (key `SOLOCUT_GEMINI_API_KEY`, model from `imageGen.providers.gemini.model`, default `gemini-nano-banana-2.1`). The title is typeset by
  Solocut as its own layer: `renders/thumbnails/title-<format>.svg` is always written; it is composited directly when
  ffmpeg has an SVG decoder (librsvg), else the same layout is drawn with libass; neither → error `ffmpeg-features`.
  Output `renders/thumbnails/{youtube-N.jpg 1280×720, shorts-N.jpg 1080×1920}` (≤ 2 MB), bases `base-*.png`;
  `outputs[].thumbnail` is set (youtube → youtube-1, vertical targets → shorts-1). Fonts: the managed `fonts` tool
  (auto-installed) or env `SOLOCUT_FONTS`, then fontconfig by name ("Noto Sans JP").
  With `--variant v` everything goes to `renders/thumbnails/<v>/` and only that variant's output is set; candidates
  to `checks/thumbs/<v>/`. The thumbnail step is done once every video has a thumbnail.
- `thumb pick <image>` (project-relative or absolute image inside the project): sets that image as the thumbnail of the
  current video's targets (`--variant` for a derived one).
- `meta set [--target t]… --title … [--description …|--description-file f] [--tags a,b] [--candidates …]… |
  --file meta.json` (object, or keyed by target) → `outputs[].metadata`, `renders/<target>/metadata.md` (description +
  YouTube chapters from the outline when valid: ≥ 3, first at 00:00, each ≥ 10 s + credits) and `credits.txt` (unique
  `license.credit` of the asset sources used by bgm/sfx/overlays/scene images). `meta show`, `meta write`.
- `past reuse <id> --what pacing,scenes,captions,sfx,thumbnail-style [--apply] [--out ops.json]` → `{ ops,
  templatePatch, notes, skipped }`: scenes at the same relative positions, sfx per trigger (section → chapter starts,
  scene-in → scene starts, cut → segment starts) at the past rate, caption style, copied asset sources, and
  `meta.references`; added elements carry `decided.needsReview`. `--apply` applies the ops and merges `templatePatch`
  (e.g. `cut.silence.minMs`, `captions.style`) into `<project>/templates/<id>/template.yaml` (`extends` the same id).
- `feedback import <session-dir> [--organize claude|codex|auto] [--id fb_…]` reads the app's session folder (everything is
  built in `feedback/.tmp-<id>-<pid>/` and renamed to `feedback/<id>/` at the end, so a failed transcription leaves nothing):

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
  `feedback list [--open] | show <id> | done <id>`. `--variant v` imports against that variant's preview/timeline (the
  variant is stored in items.json; show/done/set follow it).
  The desktop app may instead write its event list (converted internally; boxes become closed strokes, text → notes):

  ```jsonc
  { "schema": 1, "id": "fb_…"?, "createdAt": "ISO"?, "fps": { "num": 30, "den": 1 }?, "video": { "path": "…" }?,
    "micFile": "mic.wav"?, "micStartMs": 0?,
    "events": [{ "t_ms": 1200, "kind": "play"|"pause"|"seek"|"stroke"|"box"|"text", "frame": 45,
                 "data": { "points": [[x,y],…] } | { "x","y","w","h" } | { "text": "…" } }] }   // a given "id" is used as the fb id
  ```
- `feedback set|update <id> --items <file.json>`: the app's edited list (array or `{ items }`; each `{ n|index, title?, request?,
  notes? }`, order = new order, missing = deleted) → renumbered 1..n, NN.png renamed along, items.json/feedback.md rewritten.
- `mcp [--project dir]`: MCP server over stdio (newline-delimited JSON-RPC 2.0; protocol 2025-06-18 / 2025-03-26 /
  2024-11-05). Tools: status, next, step, tl_summary, tl_show, tl_range, tl_query, tl_why, edit, undo, redo, validate,
  propose_cuts, captions_build, derive, render (`all`), check (`all`), thumb_pick, multicam_material, split_for_switch,
  sfx_apply, tracks_apply, masks_from_analysis, frame (also returns the PNG), past_list,
  past_search, past_show, past_timeline, past_reuse, feedback_list, feedback_show, meta_set. Every tool also takes optional
  `project` and `variant`. Each runs the CLI command in-process with `--json`; failures are `isError: true` results.
- `publish record --target youtube|tiktok|youtube-shorts --status draft|scheduled|published|failed [--url <http(s)>]
  [--at ISO] [--variant v]`: `--url` required for published/scheduled; sets `outputs[].publish = { status, url?, at }` on the
  video that owns the target (tiktok/shorts → their variant when it exists). The `publish` step is done when every
  video's targets are published or scheduled, else needs-human with the pending list.
- Round 5 (engine helpers wired in; all are one undoable edit, `--dry-run` validates only, `--variant` works):
  - Analysis files (CLI `loadAnalysis`): `derived/analysis/faces.<sourceId>.json`, `pii.<sourceId>.json`, `cuts.<sourceId>.json`
    (number[] source seconds), `cursor.<takeId>.jsonl`, `keys.<takeId>.jsonl`; cursor/key logs fall back to the screen
    source's `cursorLog`/`keyLog` and `media/takes/<take>/{cursor,keys}.jsonl`. Malformed files → warnings, never errors.
  - `sfx apply [--seed s] [--keep] [--dry-run]`: template `sfx.rules` (cap `sfx.maxPerMin` ?? `audio.sfx.maxPerMinute`, gain
    `sfx.gainDb` ?? `audio.sfx.gainDb`, seed = project id) over the library: asset sources named `sfx_<kind>…`, files in
    `assets/sfx/<kind>/` and `~/.solocut/library/cache/sfx/<kind>/` (sidecar `<file>.json` per docs/16: id, category,
    features.durationMs, license.spdx, author, title → LicenseRef { id: spdx, credit: "<title> — <author> (<spdx>)" }).
    Cache files are copied to `assets/library/<id><ext>` when used. Earlier template-placed sfx (`decided.by: template`)
    are replaced unless `--keep`. → `{ variant, added, removed, sfx: { id, at, timecode, trigger, asset, gainDb }[], library,
    dryRun, changed, warnings }`; no rules → error `no-rules`.
  - `masks from-analysis`: see the desktop-recipe note below.
  - `multicam material` → `{ variant, cameras: { id, role, take }[], segments: SegmentMaterial[] (core cameraMaterial),
    check: CheckFinding (camera-switch), rules: { maxShotSec, minShotSec, prompt }, files, warnings }`.
    `edit split-for-switch --segment <id> --at <sourceFrame,…|[…]>` → core splitForSwitch ops (ids `<id>_s1…`); no split
    point inside the segment → `invalid-op`.
  - `tracks apply [--follow-clicks|--no-follow-clicks] [--no-overlays] [--dry-run]`: core applyTracks (followClicks from
    template `zoom.followClicks`) → setSegments when changed; click rings / keystroke badges from overlaysFromInputLogs when
    `features.cursorHighlight` / `features.keystrokes` (generated `ov_click_*` / `ov_key_*` are rebuilt). → `{ variant,
    segmentsChanged, zoomKeyframesAdded, followClicks, overlays, removedOverlays, files, dryRun, changed, warnings }`.
  - `check` adds the template's track checks when their inputs exist: caption-safe-area (captions present),
    caption-face-overlap (face tracks), mosaic-tracking (pii files), camera-switch (≥ 2 cameras; transcript words).
  - `derive` passes the loaded face/cursor tracks to deriveVariant (moving vertical crops).
  - `bench profile <samples.json|{source?, samples}> [--out f] [--url u] [--platform p]` → core benchmarkProfile, written
    to `--out` or `~/.solocut/benchmarks/bench_<time>.json` → `{ path, profile, patch }`. `bench apply <profile.json>
    [--template id] [--dry-run]`: profileToTemplatePatch deep-merged into the project's override
    (`<project>/templates/<id>/template.yaml`, when id is the project's template) or `~/.solocut/templates/<id>/template.yaml`;
    the merged template must load or the file is restored (`invalid-template`); a hand-written override is never touched
    (`template-override`). → `{ template, scope: 'project'|'user', file, patch, dryRun }`. Errors `invalid-samples`, `invalid-profile`.
- Decision model in the CLI (`decision.ts`): settings `decision.provider` default **`auto`** (agent CLI on PATH, else off);
  env `SOLOCUT_DECISION_PROVIDER` overrides (tests/CI: off). Agent CLIs need no API key and no `cloudConsent`; API
  providers keep consent + key + USD limits. CLI budget: `decision.limits.perProjectCalls` (default 200) minus the `calls`
  logged in `.solocut/decisions.jsonl`. Batching: rough-cut judges 40 candidates per call, derive scores every segment in
  one call, thumb candidates judge all frames in one call.
- Glossary: `init` seeds `meta.glossary` with Latin phrases from the title ("Claude Code", "CLAUDE.md"). Terms = meta.glossary
  + template `glossary: { term, reading? }[]` + terms in `script.md` (code spans, file names, capitalized phrases). They go
  into whisper's `--prompt` (after the filler sentence, ≤ 160 chars of terms) and a caption pass respells near-misses by
  reading (katakana sound key, Levenshtein similarity ≥ 0.75; exact spellings protected): `caption.text`/`lines` get the
  term, `spoken`/words keep what was said, and `caption.corrections[] = { from, to, decided: { by: 'rule', reason:
  'glossary: "…" → "…"', confidence, ruleRef: 'meta.glossary' } }`.
- `check` on the preview (no `--input`): a spec failure that is only the reduced preview size with the right aspect ratio
  passes ("delivery size is checked on the final render"; run `check --input renders/<target>/final.mp4`).
- Render passes `encoder: settings.export.hwEncodePreview ? 'auto' : 'x264'` to executeRenderPlan (previews only).
- `masks from-analysis` uses the desktop recipe (pii.ts = apps/desktop/src/shared/analysis.ts `piiMaskOps`): tracks of the
  same kind link at IoU ≥ 0.3 within 2 × round(sourceFps / fps) frames; id `mask_pii_` + base-36 FNV-1a of
  `<sourceId>:<kind>:<firstFrame>:<round(x·100)>:<round(y·100)>`; boxes in source pixels; last point held to `f + step − 1`;
  confidence 0.8; decided `{ by: rule, reason: "OCR found <label> on screen", confidence: 0.8, needsReview: true }`.
  Ids already in the timeline are skipped (the app owns these masks); options `--source --kinds email,phone,token
  --kind pixelate|blur|fill --dry-run`; output `{ variant, added, existing, masks, sources, files, dryRun, changed, warnings }`.
  `status`/`next` treat a todo `masks` step as done when the timeline already has `mask_pii_*` masks.
- `doctor`: `agents` lists the catalog agents that are installed or `popular` (detectAgents with the CLI's PATH, which the
  app sets to the login shell's). Settings `agents.order` / prompt `agent` accept any lower-case catalog id or `custom:<name>`.
History: `.solocut/history.jsonl` (main) / `.solocut/history.<variant>.jsonl` lines `{ at, by, agent?, kind: 'edit'|'undo'|'redo', ref?, ops, inverse, note? }`
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
// check          → { run; passed; failed; needsHuman; report: string; findings: CheckFinding[]; variant }   (run id gets "-<variant>")
// render --all   → { results: (render shape + variant)[] }      check --all → { results: (check shape)[]; failed: number }
// status adds    → { variant: 'main'|Variant; variants: { [v]: { exists; stale; lastCheckFailed } } }; steps are the expanded pipeline
// derive         → { target; variant; path: "variants/<v>/timeline.json"; selection: string[]; segments: number; durationSec;
//                    maxSec; captions: number; kept: string[] /* human edits carried over */; replaced: boolean; warnings: string[] }
// feedback import / set → { id; dir; path; variant; count; items: { n; frame; timecode; image: "feedback/<id>/NN.png"; spoken; request;
//                    title; notes: string[]; targets: { kind; id; label }[] }[]; organizedBy: string|null; warnings }   (set: no dir/variant/warnings)
// feedback list  → { feedback: { id; status: 'open'|'done'; items: number; path; … }[] }
// feedback show  → { id; variant; markdown; items /* raw items.json */; view /* same as import items */ }
// thumb candidates → { variant; candidates: { frame; timecode; image /* project-relative */; score; heuristic; model? }[]; warnings }
// thumb gen      → { variant; frame; timecode; title; typeset: 'svg'|'ass'|'none'; images: { path; provider; format: 'youtube'|'shorts';
//                    size: "1280x720"|"1080x1920" }[]; thumbnails: { format; file; base; provider }[]; errors }
// thumb pick     → { variant; target; thumbnail: { path; frame } }
// meta | meta show → { outputs: { variant; target; title; titleCandidates; description; tags; chapters: { at: "00:00"; sec; title }[];
//                    credits: string[]; render?: { path }; thumbnail?: { path; frame }; captions?: { srt }; publish? }[];
//                    chapters; credits; assets }   (all videos; --variant / --target filter)
// meta set       → { targets; files; metadata }
// publish record → { variant; target; publish: { status; url?; at }; pending: string[] }
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
{ "schema": 1, "id": "prj_…", "title": "…", "template": { "id": "talk", "version": "2" }, "language": "ja",
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
  `variantStale(main, variant) → boolean` (mainHash differs; true for a timeline without derivedFrom).
  Implemented (engine, 2026-10-11): also `mainHash(main)` (sha256 of the main minus outputs/review/meta.derivedFrom),
  `highlightScore`, `VERTICAL_SAFE` (TikTok ∩ Shorts safe area: x 80–900, y 220–1480 px). deriveVariant options add
  `screenFocus?: Record<mainSegId, Focus>` (cursor-following crop of the screen), `at?`, `rules?`; it throws on an empty,
  duplicated or unknown selection. Ids get `_tt` / `_ys` suffixes (`_tt2`… for pieces of a caption/overlay/scene split
  across segments); masks keep their ids. Layouts: camera-full → camera-full with `focus` ({x .5, y .4} for 'face', centre
  for 'center'); screen-with-wipe → split-v (screen top with optional `topFocus`, camera bottom with `bottomFocus`);
  screen-full → split-v with the take's camera when there is one; split-v kept; scene kept (re-laid for 9:16). New
  schema fields: `VideoChoice` camera-full `focus?`, split-v `topFocus?`/`bottomFocus?` = `{ x, y }` fractions (where
  the cover crop sits), `meta.derivedFrom?` as above. Captions are clipped/re-timed with style `captionStyle ??
  'tiktok-bold'` at y = 0.72 (inside the shared safe area); re-wrap their lines with @solocut/captions `layoutLines`.
  Telop/click-ring positions are scaled and clamped into the safe area; image rects scaled; bgm becomes one span over
  the mapped range; sfx/markers re-timed (dropped when cut); anchored scenes stay anchored to the renamed segment;
  voice loudness/peak from the target preset; `outputs` = [the target]. Source paths stay project-relative, so compile
  a variant with `projectDir` = the project root.
- Implemented (platform, 2026-10-11): `solocut derive --target t [--max-sec N] [--selection id,id] [--replace] [--no-captions]`.
  Selection: explicit, else the `sameAs` variant's selection (Shorts reuses TikTok's, trimmed to its maxSec), else
  pickHighlights with the decision-model scores when configured. An existing variant needs `--replace` (or is stale);
  re-derive is one undoable edit on the variant history and keeps human-decided telop/image overlays, scenes, sfx, masks
  and the output's metadata/thumbnail/publish. Captions are rebuilt with the target's style (`outputs.<t>.captions`).
  Files per variant: `variants/<v>/timeline.json`, `.solocut/history.<v>.jsonl`, `renders/<v>/preview.mp4`,
  `captions/<v>.{ass,srt}`, final `renders/<v>/final.mp4`. A command with `--variant v` before derive fails with
  `no-variant` (hint: solocut derive). Status steps: `derive:<v>` done when it exists and is fresh (stale → back to todo),
  `check:<v>` reset to todo after a re-derive, `final:<v>`, `publish`.
- cli (plan): `solocut derive --target tiktok|youtube-shorts [--max-sec N] [--selection id,id] [--json]`; global `--variant <target>`
  on every timeline command (edit/undo/redo/history per variant: `.solocut/history.<variant>.jsonl`); `render --all`, `check --all`,
  `thumb ... --variant`, `meta --variant`; `status`/`next` include per-variant steps
  (`derive:tiktok`, `check:tiktok`, `derive:youtube-shorts`, `check:youtube-shorts`, `final:*`, `publish`). Templates: replace the five
  templates with two families `tech` and `talk` whose `outputs` map lists youtube/tiktok/youtube-shorts with derive settings
  (keep the old ids as aliases that extend them). Add `prompts/vertical.md`. Default prompt `finish` must produce all three.
- desktop: workspace shows a variant switcher (YouTube / TikTok / Shorts) for preview, status and review; Publish screen lists the
  three posts in one approval screen, then announcements once URLs exist.
