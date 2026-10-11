// Pure publishing helpers (docs/14): the publish.json the AI writes (parse + validate, never throws), the
// request/result files of the `solocut publish upload` hand-off, YouTube request bodies and limits, and the
// library progress parsing. Shared by the renderer (display) and main (upload).

export const YT_TITLE_MAX = 100; // characters (code points)
export const YT_DESCRIPTION_MAX_BYTES = 5000;
export const YT_TAGS_MAX = 500; // characters, counted like YouTube (tags with spaces count their quotes)
export const TIKTOK_CAPTION_MAX = 2200; // UTF-16 code units

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Characters as YouTube counts them (code points). */
export function charCount(s: string): number {
  return [...s].length;
}

export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t, i) => n + charCount(t) + (/\s/.test(t) ? 2 : 0) + (i > 0 ? 1 : 0), 0);
}

/** Tags from free text ("a, b、#c"): trimmed, without '#', de-duplicated (case-insensitive). */
export function parseTags(text: string): string[] {
  return cleanTags(text.split(/[,、\n]/));
}

function cleanTags(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const t = r.trim().replace(/^#+/, '').trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

// ---------- publish.json ----------

export type PublishTargetId = 'youtube' | 'tiktok';
export const PUBLISH_TARGETS: readonly PublishTargetId[] = ['youtube', 'tiktok'];
export const YT_PRIVACY = ['private', 'unlisted', 'public'] as const;
export const TIKTOK_PRIVACY = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'] as const;
export type YtPrivacy = (typeof YT_PRIVACY)[number];
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY)[number];

export const DEFAULT_VIDEO = 'renders/youtube/final.mp4'; // where `solocut render --final` writes
export const PUBLISH_FILE = 'publish.json';

export interface PublishSpec {
  /** Project-relative, '/' separated. */
  video: string;
  thumbnail?: string;
  title: string;
  description: string;
  tags: string[];
  youtube: {
    enabled: boolean;
    categoryId: string;
    privacy: YtPrivacy;
    /** publish.json has no (valid) youtube.privacy: the settings default was used */
    privacyDefaulted: boolean;
    publishAt?: string; // ISO, normalized
    madeForKids: boolean;
    containsSyntheticMedia: boolean;
    chapters: boolean;
    language: string;
  };
  tiktok: {
    enabled: boolean;
    caption: string;
    privacy: TikTokPrivacy;
    /** publish.json has no (valid) tiktok.privacy: the settings default was used */
    privacyDefaulted: boolean;
    allowComment: boolean;
    allowDuet: boolean;
    allowStitch: boolean;
    isAigc: boolean;
  };
}

export interface PublishIssue {
  /** error: blocks the upload of the targets it concerns. warning: shown, a default was used. */
  level: 'error' | 'warning';
  /** dotted path in publish.json ("$" for the whole file). */
  field: string;
  code: string;
  /** extra detail (a limit, the bad value) */
  detail?: string;
}

/** Settings `publish.youtube.privacy` / `publish.tiktok.privacy`: used when publish.json does not say. */
export interface PublishDefaults {
  youtubePrivacy: YtPrivacy;
  tiktokPrivacy: TikTokPrivacy;
}
export const BUILTIN_DEFAULTS: PublishDefaults = { youtubePrivacy: 'private', tiktokPrivacy: 'SELF_ONLY' };

/** The defaults from a settings object (~/.solocut/settings.json); invalid values fall back to the safe ones. */
export function publishDefaultsFrom(settings: unknown): PublishDefaults {
  const pub = isObj(settings) && isObj(settings.publish) ? settings.publish : {};
  const yt = isObj(pub.youtube) ? pub.youtube.privacy : undefined;
  const tt = isObj(pub.tiktok) ? pub.tiktok.privacy : undefined;
  return {
    youtubePrivacy: typeof yt === 'string' && (YT_PRIVACY as readonly string[]).includes(yt) ? (yt as YtPrivacy) : BUILTIN_DEFAULTS.youtubePrivacy,
    tiktokPrivacy: typeof tt === 'string' && (TIKTOK_PRIVACY as readonly string[]).includes(tt) ? (tt as TikTokPrivacy) : BUILTIN_DEFAULTS.tiktokPrivacy,
  };
}

export interface ParsedPublish {
  spec: PublishSpec | null;
  issues: PublishIssue[];
}

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A project-relative path that stays inside the project; null when it escapes or is empty. */
export function safeRelPath(p: string): string | null {
  const s = p.trim().replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('\0')) return null;
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

const KNOWN_TOP = new Set(['video', 'thumbnail', 'title', 'description', 'tags', 'youtube', 'tiktok', '$schema', 'notes']);
const KNOWN_YT = new Set(['enabled', 'categoryId', 'privacy', 'publishAt', 'madeForKids', 'containsSyntheticMedia', 'chapters', 'language']);
const KNOWN_TT = new Set(['enabled', 'caption', 'privacy', 'allowComment', 'allowDuet', 'allowStitch', 'isAigc']);

/**
 * Reads publish.json (text or an already parsed value). Never throws: unusable values fall back to safe defaults
 * (private, not for kids, TikTok off) with a warning; values a platform would reject are errors.
 */
export function parsePublishJson(input: unknown, now = new Date(), defaults: PublishDefaults = BUILTIN_DEFAULTS): ParsedPublish {
  const issues: PublishIssue[] = [];
  const err = (field: string, code: string, detail?: string) => issues.push({ level: 'error', field, code, ...(detail !== undefined ? { detail } : {}) });
  const warn = (field: string, code: string, detail?: string) => issues.push({ level: 'warning', field, code, ...(detail !== undefined ? { detail } : {}) });

  let raw: unknown = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '');
    if (!text.trim()) return { spec: null, issues: [{ level: 'error', field: '$', code: 'empty' }] };
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { spec: null, issues: [{ level: 'error', field: '$', code: 'invalid-json', detail: e instanceof Error ? e.message : String(e) }] };
    }
  }
  if (!isObj(raw)) return { spec: null, issues: [{ level: 'error', field: '$', code: 'not-object' }] };
  for (const k of Object.keys(raw)) if (!KNOWN_TOP.has(k)) warn(k, 'unknown-field');

  const str = (v: unknown, field: string, fallback: string): string => {
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') {
      warn(field, 'coerced');
      return String(v);
    }
    warn(field, 'wrong-type');
    return fallback;
  };
  const bool = (v: unknown, field: string, fallback: boolean): boolean => {
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'false') {
      warn(field, 'coerced');
      return v === 'true';
    }
    warn(field, 'wrong-type');
    return fallback;
  };

  // files
  let video = DEFAULT_VIDEO;
  if (raw.video === undefined) warn('video', 'default', DEFAULT_VIDEO);
  else if (typeof raw.video !== 'string' || !safeRelPath(raw.video)) err('video', 'bad-path', String(raw.video));
  else video = safeRelPath(raw.video)!;
  if (!/\.(mp4|mov|webm|m4v)$/i.test(video)) warn('video', 'not-video', video);

  let thumbnail: string | undefined;
  if (raw.thumbnail !== undefined && raw.thumbnail !== null && raw.thumbnail !== '') {
    const rel = typeof raw.thumbnail === 'string' ? safeRelPath(raw.thumbnail) : null;
    if (!rel) warn('thumbnail', 'bad-path', String(raw.thumbnail));
    else if (!/\.(png|jpe?g)$/i.test(rel)) warn('thumbnail', 'not-image', rel);
    else thumbnail = rel;
  }

  // shared text
  const title = str(raw.title, 'title', '').trim();
  const description = str(raw.description, 'description', '').replace(/\r\n/g, '\n');
  let tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    if (raw.tags.some((t) => typeof t !== 'string')) warn('tags', 'wrong-type');
    tags = cleanTags(raw.tags);
  } else if (typeof raw.tags === 'string') {
    warn('tags', 'coerced');
    tags = parseTags(raw.tags);
  } else if (raw.tags !== undefined && raw.tags !== null) warn('tags', 'wrong-type');

  // YouTube
  const yt = raw.youtube === undefined || raw.youtube === null ? {} : isObj(raw.youtube) ? raw.youtube : (warn('youtube', 'wrong-type'), {});
  for (const k of Object.keys(yt)) if (!KNOWN_YT.has(k)) warn(`youtube.${k}`, 'unknown-field');
  const ytEnabled = bool(yt.enabled, 'youtube.enabled', true);
  let categoryId = str(yt.categoryId, 'youtube.categoryId', '28').trim();
  if (!/^\d{1,3}$/.test(categoryId)) {
    warn('youtube.categoryId', 'invalid', categoryId);
    categoryId = '28';
  }
  let privacy: YtPrivacy = defaults.youtubePrivacy;
  let privacyDefaulted = true;
  if (yt.privacy === undefined || yt.privacy === null) {
    if (ytEnabled) warn('youtube.privacy', 'default', privacy);
  } else if (typeof yt.privacy === 'string' && (YT_PRIVACY as readonly string[]).includes(yt.privacy.toLowerCase())) {
    privacy = yt.privacy.toLowerCase() as YtPrivacy;
    privacyDefaulted = false;
  } else warn('youtube.privacy', 'invalid', String(yt.privacy));
  let publishAt: string | undefined;
  if (yt.publishAt !== undefined && yt.publishAt !== null && yt.publishAt !== '') {
    const t = typeof yt.publishAt === 'string' ? Date.parse(yt.publishAt) : NaN;
    if (Number.isNaN(t)) err('youtube.publishAt', 'invalid', String(yt.publishAt));
    else if (t <= now.getTime()) err('youtube.publishAt', 'past', new Date(t).toISOString());
    else {
      publishAt = new Date(t).toISOString();
      if (privacy !== 'private') warn('youtube.privacy', 'scheduled-private', privacy);
      privacy = 'private'; // YouTube schedules only private videos
    }
  }
  const language = str(yt.language, 'youtube.language', 'ja').trim() || 'ja';

  if (ytEnabled) {
    if (!title) err('title', 'required');
    if (charCount(title) > YT_TITLE_MAX) err('title', 'too-long', `${charCount(title)}/${YT_TITLE_MAX}`);
    if (/[<>]/.test(title)) err('title', 'angle-brackets');
    if (utf8Bytes(description) > YT_DESCRIPTION_MAX_BYTES) err('description', 'too-long', `${utf8Bytes(description)}/${YT_DESCRIPTION_MAX_BYTES}`);
    if (/[<>]/.test(description)) err('description', 'angle-brackets');
    if (tagsLength(tags) > YT_TAGS_MAX) err('tags', 'too-long', `${tagsLength(tags)}/${YT_TAGS_MAX}`);
    if (tags.some((t) => /[<>]/.test(t))) err('tags', 'angle-brackets');
  }

  // TikTok
  const tt = raw.tiktok === undefined || raw.tiktok === null ? {} : isObj(raw.tiktok) ? raw.tiktok : (warn('tiktok', 'wrong-type'), {});
  for (const k of Object.keys(tt)) if (!KNOWN_TT.has(k)) warn(`tiktok.${k}`, 'unknown-field');
  const ttEnabled = bool(tt.enabled, 'tiktok.enabled', false);
  let caption = str(tt.caption, 'tiktok.caption', '');
  if (!caption.trim() && ttEnabled) {
    caption = [title, tags.map((t) => `#${t.replace(/\s+/g, '')}`).join(' ')].filter(Boolean).join('\n');
    warn('tiktok.caption', 'default');
  }
  let ttPrivacy: TikTokPrivacy = defaults.tiktokPrivacy;
  let ttDefaulted = true;
  if (tt.privacy !== undefined && tt.privacy !== null) {
    if (typeof tt.privacy === 'string' && (TIKTOK_PRIVACY as readonly string[]).includes(tt.privacy.toUpperCase())) {
      ttPrivacy = tt.privacy.toUpperCase() as TikTokPrivacy;
      ttDefaulted = false;
    } else warn('tiktok.privacy', 'invalid', String(tt.privacy));
  }
  if (ttEnabled && caption.length > TIKTOK_CAPTION_MAX) err('tiktok.caption', 'too-long', `${caption.length}/${TIKTOK_CAPTION_MAX}`);
  if (!ytEnabled && !ttEnabled) warn('$', 'no-target');

  const spec: PublishSpec = {
    video,
    ...(thumbnail ? { thumbnail } : {}),
    title,
    description,
    tags,
    youtube: {
      enabled: ytEnabled,
      categoryId,
      privacy,
      privacyDefaulted,
      ...(publishAt ? { publishAt } : {}),
      madeForKids: bool(yt.madeForKids, 'youtube.madeForKids', false),
      containsSyntheticMedia: bool(yt.containsSyntheticMedia, 'youtube.containsSyntheticMedia', false),
      chapters: bool(yt.chapters, 'youtube.chapters', true),
      language,
    },
    tiktok: {
      enabled: ttEnabled,
      caption,
      privacy: ttPrivacy,
      privacyDefaulted: ttDefaulted,
      allowComment: bool(tt.allowComment, 'tiktok.allowComment', false),
      allowDuet: bool(tt.allowDuet, 'tiktok.allowDuet', false),
      allowStitch: bool(tt.allowStitch, 'tiktok.allowStitch', false),
      isAigc: bool(tt.isAigc, 'tiktok.isAigc', false),
    },
  };
  return { spec, issues };
}

