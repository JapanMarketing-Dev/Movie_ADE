// Ported from Ferret src/main/terminal.ts (MIT).
// Solocut adaptations: SSH projects, accounts, failover, agent mail, the decision relay env and the prewarmed
// spare shell are dropped. Agents start through the @solocut/agents catalog (agentLaunchLine); the environment
// comes from solocutEnv() (bundled CLI first on PATH, login-shell PATH, saved secrets) through `appEnv`.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import type { IPty } from 'node-pty'
import {
  agentForProcess,
  agentLabel,
  agentLaunchLine,
  catalogCustomId,
  DEFAULT_AGENT_PREFERENCES,
  exitWhenDoneCommand,
  isBuiltinAgent,
  startupShellForPath,
  type AgentPreferences,
  type TuiAgent,
  type WindowsShell
} from '@solocut/agents'
import type {
  AgentStateInfo,
  TerminalAttachInfo,
  TerminalCreateOptions,
  TerminalSessionInfo,
  TerminalSize,
  TerminalTabInfo
} from '../../shared/terminal'
import { agentSubmitsPaste, delay } from '../../shared/terminal'
import { errorKind, flow, reportHandled } from '../../shared/report'
import { planStartupDelivery, CLI_BIN_ENV } from './shellStartup'
import { resolveProcessCwd } from './processCwd'
import { isInheritedAgentSessionEnv } from './inheritedAgentEnv'
import { TerminalHistory } from './terminalHistory'
import { defaultLocaleEnv, isHostTerminalEnv, setPathValue, stripAppImagePaths } from './terminalEnv'
import { t } from './messages'
import { windowsTreeKillCommand } from '../platform/windowsTreeKill'
import { detectState, parseTitle, stripAnsi } from '../agent/state'
import type { AgentKind } from '../agent/protocol'
import { ComposerReadiness } from '../agent/readiness'
import { nextLaunchAgentPhase, type LaunchAgentPhase } from '../agent/launchPhase'
import { sendToAgent } from '../agent/send'
import { chooseSendTarget } from '../agent/sendTarget'
import { agentInProcessTree, hasForegroundChild, isShellProcess, parseProcessRows, parseWindowsProcessRows, type ProcessRow } from '../agent/processTree'

/**
 * 内蔵ターミナル。node-pty のPTYをメインプロセスで持ち、renderer の xterm.js とは IPC でつなぐ。
 *
 * 大量出力中も入力が詰まらないよう、PTY出力はそのまま転送せず、1フレーム分ためてから1回のIPCで送る。
 */

/** PTY出力をまとめる間隔。xterm.js 側の描画が1フレームに1回で足りる */
export const FLUSH_INTERVAL_MS = 16
/**
 * 画面に出ていないターミナル（裏のタブ）の出力をまとめる間隔。多くの Agent を並べて動かすと、
 * 見ていないタブまで毎フレーム IPC と xterm の解析が走って CPU を使う。見えるようになったら、ためた分をすぐ送る（setVisible）
 */
export const HIDDEN_FLUSH_INTERVAL_MS = 250
/** 1回のフラッシュで送る上限。超えた分は次のフラッシュへ回す */
export const MAX_CHUNK = 256 * 1024
/** ためこみの上限。これを超えたら古い側を捨てて入力の応答を守る */
const MAX_BUFFER = 4 * 1024 * 1024
/**
 * 出力の流量制御。renderer がまだ描いていない（ack の来ていない）出力がこれを超えたら PTY を止め、
 * FLOW_LOW_WATER を下回ったら再開する。ack を待たずに送り続けると、renderer が詰まったとき（重い描画・読み込み直し）に
 * main の IPC の送り待ちが上限なく増える。止めている間はシェルの書き込みが待つ
 */
export const FLOW_HIGH_WATER = 2 * 1024 * 1024
export const FLOW_LOW_WATER = 256 * 1024
/** 起動ファイルにフックを差し込めないシェルで、出力が止まってから起動コマンドを書き込むまでの間 */
const STARTUP_WRITE_QUIET_MS = 300
/** 出力が止まらなくても、ここまで待ったら書き込む */
const STARTUP_WRITE_TIMEOUT_MS = 5000

export interface ShellSpec {
  file: string
  args: string[]
}

/**
 * Windows のシェル（設定の agents.windowsShell）。既定は PowerShell（7 の pwsh があればそれ、無ければ Windows に入っている 5.1）。
 * cmd.exe は終了すると履歴を残さないので、新しいタブ・再起動のあとに ↑ で前のコマンドが出ない。PowerShell は PSReadLine が
 * 履歴をファイルに残す。PowerShell が見つからなければ cmd.exe。
 * どれも OS の決まった場所の絶対パスだけを使う（PATH やプロジェクトのフォルダからは探さない）
 */
