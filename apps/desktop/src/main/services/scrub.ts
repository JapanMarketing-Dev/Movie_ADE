// Removes file paths, the home directory, URLs, emails, IPs and API keys from crash reports (docs/07: no paths,
// media or transcripts). The rules live in src/shared/telemetry.ts (ported from Ferret); these two helpers keep the
// older (string, homeDir) shape.
import { scrubString as scrubText } from '../../shared/telemetry';

/** Scrubs one string. Not truncated (the caller decides); see scrubText for the rules. */
export function scrubString(s: string, homeDir: string): string {
  return scrubText(s, { homeDir }, Number.MAX_SAFE_INTEGER);
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
