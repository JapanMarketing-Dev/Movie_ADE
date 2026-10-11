// Ported from Ferret test/unit/agent-install.test.ts (MIT). The install controller (renderer UI) is not ported.
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../src/catalog'
import { agentInstallCommand, exitWhenDoneCommand, installOutcome, isPosixOnlyInstall, requiredInstallTool } from '../src/install'

describe('exitWhenDoneCommand（終わったらその終了コードでシェルを閉じる）', () => {
  it('zsh / bash は $?、fish は $status', () => {
    expect(exitWhenDoneCommand('npm i -g x', '/bin/zsh')).toBe('npm i -g x; exit $?')
    expect(exitWhenDoneCommand(' npm i -g x ', '/usr/local/bin/bash')).toBe('npm i -g x; exit $?')
    expect(exitWhenDoneCommand('npm i -g x', '/opt/homebrew/bin/fish')).toBe('npm i -g x; exit $status')
  })

  it('PowerShell と cmd.exe', () => {
    expect(exitWhenDoneCommand('npm i -g x', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toMatch(/^npm i -g x; if \(\$\?\) \{ exit 0 \}/)
    expect(exitWhenDoneCommand('npm i -g x', 'C:\\Windows\\System32\\cmd.exe')).toBe('npm i -g x & call exit %^errorlevel%')
  })
})

describe('installOutcome（終了コードの読み方）', () => {
  it('0 は成功、127 / 9009 は道具が無い、それ以外は失敗', () => {
    expect(installOutcome(0)).toBe('success')
    expect(installOutcome(127)).toBe('missingTool')
    expect(installOutcome(9009)).toBe('missingTool')
    expect(installOutcome(1)).toBe('failed')
    expect(installOutcome(null)).toBe('failed')
  })

  it('道具はコマンドの先頭の語', () => {
    expect(requiredInstallTool('  npm install -g @openai/codex')).toBe('npm')
    expect(requiredInstallTool('brew install aider')).toBe('brew')
  })
})


describe('agentInstallCommand', () => {
  it('1行で入れられるものはコマンド、無いものは undefined（リンクだけ）', () => {
    expect(agentInstallCommand('codex')).toMatch(/codex/)
    expect(agentInstallCommand('devin')).toBe('curl -fsSL https://cli.devin.ai/install.sh | bash')
    // ソースから入れるしかないもの
    expect(agentInstallCommand('zcode')).toBeUndefined()
  })
})

describe('agentInstallCommand の OS ごとの出し分け', () => {
  it('Windows では公式の Windows の手順を出す（Claude Code は CMD、Cursor・Devin は PowerShell）', () => {
    expect(agentInstallCommand('claude', 'win32')).toBe('curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd')
    expect(agentInstallCommand('cursor', 'win32')).toMatch(/^powershell -NoProfile -Command "irm 'https:\/\/cursor\.com\/install\?win32=true' \| iex"$/)
    expect(agentInstallCommand('devin', 'win32')).toBe('powershell -NoProfile -Command "irm https://static.devin.ai/cli/setup.ps1 | iex"')
    expect(agentInstallCommand('opencode', 'win32')).toBe('npm install -g opencode-ai')
  })

  it('Windows の手順が分からず、POSIX のシェル向けしか無いものはリンクだけ（undefined）', () => {
    expect(agentInstallCommand('amp', 'win32')).toBeUndefined()
    // Homebrew（Windows に無い）と sh -c "$(curl …)" も同じ扱い
    expect(agentInstallCommand('rovo', 'win32')).toBeUndefined()
    expect(agentInstallCommand('trae', 'win32')).toBeUndefined()
  })

  it('公式の Windows の手順があるものは出す（Droid・Kiro・Grok・Junie・Kimi は PowerShell、Qoder は CMD、Crush は winget）', () => {
    for (const agent of ['droid', 'kiro', 'grok', 'junie', 'kimi'] as const) {
      expect(agentInstallCommand(agent, 'win32')).toMatch(/^powershell -NoProfile -ExecutionPolicy Bypass -Command "[^"]+"$/)
    }
    expect(agentInstallCommand('qoder', 'win32')).toBe('curl -fsSL https://qoder.com/install.cmd -o install.cmd && install.cmd && del install.cmd')
    expect(agentInstallCommand('crush', 'win32')).toBe('winget install charmbracelet.crush')
  })

  it('macOS が Homebrew だけのものは、Linux では Linux の公式の手順を出す', () => {
    expect(agentInstallCommand('crush', 'darwin')).toBe('brew install charmbracelet/tap/crush')
    expect(agentInstallCommand('crush', 'linux')).toBe('npm install -g @charmland/crush')
  })

  it('Windows でも npm などの OS に関係ないコマンドはそのまま出す', () => {
    expect(agentInstallCommand('codex', 'win32')).toMatch(/^npm (i|install) -g /)
  })

  it('macOS・Linux は curl … | bash の公式の手順のまま', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(agentInstallCommand('claude', platform)).toBe('curl -fsSL https://claude.ai/install.sh | bash')
      expect(agentInstallCommand('devin', platform)).toBe('curl -fsSL https://cli.devin.ai/install.sh | bash')
    }
  })


  it('OS を渡さなければ、この Node の process.platform で選ぶ', () => {
    expect(agentInstallCommand('claude')).toBe(agentInstallCommand('claude', process.platform))
  })

  it('Windows では、カタログのどの Agent にも POSIX のシェル向けの手順を出さない', () => {
    for (const agent of BUILTIN_AGENTS) {
      const command = agentInstallCommand(agent, 'win32')
      if (command) expect(isPosixOnlyInstall(command), agent).toBe(false)
    }
  })
})
