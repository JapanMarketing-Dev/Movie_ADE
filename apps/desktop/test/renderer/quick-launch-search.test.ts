// Ported from Ferret test/unit/quick-launch-search.test.ts (MIT). Solocut: no URL / file entries; install hints.
/**
 * 「＋」メニューの検索欄の絞り込み（Orca由来の入口を本システム向けに抜き出したもの）。
 */
import { describe, expect, it } from 'vitest'
import { buildQuickLaunchEntries, entryId, matchesQuery, type QuickLaunchSources } from '../../src/renderer/src/terminal/quickLaunchSearch'

const sources: QuickLaunchSources = {
  agents: [
    { id: 'claude', label: 'Claude Code', version: '2.1.0' },
    { id: 'codex', label: 'Codex' }
  ],
  installable: [
    { id: 'gemini', label: 'Gemini CLI', command: 'npm install -g @google/gemini-cli' },
    { id: 'opencode', label: 'OpenCode', command: 'npm install -g opencode-ai' }
  ],
  tabs: [
    { key: 'tab1', title: 'Claude Code' },
    { key: 'tab2', title: '2: zsh' }
  ]
}

describe('matchesQuery', () => {
  it('空白で区切った語がどれも含まれていれば一致（大文字小文字は区別しない）', () => {
    expect(matchesQuery('claude code', 'Claude Code')).toBe(true)
    expect(matchesQuery('CODE', 'Claude Code')).toBe(true)
    expect(matchesQuery('claude zsh', 'Claude Code')).toBe(false)
    expect(matchesQuery('', 'anything')).toBe(true)
  })
})

describe('buildQuickLaunchEntries', () => {
  it('空のときはメニューの項目と、インストールできる Agent', () => {
    expect(buildQuickLaunchEntries('', sources).map(entryId)).toEqual([
      'shell',
      'agent:claude',
      'agent:codex',
      'install:gemini',
      'install:opencode'
    ])
  })

  it('空のときに出すインストールは先頭の 8 件まで（残りは検索で出す）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, label: `Agent ${i}`, command: `install a${i}` }))
    const entries = buildQuickLaunchEntries('', { ...sources, installable: many })
    expect(entries.filter((e) => e.kind === 'install')).toHaveLength(8)
    expect(buildQuickLaunchEntries('agent 15', { ...sources, installable: many }).map(entryId)).toEqual(['install:a15'])
  })

  it('Agent・開いているタブ・インストールを絞り込む', () => {
    expect(buildQuickLaunchEntries('claude', sources).map(entryId)).toEqual(['agent:claude', 'tab:tab1'])
    expect(buildQuickLaunchEntries('zsh', sources).map(entryId)).toEqual(['tab:tab2'])
    expect(buildQuickLaunchEntries('gemini', sources).map(entryId)).toEqual(['install:gemini'])
    expect(buildQuickLaunchEntries('install', sources).map(entryId)).toEqual(['install:gemini', 'install:opencode'])
  })

  it('「新しいターミナル」は英語でも日本語でも当たる', () => {
    expect(buildQuickLaunchEntries('terminal', sources)[0]).toEqual({ kind: 'shell' })
    expect(buildQuickLaunchEntries('シェル', sources)[0]).toEqual({ kind: 'shell' })
  })

  it('インストールの項目はコマンドを持つ。版があれば Agent の項目に付ける', () => {
    const entries = buildQuickLaunchEntries('', sources)
    expect(entries.find((e) => e.kind === 'install')).toEqual({ kind: 'install', agent: 'gemini', label: 'Gemini CLI', command: 'npm install -g @google/gemini-cli' })
    expect(entries.find((e) => e.kind === 'agent')).toEqual({ kind: 'agent', agent: 'claude', label: 'Claude Code', version: '2.1.0' })
  })

  it('何にも当たらなければ空', () => {
    expect(buildQuickLaunchEntries('zzz-nothing', sources)).toEqual([])
  })
})
