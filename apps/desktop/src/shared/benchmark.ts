// Reference videos ("お手本動画", docs/09): pure helpers shared by main and the renderer. Reference URL checks, the
// range to analyze, the capture state machine (records only while the user plays the range at 1×), progress lines of
// `solocut bench analyze`, and the profile summary shown in the panel. Unit-tested.

export type BenchPlatform = 'youtube' | 'tiktok';
export type BenchScope = 'project' | 'global';

/** A saved style profile (~/.solocut/benchmarks/…json) as the panel lists it. */
export interface BenchEntry {
  id: string;
  profilePath: string;
  title: string;
  url?: string;
  platform?: string;
  /** e.g. "00:00-03:00" */
  analyzed?: string;
  mtimeMs: number;
  profile: unknown;
}

export interface BenchApplied {
  id: string;
  title: string;
  at: string;
}

export interface BenchState {
  profiles: BenchEntry[];
  /** the reference used for every video, and the one of the given project (wins over global) */
  applied: { global: BenchApplied | null; project: BenchApplied | null };
}

export interface BenchRange {
  start: number;
  end: number;
}

/** What the reference player reports (read from the page; the user drives the player). */
export interface PlayerSample {
  t: number;
  paused: boolean;
  rate: number;
  ended: boolean;
  duration?: number;
}

/** The page's answer to the player probe (anything else → null). */
export function parsePlayerSample(v: unknown): PlayerSample | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.t !== 'number' || !Number.isFinite(o.t) || typeof o.rate !== 'number' || !Number.isFinite(o.rate)) return null;
  const s: PlayerSample = { t: o.t, paused: o.paused === true, rate: o.rate, ended: o.ended === true };
  if (typeof o.duration === 'number' && Number.isFinite(o.duration) && o.duration > 0) s.duration = o.duration;
  return s;
}

// ---------- URL ----------

const HOSTS: Record<string, BenchPlatform> = {
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'm.youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'tiktok.com': 'tiktok',
  'www.tiktok.com': 'tiktok',
  'vm.tiktok.com': 'tiktok',
  'vt.tiktok.com': 'tiktok',
  'm.tiktok.com': 'tiktok',
};

/** A pasted YouTube / TikTok link (https only; http is upgraded, a bare host gets https://). */
export function parseReferenceUrl(text: string): { ok: true; url: string; platform: BenchPlatform } | { ok: false; error: 'empty' | 'invalid' | 'unsupported' } {
  const s = text.trim();
  if (!s) return { ok: false, error: 'empty' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password) return { ok: false, error: 'invalid' };
  const platform = HOSTS[u.hostname.toLowerCase()];
  if (!platform) return { ok: false, error: 'unsupported' };
  return { ok: true, url: u.toString(), platform };
}

/** Pages the reference window may navigate to (the players and their sign-in); anything else opens in the browser. */
export function allowedInReferenceWindow(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return ['youtube.com', 'youtu.be', 'google.com', 'tiktok.com'].some((d) => h === d || h.endsWith(`.${d}`));
}

// ---------- range ----------

export const DEFAULT_RANGE: BenchRange = { start: 0, end: 180 };
export const MIN_RANGE_SEC = 10;
export const MAX_RANGE_SEC = 600;

export const RANGE_PRESETS = [
  { id: 'first1', range: { start: 0, end: 60 } },
  { id: 'first3', range: { start: 0, end: 180 } },
  { id: 'first5', range: { start: 0, end: 300 } },
] as const;