export function resolveWindowsShell(preference: WindowsShell, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): ShellSpec {
  const systemRoot = env.SystemRoot && win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows'
  const comspec = env.COMSPEC && win32.isAbsolute(env.COMSPEC) ? env.COMSPEC : win32.join(systemRoot, 'System32', 'cmd.exe')
  if (preference === 'powershell') {
    const programFiles = env.ProgramFiles && win32.isAbsolute(env.ProgramFiles) ? env.ProgramFiles : 'C:\\Program Files'
    const candidates = [win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
    const found = candidates.find((path) => exists(path))
    if (found) return { file: found, args: ['-NoLogo'] }
  }
  return { file: comspec, args: [] }
}

/**
 * ユーザーのログインシェルを決める。
 * - Windows: 設定の windowsShell（既定は PowerShell。resolveWindowsShell）
 * - macOS / Linux: SOLOCUT_SHELL か $SHELL をログインシェル（-l）として起動し、
 *   .zprofile / .bash_profile で入るPATH（nvm、Homebrew など）を反映させる
 */
export function resolveShell(windowsShell: WindowsShell, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === 'win32') return resolveWindowsShell(windowsShell, env)
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = env.SOLOCUT_SHELL || env.SHELL || fallback
  return { file: shell, args: ['-l'] }
}

/** 親から受け継がない変数（Electron 固有・API キー。キーは Solocut に保存したものだけを appEnv で渡す） */
const DROPPED_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])

/**
 * PTYに渡す環境変数（純粋な関数。単体テストの対象）。
 * inherited は親の環境（process.env）、app は Solocut が足すもの（solocutEnv の PATH・SOLOCUT_*・保存したキー）
 */
export function buildPtyEnv(inherited: NodeJS.ProcessEnv, app: NodeJS.ProcessEnv, extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue
    if (DROPPED_ENV.has(key)) continue
    // 親の Claude Code / Codex のセッションの印は渡さない（新しいターミナルは親のエージェントの子ではない）
    if (isInheritedAgentSessionEnv(key, value)) continue
    // アプリを起動した端末・AppImage・Crashpad・開発起動の変数は渡さない（terminalEnv.ts）
    if (isHostTerminalEnv(key)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(app)) {
    if (value === undefined) continue
    if (key.toUpperCase() === 'PATH') setPathValue(env, value, platform)
    else env[key] = value
  }
  if (platform === 'linux') stripAppImagePaths(env, inherited.APPDIR)
  Object.assign(env, defaultLocaleEnv(env, platform))
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return { ...env, ...extra }
}

/**
 * node-pty はネイティブモジュールなので、最初のタブを開くまで読み込まない。
 * Electron のバージョンに対して正しくビルドされていない場合は、ここで原因が分かるようにする。
 */
let nodePtyPromise: Promise<typeof import('node-pty')> | null = null

async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) {
    nodePtyPromise = import('node-pty').catch((err: unknown) => {
      nodePtyPromise = null
      throw new Error(t('terminal.errors.nodePty'), { cause: err })
    })
  }
  return nodePtyPromise
}

/**
 * ps の結果。送信先を選ぶときは全タブを続けて調べるので、1秒だけ使い回す（タブの数だけ ps を起動しない）
 */
let processCache: { at: number; rows: Promise<ProcessRow[]> } | null = null
/** 前面のプロセス名からプロセスツリーで同定した Agent を使い回す間（毎秒の問い合わせで ps を毎回起動しない） */
const AGENT_LOOKUP_RETRY_MS = 5000
function processRows(): Promise<ProcessRow[]> {
  if (!processCache || Date.now() - processCache.at > 1000) {
    const rows = promisify(execFile)('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => parseProcessRows(stdout))
    processCache = { at: Date.now(), rows }
    rows.catch(() => { processCache = null }) // 失敗は使い回さない（呼び出し側が受け取る）
  }
  return processCache.rows
}

/**
 * Windows のプロセス一覧（ps が無いので PowerShell の Win32_Process）。PowerShell の起動は重いので、
 * 前の結果をすぐ返しつつ裏で取り直す（5秒に1回まで）
 */
const WINDOWS_PROCESS_QUERY =
  "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | " +
  'ForEach-Object { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine)) }'
let windowsProcessCache: { at: number; rows: ProcessRow[] | null; pending: Promise<ProcessRow[]> | null } = { at: 0, rows: null, pending: null }
function windowsProcessRows(): Promise<ProcessRow[]> {
  const cache = windowsProcessCache
  if (!cache.pending && Date.now() - cache.at > 5000) {
    cache.pending = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })
      .then(({ stdout }) => {
        const rows = parseWindowsProcessRows(stdout)
        windowsProcessCache = { at: Date.now(), rows, pending: null }
        return rows
      }, (err: unknown) => {
        windowsProcessCache = { at: Date.now(), rows: cache.rows, pending: null }
        throw err
      })
    cache.pending.catch(() => undefined) // 前の結果を返すときは、ここでの失敗を誰も受け取らない
  }
  if (cache.rows) return Promise.resolve(cache.rows)
  return cache.pending ?? Promise.reject(new Error('process list unavailable'))
}

