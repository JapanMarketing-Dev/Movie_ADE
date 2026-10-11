// Pure helpers for the restyled screens (archive stats, publish approval checklist). Unit-tested.

/** Archive stats as display rows: numbers rounded, arrays as their length, objects summarized, empty values dropped. */
export function statEntries(stats: Record<string, unknown> | null | undefined): [string, string][] {
  if (!stats) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(stats)) {
    if (v === null || v === undefined || v === '') continue;
    let s: string;
    if (typeof v === 'number') s = Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : '—';
    else if (typeof v === 'boolean') s = v ? '✓' : '—';
    else if (Array.isArray(v)) s = String(v.length);
    else if (typeof v === 'object') {
      const json = JSON.stringify(v);
      s = json.length > 60 ? `${json.slice(0, 57)}…` : json;
    } else s = String(v);
    out.push([k, s]);
  }
  return out;
}

export type PostId = 'youtube' | 'youtube-shorts' | 'tiktok';

export interface ChecklistInput {
  include: Record<PostId, boolean>;
  mainIssues: number;
  shortsIssues: number;
  tiktokFile: boolean;
  tiktokChecks: boolean;
  connected: boolean;
}

export interface CheckItem {
  id: 'anyPost' | 'account' | 'youtube' | 'youtube-shorts' | 'tiktok';
  ok: boolean;
  /** number of problems for a post (form issues), when relevant */
  issues?: number;
}

/**
 * The approval checklist of the publish screen (docs/14 PUB-3, docs/18): what must be true before "post all" can be
 * pressed. Only rows that apply are listed; posting is allowed when every row is ok.
 */
export function publishChecklist(i: ChecklistInput): CheckItem[] {
  const items: CheckItem[] = [];
  const any = i.include.youtube || i.include['youtube-shorts'] || i.include.tiktok;
  items.push({ id: 'anyPost', ok: any });
  if (i.include.youtube || i.include['youtube-shorts']) items.push({ id: 'account', ok: i.connected });
  if (i.include.youtube) items.push({ id: 'youtube', ok: i.mainIssues === 0, issues: i.mainIssues });
  if (i.include.tiktok) items.push({ id: 'tiktok', ok: i.tiktokFile && i.tiktokChecks });
  if (i.include['youtube-shorts']) items.push({ id: 'youtube-shorts', ok: i.shortsIssues === 0, issues: i.shortsIssues });
  return items;
}

export function checklistReady(items: readonly CheckItem[]): boolean {
  return items.length > 0 && items.every((x) => x.ok);
}