/** Which issue fields block which target. Path/file problems block every target. */
export function issueBlocks(issue: PublishIssue, target: PublishTargetId): boolean {
  if (issue.level !== 'error') return false;
  if (issue.field === '$' || issue.field === 'video') return true;
  if (issue.field.startsWith('tiktok.')) return target === 'tiktok';
  return target === 'youtube'; // title / description / tags / youtube.*
}

/** Targets publish.json turns on, or the requested ones (only those publish.json does not turn off). */
export function targetsToUpload(spec: PublishSpec, requested: readonly PublishTargetId[] = []): PublishTargetId[] {
  const on = PUBLISH_TARGETS.filter((t) => spec[t].enabled);
  return requested.length ? on.filter((t) => requested.includes(t)) : on;
}

/** The same spec with the thumbnail replaced, as the object to write back (keeps unknown fields of the original). */
export function withThumbnail(original: unknown, rel: string | null): Dict {
  const base: Dict = isObj(original) ? { ...original } : {};
  if (rel) base.thumbnail = rel;
  else delete base.thumbnail;
  return base;
}

/** publish.json with one target's privacy set (keeps unknown fields); null when the value is not valid. */
export function withPrivacy(original: unknown, target: PublishTargetId, value: string): Dict | null {
  const ok = target === 'youtube' ? (YT_PRIVACY as readonly string[]).includes(value) : (TIKTOK_PRIVACY as readonly string[]).includes(value);
  if (!ok) return null;
  const base: Dict = isObj(original) ? { ...original } : {};
  base[target] = { ...(isObj(base[target]) ? (base[target] as Dict) : {}), privacy: value };
  return base;
}

