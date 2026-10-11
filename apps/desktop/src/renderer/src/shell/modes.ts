// The screens of the app and the three modes of the title bar and sidebar (撮影 / 編集 / 投稿). 確認 is part of 編集
// (the review list and findings show there); サムネイル is a tab inside 投稿. Home (the new-video form and the video
// list) is reached by 新しい動画 / the logo, and 撮影 shows it while no video is open. Settings opens from the footer
// gear (and ⌘,). One 16:9 video per project: there is no output switcher. Pure functions only (unit-tested).

export type Screen = 'home' | 'workspace' | 'record' | 'thumbnails' | 'publish' | 'library' | 'settings';
export type Mode = 'record' | 'edit' | 'publish';

export const MODES: readonly Mode[] = ['record', 'edit', 'publish'];
export const SCREENS: readonly Screen[] = ['home', 'workspace', 'record', 'thumbnails', 'publish', 'library', 'settings'];

const MODE_OF: Partial<Record<Screen, Mode>> = {
  record: 'record',
  workspace: 'edit',
  publish: 'publish',
  thumbnails: 'publish',
};

/** The mode a screen belongs to; null for pages outside the modes (home, library, settings). */
export function modeOf(screen: Screen): Mode | null {
  return MODE_OF[screen] ?? null;
}

/** The mode shown as current: like modeOf, and Home counts as 撮影 while no video is open (that is where 撮影 goes). */
export function activeMode(screen: Screen, hasProject: boolean): Mode | null {
  if (screen === 'home' && !hasProject) return 'record';
  return modeOf(screen);
}

/**
 * Where a mode button goes. 投稿 remembers whether the thumbnails tab or the publish tab was last used. Without an
 * open video 撮影 goes to Home (make or open a video first).
 */
export function screenForMode(mode: Mode, lastPublishTab: 'publish' | 'thumbnails' = 'publish', hasProject = true): Screen {
  switch (mode) {
    case 'record':
      return hasProject ? 'record' : 'home';
    case 'edit':
      return 'workspace';
    case 'publish':
      return lastPublishTab;
  }
}

/** A mode needs an open video (撮影 does not: it shows Home then). */
export function modeNeedsProject(mode: Mode): boolean {
  return mode !== 'record';
}

/** Screens that only make sense with an open project. */
export function needsProject(screen: Screen): boolean {
  return screen === 'workspace' || screen === 'record' || screen === 'thumbnails' || screen === 'publish';
}

/**
 * `app:navigate` events and old callers may send any string; keep only known screens. 'edit' and 'review' (確認 is
 * part of 編集 now) are aliases of the workspace.
 */
export function parseScreen(s: string): Screen | null {
  if (s === 'edit' || s === 'review') return 'workspace';
  return (SCREENS as readonly string[]).includes(s) ? (s as Screen) : null;
}

/**
 * The `solocut:navigate` window event (Home dispatches it after creating a video): detail is a screen id, or
 * { screen } for callers that send an object. Anything else is ignored.
 */
export function parseNavigateDetail(detail: unknown): Screen | null {
  if (typeof detail === 'string') return parseScreen(detail);
  if (detail && typeof detail === 'object' && typeof (detail as { screen?: unknown }).screen === 'string') return parseScreen((detail as { screen: string }).screen);
  return null;
}

export type ModeKey = 'mode.record' | 'mode.edit' | 'mode.publish';

/** The sidebar's navigation, top to bottom: 撮影 / 編集 / 投稿 (the same three as the title bar). */
export function sidebarPages(hasProject: boolean, lastPublishTab: 'publish' | 'thumbnails' = 'publish'): { mode: Mode; screen: Screen; key: ModeKey; disabled: boolean }[] {
  return MODES.map((mode) => ({ mode, screen: screenForMode(mode, lastPublishTab, hasProject), key: `mode.${mode}` as ModeKey, disabled: !hasProject && modeNeedsProject(mode) }));
}
