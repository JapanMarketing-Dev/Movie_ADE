// Fuzzy matching for the quick open / command palette and the sidebar project search. Pure, unit-tested.
// Scoring follows the Orca quick-open idea (Orca由来: ~/bench/orca/src/renderer/src/components/quick-open-file-list.ts、MIT,
// Ferret 経由): consecutive and word-start hits score higher; every query character must appear in order.

/** Fold width / case so 全角 and half-width, upper and lower case match each other. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

/**
 * Score `text` for `query` (higher is better), or null when not every character of the query appears in order.
 * An empty query scores 0 for everything.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalize(query).replace(/\s+/g, '');
  if (!q) return 0;
  const t = normalize(text);
  // whole substring: best
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub * 2 - (t.length - q.length) * 0.1 + (sub === 0 || /[\s/_.-]/.test(t[sub - 1] ?? '') ? 100 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    score += at === prev + 1 ? 12 : 2;
    if (at === 0 || /[\s/_.-]/.test(t[at - 1] ?? '')) score += 8;
    prev = at;
    ti = at + 1;
  }
  return score - t.length * 0.05;
}

export interface Searchable {
  id: string;
  /** primary text */
  label: string;
  /** extra words that also match (path, keywords) */
  keywords?: string;
}

/** Rank items by the best score of label (weighted) and keywords. Keeps the input order for ties and empty queries. */
export function rankItems<T extends Searchable>(query: string, items: readonly T[], limit = 50): T[] {
  if (!normalize(query)) return items.slice(0, limit);
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const a = fuzzyScore(query, item.label);
    const b = item.keywords ? fuzzyScore(query, item.keywords) : null;
    const best = Math.max(a === null ? -Infinity : a + 50, b === null ? -Infinity : b);
    if (best > -Infinity) scored.push({ item, score: best, i });
  });
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Simple AND filter: every whitespace-separated word must be a substring of one of the fields. */
export function matchesAll(query: string, ...fields: Array<string | undefined>): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalize(fields.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}