/** videos.insert resource (part=snippet,status). Scheduling requires privacyStatus private + publishAt. */
export function youtubeVideoResource(s: PublishSpec): Record<string, unknown> {
  const status: Record<string, unknown> = {
    privacyStatus: s.youtube.publishAt ? 'private' : s.youtube.privacy,
    selfDeclaredMadeForKids: s.youtube.madeForKids,
    containsSyntheticMedia: s.youtube.containsSyntheticMedia,
  };
  if (s.youtube.publishAt) status.publishAt = s.youtube.publishAt;
  return {
    snippet: {
      title: s.title,
      description: s.description,
      tags: s.tags,
      categoryId: s.youtube.categoryId,
      defaultLanguage: s.youtube.language,
      defaultAudioLanguage: s.youtube.language,
    },
    status,
  };
}

const ISSUE_TEXT: Record<string, { ja: string; en: string }> = {
  empty: { ja: 'ファイルが空です', en: 'The file is empty' },
  'invalid-json': { ja: 'JSON として読めません', en: 'Not valid JSON' },
  'not-object': { ja: '{ … } の形ではありません', en: 'Not a JSON object' },
  'unknown-field': { ja: '知らない項目です（無視します）', en: 'Unknown field (ignored)' },
  coerced: { ja: '型が違うので変換しました', en: 'Wrong type; converted' },
  'wrong-type': { ja: '型が違うので無視しました', en: 'Wrong type; ignored' },
  default: { ja: '書かれていないので既定値を使います', en: 'Missing; using the default' },
  'bad-path': { ja: 'プロジェクトの中のファイルを相対パスで指定してください', en: 'Use a path relative to the project, inside it' },
  'not-video': { ja: '動画ファイル（.mp4 など）ではありません', en: 'Not a video file (.mp4 …)' },
  'not-image': { ja: 'PNG か JPEG を指定してください', en: 'Use a PNG or JPEG' },
  required: { ja: '必須です', en: 'Required' },
  'too-long': { ja: '長すぎます', en: 'Too long' },
  'angle-brackets': { ja: '< と > は使えません', en: '< and > are not allowed' },
  invalid: { ja: '値が正しくありません', en: 'Invalid value' },
  past: { ja: '予約日時が過ぎています', en: 'The scheduled time has passed' },
  'scheduled-private': { ja: '予約投稿は「非公開」で上げ、指定日時に公開されます', en: 'Scheduled videos are uploaded private and go public at the set time' },
  'no-target': { ja: 'YouTube も TikTok もオフです', en: 'Both YouTube and TikTok are off' },
  missing: { ja: 'ファイルがありません', en: 'File not found' },
};