/** "1:30", "01:02:03", "90", "90s" → seconds; null when unreadable. */
export function parseClock(text: string): number | null {
  const s = text.trim().replace(/s$/i, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (!m) return null;
  return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/** 90 → "01:30", 3725 → "1:02:05". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRange(r: BenchRange): string {
  return `${formatClock(r.start)}-${formatClock(r.end)}`;
}

/**
 * A usable range: start ≥ 0, MIN_RANGE_SEC ≤ length ≤ MAX_RANGE_SEC, inside the video when its length is known (a
 * range past the end is moved back so it still has its length where possible).
 */
export function normalizeRange(r: Partial<BenchRange> | null | undefined, durationSec?: number): BenchRange {
  let start = Number.isFinite(r?.start) ? Math.max(0, r!.start!) : DEFAULT_RANGE.start;
  let end = Number.isFinite(r?.end) ? r!.end! : start + (DEFAULT_RANGE.end - DEFAULT_RANGE.start);
  if (end - start < MIN_RANGE_SEC) end = start + MIN_RANGE_SEC;
  if (end - start > MAX_RANGE_SEC) end = start + MAX_RANGE_SEC;
  const dur = durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined;
  if (dur !== undefined && end > dur) {
    const len = end - start;
    end = dur;
    start = Math.max(0, Math.min(start, dur - len));
  }
  return { start, end };
}

// ---------- capture state machine ----------

export type CapturePhase = 'waiting' | 'recording' | 'paused' | 'done';
export type CaptureAction = 'start' | 'pause' | 'resume' | 'stop' | null;
export type CaptureHint = 'play' | 'rate' | 'before' | 'after' | 'noPlayer' | null;

export interface CaptureState {
  phase: CapturePhase;
  range: BenchRange;
  /** seconds of the range recorded so far */
  recorded: number;
  /** 'player': follows the page's video; 'clock': the page could not be read, record the range length by wall clock */
  mode: 'player' | 'clock';
  armedAt: number;
  lastT?: number;
  lastWall?: number;
  hint: CaptureHint;
}

/** Without a readable player for this long, recording starts and runs the range length by the clock. */
export const NO_PLAYER_GRACE_MS = 4000;

export function initialCapture(range: BenchRange, now: number): CaptureState {
  return { phase: 'waiting', range, recorded: 0, mode: 'player', armedAt: now, hint: 'play' };
}

const RATE_TOLERANCE = 0.01;

/**
 * One poll of the reference player. Records only while the user plays inside the range at 1× (pausing, seeking
 * outside or changing the speed pauses the recording); stops once the range is covered or the video ends.
 */
export function captureStep(s: CaptureState, sample: PlayerSample | null, now: number): { state: CaptureState; action: CaptureAction } {
  if (s.phase === 'done') return { state: s, action: null };
  const length = s.range.end - s.range.start;

  if (s.mode === 'clock' || (!sample && s.phase === 'waiting' && now - s.armedAt >= NO_PLAYER_GRACE_MS)) {
    if (s.mode !== 'clock') return { state: { ...s, mode: 'clock', phase: 'recording', lastWall: now, hint: 'noPlayer' }, action: 'start' };
    const recorded = s.recorded + Math.max(0, now - (s.lastWall ?? now)) / 1000;
    if (recorded >= length) return { state: { ...s, recorded: length, phase: 'done', lastWall: now, hint: null }, action: 'stop' };
    return { state: { ...s, recorded, lastWall: now }, action: null };
  }
  if (!sample) return { state: { ...s, hint: s.phase === 'waiting' ? 'play' : s.hint }, action: null };

  // time actually played since the last poll (a seek is a jump, not playback)
  let recorded = s.recorded;
  if (s.phase === 'recording' && s.lastT !== undefined && s.lastWall !== undefined) {
    const dt = sample.t - s.lastT;
    const dw = (now - s.lastWall) / 1000;
    if (dt > 0 && dt <= Math.max(2, dw * 1.5 + 0.5)) recorded += Math.min(dt, Math.max(0, s.range.end - s.lastT));
  }
  const base = { ...s, recorded, lastT: sample.t, lastWall: now };
  const started = s.phase !== 'waiting';
  if (started && (recorded >= length - 0.25 || sample.ended || sample.t >= s.range.end)) {
    return { state: { ...base, recorded: Math.min(recorded, length), phase: 'done', hint: null }, action: 'stop' };
  }
  const inRange = sample.t >= s.range.start && sample.t < s.range.end;
  const rateOk = Math.abs(sample.rate - 1) < RATE_TOLERANCE;
  const playing = !sample.paused && !sample.ended;
  const hint: CaptureHint = !inRange ? (sample.t < s.range.start ? 'before' : 'after') : !playing ? 'play' : !rateOk ? 'rate' : null;
  const want = inRange && playing && rateOk;
  if (s.phase === 'waiting') return want ? { state: { ...base, phase: 'recording', hint }, action: 'start' } : { state: { ...base, hint }, action: null };
  if (s.phase === 'recording' && !want) return { state: { ...base, phase: 'paused', hint }, action: 'pause' };
  if (s.phase === 'paused' && want) return { state: { ...base, phase: 'recording', hint }, action: 'resume' };
  return { state: { ...base, hint }, action: null };
}

// ---------- panel flow ----------

export type BenchFlow =
  | { step: 'idle' }
  | { step: 'browsing'; url: string; platform: BenchPlatform }
  | { step: 'capturing'; url: string; platform: BenchPlatform }
  | { step: 'analyzing'; label: string; fraction: number }
  | { step: 'result'; entry: BenchEntry }
  | { step: 'error'; message: string };

export type BenchEvent =
  | { type: 'openUrl'; url: string; platform: BenchPlatform }
  | { type: 'startCapture' }
  | { type: 'analyze'; label?: string }
  | { type: 'progress'; fraction: number; label?: string }
  | { type: 'analyzed'; entry: BenchEntry }
  | { type: 'fail'; message: string }
  | { type: 'reset' };

/** The panel's flow. Events that make no sense in the current step are ignored. */
export function benchReducer(s: BenchFlow, e: BenchEvent): BenchFlow {
  switch (e.type) {
    case 'reset':
      return { step: 'idle' };
    case 'fail':
      return { step: 'error', message: e.message };
    case 'openUrl':
      return s.step === 'analyzing' || s.step === 'capturing' ? s : { step: 'browsing', url: e.url, platform: e.platform };
    case 'startCapture':
      return s.step === 'browsing' ? { step: 'capturing', url: s.url, platform: s.platform } : s;
    case 'analyze':
      return s.step === 'analyzing' ? s : { step: 'analyzing', label: e.label ?? '', fraction: 0 };
    case 'progress':
      if (s.step !== 'analyzing') return s;
      return { step: 'analyzing', label: e.label ?? s.label, fraction: Math.max(s.fraction, Math.max(0, Math.min(1, Number.isFinite(e.fraction) ? e.fraction : 0))) };
    case 'analyzed':
      return s.step === 'analyzing' ? { step: 'result', entry: e.entry } : s;
  }
}

// ---------- CLI output ----------

/** `{"progress":{"task","fraction","label"}}` lines that `solocut … --json` writes to stderr. */
export function parseBenchProgress(line: string): { fraction: number; label: string } | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const p = (JSON.parse(s) as { progress?: { fraction?: unknown; label?: unknown } }).progress;
    if (!p || typeof p.fraction !== 'number' || !Number.isFinite(p.fraction)) return null;
    return { fraction: Math.max(0, Math.min(1, p.fraction)), label: typeof p.label === 'string' ? p.label : '' };
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** True when the JSON looks like a style profile (docs/09; `solocut bench profile|analyze` write one). */
export function isStyleProfile(v: unknown): boolean {
  const o = obj(v);
  return !!o && (!!obj(o.captions) || !!obj(o.cuts)) && (num(o.durationSec) !== undefined || !!obj(o.source));
}

/** A display title for a profile: its title, else the URL's video id / host, else the file name. */
export function profileTitle(profile: unknown, fallback: string): string {
  const src = obj(obj(profile)?.source);
  const t = str(obj(profile)?.title) ?? str(src?.title);
  if (t) return t.trim().slice(0, 120);
  const url = str(src?.url);
  if (url) {
    try {
      const u = new URL(url);
      const v = u.searchParams.get('v');
      if (v) return `${u.hostname.replace(/^www\./, '')} ${v}`;
      const path = u.pathname.replace(/\/+$/, '');
      return `${u.hostname.replace(/^www\./, '')}${path}`.slice(0, 120);
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** The entry for a profile file. */
export function benchEntry(profile: unknown, profilePath: string, mtimeMs: number): BenchEntry | null {
  if (!isStyleProfile(profile)) return null;
  const base = profilePath.split(/[\\/]/).pop() ?? profilePath;
  const id = base.replace(/\.json$/i, '');
  const src = obj(obj(profile)?.source);
  const e: BenchEntry = { id, profilePath, title: profileTitle(profile, id), mtimeMs, profile };
  const url = str(src?.url);
  if (url) e.url = url;
  const platform = str(src?.platform);
  if (platform) e.platform = platform;
  const analyzed = str(src?.range) ?? str(src?.analyzed);
  // `analyzed` is a range ("00:00-03:00") in docs/09 but a timestamp in older profiles: only a range is shown
  if (analyzed && /^\d+(:\d\d)+-\d+(:\d\d)+$/.test(analyzed)) e.analyzed = analyzed;
  return e;
}

// ---------- summary ----------

export interface SummaryRow {
  id: 'cuts' | 'captions' | 'sfx' | 'bgm' | 'speech';
  label: string;
  value: string;
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');

/** The profile as a few readable rows (cut pace, captions, SFX per minute, BGM, speaking speed); unknown values are left out. */
export function summarizeProfile(profile: unknown, lang: 'ja' | 'en'): SummaryRow[] {
  const ja = lang === 'ja';
  const p = obj(profile) ?? {};
  const rows: SummaryRow[] = [];
  const cuts = obj(p.cuts);
  const shot = num(cuts?.avgShotSec);
  if (shot !== undefined && shot > 0) {
    const jump = num(cuts?.jumpCutsPerMin);
    const extra = jump !== undefined ? (ja ? `、ジャンプカット ${r1(jump)} 回/分` : `, ${r1(jump)} jump cuts/min`) : '';
    rows.push({ id: 'cuts', label: ja ? 'カットの間隔' : 'Cut pace', value: (ja ? `平均 ${r1(shot)} 秒` : `${r1(shot)} s per shot`) + extra });
  }
  const cap = obj(p.captions);
  if (cap) {
    if (cap.present === false) rows.push({ id: 'captions', label: ja ? '字幕' : 'Captions', value: ja ? 'なし' : 'none' });
    else {
      const reveal = str(cap.reveal);
      const revealText = reveal === 'word-highlight' ? (ja ? '単語ごとに強調' : 'word highlight') : reveal === 'word' ? (ja ? '単語ごと' : 'word by word') : reveal === 'block' ? (ja ? '一括' : 'whole line') : undefined;
      const chars = num(obj(cap.charsPerLine)?.p50);
      const anchor = num(cap.anchorY);
      const parts = [
        revealText,
        chars !== undefined ? (ja ? `1行 ${Math.round(chars)} 文字` : `${Math.round(chars)} chars/line`) : undefined,
        anchor !== undefined ? (ja ? `上から ${Math.round(anchor * 100)}%` : `${Math.round(anchor * 100)}% down`) : undefined,
      ].filter(Boolean);
      if (parts.length) rows.push({ id: 'captions', label: ja ? '字幕' : 'Captions', value: parts.join(ja ? '、' : ', ') });
    }
  }
  const sfx = num(obj(p.sfx)?.perMin);
  if (sfx !== undefined) rows.push({ id: 'sfx', label: ja ? '効果音' : 'SFX', value: ja ? `${r1(sfx)} 回/分` : `${r1(sfx)} per min` });
  const bgm = obj(obj(p.audio)?.bgm);
  if (bgm && typeof bgm.present === 'boolean') {
    if (!bgm.present) rows.push({ id: 'bgm', label: 'BGM', value: ja ? 'なし' : 'none' });
    else {
      const rel = num(bgm.relDb);
      const mood = str(bgm.mood);
      const bpm = num(bgm.bpm);
      const parts = [
        rel !== undefined ? (ja ? `声より ${r1(rel)} dB` : `${r1(rel)} dB under the voice`) : undefined,
        bgm.ducking === true ? (ja ? '話す間は下げる' : 'ducked under speech') : undefined,
        mood,
        bpm !== undefined ? `${Math.round(bpm)} BPM` : undefined,
      ].filter(Boolean);
      rows.push({ id: 'bgm', label: 'BGM', value: (ja ? 'あり' : 'yes') + (parts.length ? (ja ? `（${parts.join('、')}）` : ` (${parts.join(', ')})`) : '') });
    }
  }
  const cpm = num(obj(p.speech)?.charsPerMin);
  if (cpm !== undefined && cpm > 0) rows.push({ id: 'speech', label: ja ? '話す速さ' : 'Speaking speed', value: ja ? `${Math.round(cpm)} 文字/分` : `${Math.round(cpm)} chars/min` });
  return rows;
}

/** Which reference the label in the editing screen names: this video's own, else the one for every video. */
export function activeReference(applied: BenchState['applied'] | null | undefined): { ref: BenchApplied; scope: BenchScope } | null {
  if (applied?.project) return { ref: applied.project, scope: 'project' };
  if (applied?.global) return { ref: applied.global, scope: 'global' };
  return null;
}
