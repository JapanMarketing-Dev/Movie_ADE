// Removes file paths and the home directory from crash reports (docs/07: no paths, media or transcripts).

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces the home dir with "~" and any remaining absolute path with "<path>/<basename>". */
export function scrubString(s: string, homeDir: string): string {
  let out = s;
  if (homeDir && homeDir.length > 1) {
    out = out.replace(new RegExp(escapeRe(homeDir), 'g'), '~');
    out = out.replace(new RegExp(escapeRe(homeDir.replace(/\\/g, '/')), 'g'), '~');
  }
  // Windows drive paths and POSIX paths with at least two segments (keep app-internal names readable)
  out = out.replace(/[A-Za-z]:[\\/](?:[^\\/\s:"'<>|]+[\\/])+([^\\/\s:"'<>|]+)/g, '<path>/$1');
  out = out.replace(/(^|[\s"'(=])(?:~|\/(?:Users|home|Volumes|private|tmp|var|mnt|media))(?:\/[^/\s"')]+)+\/([^/\s"')]+)/g, '$1<path>/$2');
  return out;
}

/** Deep-scrubs every string in a JSON-like value (events, breadcrumbs). Limits depth to stay cheap. */
export function scrubDeep<T>(v: T, homeDir: string, depth = 0): T {
  if (depth > 12) return v;
  if (typeof v === 'string') return scrubString(v, homeDir) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, homeDir, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrubDeep(x, homeDir, depth + 1);
    return out as T;
  }
  return v;
}
