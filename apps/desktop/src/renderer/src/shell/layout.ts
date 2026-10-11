// Panel layout of the shell: left sidebar, center (preview / timeline / review) and the agent terminal panel.
// Toggled from the title bar (LayoutToggles), shortcuts and Settings → Layout.
//
// The source of truth is settings.json `ui.layout` (docs/11: every setting is JSON). The App hydrates the store from
// it and persists changes back through `settings:set`; localStorage keeps a copy so the first frame after a start
// already has the right panels before settings.json has been read.
import { useSyncExternalStore } from 'react';

export type Panel = 'sidebar' | 'center' | 'terminal';
export const PANELS: readonly Panel[] = ['sidebar', 'center', 'terminal'];

export interface LayoutState {
  sidebar: boolean;
  center: boolean;
  terminal: boolean;
  /** sidebar width in px */
  sidebarWidth: number;
}

export const DEFAULT_LAYOUT: LayoutState = { sidebar: true, center: true, terminal: true, sidebarWidth: 240 };
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;

export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_LAYOUT.sidebarWidth;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
}

/**
 * Toggle a panel. The center and the terminal can not both be hidden (the workspace would be empty), so hiding the
 * last one of the two shows the other instead.
 */
export function togglePanel(s: LayoutState, p: Panel): LayoutState {
  const next = { ...s, [p]: !s[p] };
  if (!next.center && !next.terminal) {
    if (p === 'center') next.terminal = true;
    else next.center = true;
  }
  return next;
}

export function setPanel(s: LayoutState, p: Panel, visible: boolean): LayoutState {
  return s[p] === visible ? s : togglePanel(s, p);
}

/** Read a stored layout; anything malformed falls back to the default for that field. */
export function parseLayout(raw: string | null): LayoutState {
  if (!raw) return { ...DEFAULT_LAYOUT };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
  return layoutFromObject(v);
}

/** settings.json `ui.layout` (or any object) → layout; missing / wrong fields take the default. */
export function layoutFromObject(v: unknown): LayoutState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ...DEFAULT_LAYOUT };
  const o = v as Record<string, unknown>;
  const bool = (k: Panel) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_LAYOUT[k]);
  const s: LayoutState = {
    sidebar: bool('sidebar'),
    center: bool('center'),
    terminal: bool('terminal'),
    sidebarWidth: typeof o.sidebarWidth === 'number' ? clampSidebarWidth(o.sidebarWidth) : DEFAULT_LAYOUT.sidebarWidth,
  };
  if (!s.center && !s.terminal) s.center = true;
  return s;
}

/** The value written to settings.json `ui.layout` (only the keys the schema knows). */
export function layoutToSettings(s: LayoutState): { sidebar: boolean; center: boolean; terminal: boolean; sidebarWidth: number } {
  return { sidebar: s.sidebar, center: s.center, terminal: s.terminal, sidebarWidth: s.sidebarWidth };
}

export function sameLayout(a: LayoutState, b: LayoutState): boolean {
  return a.sidebar === b.sidebar && a.center === b.center && a.terminal === b.terminal && a.sidebarWidth === b.sidebarWidth;
}

// ---- store ----
const KEY = 'solocut.layout';
let state: LayoutState = load();
const listeners = new Set<() => void>();

function load(): LayoutState {
  try {
    return parseLayout(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

let persist: ((s: LayoutState) => void) | null = null;

function commit(next: LayoutState, fromSettings = false): void {
  if (sameLayout(state, next)) return;
  state = next;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: keep the in-memory state
  }
  if (!fromSettings) persist?.(next);
  for (const l of listeners) l();
}

export const layoutStore = {
  get: (): LayoutState => state,
  toggle: (p: Panel): void => commit(togglePanel(state, p)),
  set: (p: Panel, visible: boolean): void => commit(setPanel(state, p, visible)),
  setSidebarWidth: (w: number): void => commit({ ...state, sidebarWidth: clampSidebarWidth(w) }),
  reset: (): void => commit({ ...DEFAULT_LAYOUT }),
  /** take the value read from settings.json (does not write it back) */
  hydrate: (v: unknown): void => commit(layoutFromObject(v), true),
  /** where user changes are saved (the App wires settings.json); null to stop */
  setPersist: (fn: ((s: LayoutState) => void) | null): void => {
    persist = fn;
  },
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useLayout(): LayoutState {
  return useSyncExternalStore(layoutStore.subscribe, layoutStore.get);
}
