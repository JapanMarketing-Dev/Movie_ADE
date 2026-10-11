// The newest recorded take as-is, for the workspace player before anything is rendered: the screen recording as the
// main video, a camera as picture-in-picture and the mic, each with where it starts on the take's clock.
// Sources registered by `solocut ingest` win (their offsets may have been re-synced); otherwise take.json; otherwise
// the files in the take folder by name, all starting together.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { RawTake } from '../../shared/types';
import { mediaUrl } from '../../shared/ipc';

export interface TakeFile {
  /** source id or file name, for stable ordering */
  id: string;
  kind: 'screen' | 'camera' | 'mic';
  /** absolute path */
  path: string;
  /** seconds on the take clock where the file's t=0 sits */
  start: number;
  role?: string;
}

export interface RawPick {
  main: TakeFile;
  pip?: TakeFile;
  audio?: TakeFile;
}

/** A firstFrameMs further than this from the track's recorder start is on another clock (e.g. AudioContext before output). */
export const CLOCK_SANITY_MS = 2000;

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i;
const AUDIO_EXT = /\.(wav|m4a|mp3|ogg|opus|aac|webm)$/i;
const TAKE_ID = /^take_[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const byId = (a: TakeFile, b: TakeFile) => a.id.localeCompare(b.id);

/** The camera shown as picture-in-picture: role 'main', else 'front', else the first by id. */
export function pickCamera(cams: TakeFile[]): TakeFile | undefined {
  const sorted = [...cams].sort(byId);
  return sorted.find((c) => c.role === 'main') ?? sorted.find((c) => c.role === 'front') ?? sorted[0];
}

/** Screen as main with the camera as PiP; camera alone as main; mic as audio. Starts are made relative to main. */
export function pickRawTake(files: TakeFile[]): RawPick | null {
  const screen = files.filter((f) => f.kind === 'screen').sort(byId)[0];
  const cam = pickCamera(files.filter((f) => f.kind === 'camera'));
  const mic = files.filter((f) => f.kind === 'mic').sort(byId)[0];
  const main = screen ?? cam;
  if (!main) return null;
  const rel = (f: TakeFile): TakeFile => ({ ...f, start: f.start - main.start });
  const out: RawPick = { main: rel(main) };
  if (screen && cam) out.pip = rel(cam);
  if (mic) out.audio = rel(mic);
  return out;
}

type Rational = { num?: unknown; den?: unknown };
const rate = (r: unknown): number | undefined => {
  if (typeof r === 'number') return r > 0 ? r : undefined;
  const o = r as Rational | undefined;
  const n = num(o?.num);
  const d = num(o?.den) ?? 1;
  return n && n > 0 && d > 0 ? n / d : undefined;
};

/**
 * Files of each take from timeline.json `sources`. A source's local time = takeSec · drift + offset / rate, so its
 * t=0 sits at takeSec = -offset / rate / drift.
 */
export function filesFromSources(timeline: unknown, projectDir: string): Map<string, TakeFile[]> {
  const out = new Map<string, TakeFile[]>();
  const sources = (timeline as { sources?: unknown } | undefined)?.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return out;
  for (const [id, raw] of Object.entries(sources as Record<string, unknown>)) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') continue;
    const kind = s.kind;
    if (kind !== 'screen' && kind !== 'camera' && kind !== 'mic') continue;
    if (typeof s.take !== 'string' || typeof s.path !== 'string' || !s.path) continue;
    const r = kind === 'mic' ? rate(s.sampleRate) : rate(s.fps);
    const offset = num(s.offset) ?? 0;
    const drift = kind === 'camera' && num(s.drift) && (s.drift as number) > 0 ? (s.drift as number) : 1;
    const start = r ? -offset / r / drift : 0;
    const f: TakeFile = { id, kind, path: isAbsolute(s.path) ? s.path : resolve(projectDir, s.path), start: start === 0 ? 0 : start };
    if (typeof s.role === 'string') f.role = s.role;
    const list = out.get(s.take) ?? [];
    list.push(f);
    out.set(s.take, list);
  }
  return out;
}

interface TakeTrackJson {
  file?: unknown;
  kind?: unknown;
  role?: unknown;
  firstFrameMs?: unknown;
  recorderStartMs?: unknown;
}

