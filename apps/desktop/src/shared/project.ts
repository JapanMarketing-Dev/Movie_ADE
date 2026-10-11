// Pure parsing of CLI output and timeline.json for the project workspace. Defensive on purpose: the
// files are written by agents and other tools, so unknown or partial shapes must not crash the UI.
import type { LaneItem, LaneName, NextStep, ReviewItem, StepState, TimelineOverview, Variant } from './types';

const STEP_STATES = new Set(['todo', 'running', 'done', 'needs-human', 'skipped']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Accepts `StepState[]`, `{ steps: StepState[] }` or `{ status: StepState[] }` (status --json / status.json). */
export function parseSteps(input: unknown): StepState[] {
  let arr: unknown = input;
  if (isObj(input)) arr = input.steps ?? input.status ?? input.pipeline;
  if (!Array.isArray(arr)) return [];
  const out: StepState[] = [];
  for (const raw of arr) {
    if (!isObj(raw)) continue;
    const step = str(raw.step) ?? str(raw.id);
    if (!step) continue;
    const st = str(raw.state) ?? 'todo';
    const s: StepState = { step, state: (STEP_STATES.has(st) ? st : 'todo') as StepState['state'] };
    const note = str(raw.note);
    const at = str(raw.at);
    if (note) s.note = note;
    if (at) s.at = at;
    out.push(s);
  }
  return out;
}

export function parseNext(input: unknown): NextStep | undefined {
  const o = isObj(input) && isObj(input.next) ? input.next : input;
  if (!isObj(o)) return undefined;
  const step = str(o.step);
  if (!step) return undefined;
  const state = str(o.state);
  const n: NextStep = {
    step,
    state: state === 'needs-human' || state === 'done' ? state : 'ready',
    why: str(o.why) ?? '',
    do: str(o.do) ?? '',
    commands: Array.isArray(o.commands) ? o.commands.filter((c): c is string => typeof c === 'string') : [],
  };
  const prompt = str(o.prompt);
  if (prompt) n.prompt = prompt;
  if (Array.isArray(o.blocking)) n.blocking = o.blocking.filter((c): c is string => typeof c === 'string');
  return n;
}

export type StepMark = '✓' | '●' | '!' | '·' | '–';
export function stepMark(s: StepState): StepMark {
  switch (s.state) {
    case 'done':
      return '✓';
    case 'running':
      return '●';
    case 'needs-human':
      return '!';
    case 'skipped':
      return '–';
    default:
      return '·';
  }
}

/** Fraction of steps that are done or skipped (0..1). */
export function progressOf(steps: StepState[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  return done / steps.length;
}

/** Extracts JSON from CLI stdout: the whole text, else the last line that parses. */
export function parseCliJson(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    const lines = t.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!.trim();
      if (!l.startsWith('{') && !l.startsWith('[')) continue;
      try {
        return JSON.parse(l);
      } catch {
        /* keep looking */
      }
    }
    return undefined;
  }
}

function rangeOf(o: Record<string, unknown>): [number, number] | undefined {
  if (isObj(o.range)) {
    const s = num(o.range.start);
    const e = num(o.range.end);
    if (s !== undefined && e !== undefined) return [s, e];
  }
  const at = num(o.at);
  if (at !== undefined) return [at, at + Math.max(1, num(o.dur) ?? 1)];
  return undefined;
}

function decidedOf(o: Record<string, unknown>): Record<string, unknown> | undefined {
  return isObj(o.decided) ? o.decided : undefined;
}

