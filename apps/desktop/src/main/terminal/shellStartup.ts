// Ported from Ferret src/main/shellStartup.ts (MIT).
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellSpec } from './terminal'
import { reportHandled } from '../../shared/report'

/**
 * Agentタブの起動。ログインシェルを普段どおり立ち上げ、最初のプロンプトが出た時点で
 * Agentの起動コマンドを「打ち込まれたもの」として実行させる。
 * Agentを終了すると、そのまま同じシェルのプロンプトへ戻る（Orcaと同じ挙動）。
 *
 * Orca由来: ~/bench/orca/src/main/shell-templates.ts（getZshShellReadyMarkerRegistrationBlock,
 *           ZSH_ZDOTDIR_HANDBACK_BLOCK, ZSH_USER_ZSHENV_SOURCE_BLOCK, getFishShellReadyInitCommand）,
 *           ~/bench/orca/src/main/zsh-startup-wrapper-builder.ts,
 *           ~/bench/orca/src/main/pty/posix-shell-startup-command.ts,
 *           ~/bench/orca/src/main/daemon/daemon-bash-shell-ready-rcfile.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * PTYへ文字列を書き込むだけだと、シェルが rc を読み終える前に届いて二重に表示されたり、
 * プロンプトのテーマが入力を消したりする。Orca は zsh / bash / fish の起動ファイルに
 * 小さなフックを差し込み、最初のプロンプトでコマンドを実行させている。ここではその仕組みから、
 * 準備完了マーカー・OSC 133・履歴の付け替えなど本システムで使わない部分を除いて移植した。
 * 対応しないシェル（sh、cmd、PowerShell など）は、出力が落ち着いたところで書き込む（terminal.ts）。
 *
 * Solocut では起動コマンドが無い素のシェルでも zsh / bash / fish はこのフックで起動する。
 * 利用者の rc（path_helper・~/.zprofile など）が PATH を組み直したあと、同梱の solocut CLI のフォルダ
 * （SOLOCUT_CLI_BIN）を先頭に戻すため（以前の services/pty.ts の ZDOTDIR の仕組みの置き換え）。
 */

/** シェルへ渡す起動コマンドの環境変数。最初のプロンプトで読んだらすぐ消す */
export const STARTUP_COMMAND_ENV = 'SOLOCUT_STARTUP_COMMAND'
const ORIG_ZDOTDIR_ENV = 'SOLOCUT_ORIG_ZDOTDIR'

/** 同梱の solocut CLI のフォルダ。利用者の rc が PATH を組み直したあと、もう一度先頭に置く */
export const CLI_BIN_ENV = 'SOLOCUT_CLI_BIN'

/**
 * zsh 用の .zshenv。ZDOTDIR を利用者のものへすぐ返し、以降の .zprofile / .zshrc / .zlogin は
 * 普段どおり利用者の場所から読ませる。そのうえで最初の precmd（rc をすべて読み終えたあと）で
 * 同梱の CLI のフォルダを PATH の先頭に戻し、起動コマンドがあれば zle-line-init を差し替えて
 * 入力欄（BUFFER）に入れて accept-line する。履歴にも普通のコマンドとして残る。
 *
 * 関数はすべて利用者の .zshenv を読む「前」に定義する（.zshenv が emulate sh で終わっても
 * 関数の中身は定義時に zsh として読まれているので壊れない。Orca と同じ理由）。
 */
