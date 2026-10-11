/**
 * Shortcut labels per OS and matching of key events (ported from Ferret src/renderer/lib/shortcut.ts).
 *
 * macOS … symbols packed together (⌘⇧N)
 * Windows / Linux … words joined with + (Ctrl+Shift+N)
 *
 * The app shortcuts follow Ferret where the action exists in both apps (⌘P quick open, ⌘, settings,
 * ⌘B sidebar, ⌘J terminal panel, ⌘⇧R record, ⌘1–3 modes 撮影 / 編集 / 投稿).
 */

type Modifier = 'Mod' | 'Shift' | 'Alt' | 'Ctrl';

const MAC_SYMBOLS: Record<Modifier, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };
const OTHER_WORDS: Record<Modifier, string> = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl' };
const MAC_KEYS: Record<string, string> = { Backspace: '⌫', Enter: '↩', Escape: '⎋', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
const OTHER_KEYS: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };

let macOverride: boolean | null = null;
/** Set by the app once AppInfo is known (and by tests). */
export function setShortcutPlatform(mac: boolean | null): void {
  macOverride = mac;
}
function isMac(): boolean {
  if (macOverride !== null) return macOverride;
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
}

/** formatShortcut('Mod', 'Shift', 'N') → '⌘⇧N' on macOS, 'Ctrl+Shift+N' elsewhere. */
export function formatShortcut(...parts: Array<Modifier | string>): string {
  const mac = isMac();
  const tokens = parts.map((part) => {
    if (part in MAC_SYMBOLS) return mac ? MAC_SYMBOLS[part as Modifier] : OTHER_WORDS[part as Modifier];
    return (mac ? MAC_KEYS : OTHER_KEYS)[part] ?? part;
  });
  return mac ? tokens.join('') : tokens.join('+');
}

export type ShortcutId =
  | 'quickOpen'
  | 'commandPalette'
  | 'settings'
  | 'newProject'
  | 'openProject'
  | 'toggleSidebar'
  | 'toggleCenter'
  | 'toggleTerminal'
  | 'record'
  | 'modeRecord'
  | 'modeEdit'
  | 'modePublish';

/** Key spec: `Mod` = ⌘ on macOS / Ctrl elsewhere. The key is compared case-insensitively against KeyboardEvent.key. */
export interface ShortcutSpec {
  mod: boolean;
  shift: boolean;
  alt?: boolean;
  key: string;
}

export const SHORTCUT_SPECS: Record<ShortcutId, ShortcutSpec> = {
  quickOpen: { mod: true, shift: false, key: 'p' },
  commandPalette: { mod: true, shift: true, key: 'p' },
  settings: { mod: true, shift: false, key: ',' },
  newProject: { mod: true, shift: false, key: 'n' },
  openProject: { mod: true, shift: false, key: 'o' },
  toggleSidebar: { mod: true, shift: false, key: 'b' },
  toggleCenter: { mod: true, shift: true, key: 'e' },
  toggleTerminal: { mod: true, shift: false, key: 'j' },
  record: { mod: true, shift: true, key: 'r' },
  modeRecord: { mod: true, shift: false, key: '1' },
  modeEdit: { mod: true, shift: false, key: '2' },
  modePublish: { mod: true, shift: false, key: '3' },
};

export function shortcutLabel(id: ShortcutId): string {
  const s = SHORTCUT_SPECS[id];
  const parts: string[] = [];
  if (s.mod) parts.push('Mod');
  if (s.alt) parts.push('Alt');
  if (s.shift) parts.push('Shift');
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return formatShortcut(...parts);
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Does the event match? On macOS Mod is ⌘ (Ctrl must be up), elsewhere Ctrl. */
export function matchesShortcut(e: KeyLike, spec: ShortcutSpec, mac = isMac()): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod !== spec.mod) return false;
  if (e.shiftKey !== spec.shift) return false;
  if (e.altKey !== (spec.alt ?? false)) return false;
  return e.key.toLowerCase() === spec.key.toLowerCase();
}

/** The first shortcut the event matches, or null. */
export function shortcutFor(e: KeyLike, mac = isMac()): ShortcutId | null {
  for (const [id, spec] of Object.entries(SHORTCUT_SPECS) as [ShortcutId, ShortcutSpec][]) {
    if (matchesShortcut(e, spec, mac)) return id;
  }
  return null;
}