function short(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Builds the read-only overview (lanes + review items) from a parsed timeline.json. */
export function timelineOverview(t: unknown): TimelineOverview {
  const tl = isObj(t) ? t : {};
  const canvas = isObj(tl.canvas) ? tl.canvas : {};
  const fps = isObj(canvas.fps) ? canvas.fps : {};
  const meta = isObj(tl.meta) ? tl.meta : {};
  const lanes: Record<LaneName, LaneItem[]> = { segments: [], captions: [], scenes: [], sfx: [], markers: [] };
  const review: ReviewItem[] = [];

  const push = (lane: LaneName, raw: unknown, label: (o: Record<string, unknown>) => string) => {
    if (!isObj(raw)) return;
    const id = str(raw.id) ?? `${lane}-${lanes[lane].length}`;
    const r = rangeOf(raw);
    if (!r) return;
    const d = decidedOf(raw);
    const item: LaneItem = { id, start: r[0], end: r[1], label: short(label(raw)) };
    const kind = str(raw.kind) ?? str(raw.role);
    if (kind) item.kind = kind;
    if (d?.needsReview === true) {
      item.needsReview = true;
      const ri: ReviewItem = { id, lane, start: r[0], label: item.label };
      const reason = str(d.reason);
      const conf = num(d.confidence);
      const by = str(d.by);
      if (reason) ri.reason = reason;
      if (conf !== undefined) ri.confidence = conf;
      if (by) ri.by = by;
      review.push(ri);
    }
    lanes[lane].push(item);
  };

  for (const s of Array.isArray(tl.segments) ? tl.segments : [])
    push('segments', s, (o) => str(o.text) || str(o.role) || str(o.id) || '');
  for (const c of Array.isArray(tl.captions) ? tl.captions : []) push('captions', c, (o) => str(o.text) ?? '');
  for (const s of Array.isArray(tl.scenes) ? tl.scenes : [])
    push('scenes', s, (o) => (isObj(o.pattern) ? str(o.pattern.id) : undefined) ?? str(o.id) ?? '');
  const audio = isObj(tl.audio) ? tl.audio : {};
  for (const s of Array.isArray(audio.sfx) ? audio.sfx : [])
    push('sfx', s, (o) => str(o.trigger) ?? str(o.asset) ?? 'sfx');
  for (const m of Array.isArray(tl.markers) ? tl.markers : [])
    push('markers', m, (o) => str(o.label) ?? str(o.text) ?? str(o.kind) ?? '');

  // masks (e.g. PII found by OCR) that need review: no timeline range, listed for accept / reject
  for (const m of Array.isArray(tl.masks) ? tl.masks : []) {
    if (!isObj(m) || typeof m.id !== 'string') continue;
    const d = decidedOf(m);
    if (d?.needsReview !== true) continue;
    const ri: ReviewItem = { id: m.id, lane: 'masks', label: short(`${str(m.reason) ?? 'mask'} · ${str(m.source) ?? ''}`, 80) };
    const reason = str(d.reason);
    const conf = num(d.confidence);
    if (reason) ri.reason = reason;
    if (conf !== undefined) ri.confidence = conf;
    if (str(d.by)) ri.by = str(d.by)!;
    review.push(ri);
  }

  const rv = isObj(tl.review) ? tl.review : {};
  for (const oi of Array.isArray(rv.openItems) ? rv.openItems : []) {
    if (!isObj(oi)) continue;
    const ref = str(oi.ref);
    if (!ref || review.some((r) => r.id === ref)) continue;
    review.push({ id: ref, lane: 'open', label: short(str(oi.summary) ?? ref, 80), reason: str(oi.kind) ?? '' });
  }

  let duration = 0;
  for (const lane of Object.values(lanes)) for (const it of lane) duration = Math.max(duration, it.end);

  const ov: TimelineOverview = {
    title: str(meta.title) ?? '',
    fpsNum: num(fps.num) ?? 30,
    fpsDen: num(fps.den) ?? 1,
    durationFrames: duration,
    lanes,
    review,
  };
  if (isObj(rv.lastCheck)) {
    ov.lastCheck = {
      passed: num(rv.lastCheck.passed) ?? 0,
      failed: num(rv.lastCheck.failed) ?? 0,
      needsHuman: num(rv.lastCheck.needsHuman) ?? 0,
      at: str(rv.lastCheck.at) ?? '',
    };
  }
  return ov;
}

export type ReviewDecision = 'accept' | 'reject';
type Op = Record<string, unknown> & { op: string };

/**
 * Ops (CONTRACTS.md `Op`) that resolve one needs-review item as a human decision.
 * accept = keep the element and clear needsReview; reject = remove it. Also drops the matching review.openItems.
 * With `setDecided` (default) accept is a single `setDecided` op; `legacy` re-creates the element instead, for CLIs
 * that do not know `setDecided` yet. Returns [] when the item cannot be found.
 */
export function reviewOps(t: unknown, item: ReviewItem, decision: ReviewDecision, mode: 'setDecided' | 'legacy' = 'setDecided'): Op[] {
  const tl = isObj(t) ? t : {};
  const reason = decision === 'accept' ? 'accepted in review' : 'rejected in review';
  const decided = { by: 'human', reason, needsReview: false };
  const ops: Op[] = [];
  const find = (arr: unknown) =>
    (Array.isArray(arr) ? arr : []).find((x): x is Record<string, unknown> => isObj(x) && x.id === item.id);
  const audio = isObj(tl.audio) ? tl.audio : {};
  const el =
    item.lane === 'segments' ? find(tl.segments)
    : item.lane === 'captions' ? find(tl.captions)
    : item.lane === 'scenes' ? find(tl.scenes)
    : item.lane === 'sfx' ? find(audio.sfx)
    : item.lane === 'masks' ? find(tl.masks)
    : undefined;
  if (item.lane !== 'open' && item.lane !== 'markers' && !el) return [];
  const merged = el ? { ...(decidedOf(el) ?? {}), ...decided } : decided;

  if (el && decision === 'accept' && mode === 'setDecided') {
    ops.push({ op: 'setDecided', target: item.id, decided: merged });
  } else if (el) {
    switch (item.lane) {
      case 'segments':
        ops.push(decision === 'accept' ? { op: 'trimSegment', id: item.id, decided } : { op: 'removeSegment', id: item.id, decided });
        break;
      case 'captions':
        if (decision === 'accept') ops.push({ op: 'updateCaption', id: item.id, patch: { decided: merged } });
        else ops.push({ op: 'setCaptions', captions: (tl.captions as unknown[]).filter((x) => !(isObj(x) && x.id === item.id)) });
        break;
      case 'scenes':
        ops.push({ op: 'removeScene', id: item.id });
        if (decision === 'accept') ops.push({ op: 'addScene', scene: { ...el, decided: merged } });
        break;
      case 'sfx':
        ops.push({ op: 'removeSfx', id: item.id });
        if (decision === 'accept') ops.push({ op: 'addSfx', sfx: { ...el, decided: merged } });
        break;
      case 'masks':
        ops.push({ op: 'removeMask', id: item.id });
        if (decision === 'accept') ops.push({ op: 'addMask', mask: { ...el, decided: merged } });
        break;
      default:
        break;
    }
  }

  const rv = isObj(tl.review) ? tl.review : {};
  const open = Array.isArray(rv.openItems) ? rv.openItems : [];
  const remaining = open.filter((o) => !(isObj(o) && o.ref === item.id));
  if (remaining.length !== open.length) ops.push({ op: 'setReview', patch: { openItems: remaining } });
  return ops;
}

/** True when a CLI error means the op is unknown to this CLI (then the app retries with legacy ops). */
export function isUnknownOpError(err: unknown): boolean {
  const text = typeof err === 'string' ? err : JSON.stringify(err ?? '');
  return /setDecided/.test(text) && /(unknown|invalid|unsupported|not supported|unrecognized|invalid_union|Invalid input)/i.test(text);
}

/** Timecode for display, from frames and fps. HH:MM:SS:FF, dropping hours when zero. */
export function formatFrames(f: number, fpsNum: number, fpsDen: number): string {
  const fps = fpsNum / (fpsDen || 1);
  const r = Math.max(1, Math.round(fps));
  const totalSec = Math.floor(f / fps);
  const ff = Math.max(0, Math.round(f - totalSec * fps)) % r;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return (h > 0 ? `${p(h)}:` : '') + `${p(m)}:${p(s)}:${p(ff)}`;
}

// ---------- variants (docs/18) ----------

export function isVariant(v: unknown): v is Variant {
  return v === 'main' || v === 'tiktok' || v === 'youtube-shorts';
}

/** Project-relative timeline file of a variant. */
export function variantTimelinePath(v: Variant): string {
  return v === 'main' ? 'timeline.json' : `variants/${v}/timeline.json`;
}

/** `--variant` flag for CLI calls (none for the main video). */
export function variantArgs(v: Variant | undefined): string[] {
  return v && v !== 'main' ? ['--variant', v] : [];
}

/** Where `render --preview` puts each variant's preview, most likely first (project-relative). */
export function previewCandidates(v: Variant): string[] {
  if (v === 'main') return ['renders/youtube/preview.mp4', 'renders/preview.mp4', 'renders/preview/preview.mp4'];
  return [`renders/${v}/preview.mp4`, `variants/${v}/renders/preview.mp4`, `renders/preview-${v}.mp4`];
}

/**
 * Steps shown for a variant: the main video shows the plain steps (ingest … publish); a variant shows its own
 * `<step>:<variant>` steps with the suffix removed.
 */
export function stepsForVariant(steps: StepState[], v: Variant): StepState[] {
  if (v === 'main') return steps.filter((s) => !s.step.includes(':'));
  const suffix = `:${v}`;
  return steps.filter((s) => s.step.endsWith(suffix)).map((s) => ({ ...s, step: s.step.slice(0, -suffix.length) }));
}

/** Short label of the main/variant output for the UI. */
export function variantTarget(v: Variant): 'youtube' | 'tiktok' | 'youtube-shorts' {
  return v === 'main' ? 'youtube' : v;
}

/** `status --json` → `variants: { tiktok: { exists, stale, lastCheckFailed }, … }` (CONTRACTS.md, docs/18). */
export function parseVariantStatus(input: unknown): Partial<Record<Variant, { exists: boolean; stale: boolean }>> {
  const out: Partial<Record<Variant, { exists: boolean; stale: boolean }>> = {};
  const v = isObj(input) && isObj(input.variants) ? input.variants : {};
  for (const [k, x] of Object.entries(v)) {
    if (!isVariant(k) || !isObj(x)) continue;
    out[k] = { exists: x.exists === true, stale: x.stale === true };
  }
  return out;
}
