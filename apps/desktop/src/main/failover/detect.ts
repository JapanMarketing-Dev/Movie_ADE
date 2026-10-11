// Detecting that an agent hit its usage limit (pure part).
//
// Ported from Ferret src/main/failover/detect.ts (MIT), combined with @solocut/agents `detectUsageLimit` (the
// catalog's per-agent limitPatterns), so agents added to the catalog are covered too.
//
// 1. The limit message in the agent's terminal output. Real wording of each CLI (checked against official issues
//    and docs, 2026-10):
//    - Claude Code: "5-hour limit reached ∙ resets 3pm", "You've hit your session limit · resets 3:45pm",
//      "You've hit your weekly limit · resets Mon 12:00am", "Claude usage limit reached. Your limit will reset at 3pm",
//      "Usage limit reached · continuing automatically at 3:45pm · esc to cancel", "Claude AI usage limit reached|1760000000"
//    - Codex: "You've hit your usage limit. Upgrade to Pro (…) or try again in 3 hours 2 minutes."
//      "You've hit your usage limit. To get more access now, send a request to your admin or try again at …"
//    - Gemini CLI etc.: "Quota exceeded for quota metric …", "RESOURCE_EXHAUSTED", "usage limit reached"
// 2. Fetched usage (the footer's meters): any of 5h / week / per-model at or above the threshold.
//
// So that an agent merely writing these words (quoted code, logs, diffs) never triggers a switch, only short status
// lines starting at the beginning of the line (after frames and symbols) count.
import { AGENTS, detectUsageLimit } from '@solocut/agents';
import type { ProviderRateLimits } from '../../shared/usage';

/** leading decoration (frames, symbols, bullets); digits and +- are excluded so diff lines never match */
const LEAD = String.raw`^[\s│┃|>⎿●○■□▪•·✗✘⚠!*]*`;

const CLAUDE_PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}(?:(?:5-hour|session|weekly|opus|sonnet|fable|daily)\\s+){0,2}(?:usage\\s+)?limit reached\\b`, 'i'),
  new RegExp(`${LEAD}(?:Claude(?: AI)?\\s+)?usage limit reached\\b`, 'i'),
  new RegExp(`${LEAD}You(?:'|’)ve hit your (?:session |weekly |usage |opus |sonnet |fable )?limit\\b`, 'i'),
];

const CODEX_PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}You(?:'|’)ve hit your usage limit\\b`, 'i'),
  new RegExp(`${LEAD}(?:usage|rate) limit reached\\b`, 'i'),
];

const GENERIC_PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}(?:\\[?API Error\\]?:?\\s*)?Quota exceeded\\b`, 'i'),
  new RegExp(`${LEAD}.{0,40}\\bRESOURCE_EXHAUSTED\\b`),
  new RegExp(`${LEAD}You(?:'|’)ve (?:hit|reached) your (?:daily |usage |session |weekly )?(?:limit|quota)\\b`, 'i'),
  new RegExp(`${LEAD}(?:usage|daily) (?:limit|quota) (?:reached|exceeded)\\b`, 'i'),
];

/** longest line that still counts as a status line (long prose paragraphs are ignored) */
const MAX_STATUS_LINE = 220;

function patternsFor(agent: string): RegExp[] {
  if (agent === 'claude') return CLAUDE_PATTERNS;
  if (agent === 'codex') return CODEX_PATTERNS;
  return GENERIC_PATTERNS;
}

/** Whether a line is the agent's limit message. */
function isLimitLine(agent: string, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_STATUS_LINE) return false;
  if (patternsFor(agent).some((re) => re.test(line))) return true;
  // the catalog's patterns for this agent (custom agents have none)
  const def = AGENTS.filter((d) => d.id === agent);
  return def.length > 0 && detectUsageLimit(line, def) !== null;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Whether newly received output (ANSI stripped or not) has a line that looks like any agent's limit message (cheap first pass). */
export function mentionsLimit(text: string): boolean {
  if (!/limit|quota|RESOURCE_EXHAUSTED/i.test(text)) return false;
  const clean = text.replace(ANSI, '');
  if (clean.split(/\r?\n|\r/).some((line) => ['claude', 'codex', 'gemini'].some((agent) => isLimitLine(agent, line)))) return true;
  return detectUsageLimit(clean) !== null;
}

/**
 * Whether the agent's limit message is on the end of the screen (last `lines` non-empty lines). Only the end is
 * checked so an old message that scrolled up (after the limit reset) never triggers a switch.
 */
export function limitOnScreen(agent: string, screen: string, lines = 20): boolean {
  const tail = screen.replace(ANSI, '').split(/\r?\n|\r/).filter((line) => line.trim()).slice(-lines);
  return tail.some((line) => isLimitLine(agent, line));
}

/** Highest window (%). null when unknown; 0 for unlimited plans. */
export function maxUsedPercent(limits: ProviderRateLimits | null | undefined): number | null {
  if (!limits || limits.unlimited) return limits?.unlimited ? 0 : null;
  const windows = [limits.session, limits.weekly, limits.fableWeekly, limits.spendLimit].filter((w): w is NonNullable<typeof w> => !!w);
  if (windows.length === 0) return null;
  return Math.max(...windows.map((w) => (Number.isFinite(w.usedPercent) ? w.usedPercent : 0)));
}

/** Among windows at or above the threshold, the latest reset time (unusable until then). null when unknown. */
export function limitedUntil(limits: ProviderRateLimits | null | undefined, thresholdPercent: number): number | null {
  if (!limits) return null;
  const windows = [limits.session, limits.weekly, limits.fableWeekly, limits.spendLimit].filter(
    (w): w is NonNullable<typeof w> => !!w && w.usedPercent >= thresholdPercent,
  );
  const resets = windows.map((w) => w.resetsAt).filter((at): at is number => typeof at === 'number');
  return resets.length > 0 ? Math.max(...resets) : null;
}
