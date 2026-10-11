// Ported from Ferret src/shared/agentInstall.ts and src/renderer/onboarding/agentInstall.ts (MIT).
import { AGENT_CATALOG, type BuiltinAgent } from './catalog'

/**
 * Agent の CLI をアプリ内の小さなターミナルでインストールするときの、画面に依存しない部分（main・renderer・単体テストで共有）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingInlineCommandTerminal.tsx（MIT）。
 * Orca は開いたシェルにコマンドを貼り、OSC 133;D（シェル統合）で終了コードを受け取る。
 * 本システムにはシェル統合が無いので、コマンドの後ろに「終わったらその終了コードでシェルを閉じる」を付け、
 * PTY の終了コード（terminal:exit）をそのままコマンドの結果として使う。
 */

/** シェルのファイル名（/bin/zsh・pwsh.exe など）から、終わったら閉じる1行を作る */
export function exitWhenDoneCommand(command: string, shellFile: string): string {
  const name = (shellFile.split(/[\\/]/).pop() ?? shellFile).toLowerCase().replace(/\.exe$/, '')
  const line = command.trim()
  if (name === 'fish') return `${line}; exit $status`
  if (name === 'pwsh' || name === 'powershell') {
    // 外部コマンドの失敗は $? が false になる。見つからないときは $LASTEXITCODE が空なので 1 にする
    return `${line}; if ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }`
  }
  // cmd.exe は1行を読んだ時点で %errorlevel% を展開してしまうので、call で実行時に展開させる（Windows では未検証）
  if (name === 'cmd') return `${line} & call exit %^errorlevel%`
  // zsh / bash / sh など
  return `${line}; exit $?`
}

export type InstallOutcome = 'success' | 'failed' | 'missingTool'

/**
 * 終了コードの読み方。127 は POSIX のシェルの「コマンドが見つからない」（npm・brew・pip が無い）、
 * 9009 は cmd.exe の同じ意味の値
 */
export function installOutcome(exitCode: number | null): InstallOutcome {
  if (exitCode === 0) return 'success'
  if (exitCode === 127 || exitCode === 9009) return 'missingTool'
  return 'failed'
}

/** インストールに要る道具（コマンドの先頭の語）。見つからなかったときの案内に使う */
export function requiredInstallTool(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

/**
 * Windows では動かない入れ方。POSIX のシェル向け（curl … | bash / sh、sh -c "$(curl …)"）と、
 * Windows に無い Homebrew（brew install …）
 */
export function isPosixOnlyInstall(command: string): boolean {
  return /\|\s*(?:ba|z)?sh\b/.test(command) || /^\s*sh\s+-c\b/.test(command) || /^\s*brew\s/.test(command)
}

/**
 * 見つからなかった Agent の CLI のインストールコマンド（AgentInstallTerminal で、押したときだけ実行する）。
 * 正本はカタログ（src/shared/agentCatalog.ts）。OS ごとに出し分ける:
 *   - Windows: installWindows（公式の Windows の手順）があればそれ。無く、install が POSIX のシェル向けなら undefined
 *     （公式ページへのリンクだけを出す）。npm / pip などの OS に関係ないコマンドはそのまま
 *   - Linux: installLinux（install が macOS の Homebrew だけのもの）があればそれ。無ければ install
 *   - macOS: install
 * どれも無いもの（ソースからしか入れられないなど）は undefined
 */
export function agentInstallCommand(agent: BuiltinAgent, platform: NodeJS.Platform | string = process.platform): string | undefined {
  const entry = AGENT_CATALOG[agent]
  if (!entry) return undefined
  if (platform === 'win32') {
    const windows = entry.installWindows?.trim()
    if (windows) return windows
    const install = entry.install.trim()
    return install && !isPosixOnlyInstall(install) ? install : undefined
  }
  if (platform === 'linux') {
    const linux = entry.installLinux?.trim()
    if (linux) return linux
  }
  return entry.install.trim() || undefined
}