interface Session {
  id: string
  pty: IPty
  buffer: string[]
  bufferBytes: number
  timer: NodeJS.Timeout | null
  /** 今の timer の待ち（裏のターミナルのゆっくりのフラッシュを、たまったときに早めるかの判断） */
  timerDelay?: number
  tail: string
  screen?: { text: string; at: number }
  title?: string
  readiness: ComposerReadiness
  sending: boolean
  info: TerminalSessionInfo
  /** 直近の出力。画面を読み込み直したあと、つなぎ直したタブに流し直す */
  history: TerminalHistory
  /** 起動時の Agent の推定の段階（agent/launchPhase.ts） */
  launchAgent?: LaunchAgentPhase
  /** 前面のプロセス名からプロセスツリーで同定した Agent（AGENT_LOOKUP_RETRY_MS の間だけ使い回す） */
  agentLookup?: { command: string; agent: string | null; at: number }
  /** 送ったが renderer の ack がまだの文字数（流量制御） */
  unacked: number
  /** 流量制御で PTY を止めているか */
  paused: boolean
}

/**
 * 次のフラッシュまでの待ち。見えているターミナルは毎フレーム、裏のターミナルは HIDDEN_FLUSH_INTERVAL_MS。
 * 裏でも 1 回で送る上限（MAX_CHUNK）以上たまっていればすぐ送る（大量の出力で MAX_BUFFER を超えて古い出力を捨てない）
 */
export function flushDelayMs(hidden: boolean, bufferedBytes: number): number {
  return hidden && bufferedBytes < MAX_CHUNK ? HIDDEN_FLUSH_INTERVAL_MS : FLUSH_INTERVAL_MS
}

export class TerminalManager {
  private sessions = new Map<string, Session>()
  /** kill は済んだが、まだ onExit が届いていないPTY（強制終了に切り替えるときのため、子孫PIDも持つ） */
  private awaitingExit = new Map<string, { pty: IPty; descendants: number[] }>()
  /** 「全部の終了通知が届いた」を待っている人たち */
  private exitWaiters = new Set<() => void>()
  private seq = 0
  /** renderer が最後に知らせたとき（terminal:visible）に画面に出ていなかったターミナル。出力をゆっくりまとめる */
  private hidden = new Set<string>()
  private cwd: string = homedir()