export function issueText(i: PublishIssue, lang: 'ja' | 'en' = 'ja'): string {
  const m = ISSUE_TEXT[i.code]?.[lang] ?? i.code;
  return `${i.field === '$' ? 'publish.json' : i.field}: ${m}${i.detail ? ` (${i.detail})` : ''}`;
}

// ---------- upload hand-off (CLI ⇄ app) ----------

export const REQUEST_FILE = '.solocut/publish-request.json';
export const RESULT_FILE = '.solocut/publish-result.json';
export const PUBLISH_LOG_FILE = '.solocut/publish-log.json';
/** A request the app has not picked up within this time is ignored (the CLI gave up long ago). */
export const REQUEST_TTL_MS = 10 * 60_000;

export interface PublishRequest {
  id: string;
  /** Empty: every target publish.json turns on. */
  targets: PublishTargetId[];
  at: string;
  /** Upload again even when this video was already published to the target. */
  force?: boolean;
}

export interface PublishTargetResult {
  target: PublishTargetId;
  ok: boolean;
  url?: string;
  error?: string;
  /** youtube: published | scheduled; tiktok: inbox (draft in the TikTok app) | published */
  status?: 'published' | 'scheduled' | 'inbox' | 'skipped';
  /** Not uploaded again: publish-log.json says this video is already there. */
  alreadyPublished?: boolean;
  warnings?: string[];
}

