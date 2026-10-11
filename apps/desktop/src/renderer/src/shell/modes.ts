// The screens of the app and the four modes of the title bar (撮影 / 編集 / 確認 / 投稿, docs/02 "デスクトップアプリの画面").
// Pure functions only (unit-tested).
import type { Variant } from '@shared/types';

export type Screen = 'home' | 'workspace' | 'review' | 'record' | 'thumbnails' | 'publish' | 'archive' | 'library' | 'settings';
export type Mode = 'record' | 'edit' | 'review' | 'publish';

export const MODES: readonly Mode[] = ['record', 'edit', 'review', 'publish'];
export const SCREENS: readonly Screen[] = ['home', 'workspace', 'review', 'record', 'thumbnails', 'publish', 'archive', 'library', 'settings'];

const MODE_OF: Partial<Record<Screen, Mode>> = {
  record: 'record',
  workspace: 'edit',
  review: 'review',
  publish: 'publish',
  thumbnails: 'publish',
};

/** The title-bar mode a screen belongs to; null for pages outside the four modes (home, archive, library, settings). */
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

/** The variant switcher is shown in the title bar on these screens (docs/18: 3 videos from one take). */
export function showsVariant(screen: Screen): boolean {
  return screen === 'workspace' || screen === 'review';
}

/** `app:navigate` events and old callers may send any string; keep only known screens. 'edit' is an alias. */
export function parseScreen(s: string): Screen | null {
  if (s === 'edit') return 'workspace';
  return (SCREENS as readonly string[]).includes(s) ? (s as Screen) : null;
}

export const VARIANT_ORDER: readonly Variant[] = ['main', 'tiktok', 'youtube-shorts'];