  /** エージェントの設定（index.ts が settings.json の agents から読む。単体テストでは既定のまま） */
  settings: () => AgentPreferences = () => DEFAULT_AGENT_PREFERENCES
  /** Solocut が足す環境変数（solocutEnv。PATH の先頭は同梱の CLI のフォルダ） */
  appEnv: () => NodeJS.ProcessEnv = () => ({})
  /** 同梱の solocut CLI のフォルダ。rc を読んだあとに PATH の先頭へ戻す（shellStartup.ts）。null なら戻さない */
  cliBin: () => string | null = () => null
  /** Claude Code / Codex を起動する前に、そのプロジェクトのフォルダを信頼済みにする（agentWorkspaceTrust.ts） */
  trustWorkspace: ((agentId: string, projectDir: string, env: Record<string, string>) => Promise<unknown>) | null = null
  /** cwd が Solocut のプロジェクトのフォルダか（フォルダの信頼と、権限確認を省く決まりの projectId に使う） */
  isProjectDir: (dir: string) => boolean = () => false
  /** アカウントの切り替えなど、Agent ごとに環境変数を変える（accounts が設定する） */
  resolveAgentEnv: ((agentId: string, env: Record<string, string>, accountId?: string | null) => Record<string, string>) | null = null
  /** the account a new agent tab opens with (accounts.tabAccountId); undefined = agent without accounts */
  tabAccountId: ((agentId: string, requested: string | null | undefined) => string | null | undefined) | null = null
  /** output listeners besides the renderer (failover watches for usage-limit messages) */
  readonly outputListeners = new Set<(id: string, data: string) => void>()

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number) => void
  ) {}

  /** 後始末が残っているPTYの数（生きているものと、kill 済みで終了通知待ちのもの） */
  pendingCount(): number {
    return this.sessions.size + this.awaitingExit.size
  }

  /** 開いたプロジェクトフォルダを、以降に作るタブのカレントにする */
  setCwd(dir: string | null): void {
    this.cwd = dir ?? homedir()
  }

  private ptyEnv(extra: Record<string, string> = {}): Record<string, string> {
    const cliBin = this.cliBin()
    return buildPtyEnv(process.env, this.appEnv(), { ...(cliBin ? { [CLI_BIN_ENV]: cliBin } : {}), ...extra })
  }

  /**
   * タブを1つ開く。cwd を省略すると開いているプロジェクトのフォルダ。
   * agent を指定すると、ログインシェルが立ち上がった最初のプロンプトでそのAgentを起動する
   * （Agentを終了するとシェルに戻る。Orcaと同じ）。command は1行のコマンドを同じように実行する。
   */
  async create(options: TerminalCreateOptions): Promise<TerminalTabInfo> {
    const { size, agent } = options
    const nodePty = await loadNodePty()
    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : this.cwd
    const prefs = this.settings()
    let shell = resolveShell(prefs.windowsShell)
    const startupShell = startupShellForPath(shell.file)
    let startupCommand: string | null = null
    let resumed = false
    if (agent) {
      const projectId = this.isProjectDir(cwd) ? cwd : null
      const launch = agentLaunchLine(agent, prefs, { shell: startupShell, projectId, ...(options.resume ? { resume: true } : {}) })
      if (!launch.ok) throw new Error(t('terminal.errors.launch', { agent: labelOf(agent, prefs), error: launch.error }))
      resumed = launch.resumed === true
      startupCommand = launch.line
      // パンくず：自作の Agent は名前を出さない（利用者が付けた名前を送らない）
      flow('agent launch', { agent: isBuiltinAgent(agent) ? agent : 'custom' })
      // Claude Code / Codex の「このフォルダを信頼しますか」を、Solocut のプロジェクトのフォルダについて先に書いておく
      if ((agent === 'claude' || agent === 'codex') && projectId && this.trustWorkspace) {
        await this.trustWorkspace(agent, projectId, this.ptyEnv()).catch((err: unknown) => reportHandled(errorKind(err), { area: 'agent-launch', op: 'grant folder trust' }))
      }
    } else if (options.command?.trim()) {
      const line = options.command.trim()
      startupCommand = options.exitWhenDone ? exitWhenDoneCommand(line, shell.file) : line
    }
    // 起動コマンドを、シェルの最初のプロンプトで実行させる。zsh / bash / fish は起動コマンドが無くても
    // フックで起動し、rc を読んだあとに同梱の CLI のフォルダを PATH の先頭へ戻す
    const delivery = planStartupDelivery(shell, startupCommand)
    shell = delivery.shell
    const pendingWrite = delivery.kind === 'write' ? startupCommand : null
    const id = `t${++this.seq}`
    let env = this.ptyEnv(delivery.env)
    const accountId = agent && this.tabAccountId ? this.tabAccountId(agent, options.accountId) : undefined
    // accounts: CLAUDE_CONFIG_DIR / CODEX_HOME of the tab's account (throws when that account's folder is unusable)
    if (agent && this.resolveAgentEnv) env = { ...env, ...this.resolveAgentEnv(agent, env, accountId) }
    if (options.env) env = { ...env, ...options.env }
    let pty: IPty
    try {
      pty = nodePty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(2, size.cols),
        rows: Math.max(1, size.rows),
        cwd,
        env
      })
      hardenWindowsPty(pty)
    } catch (err) {
      reportHandled(err, { area: 'pty', op: 'spawn shell' })
      throw err
    }
    const title = options.title?.trim() || (agent ? labelOf(agent, prefs) : `${id.slice(1)}: ${shellLabel(shell.file)}`)
    const session: Session = { id, pty, buffer: [], bufferBytes: 0, timer: null,
      tail: '', readiness: new ComposerReadiness(), sending: false,
      info: { id, pid: pty.pid, cwd, title, agent: agent ?? null, ...(accountId !== undefined ? { accountId } : {}) }, history: new TerminalHistory(), unacked: 0, paused: false }
    this.sessions.set(id, session)
    this.wirePty(session, pendingWrite, agent ?? null)
    flow('terminal create', { kind: agent ? 'agent' : options.command ? 'command' : 'shell' })
    return { id, title, agent: agent ?? null, cwd, ...(resumed ? { resumed } : {}) }
  }

  /** PTY の出力と終了をセッションにつなぐ */
  private wirePty(session: Session, pendingWrite: string | null, launched: string | null): void {
    const { id, pty } = session
    const stopStartupWrite = pendingWrite ? this.scheduleStartupWrite(session, pendingWrite) : null
    pty.onData((data) => {
      stopStartupWrite?.touch()
      this.enqueue(session, data)
      for (const l of this.outputListeners) {
        try {
          l(id, data)
        } catch (err) {
          reportHandled(err, { area: 'terminal', op: 'output listener' })
        }
      }
    })
    pty.onExit(({ exitCode }) => {
      // パンくず：Agent の異常終了（exit code≠0）が、このあとの失敗の手がかりになる
      flow('terminal exit', { exitCode, kind: launched ? (isBuiltinAgent(launched) ? launched : 'custom') : 'shell' })
      releaseWindowsConout(pty)
      stopStartupWrite?.cancel()
      this.flush(session)
      this.sessions.delete(id)
      this.hidden.delete(id)
      this.awaitingExit.delete(id)
      this.onExit(id, exitCode)
      this.notifyExitWaiters()
    })
  }

  /** シェルの今のカレント（分割したペインに引き継ぐ）。調べられなければ開いたときのカレント */
  async currentCwd(id: string): Promise<string | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    return (await resolveProcessCwd(session.pty.pid)) || session.info.cwd
  }

  /** 開いているターミナルの一覧 */
  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }))
  }

  /**
   * 画面を読み込み直したあと、生きているターミナルにつなぎ直す。新しくは作らず、直近の出力を返す。
   * 送りかけの出力は先に流して、履歴と画面への転送が重ならないようにする。終了していれば null
   */
  attach(id: string): TerminalAttachInfo | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.flush(session)
    return { ...session.info, history: session.history.snapshot(), size: { cols: session.pty.cols, rows: session.pty.rows } }
  }

  /**
   * フックを差し込めないシェル向け。最初の出力のあと出力が止まったら（＝プロンプトが出たら）
   * 起動コマンドを打ち込む。Orca が準備完了を待てないときに待ち時間で書き込むのと同じ考え方。
   */
  private scheduleStartupWrite(session: Session, command: string): { touch: () => void; cancel: () => void } {
    let done = false
    let quietTimer: NodeJS.Timeout | null = null
    const fire = (): void => {
      if (done) return
      done = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(deadline)
      if (this.sessions.get(session.id) === session) session.pty.write(`${command}\r`)
    }
    const deadline = setTimeout(fire, STARTUP_WRITE_TIMEOUT_MS)
    return {
      touch: () => {
        if (done) return
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(fire, STARTUP_WRITE_QUIET_MS)
      },
      cancel: () => {
        done = true
        if (quietTimer) clearTimeout(quietTimer)
        clearTimeout(deadline)
      }
    }
  }

  private enqueue(session: Session, data: string): void {
    session.history.push(data)
    // 色などの制御を外すのは1回だけ（どのターミナルの出力も main で毎回通る）
    const plain = stripAnsi(data)
    session.tail = (session.tail + plain).slice(-8000)
    session.title = parseTitle(data) ?? session.title
    session.readiness.push(data)
    session.buffer.push(data)
    session.bufferBytes += data.length
    while (session.bufferBytes > MAX_BUFFER && session.buffer.length > 1) {
      const dropped = session.buffer.shift()
      session.bufferBytes -= dropped?.length ?? 0
    }
    const delay = flushDelayMs(this.hidden.has(session.id), session.bufferBytes)
    if (session.timer) {
      // 裏のターミナルで 1 回分を超えてたまった。待たずに送る（古い出力を捨てない）
      if (delay === FLUSH_INTERVAL_MS && session.timerDelay !== FLUSH_INTERVAL_MS) this.flush(session)
      return
    }
    session.timerDelay = delay
    session.timer = setTimeout(() => this.flush(session), delay)
  }

  /**
   * 画面に出ているターミナル（renderer の terminal:visible）。それ以外の今あるターミナルは出力をゆっくりまとめる。
   * 見えるようになったターミナルは、ためていた出力をすぐ送る（表示を切り替えた直後に古い画面を見せない）
   */
  setVisible(ids: readonly string[]): void {
    const shown = new Set(ids)
    const hidden = new Set<string>()
    for (const session of this.sessions.values()) {
      if (shown.has(session.id)) continue
      hidden.add(session.id)
    }
    const revealed = [...this.hidden].filter((id) => !hidden.has(id))
    this.hidden = hidden
    for (const id of revealed) {
      const session = this.sessions.get(id)
      if (session?.timer) this.flush(session)
    }
  }

  /** 画面に出ているか（Agent の「終わった（まだ見ていない）」の判定に使う） */
  isVisible(id: string): boolean {
    return this.sessions.has(id) && !this.hidden.has(id)
  }

  private flush(session: Session): void {
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
      session.timerDelay = undefined
    }
    if (session.buffer.length === 0) return
    let payload = session.buffer.join('')
    session.buffer = []
    session.bufferBytes = 0
    if (payload.length > MAX_CHUNK) {
      const rest = payload.slice(MAX_CHUNK)
      payload = payload.slice(0, MAX_CHUNK)
      session.buffer.push(rest)
      session.bufferBytes = rest.length
      // 残りは見えているかに関わらず次のフレームで送る（ためたまま次の出力を待たない）
      session.timerDelay = FLUSH_INTERVAL_MS
      session.timer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS)
    }
    this.onData(session.id, payload)
    session.unacked += payload.length
    if (!session.paused && session.unacked > FLOW_HIGH_WATER && this.sessions.get(session.id) === session) {
      session.paused = true
      try {
        session.pty.pause()
      } catch {
        /* すでに終了している */
      }
    }
  }

  /** renderer が出力を描き終えた（terminal:ack）。止めていた PTY は、未処理が減ったら再開する */
  ack(id: string, chars: number): void {
    const session = this.sessions.get(id)
    if (!session || !Number.isFinite(chars) || chars <= 0) return
    session.unacked = Math.max(0, session.unacked - chars)
    if (session.paused && session.unacked < FLOW_LOW_WATER) this.resumeFlow(session)
  }

  /** 画面を読み込み直した。前の画面に送った出力の ack は来ないので、数え直して全部再開する */
  resetFlow(): void {
    // 前の画面が知らせた表示の状態も忘れる（新しい画面がつなぎ直してから知らせ直す）
    this.hidden.clear()
    for (const session of this.sessions.values()) {
      session.unacked = 0
      if (session.paused) this.resumeFlow(session)
    }
  }

  private resumeFlow(session: Session): void {
    session.paused = false
    try {
      session.pty.resume()
    } catch {
      /* すでに終了している */
    }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  /** 画面の末尾のテキスト（renderer が送った表示、無ければ出力の末尾） */
  screenText(id: string): string {
    const session = this.sessions.get(id)
    return session ? (session.screen?.text ?? session.tail) : ''
  }

  updateScreen(id: string, text: string): void {
    const session = this.sessions.get(id)
    if (session && session.screen?.text !== text.slice(-10000)) session.screen = { text: text.slice(-10000), at: Date.now() }
  }

  async agentState(id: string): Promise<AgentStateInfo & { kind: AgentKind }> {
    const session = this.sessions.get(id)
    if (!session) return { kind: 'unknown', state: 'unknown', agent: null }
    const prefs = this.settings()
    // PTY が終わったあとは process が undefined になる（node-pty。前面には何も居ない扱い）
    const command = session.pty.process ?? ''
    const windows = process.platform === 'win32'
    // node-pty の Windows 版の process は端末名（xterm-256color）で、前面のプロセスを表さない
    let agent: string | null = windows ? null : agentForProcess(command, prefs)
    // 名前で決まらないとき（npm 版は node、公式インストーラの Claude Code は版番号、ラッパーのスクリプトなど）は、
    // シェルの子から1段ずつコマンド行を見て同定する（agent/processTree.ts）。シェルに戻っていれば何も居ない
    let foreground = !isShellProcess(command)
    if (windows) {
      // Windows はシェルの子を見る。一覧が取れなければ、起動時の Agent で判断する（下）
      const rows = await windowsProcessRows().catch(() => null)
      if (rows) {
        foreground = hasForegroundChild(rows, session.pty.pid)
        if (foreground) agent = agentInProcessTree(rows, session.pty.pid, (line) => agentForProcess(line, prefs))
      }
    }
    // シェルに戻ったら忘れる（同じ名前の別のプロセスを Agent と取り違えない）
    if (!foreground) session.agentLookup = undefined
    if (!agent && foreground && !windows) {
      const cached = session.agentLookup
      if (cached && cached.command === command && Date.now() - cached.at < AGENT_LOOKUP_RETRY_MS) {
        agent = cached.agent
      } else {
        try {
          agent = agentInProcessTree(await processRows(), session.pty.pid, (line) => agentForProcess(line, prefs))
          session.agentLookup = { command, agent, at: Date.now() }
        } catch { /* ps が使えなければ下の起動時の Agent で判断する */ }
      }
    }
    // Agent として開いたタブで、シェルではない何かが前面で動いていれば、その Agent とみなす。
    // いちど Agent が終わってシェルに戻ったら、以後はこの推定をしない（agent/launchPhase.ts。Orca #6355）
    if (session.info.agent) session.launchAgent = nextLaunchAgentPhase(session.launchAgent, foreground)
    if (!agent && foreground && session.info.agent && session.launchAgent !== 'ended') agent = session.info.agent
    const kind: AgentKind = agent === 'claude' ? 'claude-code' : agent === 'codex' ? 'codex' : agent ? 'generic' : 'unknown'
    return { kind, agent, state: kind === 'unknown' ? 'unknown' : detectState(kind, { title: session.title, tail: session.screen?.text ?? session.tail }) }
  }

  /** 複数のターミナルの状態をまとめて調べる。返す順は ids と同じ */
  async agentStates(ids: readonly string[]): Promise<AgentStateInfo[]> {
    return Promise.all(ids.map((id) => this.agentState(id)))
  }

  /** その Agent が動いている、同じプロジェクトのターミナル（待機中を先に）。無ければ null */
  async findAgentTerminal(agent: string, projectDir: string | null, exclude: string | null = null): Promise<string | null> {
    const candidates = await Promise.all([...this.sessions.values()].filter((session) => session.id !== exclude).map(async (session) => ({
      id: session.id, cwd: session.info.cwd, ...(await this.agentState(session.id))
    })))
    return chooseSendTarget(null, candidates.filter((c) => c.agent === agent), projectDir)
  }

  /**
   * 「Agentへ送信」の宛先。選んでいるターミナルに Agent が居なければ、同じプロジェクトの Agent のターミナル。
   * どこにも居なければ null（agent/sendTarget.ts）
   */
  async resolveSendTarget(preferred: string | null, projectDir: string | null): Promise<string | null> {
    const candidates = await Promise.all([...this.sessions.values()].map(async (session) => ({
      id: session.id, cwd: session.info.cwd, ...(await this.agentState(session.id))
    })))
    return chooseSendTarget(preferred, candidates, projectDir)
  }

  /**
   * Agent へ本文を送る（ブラケットペースト → 確かめる → 別の write で Enter。agent/send.ts）。
   * 確認待ち（許可・質問）のときは送らない。作業中の Agent にはそのまま送る（今の作業のあとに読む）
   */
  async sendText(id: string, text: string): Promise<{ ok: boolean; message: string; submitted?: boolean }> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, message: t('terminal.send.openTerminal') }
    if (session.sending) return { ok: false, message: t('terminal.send.busy') }
    const { kind, agent } = await this.agentState(id)
    if (kind === 'unknown') return { ok: false, message: t('terminal.send.noAgent') }
    // Enter で送信されると確かめていない Agent は、貼り付けるだけにする（shared/terminal.ts）
    const submit = agentSubmitsPaste(agent)
    // Claude Code / Codex 以外は待機中の見え方を知らないので、確認待ちでなく、出力が落ち着いていれば送る
    const generic = kind === 'generic'
    // 起動の直後など入力欄がまだ出ていないときだけ、少し（最大 5 秒）待ってから送る
    const deadline = Date.now() + 5000
    let queued = false
    while (session.readiness.status() !== 'ready') {
      const state = await this.agentState(id)
      if (state.state === 'blocked') return { ok: false, message: t('terminal.send.blocked') }
      if (state.state === 'working') { queued = true; break }
      const quiet = session.screen && Date.now() - session.screen.at >= 1500
      if (quiet && (state.state === 'idle' || (generic && state.state === 'unknown'))) break
      if (Date.now() >= deadline) break
      await delay(100)
    }
    session.sending = true
    try {
      const result = await sendToAgent({ text, submit,
        terminal: { write: (data) => { if (!this.sessions.has(id)) throw new Error(t('terminal.send.exited')); session.pty.write(data) }, onData: () => () => {} },
        getState: async () => {
          const state = (await this.agentState(id)).state
          if (state === 'blocked' || state === 'idle' || state === 'working') return state
          return generic ? 'idle' : 'unknown'
        } })
      if (result.ok && !result.submitted) return { ok: true, submitted: false, message: t('terminal.send.pastedNoEnter', { agent: labelOf(agent, this.settings()) }) }
      return { ok: result.ok, submitted: result.ok, message: result.ok ? t(queued ? 'terminal.send.queued' : generic ? 'terminal.send.doneUnverified' : 'terminal.send.done') : result.message }
    } finally { session.sending = false }
  }

  resize(id: string, size: TerminalSize): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty.resize(Math.max(2, size.cols), Math.max(1, size.rows))
    } catch (err) {
      // ウィンドウ縮小の途中で不正な値になることがある。無視して次のリサイズを待つ
      console.warn(`[terminal] resize failed ${id}`, err)
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.flush(session)
    this.sessions.delete(id)
    this.hidden.delete(id)
    // kill してから onExit が届くまでを「後始末中」として数える。
    // 子孫PIDは、シェルが死んで辿れなくなる前のものを控えておく。
    const descendants = killPtyTree(session.pty, 'SIGHUP')
    this.awaitingExit.set(id, { pty: session.pty, descendants })
  }

  private notifyExitWaiters(): void {
    if (this.awaitingExit.size > 0) return
    for (const waiter of [...this.exitWaiters]) waiter()
  }

  /**
   * すべてのPTYを終了する（終了通知は待たない）。
   *
   * アプリ終了の直前ではなく、できるだけ早い段階で呼ぶこと。
   * node-pty は exit を ThreadSafeFunction でJSへ返すため、Nodeの環境クリーンアップに重なると
   * napi 呼び出しに失敗し、プロセスが abort する（SIGABRT）。
   */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /**
   * すべてのPTYを終了し、**各PTYの onExit が届くまで待つ**。
   * 既定の kill は SIGHUP で、無視するシェルでは終了しない。`escalateAfterMs` で SIGKILL に切り替え、
   * それでも届かない場合は `timeoutMs` で打ち切る。
   */
  disposeAllAndWait(
    options: { escalateAfterMs?: number; timeoutMs?: number } = {}
  ): Promise<{ clean: boolean; pending: number; waitedMs: number }> {
    const escalateAfterMs = options.escalateAfterMs ?? 500
    const timeoutMs = options.timeoutMs ?? 2000
    const startedAt = Date.now()

    this.disposeAll()
    if (this.awaitingExit.size === 0) {
      return Promise.resolve({ clean: true, pending: 0, waitedMs: 0 })
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (clean: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(escalateTimer)
        clearTimeout(giveUpTimer)
        this.exitWaiters.delete(waiter)
        resolve({ clean, pending: this.awaitingExit.size, waitedMs: Date.now() - startedAt })
      }
      const waiter = (): void => finish(true)

      // SIGHUP を無視するシェルが残っていたら、強制終了に切り替える
      const escalateTimer = setTimeout(() => {
        for (const entry of this.awaitingExit.values()) {
          killPtyTree(entry.pty, 'SIGKILL', entry.descendants)
        }
      }, escalateAfterMs)
      escalateTimer.unref?.()

      // 打ち切るときは、終了の通知が来なかった PTY の出力用の Worker（Windows）を片付けてから返す
      const giveUpTimer = setTimeout(() => {
        for (const entry of this.awaitingExit.values()) releaseWindowsConout(entry.pty)
        finish(false)
      }, timeoutMs)
      giveUpTimer.unref?.()

      this.exitWaiters.add(waiter)
    })
  }
}