export interface PublishResult {
  id: string;
  /** running: the app picked the request up (progress follows); done: results are final. */
  state: 'running' | 'done';
  at: string;
  progress?: { target: PublishTargetId; phase: string; fraction?: number };
  results: PublishTargetResult[];
  /** why nothing was uploaded (no publish.json, no target turned on, …) */
  error?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

function parseJsonish(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function parsePublishRequest(input: unknown): PublishRequest | null {
  const o = parseJsonish(input);
  if (!isObj(o) || !isRequestId(o.id)) return null;
  const targets = Array.isArray(o.targets) ? [...new Set(o.targets.filter((t): t is PublishTargetId => (PUBLISH_TARGETS as readonly unknown[]).includes(t)))] : [];
  if (Array.isArray(o.targets) && o.targets.length > 0 && targets.length === 0) return null; // only unknown targets
  const at = typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? o.at : '';
  if (!at) return null;
  return { id: o.id, targets, at, ...(o.force === true ? { force: true } : {}) };
}

export function parsePublishResult(input: unknown): PublishResult | null {
  const o = parseJsonish(input);
  if (!isObj(o) || !isRequestId(o.id)) return null;
  const results: PublishTargetResult[] = [];
  for (const r of Array.isArray(o.results) ? o.results : []) {
    if (!isObj(r) || !(PUBLISH_TARGETS as readonly unknown[]).includes(r.target) || typeof r.ok !== 'boolean') continue;
    const x: PublishTargetResult = { target: r.target as PublishTargetId, ok: r.ok };
    if (typeof r.url === 'string') x.url = r.url;
    if (typeof r.error === 'string') x.error = r.error;
    if (r.status === 'published' || r.status === 'scheduled' || r.status === 'inbox' || r.status === 'skipped') x.status = r.status;
    if (r.alreadyPublished === true) x.alreadyPublished = true;
    if (Array.isArray(r.warnings)) x.warnings = r.warnings.filter((w): w is string => typeof w === 'string');
    results.push(x);
  }
  const state = o.state === 'running' ? 'running' : 'done'; // a result without state (SPEC's minimal shape) is final
  const out: PublishResult = { id: o.id, state, at: typeof o.at === 'string' ? o.at : '', results };
  if (typeof o.error === 'string' && o.error) out.error = o.error;
  if (isObj(o.progress) && (PUBLISH_TARGETS as readonly unknown[]).includes(o.progress.target)) {
    const p = o.progress;
    out.progress = { target: p.target as PublishTargetId, phase: typeof p.phase === 'string' ? p.phase : '', ...(typeof p.fraction === 'number' && Number.isFinite(p.fraction) ? { fraction: Math.max(0, Math.min(1, p.fraction)) } : {}) };
  }
  return out;
}

export function requestIsStale(req: PublishRequest, nowMs: number): boolean {
  const t = Date.parse(req.at);
  return Number.isNaN(t) || nowMs - t > REQUEST_TTL_MS;
}

/** Overall outcome: every target ok (an empty result is a failure: nothing was posted). */
export function resultOk(r: PublishResult): boolean {
  return r.state === 'done' && r.results.length > 0 && r.results.every((x) => x.ok);
}

// ---------- publish log (double-upload guard) ----------

export interface PublishLogEntry {
  target: PublishTargetId;
  video: string; // project-relative
  size: number;
  url?: string;
  status: PublishTargetResult['status'];
  requestId: string;
  at: string;
}

export function parsePublishLog(input: unknown): PublishLogEntry[] {
  const o = parseJsonish(input);
  const arr = isObj(o) && Array.isArray(o.entries) ? o.entries : [];
  return arr.filter(
    (e): e is PublishLogEntry =>
      isObj(e) && (PUBLISH_TARGETS as readonly unknown[]).includes(e.target) && typeof e.video === 'string' && typeof e.size === 'number' && typeof e.requestId === 'string',
  );
}

/** The earlier upload of this exact file (path and size) to the target, if any. */
export function alreadyPublished(log: readonly PublishLogEntry[], target: PublishTargetId, video: string, size: number): PublishLogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.target === target && e.video === video && e.size === size) return e;
  }
  return null;
}

