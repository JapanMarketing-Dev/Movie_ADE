import { describe, expect, it } from 'vitest';
import { formatShortcut, matchesShortcut, setShortcutPlatform, shortcutFor, shortcutLabel, SHORTCUT_SPECS, type KeyLike } from '../src/renderer/src/shell/shortcut';
import { modeOf, needsProject, parseScreen, screenForMode, showsVariant, MODES, SCREENS } from '../src/renderer/src/shell/modes';
import { clampSidebarWidth, DEFAULT_LAYOUT, parseLayout, setPanel, SIDEBAR_MAX, SIDEBAR_MIN, togglePanel } from '../src/renderer/src/shell/layout';
import { analysisProgress, dayBucket, formatBytes, formatElapsed, initialOf, shortPath, summarizePipeline, summarizeTools, updatePill } from '../src/renderer/src/shell/format';
import { fuzzyScore, matchesAll, normalize, rankItems } from '../src/renderer/src/shell/search';
import { parseFeedbackList, parseTakes } from '../src/renderer/src/shell/projectItems';
import { parseFailover, parseUsage, resetIn, tightestWindow, usageTone } from '../src/renderer/src/shell/usageModel';
import type { AnalysisStatus, StepState, ToolState } from '../src/shared/types';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe('shortcut labels', () => {
  it('uses symbols on macOS and words elsewhere', () => {
    setShortcutPlatform(true);
    expect(formatShortcut('Mod', 'Shift', 'R')).toBe('⌘⇧R');
    expect(formatShortcut('Mod', 'Escape')).toBe('⌘⎋');
    setShortcutPlatform(false);
    expect(formatShortcut('Mod', 'Shift', 'R')).toBe('Ctrl+Shift+R');
    expect(formatShortcut('Escape')).toBe('Esc');
    setShortcutPlatform(null);
  });
  it('labels every declared shortcut with an upper-case key', () => {
    setShortcutPlatform(true);
    expect(shortcutLabel('quickOpen')).toBe('⌘P');
    expect(shortcutLabel('commandPalette')).toBe('⌘⇧P');
    expect(shortcutLabel('settings')).toBe('⌘,');
    for (const id of Object.keys(SHORTCUT_SPECS) as (keyof typeof SHORTCUT_SPECS)[]) expect(shortcutLabel(id).startsWith('⌘')).toBe(true);
    setShortcutPlatform(null);
  });
});