/** 直前の ps の結果。終了時に全部のタブを続けて閉じるとき、タブの数だけ同期の ps で main を止めない */
let psListingCache: { at: number; listing: string } | null = null
const PS_LISTING_REUSE_MS = 500

/**
 * あるプロセスの子孫のPIDを列挙する（POSIX）。
 * シェルを落とすと子プロセスの親は init に付け替えられ、辿れなくなる。そのため kill の**前**に呼び、結果を控えておく。
 */
function descendantPids(root: number): number[] {
  let listing: string
  try {
    if (psListingCache && Date.now() - psListingCache.at < PS_LISTING_REUSE_MS) listing = psListingCache.listing
    else {
      listing = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
      psListingCache = { at: Date.now(), listing }
    }
  } catch (err) {
    // 子プロセスを数えられないだけで、終了処理は pty.kill で続ける。失敗の文は ps の stderr を含むので、種類だけを送る
    reportHandled(errorKind(err), { area: 'terminal', op: 'list child processes' })
    return []
  }

  const children = new Map<number, number[]>()
  for (const line of listing.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!matched) continue
    const pid = Number(matched[1])
    const ppid = Number(matched[2])
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }

  const found: number[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as number
    for (const child of children.get(current) ?? []) {
      // 念のため自分自身とinitは触らない
      if (child <= 1 || child === process.pid) continue
      found.push(child)
      stack.push(child)
    }
  }
  return found
}

