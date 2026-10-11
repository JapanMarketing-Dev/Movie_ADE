// Ported from Ferret src/renderer/terminal/quickLaunchSearch.ts (MIT).
// Solocut keeps the menu actions and the open tabs; there is no in-app browser or file tree, so the URL and file
// entries are dropped. Agents that are not installed are listed with their install command (install hints).

/**
 * 「＋」メニューの検索欄（純粋関数だけ。QuickLaunchButton と単体テストから使う）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx,
 *           ~/bench/orca/src/renderer/src/components/tab-bar/tab-create-entry-classifier.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca の「開いているタブ・Agent をまとめて探す」入口から、本システムにあるものだけを抜き出した。
 */

export type QuickLaunchEntry =
  | { kind: 'shell' }
  | { kind: 'agent'; agent: string; label: string; version?: string }
  /** インストールされていない Agent。選ぶとインストールのコマンドを新しいタブに入れる（実行は利用者が Enter） */
  | { kind: 'install'; agent: string; label: string; command: string }
  | { kind: 'tab'; tabKey: string; title: string }

export interface QuickLaunchSources {
  /** インストール済みの Agent */
  agents: ReadonlyArray<{ id: string; label: string; version?: string }>
  /** インストールされていない Agent（インストールのコマンドがあるものだけ） */
  installable: ReadonlyArray<{ id: string; label: string; command: string }>
  tabs: ReadonlyArray<{ key: string; title: string }>
}

/** 1種類あたりに出す上限。多すぎると選びにくい */
const MAX_PER_KIND = 8

export function entryId(entry: QuickLaunchEntry): string {
  switch (entry.kind) {
    case 'shell':
      return entry.kind
    case 'agent':
      return `agent:${entry.agent}`
    case 'install':
      return `install:${entry.agent}`
    case 'tab':
      return `tab:${entry.tabKey}`
  }
}

/** 空白で区切った語が、どれも含まれていれば一致（大文字小文字は区別しない） */
export function matchesQuery(query: string, ...texts: string[]): boolean {
  const haystack = texts.join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

// 検索語は画面の言語によらず、英語でも日本語でも当たるようにする
const SHELL_KEYWORDS = ['new terminal', '新しいターミナル', 'terminal', 'shell', 'シェル']
const INSTALL_KEYWORDS = ['install', 'インストール']

/**
 * 入力に合う項目を並べる。空のときはメニューの項目（新しいターミナル／Agent）と、インストールできる Agent の先頭の数件
 * （カタログは 40 を超えるので、残りは検索で出す）。
 * 並びは「操作 → 開いているタブ → インストール」。
 */
export function buildQuickLaunchEntries(query: string, sources: QuickLaunchSources): QuickLaunchEntry[] {
  const q = query.trim()
  const actions: QuickLaunchEntry[] = [
    { kind: 'shell' },
    ...sources.agents.map((agent): QuickLaunchEntry => ({ kind: 'agent', agent: agent.id, label: agent.label, ...(agent.version ? { version: agent.version } : {}) }))
  ]
  const installs = sources.installable.map((agent): QuickLaunchEntry => ({ kind: 'install', agent: agent.id, label: agent.label, command: agent.command }))
  if (!q) return [...actions, ...installs.slice(0, MAX_PER_KIND)]

  const matchedActions = actions.filter((entry) => {
    if (entry.kind === 'shell') return matchesQuery(q, ...SHELL_KEYWORDS)
    if (entry.kind === 'agent') return matchesQuery(q, entry.label, entry.agent)
    return false
  })
  const tabs = sources.tabs
    .filter((tab) => matchesQuery(q, tab.title))
    .slice(0, MAX_PER_KIND)
    .map((tab): QuickLaunchEntry => ({ kind: 'tab', tabKey: tab.key, title: tab.title }))
  const matchedInstalls = installs
    .filter((entry) => entry.kind === 'install' && matchesQuery(q, entry.label, entry.agent, ...INSTALL_KEYWORDS))
    .slice(0, MAX_PER_KIND)
  return [...matchedActions, ...tabs, ...matchedInstalls]
}