describe('shortcut matching', () => {
  it('matches ⌘ on macOS and Ctrl elsewhere, never both', () => {
    expect(matchesShortcut(key('p', { metaKey: true }), SHORTCUT_SPECS.quickOpen, true)).toBe(true);
    expect(matchesShortcut(key('p', { ctrlKey: true }), SHORTCUT_SPECS.quickOpen, true)).toBe(false);
    expect(matchesShortcut(key('p', { ctrlKey: true }), SHORTCUT_SPECS.quickOpen, false)).toBe(true);
    expect(matchesShortcut(key('p', { metaKey: true, ctrlKey: true }), SHORTCUT_SPECS.quickOpen, true)).toBe(false);
  });
  it('separates shift / alt variants and is case-insensitive', () => {
    expect(shortcutFor(key('P', { metaKey: true, shiftKey: true }), true)).toBe('commandPalette');
    expect(shortcutFor(key('p', { metaKey: true }), true)).toBe('quickOpen');
    expect(shortcutFor(key('p', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(shortcutFor(key('R', { metaKey: true, shiftKey: true }), true)).toBe('record');
    expect(shortcutFor(key('r', { metaKey: true }), true)).toBeNull(); // ⌘R stays the menu's reload
    expect(shortcutFor(key('2', { ctrlKey: true }), false)).toBe('modeEdit');
  });
  it('ignores plain keys (typing in fields and terminals)', () => {
    expect(shortcutFor(key('p'), true)).toBeNull();
    expect(shortcutFor(key('1', { shiftKey: true }), true)).toBeNull();
  });
  it('has no two shortcuts with the same keys', () => {
    const seen = new Set<string>();
    for (const s of Object.values(SHORTCUT_SPECS)) {
      const k = `${s.mod}-${s.shift}-${s.alt ?? false}-${s.key}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

describe('modes', () => {
  it('maps every screen to at most one mode', () => {
    expect(modeOf('record')).toBe('record');
    expect(modeOf('workspace')).toBe('edit');
    expect(modeOf('review')).toBe('review');
    expect(modeOf('publish')).toBe('publish');
    expect(modeOf('thumbnails')).toBe('publish');
    for (const s of ['home', 'archive', 'library', 'settings'] as const) expect(modeOf(s)).toBeNull();
  });
  it('round-trips mode → screen → mode', () => {
    for (const m of MODES) expect(modeOf(screenForMode(m))).toBe(m);
    expect(screenForMode('publish', 'thumbnails')).toBe('thumbnails');
  });
  it('knows which screens need a project and show the variant switcher', () => {
    expect(needsProject('home')).toBe(false);
    expect(needsProject('settings')).toBe(false);
    expect(needsProject('workspace')).toBe(true);
    expect(showsVariant('workspace')).toBe(true);
    expect(showsVariant('review')).toBe(true);
    expect(showsVariant('record')).toBe(false);
  });
  it('parses navigation requests, rejecting unknown screens', () => {
    for (const s of SCREENS) expect(parseScreen(s)).toBe(s);
    expect(parseScreen('edit')).toBe('workspace');
    expect(parseScreen('')).toBeNull();
    expect(parseScreen('__proto__')).toBeNull();
    expect(parseScreen('Workspace')).toBeNull();
  });
});

describe('layout', () => {
  it('toggles panels but never hides both center and terminal', () => {
    const s = { ...DEFAULT_LAYOUT };
    const a = togglePanel(s, 'terminal');
    expect(a).toMatchObject({ center: true, terminal: false });
    const b = togglePanel(a, 'center');
    expect(b).toMatchObject({ center: false, terminal: true });
    const c = togglePanel({ ...s, terminal: false }, 'center');
    expect(c.center || c.terminal).toBe(true);
    expect(togglePanel(s, 'sidebar').sidebar).toBe(false);
  });
  it('setPanel is a no-op when already in that state', () => {
    const s = { ...DEFAULT_LAYOUT };
    expect(setPanel(s, 'sidebar', true)).toBe(s);
    expect(setPanel(s, 'sidebar', false).sidebar).toBe(false);
  });
  it('clamps the sidebar width', () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(10_000)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(250.6)).toBe(251);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_LAYOUT.sidebarWidth);
  });
  it('parses stored layouts defensively', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('not json')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('[]')).toEqual({ ...DEFAULT_LAYOUT });
    expect(parseLayout('42')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ sidebar: false, center: 'yes', sidebarWidth: 9999 }))).toEqual({ ...DEFAULT_LAYOUT, sidebar: false, sidebarWidth: SIDEBAR_MAX });
    expect(parseLayout(JSON.stringify({ center: false, terminal: false })).center).toBe(true);
  });
});

describe('formatters', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(-5)).toBe('00:00');
    expect(formatElapsed(Number.NaN)).toBe('00:00');
    expect(formatElapsed(59_999)).toBe('00:59');
    expect(formatElapsed(61_000)).toBe('01:01');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1.06 * 1024 ** 3)).toBe('1.06 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
  it('buckets days', () => {
    const now = new Date(2026, 9, 11, 15, 0, 0);
    expect(dayBucket(new Date(2026, 9, 11, 0, 0, 1).toISOString(), now)).toBe('today');
    expect(dayBucket(new Date(2026, 9, 10, 23, 59).toISOString(), now)).toBe('yesterday');
    expect(dayBucket(new Date(2026, 9, 1).toISOString(), now)).toBe('older');
    expect(dayBucket(undefined, now)).toBe('unknown');
    expect(dayBucket('garbage', now)).toBe('unknown');
  });
  it('makes initials and short paths', () => {
    expect(initialOf('  claude tips')).toBe('C');
    expect(initialOf('動画')).toBe('動');
    expect(initialOf('')).toBe('?');
    expect(initialOf('😀 emoji')).toBe('😀');
    expect(shortPath('/Users/me/Movies/Solocut/a', '/Users/me', 2)).toBe('…/Solocut/a');
    expect(shortPath('/Users/me/a', '/Users/me')).toBe('~/a');
    expect(shortPath('/Users/meow/a', '/Users/me')).toBe('/Users/meow/a');
    expect(shortPath('C:\\Users\\me\\v\\x\\y\\z', undefined, 2)).toBe('…\\y\\z');
  });
});

describe('pipeline summary', () => {
  const st = (step: string, state: StepState['state']): StepState => ({ step, state });
  it('counts done and skipped, finds the current step', () => {
    const s = summarizePipeline([st('ingest', 'done'), st('sync', 'skipped'), st('transcribe', 'running'), st('rough-cut', 'todo')]);
    expect(s).toMatchObject({ done: 2, total: 4, needsHuman: false });
    expect(s.current?.step).toBe('transcribe');
    expect(s.progress).toBe(0.5);
  });
  it('prefers running over needs-human over todo', () => {
    expect(summarizePipeline([st('a', 'todo'), st('b', 'needs-human')]).current?.step).toBe('b');
    expect(summarizePipeline([st('a', 'needs-human'), st('b', 'running')]).current?.step).toBe('b');
    expect(summarizePipeline([st('a', 'needs-human')]).needsHuman).toBe(true);
  });
  it('handles empty and finished pipelines', () => {
    expect(summarizePipeline([])).toEqual({ done: 0, total: 0, current: null, progress: 0, needsHuman: false });
    const done = summarizePipeline([st('a', 'done')]);
    expect(done.current).toBeNull();
    expect(done.progress).toBe(1);
  });
});

describe('tools summary', () => {
  const t = (name: string, installed: boolean): ToolState => ({ name, installed });
  it('reports missing essentials only', () => {
    const s = summarizeTools([t('ffmpeg', true), t('ffprobe', true), t('whisper-cli', false), t('whisper-model', false), t('whisper-model-small', true), t('fonts', true)]);
    expect(s.missing).toEqual(['whisper-cli']); // the small model satisfies whisper-model
    expect(s.ok).toBe(false);
    expect(s.total).toBe(5);
  });
  it('treats unknown lists as nothing missing and ignores tools main does not report', () => {
    expect(summarizeTools(null)).toMatchObject({ ok: true, missing: [] });
    expect(summarizeTools([t('ffmpeg', true)])).toMatchObject({ ok: true, total: 1, installed: 1 });
    expect(summarizeTools([])).toMatchObject({ ok: true, total: 0 });
  });
});

describe('analysis progress and update pill', () => {
  const base: AnalysisStatus = { running: true, phase: 'analyzing', jobs: [] };
  it('is null when idle and weights model download as the first 10%', () => {
    expect(analysisProgress(null)).toBeNull();
    expect(analysisProgress({ ...base, running: false })).toBeNull();
    expect(analysisProgress({ ...base, phase: 'models', modelProgress: 0.5 })).toBeCloseTo(0.05);
    expect(analysisProgress({ ...base, phase: 'models' })).toBe(0);
    expect(analysisProgress(base)).toBe(0);
  });
  it('averages jobs and counts failed / cancelled as finished', () => {
    const jobs = [
      { id: 'a', kind: 'faces' as const, sourceId: 's', state: 'running' as const, progress: 0.5 },
      { id: 'b', kind: 'ocr' as const, sourceId: 's', state: 'failed' as const, progress: 0 },
    ];
    expect(analysisProgress({ ...base, jobs })).toBeCloseTo(0.1 + 0.75 * 0.9);
    expect(analysisProgress({ ...base, jobs: [{ ...jobs[0]!, progress: 7 }] })).toBeCloseTo(1);
  });
  it('maps update states to the pill', () => {
    expect(updatePill(null)).toBeNull();
    expect(updatePill({ status: 'idle', current: '0.1.0' })).toBeNull();
    expect(updatePill({ status: 'error', current: '0.1.0' })).toBeNull();
    expect(updatePill({ status: 'ready', current: '0.1.0', latest: '0.2.0' })).toEqual({ kind: 'ready', version: '0.2.0' });
    expect(updatePill({ status: 'downloading', current: '0.1.0', latest: '0.2.0', progress: 0.426 })).toEqual({ kind: 'downloading', version: '0.2.0', progress: 43 });
    expect(updatePill({ status: 'notify-only', current: '0.1.0', latest: '0.2.0' })?.kind).toBe('available');
  });
});

describe('search', () => {
  it('normalizes width and case', () => {
    expect(normalize('ＡＢＣ　def ')).toBe('abc　def'.replace('　', ' '));
    expect(fuzzyScore('ｃｌａｕｄｅ', 'Claude Code')).not.toBeNull();
  });
  it('requires query characters in order', () => {
    expect(fuzzyScore('cc', 'Claude Code')).not.toBeNull();
    expect(fuzzyScore('ccx', 'Claude Code')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
  it('ranks prefix and substring hits above scattered ones', () => {
    const a = fuzzyScore('set', 'Settings')!;
    const b = fuzzyScore('set', 'Thumbnail settings')!;
    const c = fuzzyScore('set', 'save every thing')!;
    expect(a).toBeGreaterThan(c);
    expect(b).toBeGreaterThan(c);
  });
  it('ranks items by label, then keywords, stable for ties', () => {
    const items = [
      { id: '1', label: 'Library', keywords: 'tools ffmpeg' },
      { id: '2', label: 'Settings: Library and tools' },
      { id: '3', label: 'Record' },
    ];
    expect(rankItems('', items).map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(rankItems('ffmpeg', items).map((i) => i.id)).toEqual(['1']);
    expect(rankItems('lib', items)[0]!.id).toBe('1');
    expect(rankItems('zzz', items)).toEqual([]);
    expect(rankItems('', items, 2)).toHaveLength(2);
  });
  it('matchesAll needs every word', () => {
    expect(matchesAll('claude tips', 'Claude Code の tips', '/x')).toBe(true);
    expect(matchesAll('claude zzz', 'Claude Code')).toBe(false);
    expect(matchesAll('  ', 'x')).toBe(true);
    expect(matchesAll('movies', 'title', undefined, '/Users/me/Movies/a')).toBe(true);
  });
});

describe('project items (CLI JSON)', () => {
  it('parses takes and sorts newest first', () => {
    const r = parseTakes({
      ok: true,
      takes: [
        { id: 't-20261010-100000', files: ['screen.mp4', 3], complete: true, markers: 2, ingested: true },
        { id: 't-20261011-090000', files: 'x', complete: 'yes', markers: -4.5 },
        { id: '', files: [] },
        null,
        'junk',
      ],
    });
    expect(r.map((x) => x.id)).toEqual(['t-20261011-090000', 't-20261010-100000']);
    expect(r[1]).toEqual({ id: 't-20261010-100000', files: ['screen.mp4'], complete: true, markers: 2, ingested: true });
    expect(r[0]).toEqual({ id: 't-20261011-090000', files: [], complete: null, markers: 0, ingested: false });
  });
  it('returns [] for anything that is not the expected envelope', () => {
    expect(parseTakes(undefined)).toEqual([]);
    expect(parseTakes({ takes: 'no' })).toEqual([]);
    expect(parseTakes([])).toEqual([]);
    expect(parseFeedbackList(null)).toEqual([]);
    expect(parseFeedbackList({ feedback: {} })).toEqual([]);
  });
  it('parses feedback, open sessions first', () => {
    const r = parseFeedbackList({
      feedback: [
        { id: 'fb-1', status: 'done', items: 3, path: 'feedback/fb-1' },
        { id: 'fb-2', status: 'open', items: [1, 2], path: 'feedback/fb-2' },
        { id: 'fb-3', status: 'weird', items: 'x' },
      ],
    });
    expect(r.map((x) => [x.id, x.status, x.items])).toEqual([
      ['fb-2', 'open', 2],
      ['fb-3', 'done', 0],
      ['fb-1', 'done', 3],
    ]);
  });
});

describe('usage model', () => {
  it('parses usage defensively and clamps percentages', () => {
    const u = parseUsage([
      { agent: 'claude', status: 'ok', windows: [{ label: '5h', usedPercent: 140, resetsAt: '2026-10-11T20:00:00Z' }, { label: 'week', usedPercent: -3 }, null], plan: 'Max', account: 'a@b' },
      { id: 'codex', windows: [{ label: '5h', usedPercent: 'x' }] },
      { status: 'ok' },
      'junk',
    ]);
    expect(u).toHaveLength(2);
    expect(u[0]!.windows.map((w) => w.usedPercent)).toEqual([100, 0]);
    expect(u[0]).toMatchObject({ plan: 'Max', account: 'a@b', status: 'ok' });
    expect(u[1]).toMatchObject({ agent: 'codex', status: 'ok' });
    expect(u[1]!.windows[0]!.usedPercent).toBe(0);
    expect(parseUsage({ usage: [{ agent: 'gemini' }] })[0]).toMatchObject({ agent: 'gemini', status: 'unavailable', windows: [] });
    expect(parseUsage(undefined)).toEqual([]);
  });
  it('picks the tightest window and tones', () => {
    expect(tightestWindow({ agent: 'a', status: 'ok', windows: [] })).toBeNull();
    expect(tightestWindow({ agent: 'a', status: 'ok', windows: [{ label: '5h', usedPercent: 20 }, { label: 'week', usedPercent: 80 }] })?.label).toBe('week');
    expect([usageTone(0), usageTone(69.9), usageTone(70), usageTone(90), usageTone(100)]).toEqual(['ok', 'ok', 'warn', 'danger', 'danger']);
  });
  it('formats time to reset', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(resetIn(undefined, now)).toBe('');
    expect(resetIn('nope', now)).toBe('');
    expect(resetIn('2026-10-11T11:00:00Z', now)).toBe('');
    expect(resetIn('2026-10-11T12:45:00Z', now)).toBe('45m');
    expect(resetIn('2026-10-11T14:05:00Z', now)).toBe('2h 05m');
    expect(resetIn('2026-10-14T16:00:00Z', now)).toBe('3d 4h');
  });
  it('parses failover', () => {
    expect(parseFailover(null)).toBeNull();
    expect(parseFailover({ current: 'claude' })).toBeNull();
    expect(parseFailover({ enabled: true, current: 'claude', next: 'codex', last: { from: 'claude', to: 'codex', at: '2026-10-11T00:00:00Z' } })).toEqual({
      enabled: true,
      current: 'claude',
      next: 'codex',
      last: { from: 'claude', to: 'codex', at: '2026-10-11T00:00:00Z' },
    });
    expect(parseFailover({ enabled: false, last: { from: 1 } })).toEqual({ enabled: false });
  });
});

describe('usage from the desktop IPC shapes', () => {
  it('merges usage:state windows with usage:meters accounts', async () => {
    const { usageFromDesktop, failoverFromStatus } = await import('../src/renderer/src/shell/usageModel');
    const at = Date.parse('2026-10-11T20:00:00Z');
    const u = usageFromDesktop(
      {
        claude: { provider: 'claude', session: { usedPercent: 42, windowMinutes: 300, resetsAt: at }, weekly: { usedPercent: 120, windowMinutes: 10080, resetsAt: null }, status: 'ok', error: null, updatedAt: 0 },
        codex: null,
      },
      [
        { agent: 'claude', accountLabel: 'me@example.com', plan: 'Max', percent: 42, windowLabel: '5h', resetsAt: at, status: 'ok', statusLabel: null },
        { agent: 'codex', accountLabel: 'System default', plan: null, percent: 10, windowLabel: 'wk', resetsAt: null, status: 'ok', statusLabel: null },
        { agent: 'gemini', percent: null, statusLabel: 'Not signed in', status: 'unavailable' },
        'junk',
      ],
    );
    expect(u.find((x) => x.agent === 'claude')).toEqual({
      agent: 'claude',
      status: 'ok',
      windows: [
        { label: '5h', usedPercent: 42, resetsAt: '2026-10-11T20:00:00.000Z' },
        { label: 'week', usedPercent: 100 },
      ],
      account: 'me@example.com',
      plan: 'Max',
    });
    expect(u.find((x) => x.agent === 'codex')).toMatchObject({ status: 'ok', windows: [{ label: 'wk', usedPercent: 10 }], account: 'System default' });
    expect(u.find((x) => x.agent === 'gemini')).toMatchObject({ status: 'unavailable', windows: [], error: 'Not signed in' });
    expect(usageFromDesktop(undefined, undefined)).toEqual([]);
    expect(failoverFromStatus({ enabled: true, last: { fromAgent: 'claude', toAgent: 'codex', at, message: 'switched' } })).toEqual({
      enabled: true,
      current: 'codex',
      last: { from: 'claude', to: 'codex', at: '2026-10-11T20:00:00.000Z', reason: 'switched' },
    });
    expect(failoverFromStatus({ enabled: false, last: null })).toEqual({ enabled: false });
    expect(failoverFromStatus('x')).toBeNull();
  });
});