/**
 * PTYにぶら下がるプロセスを、シェルだけでなくまとめて終了させる。
 *
 * `pty.kill()` はシェル本体にしかシグナルを送らない。対話シェルはジョブ制御で実行中のコマンド（起動中のAgent など）を
 * **別のプロセスグループ**に置くため、シェルを落としてもそれらは孤児として残る。
 * そこで、シェルの子孫を先に落としてから、シェル自身のプロセスグループを落とす。
 * Windows は、先に taskkill /T でシェルの子孫ごと終わらせてから `kill()` する（windowsTreeKill.ts）。
 *
 * @param known 以前に列挙した子孫。シェルが先に死んで辿れなくなった場合に使う
 */
function killPtyTree(pty: IPty, signal: NodeJS.Signals, known: readonly number[] = []): number[] {
  if (process.platform === 'win32') {
    // 同じ PTY の kill は1回だけ（閉じるときの taskkill の後と、終了時の強制終了の両方から来る）
    const killPty = () => {
      if (killedWindowsPtys.has(pty)) return
      killedWindowsPtys.add(pty)
      try {
        pty.kill()
      } catch {
        /* すでに終了している */
      }
    }
    // 強制終了（終了時の切り替え）は待たずに閉じる。taskkill は最初の1回だけ
    const command = signal === 'SIGKILL' ? null : windowsTreeKillCommand(pty.pid, process.env.SystemRoot)
    if (!command) killPty()
    // 子孫が無い・すでに終わっているときも taskkill は失敗で返るだけ。どちらでも ConPTY を閉じる
    else execFile(command.file, command.args, { timeout: 3000, windowsHide: true }, killPty)
    return []
  }

  const descendants = [...new Set([...known, ...descendantPids(pty.pid)])]
  for (const pid of descendants) {
    try {
      process.kill(pid, signal)
    } catch {
      /* すでに終了している */
    }
  }

  try {
    process.kill(-pty.pid, signal)
  } catch {
    try {
      pty.kill(signal)
    } catch {
      /* すでに終了している */
    }
  }

  return descendants
}

