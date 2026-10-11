// Terminal text size the user picks from the pane's right-click menu, remembered per machine. (⌘+ / ⌘- stay
// with the View menu's page zoom.)

export const DEFAULT_FONT_SIZE = 13
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 28
const KEY = 'solocut.terminal.fontSize'

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

export function loadFontSize(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): number {
  try {
    const raw = storage?.getItem(KEY)
    return raw ? clampFontSize(Number(raw)) : DEFAULT_FONT_SIZE
  } catch {
    // storage blocked (private window, previews): the default size
    return DEFAULT_FONT_SIZE
  }
}

export function saveFontSize(size: number, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null): void {
  try {
    storage?.setItem(KEY, String(size))
  } catch {
    /* not remembered; the size still applies until restart */
  }
}

export function nextFontSize(current: number, action: 'bigger' | 'smaller' | 'reset'): number {
  if (action === 'reset') return DEFAULT_FONT_SIZE
  return clampFontSize(current + (action === 'bigger' ? 1 : -1))
}
