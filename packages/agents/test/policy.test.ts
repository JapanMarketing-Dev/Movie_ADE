// Ported from Ferret test/unit/security-5-agents.test.ts [2] (MIT). [3]/[5] and the source-scan invariant test Ferret
// main code (accounts, SSH, executable resolution) and are not ported.
import { describe, expect, it } from 'vitest'
import {
  AGENT_CATALOG,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_PREFERENCES,
  SKIP_PERMISSION_AGENTS,
  bypassArgUnits,
  defaultLaunchConfig,
  sanitizeAgentPreferences
} from '../src/catalog'
import type { BuiltinAgent } from '../src/catalog'
import { canonicalLaunchCommand, findPermissionFlags, resolveAgentLaunchPolicy } from '../src/policy'

const policy = (agent: BuiltinAgent, config: { command?: string; args?: string }, options: { skipPermissions?: boolean; projectId?: string | null } = {}) =>
  resolveAgentLaunchPolicy({
    agent,
    command: config.command ?? '',
    args: config.args ?? '',
    projectId: options.projectId === undefined ? 'p1' : options.projectId,
    skipPermissions: options.skipPermissions ?? true,
    shell: 'posix'
  })

/** argv の中の、権限確認を省く引数・フォルダの信頼の引数 */
const grants = (agent: BuiltinAgent, argv: string[]) => findPermissionFlags(agent, argv.slice(1)).filter((m) => m.kind !== 'mode')

// ───────────────────────── [2] ─────────────────────────