/**
 * Windows の node-pty の中（WindowsPtyAgent）の resize・kill を包む。
 * - 同じ PTY の kill は1回だけにする。2回目の kill は ConPTY のハンドルを二重に閉じ、main がネイティブに落ちる
 * - node-pty は最初の出力が届くまで resize・kill を後回しにし、最初の出力の 'data' の中でまとめて実行する。
 *   そのときにはシェルがもう終わっていると resize が投げ、main の捕まえていない例外になる。投げさせない
 */
export function hardenWindowsPty(pty: IPty, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  const agent = (pty as unknown as { _agent?: Record<string, unknown> })._agent
  if (!agent) return
  let killed = false
  for (const name of ['resize', 'kill'] as const) {
    const original = agent[name]
    if (typeof original !== 'function') continue
    agent[name] = (...args: unknown[]) => {
      if (name === 'kill') {
        if (killed) return undefined
        killed = true
      }
      try {
        return (original as (...a: unknown[]) => unknown).apply(agent, args)
      } catch {
        // 終わった PTY への resize・kill（想定内）
        return undefined
      }
    }
  }
}

/** Windows で kill 済みの PTY（killPtyTree の二重の kill を防ぐ） */
const killedWindowsPtys = new WeakSet<IPty>()

/**
 * Windows: シェルが自分で終わったときも、node-pty が PTY ごとに main に作る出力用の Worker を片付ける。
 * node-pty（1.2.0-beta.15 まで）はこれを kill() の中でしか片付けず、`exit` で閉じたシェルのたびに main に Worker が残り続けた。
 * kill() は呼ばない。dispose は何度呼んでもよい
 */
export function releaseWindowsConout(pty: IPty, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  try {
    (pty as unknown as { _agent?: { _conoutSocketWorker?: { dispose?: () => void } } })._agent?._conoutSocketWorker?.dispose?.()
  } catch {
    /* すでに片付いている */
  }
}

/** 表示名。設定のカスタムの id（custom:My_Agent）はカタログの形に直して引く */
export function labelOf(agent: string | null, prefs: AgentPreferences): string {
  return agent ? agentLabel(catalogCustomId(agent) as TuiAgent, prefs) : ''
}

export function shellLabel(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  return base.replace(/\.exe$/i, '')
}