/** Where a track starts (ms, recorder clock): its first frame, unless that is clearly on another clock. */
export function trackStartMs(tr: TakeTrackJson, startedAtMs: number | undefined): number | undefined {
  const first = num(tr.firstFrameMs);
  const ref = num(tr.recorderStartMs) ?? startedAtMs;
  if (first !== undefined && (ref === undefined || Math.abs(first - ref) <= CLOCK_SANITY_MS)) return first;
  return ref;
}

/** Files of a take from its take.json (null when missing or broken). Tracks whose file is missing are skipped. */
export function filesFromTakeJson(meta: unknown, takeDir: string, exists: (p: string) => boolean = existsSync): TakeFile[] | null {
  const m = meta as { tracks?: unknown; startedAtMs?: unknown } | null | undefined;
  if (!m || typeof m !== 'object' || !Array.isArray(m.tracks)) return null;
  const startedAt = num(m.startedAtMs);
  const items: { f: Omit<TakeFile, 'start'>; ms: number | undefined }[] = [];
  for (const raw of m.tracks as unknown[]) {
    const tr = raw as TakeTrackJson | null;
    if (!tr || typeof tr !== 'object' || typeof tr.file !== 'string' || !tr.file || tr.file.includes('/') || tr.file.includes('\\')) continue;
    const kind = tr.kind;
    if (kind !== 'screen' && kind !== 'camera' && kind !== 'mic') continue; // 'system' audio is not the voice
    const path = join(takeDir, tr.file);
    if (!exists(path)) continue;
    const f: Omit<TakeFile, 'start'> = { id: basename(tr.file, extname(tr.file)), kind, path };
    if (typeof tr.role === 'string') f.role = tr.role;
    items.push({ f, ms: trackStartMs(tr, startedAt) });
  }
  const known = items.map((i) => i.ms).filter((x): x is number => x !== undefined);
  const t0 = known.length ? Math.min(...known) : 0;
  return items.map(({ f, ms }) => ({ ...f, start: ms === undefined ? 0 : (ms - t0) / 1000 }));
}

/** Files of a take folder guessed from their names (screen…, camera… or cam…, mic…), all starting together. */
export function filesFromNames(names: string[], takeDir: string): TakeFile[] {
  const out: TakeFile[] = [];
  for (const name of names) {
    const base = name.toLowerCase();
    if (base.endsWith('.part')) continue;
    let kind: TakeFile['kind'] | null = null;
    if (base.startsWith('screen') && VIDEO_EXT.test(base)) kind = 'screen';
    else if ((base.startsWith('camera') || base.startsWith('cam')) && VIDEO_EXT.test(base)) kind = 'camera';
    else if (base.startsWith('mic') && AUDIO_EXT.test(base)) kind = 'mic';
    if (kind) out.push({ id: basename(name, extname(name)), kind, path: join(takeDir, name), start: 0 });
  }
  return out;
}

/** The take to show: the newest by id (ids are take_<YYYYMMDD-HHMMSS>), from the take folders and the sources. */
export function newestTake(ids: Iterable<string>): string | null {
  const list = [...new Set(ids)].filter((id) => TAKE_ID.test(id)).sort();
  return list.length ? list[list.length - 1]! : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The newest take of a project, ready for the player (null when nothing playable was recorded). */
export function rawTake(projectDir: string): RawTake | null {
  const takesDir = join(projectDir, 'media', 'takes');
  const fromSources = filesFromSources(readJson(join(projectDir, 'timeline.json')), projectDir);
  const take = newestTake([...listDir(takesDir), ...fromSources.keys()]);
  if (!take) return null;
  const takeDir = join(takesDir, take);
  const candidates: (() => TakeFile[] | null)[] = [
    () => (fromSources.get(take) ?? []).filter((f) => existsSync(f.path)),
    () => filesFromTakeJson(readJson(join(takeDir, 'take.json')), takeDir),
    () => filesFromNames(listDir(takeDir), takeDir),
  ];
  for (const get of candidates) {
    const files = get();
    const pick = files && pickRawTake(files);
    if (!pick) continue;
    const file = (f: TakeFile) => ({ path: f.path, url: url(f.path), start: f.start });
    const out: RawTake = { take, main: { ...file(pick.main), kind: pick.main.kind === 'screen' ? 'screen' : 'camera' } };
    if (pick.pip) out.pip = file(pick.pip);
    if (pick.audio) out.audio = file(pick.audio);
    return out;
  }
  return null;
}

function url(path: string): string {
  try {
    return mediaUrl(path, statSync(path).mtimeMs);
  } catch {
    return mediaUrl(path);
  }
}
