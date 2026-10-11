// Pure publishing helpers (docs/14): YouTube form validation and request bodies, SNS Web Intent URLs and
// X's weighted character count. Shared by the renderer (live validation) and main (upload).
import type { YouTubeForm } from './types';

export const YT_TITLE_MAX = 100; // characters
export const YT_DESCRIPTION_MAX_BYTES = 5000;
export const YT_TAGS_MAX = 500; // characters, counted like YouTube (tags with spaces count their quotes)

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

export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,、\n]/)) {
    const t = raw.trim().replace(/^#/, '');
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

export type YtIssue = { field: keyof YouTubeForm | 'approve'; code: string };

/** Problems that block an upload. An empty list means the form can be submitted. */
export function validateYouTube(f: YouTubeForm, now = new Date()): YtIssue[] {
  const issues: YtIssue[] = [];
  if (!f.videoPath) issues.push({ field: 'videoPath', code: 'required' });
  const title = f.title.trim();
  if (!title) issues.push({ field: 'title', code: 'required' });
  if (charCount(f.title) > YT_TITLE_MAX) issues.push({ field: 'title', code: 'too-long' });
  if (/[<>]/.test(f.title)) issues.push({ field: 'title', code: 'angle-brackets' });
  if (utf8Bytes(f.description) > YT_DESCRIPTION_MAX_BYTES) issues.push({ field: 'description', code: 'too-long' });
  if (/[<>]/.test(f.description)) issues.push({ field: 'description', code: 'angle-brackets' });
  if (tagsLength(f.tags) > YT_TAGS_MAX) issues.push({ field: 'tags', code: 'too-long' });
  if (f.madeForKids === null) issues.push({ field: 'madeForKids', code: 'required' });
  if (f.publishAt) {
    const t = Date.parse(f.publishAt);
    if (Number.isNaN(t)) issues.push({ field: 'publishAt', code: 'invalid' });
    else if (t <= now.getTime()) issues.push({ field: 'publishAt', code: 'past' });
  }
  return issues;
}

/** videos.insert resource (part=snippet,status). Scheduling requires privacyStatus private + publishAt. */
export function youtubeVideoResource(f: YouTubeForm): Record<string, unknown> {
  const status: Record<string, unknown> = {
    privacyStatus: f.publishAt ? 'private' : f.privacy,
    selfDeclaredMadeForKids: f.madeForKids === true,
    containsSyntheticMedia: f.containsSyntheticMedia,
  };
  if (f.publishAt) status.publishAt = new Date(f.publishAt).toISOString();
  return {
    snippet: {
      title: f.title.trim(),
      description: f.description,
      tags: f.tags,
      categoryId: f.categoryId || '28',
      defaultLanguage: f.language,
      defaultAudioLanguage: f.language,
    },
    status,
  };
}

/** Next byte to send after a 308 from a resumable upload ("Range: bytes=0-12345"); 0 if none received. */
export function nextOffsetFromRange(range: string | null | undefined): number {
  const m = /bytes=0-(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/** Chunk size for resumable uploads: a multiple of 256 KiB. */
export const UPLOAD_CHUNK = 8 * 1024 * 1024;

// ---------- announce ----------

export type AnnouncePlatform = 'x' | 'threads' | 'facebook';

/**
 * X counts most CJK and emoji as 2 and every URL as 23 (twitter-text weighting, simplified: code points in the
 * Latin-1 / general punctuation ranges count 1, everything else 2).
 */
export function xWeightedLength(text: string): number {
  const urlRe = /https?:\/\/[^\s]+/g;
  let n = 0;
  const withoutUrls = text.replace(urlRe, () => {
    n += 23;
    return '';
  });
  for (const ch of withoutUrls) {
    const c = ch.codePointAt(0)!;
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

export const ANNOUNCE_LIMITS: Record<AnnouncePlatform, number> = { x: 280, threads: 500, facebook: 63206 };

export function announceLength(p: AnnouncePlatform, text: string, url: string): number {
  if (p === 'x') return xWeightedLength(url ? `${text} ${url}` : text);
  return charCount(url ? `${text}\n${url}` : text);
}

/** Web Intent URL that opens the platform's composer with the text (the person presses Post). */
export function intentUrl(p: AnnouncePlatform, text: string, url: string): string {
  const e = encodeURIComponent;
  switch (p) {
    case 'x':
      return `https://x.com/intent/post?text=${e(text)}${url ? `&url=${e(url)}` : ''}`;
    case 'threads':
      return `https://www.threads.com/intent/post?text=${e(url ? `${text}\n${url}` : text)}`;
    case 'facebook':
      // the share dialog only takes the link; the text is shown in the app for copy and paste
      return `https://www.facebook.com/sharer/sharer.php?u=${e(url)}`;
  }
}

export const UPLOAD_PAGES = {
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  instagram: 'https://www.instagram.com/',
} as const;

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
