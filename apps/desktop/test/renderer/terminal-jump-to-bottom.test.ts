// Ported from Ferret test/unit/terminal-jump-to-bottom.test.ts (MIT).
/**
 * ターミナルの「一番下へ」のボタン（src/renderer/src/terminal/jumpToBottom.ts）。
 * Agent が出力し続けている間に上を読んでいても、1回押せば最新の行まで移れる
 */
import { describe, expect, it } from 'vitest'
import { isScrolledUp } from '../../src/renderer/src/terminal/jumpToBottom'

describe('一番下へのボタン', () => {
  it('上へスクロールして下に行があるときだけ出す', () => {
    expect(isScrolledUp({ viewportY: 10, baseY: 120 })).toBe(true)
    expect(isScrolledUp({ viewportY: 120, baseY: 120 })).toBe(false)
    expect(isScrolledUp({ viewportY: 0, baseY: 0 })).toBe(false)
  })
})