export function zshStartupWrapper(): string {
  return `# Solocut zsh startup wrapper（Orca由来。毎回作り直すので編集しないこと）
__solocut_usable_zdotdir() {
  [[ -n "\${1:-}" ]] || return 1
  [[ "$1" != */solocut-shell-*/zsh ]] || return 1
  return 0
}
if __solocut_usable_zdotdir "\${${ORIG_ZDOTDIR_ENV}:-}"; then
  builtin export ZDOTDIR="$${ORIG_ZDOTDIR_ENV}"
else
  builtin unset ZDOTDIR
fi
builtin unset ${ORIG_ZDOTDIR_ENV}
builtin unfunction __solocut_usable_zdotdir
__solocut_deferred_init() {
  builtin emulate -L zsh
  builtin typeset -g precmd_functions
  precmd_functions=(\${precmd_functions:#__solocut_deferred_init})
  [[ -z "\${${CLI_BIN_ENV}:-}" ]] || builtin export PATH="$${CLI_BIN_ENV}:$PATH"
  if (( ! \${+${STARTUP_COMMAND_ENV}} )); then
    builtin unfunction __solocut_deferred_init
    return 0
  fi
  # 利用者の zle-line-init があれば、それを呼んでから起動コマンドを入れる
  if [[ "\${widgets[zle-line-init]:-}" == "user:__solocut_line_init" ]]; then
    :
  elif (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
    builtin typeset -g __solocut_prev_line_init_fn="\${widgets[zle-line-init]#user:}"
  else
    builtin typeset -g __solocut_prev_line_init_fn=""
  fi
  __solocut_line_init() {
    if [[ -n "\${__solocut_prev_line_init_fn:-}" ]]; then
      "\${__solocut_prev_line_init_fn}" "$@"
    fi
    if (( \${+${STARTUP_COMMAND_ENV}} )); then
      BUFFER="$${STARTUP_COMMAND_ENV}"
      CURSOR=\${#BUFFER}
      builtin unset ${STARTUP_COMMAND_ENV}
      zle accept-line
    fi
  }
  zle -N zle-line-init __solocut_line_init
  builtin unfunction __solocut_deferred_init
}
{
  builtin typeset _solocut_user_zshenv="\${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$_solocut_user_zshenv" ]] || builtin source -- "$_solocut_user_zshenv"
} always {
  builtin unset _solocut_user_zshenv
  builtin typeset -ag precmd_functions
  (( \${precmd_functions[(Ie)__solocut_deferred_init]} )) || precmd_functions+=(__solocut_deferred_init)
}
`
}

/**
 * bash 用の rcfile。`bash --rcfile` は非ログインの対話シェルになるため、
 * ログインシェルと同じ起動ファイル（/etc/profile → ~/.bash_profile 等）を自分で読む（Orcaと同じ）。
 * 読み終えたら同梱の CLI のフォルダを PATH の先頭に戻し、
 * 最初のプロンプトの PROMPT_COMMAND で起動コマンドを表示・履歴登録してから実行する。
 */
export function bashStartupRcfile(): string {
  return `# Solocut bash startup wrapper（Orca由来。毎回作り直すので編集しないこと）
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
[[ -z "\${${CLI_BIN_ENV}:-}" ]] || export PATH="$${CLI_BIN_ENV}:$PATH"
__solocut_run_startup_command() {
  [[ \${${STARTUP_COMMAND_ENV}+present} == present ]] || return 0
  local __solocut_command="$${STARTUP_COMMAND_ENV}"
  unset ${STARTUP_COMMAND_ENV}
  builtin history -s "$__solocut_command" 2>/dev/null || true
  builtin printf '%s\\n' "$__solocut_command"
  eval "$__solocut_command"
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__solocut_run_startup_command)
else
  PROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND%;}; }__solocut_run_startup_command"
fi
`
}

/** fish は config.fish の後に走る --init-command で、最初の fish_prompt に一度だけ実行する */
export function fishStartupInitCommand(): string {
  return `function __solocut_startup_command --on-event fish_prompt
  functions -e __solocut_startup_command
  if set -q ${CLI_BIN_ENV}
    set -gx PATH $${CLI_BIN_ENV} $PATH
  end
  if set -q ${STARTUP_COMMAND_ENV}
    set -l __solocut_command "$${STARTUP_COMMAND_ENV}"
    set -e ${STARTUP_COMMAND_ENV}
    builtin printf '%s\\n' "$__solocut_command"
    eval "$__solocut_command"
  end
end`
}

/**
 * 起動ファイルの置き場所（security-2 [7]）。
 *
 * 以前は決まった名前の共有の一時フォルダ（<tmpdir>/solocut-shell-<user>）に置いていた。
 * そのため、同じマシンのほかの利用者が先にフォルダやリンクを作っておくと、起動ファイルを差し替えられた
 * （シェルはそれを rc として実行する）。今は次のようにして防ぐ。
 * - プロセスごとに mkdtemp で、推測できない名前のフォルダを排他で作る（POSIX では 0700）
 * - ファイルは O_CREAT | O_EXCL | O_NOFOLLOW で作る（既にあるもの・リンクは使わない）
 * - 使うたびに、フォルダとファイルがリンクでなく、自分の持ち物で、ほかの人が書けず、中身が書いたとおりかを確かめる。
 *   崩れていれば作り直す
 * Windows では O_NOFOLLOW と持ち主の確認が無い。%TEMP% は利用者ごとなので、mkdtemp と O_EXCL だけで足りる。
 */
let wrapperRoot: string | null = null

const WRAPPER_FILES = (root: string): Array<[path: string, content: string]> => [
  [join(root, 'zsh', '.zshenv'), zshStartupWrapper()],
  [join(root, 'bashrc'), bashStartupRcfile()]
]