// ---------- resumable upload ----------

/** Next byte to send after a 308 from a resumable upload ("Range: bytes=0-12345"); 0 if none received. */
export function nextOffsetFromRange(range: string | null | undefined): number {
  const m = /bytes=0-(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/** Chunk size for resumable uploads: a multiple of 256 KiB. */
export const UPLOAD_CHUNK = 8 * 1024 * 1024;

export const TIKTOK_UPLOAD_PAGE = 'https://www.tiktok.com/tiktokstudio/upload';

// ---------- library ----------

/** `solocut lib install <name>` name for a toolchain tool. */
export function libNameFor(tool: string): string | null {
  if (tool === 'ffmpeg' || tool === 'ffprobe') return 'ffmpeg';
  if (tool === 'whisper-cli' || tool === 'whisper-model') return 'whisper';
  if (tool === 'whisper-model-small') return 'whisper-small';
  return null;
}

/** Progress from a CLI output line: NDJSON {progress:{received,total}} or any "NN%" text. */
export function parseProgress(line: string): number | null {
  const t = line.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { progress?: { received?: number; total?: number; fraction?: number } };
      const p = o.progress;
      if (p) {
        if (typeof p.fraction === 'number') return Math.max(0, Math.min(1, p.fraction));
        if (typeof p.received === 'number' && typeof p.total === 'number' && p.total > 0) return Math.max(0, Math.min(1, p.received / p.total));
      }
    } catch {
      /* not JSON */
    }
  }
  const m = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(t);
  if (m) {
    const v = Number(m[1]);
    if (v >= 0 && v <= 100) return v / 100;
  }
  return null;
}

