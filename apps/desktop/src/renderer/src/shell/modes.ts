// The screens of the app and the four modes of the title bar (撮影 / 編集 / 確認 / 投稿, docs/02 "デスクトップアプリの画面").
// One video per project (16:9): there is no output switcher. Pure functions only (unit-tested).

export type Screen = 'home' | 'workspace' | 'review' | 'record' | 'thumbnails' | 'publish' | 'library' | 'settings';
export type Mode = 'record' | 'edit' | 'review' | 'publish';

export const MODES: readonly Mode[] = ['record', 'edit', 'review', 'publish'];
export const SCREENS: readonly Screen[] = ['home', 'workspace', 'review', 'record', 'thumbnails', 'publish', 'library', 'settings'];

const MODE_OF: Partial<Record<Screen, Mode>> = {
  record: 'record',
  workspace: 'edit',
  review: 'review',
  publish: 'publish',
  thumbnails: 'publish',
};

/** The title-bar mode a screen belongs to; null for pages outside the four modes (home, library, settings). */
export function modeOf(screen: Screen): Mode | null {
  return MODE_OF[screen] ?? null;
}

/** Where a mode button goes. 投稿 remembers whether the thumbnails tab or the publish tab was last used. */
export function screenForMode(mode: Mode, lastPublishTab: 'publish' | 'thumbnails' = 'publish'): Screen {
  switch (mode) {
    case 'record':
      return 'record';
    case 'edit':
      return 'workspace';
    case 'review':
      return 'review';
    case 'publish':
      return lastPublishTab;
  }
}

/** Screens that only make sense with an open project. */
export function needsProject(screen: Screen): boolean {
  return screen === 'workspace' || screen === 'review' || screen === 'record' || screen === 'thumbnails' || screen === 'publish';
}

/** `app:navigate` events and old callers may send any string; keep only known screens. 'edit' is an alias. */
export function parseScreen(s: string): Screen | null {
  if (s === 'edit') return 'workspace';
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

export type SidebarPageKey = 'nav.home' | 'mode.record' | 'mode.edit' | 'mode.review' | 'mode.publish' | 'nav.library' | 'common.settings';

/**
 * The pages of the sidebar, top to bottom: ホーム, the four modes, ライブラリ, 設定. Like the title bar, 編集 / 確認 / 投稿
 * need an open video; 撮影 does not.
 */
export function sidebarPages(hasProject: boolean): { screen: Screen; key: SidebarPageKey; disabled: boolean }[] {
  const modes = MODES.map((m) => ({ screen: screenForMode(m), key: `mode.${m}` as SidebarPageKey, disabled: !hasProject && m !== 'record' }));
  return [{ screen: 'home', key: 'nav.home', disabled: false }, ...modes, { screen: 'library', key: 'nav.library', disabled: false }, { screen: 'settings', key: 'common.settings', disabled: false }];
}

/** The sidebar row of a screen is shown as current (the thumbnails tab belongs to 投稿). */
export function sidebarActive(page: Screen, current: Screen): boolean {
  return page === current || (page === 'publish' && current === 'thumbnails');
}
