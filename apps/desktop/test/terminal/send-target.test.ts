// Ported from Ferret test/unit/send-target.test.ts (MIT). Solocut: no send-target picker in the UI; main picks the
// terminal (agent/request.ts) and the renderer opens the default agent when none runs.
/**
 * 「エージェントへ送る」の宛先と、未対応の Agent（貼るだけで Enter を押さない）、本文の整え方。
 */
import { describe, expect, it } from 'vitest'
import { chooseSendTarget } from '../../src/main/agent/sendTarget'
import { sendToAgent } from '../../src/main/agent/send'
import { sanitizePastePayload } from '../../src/main/agent/sanitize'
import { MAX_SEND_TEXT, pickSendTarget, sendAgentRequest, type SendHost } from '../../src/main/agent/request'
import { setMessageLanguage } from '../../src/main/terminal/messages'
import type { AgentStateInfo } from '../../src/shared/terminal'
import { agentSubmitsPaste } from '../../src/shared/terminal'
import { defaultAgent } from '../../src/renderer/src/terminal/defaultAgent'

setMessageLanguage(() => 'ja')

describe('宛先の決め方（main）', () => {
  const c = (id: string, agent: string | null, state = 'idle', cwd = '/p') => ({
    id, cwd, state, agent, kind: agent === 'claude' ? 'claude-code' as const : agent === 'codex' ? 'codex' as const : agent ? 'generic' as const : 'unknown' as const
  })

  it('Agent を選んだら、その Agent が動いている同じプロジェクトのタブ（待機中を先に）。無ければ null で起動へ', () => {
    const all = [c('t1', 'claude'), c('t2', 'gemini', 'working'), c('t3', 'gemini', 'idle'), c('t4', 'gemini', 'idle', '/other')]
    const pick = (agent: string) => chooseSendTarget(null, all.filter((x) => x.agent === agent), '/p')
    expect(pick('gemini')).toBe('t3')
    expect(pick('aider')).toBeNull()
  })

  it('フォーカス中のタブに Agent が居ればそこ。素のシェルなら同じプロジェクトの Agent（Claude Code → Codex → ほか、確認待ちは最後）', () => {
    const all = [c('t1', null), c('t2', 'gemini'), c('t3', 'codex', 'blocked'), c('t4', 'claude', 'idle', '/other'), c('t5', 'codex')]
    expect(chooseSendTarget('t2', all, '/p')).toBe('t2')
    expect(chooseSendTarget('t1', all, '/p')).toBe('t5')
    expect(chooseSendTarget('t1', all, null)).toBe('t4')
    expect(chooseSendTarget('t1', [c('t1', null)], '/p')).toBeNull()
  })

  it('何も居なければ Claude Code（入っていれば）、無ければ最初に入っている Agent を起動する', () => {
    expect(defaultAgent([{ id: 'codex', installed: true }, { id: 'claude', installed: true }])).toBe('claude')
    expect(defaultAgent([{ id: 'claude', installed: false }, { id: 'codex', installed: true }])).toBe('codex')
    expect(defaultAgent([{ id: 'claude', installed: false }])).toBeNull()
  })
})

/** 偽の TerminalManager（送り先の候補と、送った本文を記録する） */
function fakeHost(terminals: Array<{ id: string; agent: string | null; cwd?: string }>, appearAfter = 0) {
  let polls = 0
  const sent: Array<{ id: string; text: string }> = []
  const visible = () => (polls >= appearAfter ? terminals : [])
  const state = (id: string): AgentStateInfo => {
    const t = visible().find((x) => x.id === id)
    const agent = t?.agent ?? null
    return { kind: agent === 'claude' ? 'claude-code' : agent === 'codex' ? 'codex' : agent ? 'generic' : 'unknown', state: agent ? 'idle' : 'unknown', agent }
  }
  const candidates = () => visible().map((t) => ({ id: t.id, cwd: t.cwd ?? '/p', ...state(t.id) }))
  const host: SendHost = {
    agentState: async (id) => state(id),
    findAgentTerminal: async (agent, projectDir) => chooseSendTarget(null, candidates().filter((x) => x.agent === agent), projectDir),
    resolveSendTarget: async (preferred, projectDir) => {
      polls += 1
      return chooseSendTarget(preferred, candidates(), projectDir)
    },
    sendText: async (id, text) => {
      sent.push({ id, text })
      return { ok: true, message: 'sent', submitted: true }
    }
  }
  return { host, sent }
}