describe('security-5 [2] 権限確認を省く引数・フォルダの信頼は、明示の設定からだけ入る', () => {
  it('カタログの既定の起動コマンドには、権限やフォルダの信頼のフラグが無い（実行ファイルとサブコマンドだけ）', () => {
    for (const agent of BUILTIN_AGENTS) {
      const command = canonicalLaunchCommand(agent, defaultLaunchConfig(agent).command, 'posix')
      expect(command.ok, agent).toBe(true)
      const words = command.ok ? command.words.map((w) => w.value) : []
      // 画面を選ぶだけのフラグ（確かめたもの）のほかは、フラグを置かない
      expect(words.slice(1).filter((w) => w.startsWith('-') && !(agent === 'hermes' && w === '--tui')), agent).toEqual([])
      expect(findPermissionFlags(agent, words.slice(1)).filter((m) => m.kind !== 'mode'), agent).toEqual([])
    }
    expect(AGENT_CATALOG.muse.trustArgs).toBe('--trust-workspace')
    expect(AGENT_CATALOG['command-code'].trustArgs).toBe('--trust')
  })

  it('既定の設定で、切なら（同意が無ければ）どの Agent にも省く引数・信頼の引数を足さない', () => {
    for (const agent of BUILTIN_AGENTS) {
      const result = policy(agent, DEFAULT_AGENT_PREFERENCES.launch[agent], { skipPermissions: false })
      expect(result.ok, agent).toBe(true)
      if (result.ok) {
        expect(grants(agent, result.argv), agent).toEqual([])
        expect(result.trustFolder, agent).toBe(false)
      }
    }
  })

  it('入でも、省く引数は確かめた Agent（Claude Code / Codex）だけ。信頼の引数は登録したプロジェクトのフォルダだけ', () => {
    for (const agent of BUILTIN_AGENTS) {
      const result = policy(agent, DEFAULT_AGENT_PREFERENCES.launch[agent], { skipPermissions: true, projectId: null })
      if (!result.ok) throw new Error(agent)
      const bypass = grants(agent, result.argv).filter((m) => m.kind === 'bypass')
      expect(bypass.length > 0, agent).toBe(SKIP_PERMISSION_AGENTS.includes(agent))
      expect(grants(agent, result.argv).filter((m) => m.kind === 'trust'), agent).toEqual([])
    }
    expect(policy('muse', { args: '' }, { projectId: 'p1' })).toEqual({ ok: true, argv: ['muse', '--trust-workspace'], trustFolder: false })
    expect(policy('command-code', { args: '--model x' }, { projectId: 'p1' })).toEqual({ ok: true, argv: ['command-code', '--trust', '--model', 'x'], trustFolder: false })
    expect(policy('muse', { args: '' }, { skipPermissions: false })).toEqual({ ok: true, argv: ['muse'], trustFolder: false })
  })

  it('以前の既定（コマンドの欄に信頼の引数）の保存された設定は、今の既定のコマンドに戻す', () => {
    const prefs = sanitizeAgentPreferences({ skipPermissions: false, launch: {
      muse: { command: 'muse --trust-workspace', args: '' }, 'command-code': { command: 'command-code --trust', args: '--model x' } } })
    expect(prefs.launch.muse).toEqual({ command: 'muse', args: '' })
    expect(prefs.launch['command-code']).toEqual({ command: 'command-code', args: '--model x' })
  })

  it('コマンドの欄に書いた省く引数・信頼の引数は起動しない（欄をまたいで分けた形も）', () => {
    const cases: Array<[BuiltinAgent, string, string]> = [
      ['claude', 'claude --dangerously-skip-permissions', ''],
      ['claude', 'claude --permission-mode bypassPermissions', ''],
      ['claude', 'claude --permission-mode', 'bypassPermissions'],
      ['codex', 'codex --yolo', ''],
      ['codex', 'codex -c', 'approval_policy=never'],
      ['codex', 'codex --sandbox=danger-full-access', ''],
      ['gemini', 'gemini --dangerously-anything', ''],
      ['muse', 'muse --trust-workspace', ''],
      ['command-code', 'command-code --trust', ''],
      ['crush', 'crush --yolo', '']
    ]
    for (const [agent, command, args] of cases) {
      for (const skipPermissions of [true, false]) {
        const result = policy(agent, { command, args }, { skipPermissions })
        expect(result.ok ? 'ok' : result.reason, `${command} | ${args}`).toBe('flag-in-command')
      }
    }
    // アカウントのログインも同じ
    expect(canonicalLaunchCommand('claude', 'claude --dangerously-skip-permissions', 'posix').ok).toBe(false)
    // サブコマンドはよい
    expect(policy('rovo', {}, { skipPermissions: false })).toEqual({ ok: true, argv: ['acli', 'rovodev', 'run'], trustFolder: false })
  })

  it('引用符・バックスラッシュ・= や値をくっつけた形で書き換えたものは起動しない', () => {
    const cases: Array<[BuiltinAgent, string]> = [
      ['claude', '"--dangerously-skip-permissions"'],
      ['claude', "'--dangerously-skip-permissions' --chrome"],
      ['claude', '--danger\\ously-skip-permissions'],
      ['claude', '--dangerously-skip-permissions""'],
      ['claude', '--permission-mode "bypassPermissions"'],
      ['claude', "--permission-mode=bypass'Permissions'"],
      ['codex', `-c 'sandbox_mode="danger-full-access"'`],
      ['codex', '--config "approval_policy = never"'],
      ['codex', '"-sdanger-full-access"'],
      ['codex', '-a "never"'],
      ['muse', '"--trust-workspace"']
    ]
    for (const [agent, args] of cases) {
      for (const skipPermissions of [true, false]) {
        const result = policy(agent, { args }, { skipPermissions })
        expect(result.ok ? 'ok' : result.reason, args).toBe('disguised-flag')
      }
    }
  })

  it('同じ意味の書き方（--config・-sVALUE・TOML の空白）も見分け、入でも省く引数を重ねない', () => {
    for (const args of ['--config approval_policy=never', '-sdanger-full-access', '-c approval_policy=never', '--sandbox=danger-full-access', '-anever']) {
      const result = policy('codex', { args })
      expect(result.ok && result.argv.join(' '), args).toBe(`codex ${args}`)
      expect(bypassArgUnits('codex').length).toBeGreaterThan(0)
    }
    // `--` の後はプロンプトなので、フラグとして読まない
    const prompt = policy('claude', { args: '--chrome -- "--dangerously-skip-permissions"' }, { skipPermissions: false })
    expect(prompt.ok && prompt.argv).toEqual(['claude', '--chrome', '--', '--dangerously-skip-permissions'])
  })

  it('引数の欄にそのまま書いたものは、利用者の明示の設定として書いたとおりに使う（SECURITY.md の Agent permissions）', () => {
    const result = policy('claude', { args: '--dangerously-skip-permissions --chrome' }, { skipPermissions: false })
    expect(result).toEqual({ ok: true, argv: ['claude', '--dangerously-skip-permissions', '--chrome'], trustFolder: false })
  })

})