/** 排他で作り、リンクをたどらない（既にあれば EEXIST で失敗する） */
function writeExclusive(path: string, content: string): void {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

/** リンクでなく、自分の持ち物で、ほかの人が書けない（POSIX）。Windows は種類だけ見る */
function isPrivate(path: string, kind: 'dir' | 'file'): boolean {
  const st = lstatSync(path)
  if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile())) return false
  if (process.platform === 'win32') return true
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
  return (st.mode & 0o077) === 0
}

/** 置き場所がそのまま使えるか（持ち主・権限・リンク・中身）。少しでも崩れていれば false */
export function verifyWrapperRoot(root: string): boolean {
  try {
    if (!isPrivate(root, 'dir') || !isPrivate(join(root, 'zsh'), 'dir')) return false
    return WRAPPER_FILES(root).every(([path, content]) => isPrivate(path, 'file') && readFileSync(path, 'utf8') === content)
  } catch {
    return false
  }
}

/** 新しい置き場所を base の下に作る（テストでは base を一時フォルダにする） */
export function createWrapperRoot(base: string = tmpdir()): string {
  const root = mkdtempSync(join(base, 'solocut-shell-'))
  try {
    mkdirSync(join(root, 'zsh'), { mode: 0o700 })
    for (const [path, content] of WRAPPER_FILES(root)) writeExclusive(path, content)
    if (!verifyWrapperRoot(root)) throw new Error('shell startup directory is not private')
    return root
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}

/** 起動ファイルの置き場所（プロセスで1つ。使うたびに確かめ、崩れていれば作り直す） */
function ensureWrapperRoot(): string {
  if (wrapperRoot && verifyWrapperRoot(wrapperRoot)) return wrapperRoot
  if (wrapperRoot) {
    console.warn('[terminal] 起動ファイルの置き場所が書き換えられていたので、作り直します', wrapperRoot)
    reportHandled(new Error('shell startup directory was tampered'), { area: 'terminal', op: 'verify shell startup file' })
  }
  const root = createWrapperRoot()
  if (!wrapperRoot) {
    // 終了時に片付ける（残っても中身は固定の起動ファイルだけ）
    process.once('exit', () => {
      if (wrapperRoot) rmSync(wrapperRoot, { recursive: true, force: true })
    })
  }
  wrapperRoot = root
  return root
}

type StartupDelivery =
  /** シェルの起動ファイルが最初のプロンプトで実行する */
  | { kind: 'shell-hook'; shell: ShellSpec; env: Record<string, string> }
  /** フックを差し込めないシェル。出力が落ち着いたらPTYへ書き込む */
  | { kind: 'write'; shell: ShellSpec; env: Record<string, string> }

/**
 * 起動コマンドを、そのシェルに合った渡し方にする。command が null なら起動コマンドは無く、
 * rc を読んだあとの PATH の付け直しだけを行う。
 * 起動ファイルを書き出せないときは、書き込み方式に切り替える。
 */
export function planStartupDelivery(
  shell: ShellSpec,
  command: string | null,
  inheritedZdotdir: string | undefined = process.env.ZDOTDIR
): StartupDelivery {
  const name = (shell.file.split(/[\\/]/).pop() ?? shell.file).toLowerCase()
  const commandEnv: Record<string, string> = command === null ? {} : { [STARTUP_COMMAND_ENV]: command }
  try {
    if (name === 'zsh') {
      const root = ensureWrapperRoot()
      const env: Record<string, string> = { ZDOTDIR: join(root, 'zsh'), ...commandEnv }
      if (inheritedZdotdir) env[ORIG_ZDOTDIR_ENV] = inheritedZdotdir
      return { kind: 'shell-hook', shell, env }
    }
    if (name === 'bash') {
      const root = ensureWrapperRoot()
      return {
        kind: 'shell-hook',
        shell: { file: shell.file, args: ['--rcfile', join(root, 'bashrc'), '-i'] },
        env: commandEnv
      }
    }
    if (name === 'fish') {
      return {
        kind: 'shell-hook',
        shell: { file: shell.file, args: [...shell.args, '--init-command', fishStartupInitCommand()] },
        env: commandEnv
      }
    }
  } catch (err) {
    console.warn('[terminal] 起動ファイルを書き出せません。入力で起動します', err)
    reportHandled(err, { area: 'terminal', op: 'write shell startup file' })
  }
  return { kind: 'write', shell, env: {} }
}