// ---------- screen / accounts (IPC shapes) ----------

export interface PublishView {
  /** publish.json exists */
  exists: boolean;
  spec: PublishSpec | null;
  issues: PublishIssue[];
  /** absolute paths, when the files exist */
  videoPath?: string;
  thumbnailPath?: string;
  request: PublishRequest | null;
  result: PublishResult | null;
  log: PublishLogEntry[];
  /** this exact video (path + size) is already on the target */
  published: Partial<Record<PublishTargetId, PublishLogEntry>>;
}

export interface PublishAccount {
  /** a client id / key is built in (or set for development) */
  configured: boolean;
  connected: boolean;
  /** channel / display name */
  name?: string;
  /** tiktok: posts go straight to the profile (else to the TikTok app's inbox as a draft) */
  directPost?: boolean;
}
export type PublishAccounts = Record<PublishTargetId, PublishAccount>;

export interface ThumbFile {
  path: string; // absolute
  rel: string; // project-relative
  mtimeMs: number;
}

// ---------- the "OK・投稿する" button ----------

export type OkState =
  | { kind: 'ready'; targets: PublishTargetId[] }
  | { kind: 'no-file' }
  | { kind: 'no-video' }
  | { kind: 'no-target' }
  | { kind: 'connect'; target: PublishTargetId }
  | { kind: 'sent' }
  | { kind: 'running' }
  | { kind: 'published' };

/** How long after pressing OK the button waits for the agent to start the upload. */
export const SENT_HOLD_MS = 3 * 60_000;

/**
 * What the OK button does now. Issues in publish.json do not block it: the publish prompt asks the agent to fix
 * them before uploading. A target that is already published with this exact file is not posted again.
 */
export function okState(view: PublishView | null, accounts: PublishAccounts | null, sentAt: number | null, nowMs: number): OkState {
  if (!view || !view.exists || !view.spec) return { kind: 'no-file' };
  if (view.result && view.result.state === 'running' && (!view.request || view.request.id === view.result.id) && nowMs - (Date.parse(view.result.at) || 0) < 30 * 60_000) return { kind: 'running' };
  if (sentAt !== null && nowMs - sentAt < SENT_HOLD_MS) return { kind: 'sent' };
  if (!view.videoPath) return { kind: 'no-video' };
  const on = PUBLISH_TARGETS.filter((t) => view.spec![t].enabled);
  if (!on.length) return { kind: 'no-target' };
  const todo = on.filter((t) => !view.published[t]);
  if (!todo.length) return { kind: 'published' };
  if (todo.includes('youtube') && accounts && !accounts.youtube.connected) return { kind: 'connect', target: 'youtube' };
  if (todo.includes('tiktok') && accounts && accounts.tiktok.configured && !accounts.tiktok.connected) return { kind: 'connect', target: 'tiktok' };
  return { kind: 'ready', targets: todo };
}

/** The short request the "AI に直してもらう" button sends. */
export function fixRequestText(input: string): string {
  const t = input.trim().replace(/\s+/g, ' ').slice(0, 500);
  return t ? `publish.json を「${t}」に直して` : 'publish.json を見直して、問題があれば直して';
}
