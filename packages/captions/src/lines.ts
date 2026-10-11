import { loadDefaultJapaneseParser } from 'budoux';

type Parser = ReturnType<typeof loadDefaultJapaneseParser>;
let parser: Parser | null = null;

/** Display length used for line limits (code points). */
export function charLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** BudouX phrases (Japanese). Concatenating them gives back the input. */
export function phrases(text: string): string[] {
  if (text === '') return [];
  parser ??= loadDefaultJapaneseParser();
  return parser.parse(text);
}

function hardSplit(s: string, max: number): string[] {
  const chars = [...s];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
  return out;
}

/** Atoms that lines may break between: BudouX phrases (ja) or space-separated words (en). Over-long atoms are split. */
export function breakAtoms(text: string, language: 'ja' | 'en', maxChars: number): string[] {
  const raw = language === 'ja' ? phrases(text) : text.split(/(?<=\s)/).filter((w) => w !== '');
  const atoms: string[] = [];
  for (const a of raw) {
    if (charLen(a.trimEnd()) > maxChars) atoms.push(...hardSplit(a, maxChars));
    else atoms.push(a);
  }
  return atoms;
}

/**
 * Break text into lines of at most `maxChars` without splitting a phrase (unless the phrase itself is longer than a
 * line). Uses the fewest lines possible, then balances their lengths.
 */
export function layoutLines(text: string, maxChars: number, language: 'ja' | 'en'): string[] {
  if (!(maxChars >= 1)) throw new RangeError('maxChars must be >= 1');
  const t = text.trim();
  if (t === '') return [];
  const atoms = breakAtoms(t, language, maxChars);
  const n = atoms.length;
  const len = (i: number, j: number) => charLen(atoms.slice(i, j).join('').trim());
  // Fewest lines: greedy is optimal for line count.
  let count = 0;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && len(i, j + 1) <= maxChars) j++;
    count++;
    i = j;
  }
  // DP: split into exactly `count` lines minimizing the sum of squared slack (balanced lines).
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(INF));
  const back: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
  cost[0]![0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let j = 1; j <= n; j++) {
      for (let i = j - 1; i >= 0; i--) {
        const l = len(i, j);
        if (l > maxChars) break;
        const prev = cost[k - 1]![i]!;
        if (prev === INF) continue;
        const c = prev + (maxChars - l) ** 2;
        if (c < cost[k]![j]!) {
          cost[k]![j] = c;
          back[k]![j] = i;
        }
      }
    }
  }
  if (cost[count]![n] === INF) {
    // Should not happen (atoms ≤ maxChars), fall back to greedy.
    return hardSplit(t, maxChars);
  }
  const lines: string[] = [];
  for (let k = count, j = n; k > 0; k--) {
    const i = back[k]![j]!;
    lines.unshift(atoms.slice(i, j).join('').trim());
    j = i;
  }
  return lines;
}