describe('送る依頼（agent:send）', () => {
  it('プロンプトの Agent が動いていればそのタブ、無ければフォーカス中・同じプロジェクトの Agent', async () => {
    const { host } = fakeHost([{ id: 't1', agent: 'claude' }, { id: 't2', agent: 'codex' }])
    expect(await pickSendTarget(host, { text: 'x', agent: 'codex', projectDir: '/p' })).toBe('t2')
    expect(await pickSendTarget(host, { text: 'x', agent: 'gemini', tabId: 't2', projectDir: '/p' })).toBe('t2')
    expect(await pickSendTarget(host, { text: 'x', agent: 'default', projectDir: '/p' })).toBe('t1')
  })

  it('Agent が居なければ noAgent を返し、送らない', async () => {
    const { host, sent } = fakeHost([{ id: 't1', agent: null }])
    const result = await sendAgentRequest(host, { text: 'hello', projectDir: '/p' })
    expect(result).toMatchObject({ ok: false, noAgent: true })
    expect(sent).toEqual([])
  })

  it('waitMs の間は Agent のタブが出てくるのを待ってから送る（開いたばかりのタブ）', async () => {
    const { host, sent } = fakeHost([{ id: 't9', agent: 'claude' }], 3)
    let now = 0
    const result = await sendAgentRequest(host, { text: 'hello', projectDir: '/p', waitMs: 5000 }, async (ms) => { now += ms }, () => now)
    expect(result).toMatchObject({ ok: true, tabId: 't9' })
    expect(sent).toEqual([{ id: 't9', text: 'hello' }])
  })

  it('待っても出てこなければ、waitMs で諦める（上限 30 秒）', async () => {
    const { host } = fakeHost([], 0)
    let now = 0
    const result = await sendAgentRequest(host, { text: 'hello', waitMs: 10 ** 9 }, async (ms) => { now += ms }, () => now)
    expect(result.noAgent).toBe(true)
    expect(now).toBe(30_000)
  })

  it('空の本文は送らない。長すぎる本文は上限で切る', async () => {
    const { host, sent } = fakeHost([{ id: 't1', agent: 'claude' }])
    expect(await sendAgentRequest(host, { text: '  \n ' })).toMatchObject({ ok: false, message: '送る内容がありません。' })
    await sendAgentRequest(host, { text: 'a'.repeat(MAX_SEND_TEXT + 10) })
    expect(sent[0]?.text).toHaveLength(MAX_SEND_TEXT)
  })
})

describe('未対応の Agent（Enter で送信されると確かめていない）', () => {
  it('確かめた Agent だけ Enter を送る。ほかの組み込み・カスタム・不明は貼るだけ', () => {
    for (const agent of ['claude', 'codex', 'gemini', 'cursor', 'copilot', 'opencode']) expect(agentSubmitsPaste(agent), agent).toBe(true)
    for (const agent of ['aider', 'goose', 'custom:my-bot']) expect(agentSubmitsPaste(agent), agent).toBe(false)
    expect(agentSubmitsPaste(null)).toBe(false)
  })

  it('submit: false なら、ブラケットペーストで貼るだけで Enter を送らない', async () => {
    const writes: string[] = []
    const result = await sendToAgent({ text: 'Read feedback.md', submit: false, getState: () => 'idle', sleep: async () => undefined,
      terminal: { write: (data) => { writes.push(data) }, onData: () => () => {} } })
    expect(result).toMatchObject({ ok: true, submitted: false })
    expect(writes).toEqual(['\x1b[200~Read feedback.md\x1b[201~'])
  })

  it('既定（submit 省略）は貼ったあと Enter を別に送る', async () => {
    const writes: string[] = []
    const result = await sendToAgent({ text: 'Read feedback.md', getState: () => 'idle', sleep: async () => undefined,
      terminal: { write: (data) => { writes.push(data) }, onData: () => () => {} } })
    expect(result).toMatchObject({ ok: true, submitted: true })
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe('\r')
  })
})

describe('貼り付ける本文の整え方（ページの文字からの指示の注入）', () => {
  it('8ビットの CSI（U+009B）などの C1 制御文字を落とし、ペーストの枠の外へ出させない', () => {
    const out = sanitizePastePayload('fix the header\u009b201~rm -rf ~\r')
    expect(out).not.toMatch(/[\u0080-\u009f]/)
    expect(out).toBe('fix the header201~rm -rf ~\r')
  })

  it('文字の向きを変える制御文字を落とす。ESC は見える文字にする', () => {
    expect(sanitizePastePayload('a‮b⁦c⁩d')).toBe('abcd')
    expect(sanitizePastePayload('x\x1b[201~y')).toBe('x␛[201~y')
  })
})
