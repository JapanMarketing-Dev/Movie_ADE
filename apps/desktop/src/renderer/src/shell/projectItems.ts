// Parsing of `solocut takes --json` and `solocut feedback list --json` for the sidebar. Defensive: the CLI output
// is JSON from another process, so anything unexpected is dropped instead of crashing the sidebar. Unit-tested.

export interface TakeEntry {
  id: string;
  files: string[];
  /** take.json says the recording finished; null when unknown */
  complete: boolean | null;
  markers: number;
  /** registered as timeline sources by `solocut ingest` */
  ingested: boolean;
}

export interface FeedbackEntry {
  id: string;
  status: 'open' | 'done';
  items: number;
  path: string;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseTakes(data: unknown): TakeEntry[] {
  const list = obj(data)?.takes;
  if (!Array.isArray(list)) return [];
  const out: TakeEntry[] = [];
  for (const x of list) {
    const o = obj(x);
    if (!o || typeof o.id !== 'string' || !o.id) continue;
    out.push({
      id: o.id,
      files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string') : [],
      complete: typeof o.complete === 'boolean' ? o.complete : null,
      markers: typeof o.markers === 'number' && Number.isFinite(o.markers) ? Math.max(0, Math.floor(o.markers)) : 0,
      ingested: o.ingested === true,
    });
  }
  // newest first: take ids are time-based (t-YYYYMMDD-HHMMSS…), so a reverse string sort is chronological
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export function parseFeedbackList(data: unknown): FeedbackEntry[] {
  const list = obj(data)?.feedback;
  if (!Array.isArray(list)) return [];
  const out: FeedbackEntry[] = [];
  for (const x of list) {
    const o = obj(x);
    if (!o || typeof o.id !== 'string' || !o.id) continue;
    out.push({
      id: o.id,
      status: o.status === 'open' ? 'open' : 'done',
      items: typeof o.items === 'number' && Number.isFinite(o.items) ? Math.max(0, Math.floor(o.items)) : Array.isArray(o.items) ? o.items.length : 0,
      path: typeof o.path === 'string' ? o.path : '',
    });
  }
  return out.sort((a, b) => (a.status === b.status ? b.id.localeCompare(a.id) : a.status === 'open' ? -1 : 1));
}
