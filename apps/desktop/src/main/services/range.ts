// HTTP Range parsing for the solocut-media:// protocol (single ranges only; that is all <video> sends).

export type RangeResult = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'invalid' };

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: 'full' }; // multi-range or unknown units: ignore Range, send the whole file
  const [, a, b] = m;
  if (size <= 0) return { kind: 'invalid' };
  if (a === '' && b === '') return { kind: 'invalid' };
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return { kind: 'invalid' };
  return { kind: 'partial', start, end };
}

const TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  wasm: 'application/wasm', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', md: 'text/markdown; charset=utf-8', srt: 'text/plain; charset=utf-8', vtt: 'text/vtt',
};

export function contentTypeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}
