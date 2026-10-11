// Crash-report rules shared by main (Sentry init / beforeSend) and unit tests: what may be sent, and the scrubbing
// that runs before anything leaves the machine. Renderer events and minidumps also pass through main's beforeSend,
// so scrubbing here covers every path. Sentry types are not imported; events are plain objects.
//
// Ported from Ferret src/shared/telemetry.ts (MIT): scrubbing (home / project paths, URLs, emails, IPs, API keys),
// breadcrumb allow-list, per-run limiter, send gate, envelope filter, native-crash minimizing, install id, log ring.
// Solocut additions: absolute paths outside the home dir collapse to "<path>/<basename>" (docs/07: no paths).
import type { MinidumpCrash } from './minidump'

/** release name: `solocut@<version>` (the same name the source-map upload uses) */
export const RELEASE_PREFIX = 'solocut'

export function sentryRelease(version: string): string {
  return `${RELEASE_PREFIX}@${version}`
}

/** settings.telemetry.crashReports: unset means on */
export function crashReportsEnabled(settings: { crashReports?: boolean }): boolean {
  return settings.crashReports !== false
}

/** sends only when the setting is on, SOLOCUT_NO_TELEMETRY is not set and this is not a unit test */
export function shouldSendCrashReports(c: { enabled: boolean; optOut: boolean; unitTest: boolean }): boolean {
  return c.enabled && !c.optOut && !c.unitTest
}

interface TelemetryProfile {
  environment: 'production' | 'development'
  /** share of JS errors sent (native crashes are always sent) */
  sampleRate: number
  /** errors / crashes per run */
  maxEventsPerRun: number
  /** handled failures and warnings per run (counted apart so they do not use up the crash budget) */
  maxWarningsPerRun: number
}

/** Solocut has few users yet, so packaged builds send every JS error (deduplicated and capped per run). */
export function telemetryProfile(packaged: boolean): TelemetryProfile {
  return packaged
    ? { environment: 'production', sampleRate: 1, maxEventsPerRun: MAX_EVENTS_PER_RUN, maxWarningsPerRun: 5 }
    : { environment: 'development', sampleRate: 1, maxEventsPerRun: MAX_DEV_EVENTS_PER_RUN, maxWarningsPerRun: 30 }
}

/** 送る前に伏せる材料。プロジェクトのフォルダは設定から渡す */
export interface ScrubContext {
  homeDir?: string
  projectPaths?: readonly string[]
}

/** 例外のメッセージなど、1つの文字列の上限。長い文には画面の中身が入りやすい */
const MAX_STRING_LENGTH = 300

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** http(s)/ws(s) の URL。内蔵ブラウザで開いたページ・API の接続先。app:// と file:// はスタックに要るので残す */
const WEB_URL = /\b(?:https?|wss?):\/\/[^\s"'<>()]+/gi
/** ホームの下の利用者名（/Users/<name>、/home/<name>、C:\Users\<name>）。区切りは / と \ の両方 */
const HOME_UNIX = /(^|[\s"'(=:]|file:\/\/)\/(?:Users|home)\/[^/\\\s"']+/g
const HOME_WIN = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"']+/gi
/**
 * 素の IP アドレス（SECURITY.md で送らないと約束している）。URL の中のものは WEB_URL が先に丸ごと消す。
 * IPv6 は省略形（::）・8区切りの全形・末尾が IPv4 の形・%ゾーン付き。時刻（12:34:56）や C++ の Foo::bar には当てない
 */
const IPV4_CORE = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}`
const IPV4 = new RegExp(String.raw`(?<![\w.])${IPV4_CORE}(?!\w|\.\d)`, 'g')
const H6 = '[0-9a-f]{1,4}'
const IPV6_TAIL = String.raw`(?:${IPV4_CORE}|${H6})`
const IPV6 = new RegExp(
  String.raw`(?<![\w:.])(?:` +
    // 全形（8区切り）。末尾 32bit が IPv4 の形も
    String.raw`(?:${H6}:){7}${H6}|(?:${H6}:){6}${IPV4_CORE}|` +
    // 省略形。:: の前後どちらかに少なくとも1区切り
    String.raw`(?:${H6}(?::${H6}){0,6})?::(?:(?:${H6}:){0,6}${IPV6_TAIL})?` +
  // 後ろの :<ポート>（全形のあとの :443 など）は IP に含めず、IP だけを落とす
  String.raw`)(?:%[\w.-]+)?(?!\w|\.\d|:(?!\d{1,5}(?![\w:])))`,
  'gi'
)
const IP_PLACEHOLDER = '<ip>'

/** よく使われる API キーの形（redact.ts の looksSecret と同じ前置き）、Bearer、JWT、長い16進 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\bxox[bpsar]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[0-9a-f]{32,}\b/gi,
  // Solocut: Google OAuth access / refresh tokens (YouTube publishing)
  /\bya29\.[A-Za-z0-9_-]{10,}/g,
  /(?<![\w/])1\/\/0[A-Za-z0-9_-]{20,}/g
]

/**
 * Solocut: absolute paths that remain after the home dir became "~" keep only their last segment
 * ("ENOENT ~/Movies/take-1/timeline.json" → "ENOENT <path>/timeline.json"). Windows drive paths too.
 */
const WIN_PATH = /[A-Za-z]:[\\/](?:[^\\/\s:"'<>|]+[\\/])+([^\\/\s:"'<>|]+)/g
const UNIX_PATH = /(^|[\s"'(=])(?:~|<project>|\/(?:Users|home|Volumes|private|tmp|var|mnt|media|opt|srv))(?:\/[^/\s"')]+)*\/([^/\s"')]+)/g

export function collapsePaths(s: string): string {
  return s.replace(WIN_PATH, '<path>/$1').replace(UNIX_PATH, '$1<path>/$2')
}

/** 文字列1つから個人の情報を落とす */
export function scrubString(input: string, ctx: ScrubContext = {}, max = MAX_STRING_LENGTH): string {
  let s = input
  // プロジェクトのフォルダはホームより先に（ホームの下にあることが多い）
  for (const p of ctx.projectPaths ?? []) {
    if (p && p.length > 1) s = s.replace(new RegExp(escapeRegExp(p), 'g'), '<project>')
  }
  if (ctx.homeDir && ctx.homeDir.length > 1) s = s.replace(new RegExp(escapeRegExp(ctx.homeDir), 'g'), '~')
  s = s.replace(HOME_UNIX, (_m, lead: string) => `${lead}~`)
  s = s.replace(HOME_WIN, '~')
  s = s.replace(WEB_URL, '<url>')
  s = collapsePaths(s)
  s = s.replace(EMAIL, '<email>')
  s = s.replace(IPV6, (m) => (m === '::' ? m : IP_PLACEHOLDER)).replace(IPV4, IP_PLACEHOLDER)
  for (const re of SECRET_PATTERNS) s = s.replace(re, '<secret>')
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
}

/** スタックのファイル名は長さで切らない（ソースマップの照合に要る） */
/** Sentry が付ける ID（32桁の16進）。秘密の形に見えても触らない */
const ID_KEYS = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'sid', 'replay_id', 'profile_id'])

const UNTRUNCATED_KEYS = new Set(['filename', 'abs_path', 'module', 'debug_id', 'code_file', 'debug_file'])
/** 長くてよい文字列（React のコンポーネントの階層）。伏せる処理は同じ */
const LONG_TEXT_KEYS: Record<string, number> = { componentStack: 2000 }

function scrubDeep(value: unknown, ctx: ScrubContext, key = '', depth = 0): unknown {
  if (depth > 12) return undefined
  if (typeof value === 'string') {
    if (ID_KEYS.has(key)) return value
    return UNTRUNCATED_KEYS.has(key) ? scrubPath(value, ctx) : scrubString(value, ctx, LONG_TEXT_KEYS[key])
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, ctx, key, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, ctx, k, depth + 1)
    return out
  }
  return value
}

/** スタックのファイル名。伏せるのはホームとプロジェクトのパスだけで、長さでは切らない */
function scrubPath(value: string, ctx: ScrubContext): string {
  let s = value
  for (const p of ctx.projectPaths ?? []) if (p && p.length > 1) s = s.split(p).join('<project>')
  if (ctx.homeDir && ctx.homeDir.length > 1) s = s.split(ctx.homeDir).join('~')
  return s.replace(HOME_UNIX, (_m, lead: string) => `${lead}~`).replace(HOME_WIN, '~')
}

/**
 * 残してよい breadcrumb の種類。アプリやウィンドウの出来事（electron）、子プロセスの終了、
 * 起動の失敗（startup。console.error の `[startup]` だけを拾う）。
 * ほかの console・fetch・クリック・画面遷移は、ターミナルの出力やページの URL・要素の文言を含みうるので落とす。
 */
const BREADCRUMB_CATEGORIES = new Set(['electron', 'child-process', 'startup', 'flow'])
/** flow（主要な流れの区切り。src/shared/report.ts）の data に残してよい値：数と、短い識別子（agent 名・種類）だけ */
const FLOW_VALUE = /^[A-Za-z0-9_.:-]{1,40}$/
const MAX_BREADCRUMBS = 30

type Breadcrumb = { category?: string; message?: string; data?: { [key: string]: unknown } }

export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T, ctx: ScrubContext = {}): T | null {
  if (!crumb.category || !BREADCRUMB_CATEGORIES.has(crumb.category)) return null
  // data には URL やウィンドウのタイトルが入るので、子プロセスの終了の情報と、flow の短い識別子以外は持たない
  const data = crumb.category === 'child-process' && crumb.data
    ? pick(crumb.data, ['type', 'reason', 'exitCode', 'name'])
    : crumb.category === 'flow' && crumb.data
      ? flowData(crumb.data)
      : undefined
  const out: Breadcrumb = { ...crumb, data }
  if (!data) delete out.data
  if (typeof out.message === 'string') out.message = scrubString(out.message, ctx)
  return scrubDeep(out, ctx) as T
}

function flowData(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!FLOW_VALUE.test(k)) continue
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && FLOW_VALUE.test(v))) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function electronContext(v: Record<string, unknown>): Record<string, unknown> {
  const details = v.details && typeof v.details === 'object' ? pick(v.details as Record<string, unknown>, ['reason', 'exitCode', 'type', 'name']) : undefined
  return details ? { details } : {}
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** 残してよい contexts（OS・端末・アプリ・実行環境の版）。それ以外は落とす */
// crash は minimizeNativeCrash が形を確かめて作る落ちた場所（モジュール名+位置・symbols の ID・スレッド名）。
// ここで落としていたため、FERRET-1Q は 0.4.21 から 0.6.2 まで場所が届かなかった
const ALLOWED_CONTEXTS = new Set(['os', 'device', 'app', 'runtime', 'electron', 'chrome', 'node', 'gpu', 'culture', 'trace', 'react', 'block', 'startup', 'crash'])

type EventLike = {
  user?: unknown
  breadcrumbs?: Breadcrumb[]
  contexts?: object
  exception?: unknown
  message?: unknown
}

/**
 * Sentry へ送る前のイベントから個人の情報を落とす。
 * user・request・extra・server_name は丸ごと持たない。残る文字列は全部 scrubString を通す。
 */
export function scrubEvent<T extends EventLike>(event: T, ctx: ScrubContext = {}): T {
  const copy = { ...event } as EventLike & Record<string, unknown>
  // 利用者は、端末ごとに作ったランダムな ID（インストール ID）だけを残す（「影響を受けた人数」を数えるため）。
  // 名前・メール・IP は持たない
  const userId = (copy.user as { id?: unknown } | undefined)?.id
  // 空の geo も必ず置く。Sentry は IP を送らなくても（infer_ip: never・ip_address: null でも）接続元の IP から
  // 市区町村を推定して user.geo に入れるが、geo が既にあれば推定しない（2026-10-04 に verification へ送って確かめた）
  copy.user = isInstallId(userId) ? { id: userId, geo: {} } : { geo: {} }
  delete copy.request
  delete copy.extra
  delete copy.server_name
  if (copy.contexts) {
    const contexts: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(copy.contexts)) {
      if (!ALLOWED_CONTEXTS.has(k) || !v || typeof v !== 'object') continue
      // 端末名・機種の ID・起動した時刻など、端末の識別につながる項目は落とす
      const { name: _n, model_id: _m, boot_time: _b, ...rest } = v as Record<string, unknown>
      // electron には crashpad の注釈・クラッシュした画面の URL が入るので、終了の情報だけを残す
      contexts[k] = k === 'device' ? rest : k === 'electron' ? electronContext(v as Record<string, unknown>) : v
    }
    copy.contexts = contexts
  }
  if (copy.breadcrumbs) {
    copy.breadcrumbs = copy.breadcrumbs
      .map((b) => scrubBreadcrumb(b, ctx))
      .filter((b): b is Breadcrumb => b !== null)
      .slice(-MAX_BREADCRUMBS)
  }
  return scrubDeep(copy, ctx) as T
}

/**
 * 同じエラーを何度も送らないための鍵。例外の種類・メッセージ・一番上のフレームで決める。
 * 1回の起動で同じ鍵は1度だけ送る（無料の上限の中に収める）。
 */
function eventFingerprint(event: EventLike): string {
  const values = (event.exception as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? []
  const last = values[values.length - 1]
  if (!last) return `msg:${String(event.message ?? '')}`
  const frames = ((last.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined)?.frames ?? [])
  const top = frames[frames.length - 1]
  return [last.type, last.value, top?.filename, top?.function, top?.lineno].map((v) => String(v ?? '')).join('|')
}

/** 1回の起動で送る数の上限。暴走しているときに無料の枠を使い切らない */
export const MAX_EVENTS_PER_RUN = 10
/** dev 起動の上限。開発者の手元だけなので多めに集める（重複の抑止は同じ） */
const MAX_DEV_EVENTS_PER_RUN = 50

/** 起動ごとの送信の抑え（重複と上限）。テストのため状態を外に持てる形にする */
export function createEventLimiter(max = MAX_EVENTS_PER_RUN): (event: EventLike) => boolean {
  const seen = new Set<string>()
  let sent = 0
  return (event) => {
    if (sent >= max) return false
    const key = eventFingerprint(event)
    if (seen.has(key)) return false
    seen.add(key)
    sent += 1
    return true
  }
}

/**
 * JS の例外は半分だけ送る（同じ不具合は多くの人で起きるので、半分でも気づける）。
 * ネイティブのクラッシュ（minidump）は数が少なく重いので、全部送る。
 */
const JS_ERROR_SAMPLE_RATE = 0.5

export function sampleEvent(isNativeCrash: boolean, random: () => number = Math.random, rate = JS_ERROR_SAMPLE_RATE): boolean {
  return isNativeCrash || random() < rate
}

/**
 * did-fail-load を送るか。アプリ自身の画面（main の renderer・録画ウインドウ・プレビュー）の読み込み失敗だけを送る。
 * 内蔵ブラウザで開いた利用者のページ（別のセッション）は、相手のサーバーが止まっているなど利用者側の失敗が
 * 普通に起きるので送らない。-3（ERR_ABORTED）は次の読み込みで前の読み込みが止まっただけなので送らない。
 */

export function shouldReportLoadFailure(f: { ownPage: boolean; errorCode: number; isMainFrame: boolean }): boolean {
  if (!f.isMainFrame || f.errorCode === -3) return false
  return f.ownPage
}

/** Solocut 自身の実行ファイルの名前か（配布版の solocut・Solocut.exe、dev の electron。小文字で比べる） */
export function isOwnExecutable(name: string): boolean {
  return /^(solocut|electron)(\.exe)?$/.test(name.toLowerCase())
}

/** render-process-gone / child-process-gone を送るか。正常終了と、利用者が止めた（killed）ものは送らない */
export function shouldReportProcessGone(reason: string): boolean {
  return reason !== 'clean-exit' && reason !== 'killed'
}

/**
 * minimizeNativeCrash を通したネイティブのクラッシュを送るか。main（browser）以外のプロセスが外から止められた（killed）・
 * 正常に終わった（clean-exit）ものは、shouldReportProcessGone と同じく送らない。
 * macOS の Utility が SIGTERM（exitCode 15）で止められたときも crashpad が報告を作り、SDK が「Native crash (Utility, killed)」として送っていた（Sentry FERRET-1V）。
 * main は前の起動の理由が分からない（unknown）ことが多いので、理由では捨てない。
 * 子のプロセスが dyld で読み込みの途中に外から止められた報告（例外なし crash.code 0x0・落ちた場所が dyld）も同じく送らない。
 * 次の起動で見つかった報告はプロセスと理由が分からない（unknown）ため、killed で捨てられずに「Native crash (unknown): dyld」になっていた（Sentry FERRET-1W。1V と同じ形）
 *
 * Ferret の外のプログラムの報告も送らない。macOS では crashpad の例外の受け口（mach の exception port）が子に引き継がれるため、
 * ターミナルから起動したプログラム（Playwright の headless_shell など）が落ちても Ferret の報告になり、
 * 「Native crash (unknown): headless_shell」として届いてクラッシュしなかった割合も下げていた（Sentry FERRET-1X・FERRET-Q）。
 * 実行ファイルの名前（crash.exe）が分かって、Ferret（配布版の ferret・ferret.exe、dev の electron）でなければ捨てる。
 * Ferret の helper（「Ferret Helper (Renderer)」など）は名前に空白が入り crash.exe が付かないので、これまでどおり送る
 */
export function shouldSendNativeCrash(event: { tags?: object }): boolean {
  const tags = (event.tags ?? {}) as Record<string, unknown>
  if (tags['event.process'] === 'browser') return true
  if (typeof tags['crash.exe'] === 'string' && !isOwnExecutable(tags['crash.exe'])) return false
  if (tags['crash.code'] === '0x0' && tags['crash.module'] === 'dyld') return false
  return typeof tags['exit.reason'] !== 'string' || shouldReportProcessGone(tags['exit.reason'])
}

/**
 * インストール ID：端末（userData）ごとに1度だけ作るランダムな UUID。利用者の情報は何も含まない。
 * 「影響を受けた人数」と、リリースごとのクラッシュしなかった人の割合を数えるためだけに使う
 */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isInstallId(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_ID.test(value)
}

/** 保存してあった ID が使えればそれを、無い・壊れていれば新しく作る（作ったかどうかも返す） */
export function resolveInstallId(saved: string | null | undefined, create: () => string): { id: string; created: boolean } {
  const v = saved?.trim()
  if (isInstallId(v)) return { id: v, created: false }
  return { id: create(), created: true }
}

/**
 * クラッシュのイベントか。ネイティブのクラッシュ（minidump）、fatal、捕まえていない例外。
 * これにだけ main の直前のログを添付する
 */
export function isCrashEvent(event: { level?: unknown; exception?: unknown }, isNativeCrash: boolean): boolean {
  if (isNativeCrash || event.level === 'fatal') return true
  const values = (event.exception as { values?: Array<{ mechanism?: { handled?: unknown } }> } | undefined)?.values ?? []
  return values.some((v) => v.mechanism?.handled === false)
}

/** 添付する main のログの行数と、1行の長さの上限 */
const LOG_RING_LINES = 50
export const LOG_LINE_MAX = 160

/**
 * main のログの直近の行（クラッシュに添付する）。
 * `[startup]` `[recording]` のようにアプリが付けた見出しで始まる行だけを残す（ターミナルの出力・文字起こし・
 * 指摘の本文が混ざらないように）。1行は短く切り、パス・URL・メール・キーは送る前の除去と同じ規則で伏せる
 */
export function createLogRing(max = LOG_RING_LINES, ctx: () => ScrubContext = () => ({})) {
  const lines: string[] = []
  return {
    push(level: string, args: unknown[]): void {
      const first = args[0]
      if (typeof first !== 'string' || !/^\[[\w:.-]{1,24}\]/.test(first)) return
      const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : '')).filter(Boolean).join(' ')
      lines.push(`${new Date().toISOString()} ${level} ${scrubString(text, ctx(), LOG_LINE_MAX)}`)
      if (lines.length > max) lines.shift()
    },
    snapshot(): string {
      return lines.join('\n')
    }
  }
}

/**
 * 「クラッシュレポートを送る」を起動中に切り替えたときの扱い。allow() は送る直前に毎回呼び、そのときの設定で決める
 * （OFF にした瞬間から、エラー・warning・セッション・添付・renderer のイベントまで全部止まる）。
 * ON / OFF が変わったら onDisable / onEnable を1度だけ呼ぶ（セッションを閉じる・始め直す）
 */
export function createSendGate(isEnabled: () => boolean, hooks: { onDisable?: () => void; onEnable?: () => void } = {}) {
  let last = isEnabled()
  const sync = (): boolean => {
    const now = isEnabled()
    if (now !== last) {
      last = now
      if (now) hooks.onEnable?.()
      else hooks.onDisable?.()
    }
    return now
  }
  return { allow: sync, sync }
}

/**
 * 送ってよい添付。main の直近のログ（見出し付きの行だけ・行ごとに伏せ字済み。createLogRing）だけ。
 * minidump（ネイティブのクラッシュのメモリの写し）は、キー・パス・画面の文などが入りうるのに伏せ字を通せないので送らない（security-2 [13]）
 */
export const ALLOWED_ATTACHMENTS: ReadonlySet<string> = new Set(['main-log.txt'])

type AttachmentLike = { filename?: unknown; attachmentType?: unknown }

export function isAllowedAttachment(attachment: AttachmentLike): boolean {
  return typeof attachment.filename === 'string' && ALLOWED_ATTACHMENTS.has(attachment.filename) &&
    (attachment.attachmentType === undefined || attachment.attachmentType === 'event.attachment')
}

/**
 * 送ってよい envelope の項目。beforeSend（伏せ字）を通ったイベント、セッション（数だけ）、送れなかった数、許した添付だけ。
 * renderer から直接届く span・profile・feedback・replay などは beforeSend を通らないので送らない
 */
const ALLOWED_ENVELOPE_ITEMS = new Set(['event', 'session', 'sessions', 'client_report', 'attachment'])

/** envelope から送ってよくない項目を落とす。何も残らない・形が違うときは null（送らない） */
export function filterEnvelope<E>(envelope: E): E | null {
  if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[1])) return null
  const items = (envelope[1] as unknown[]).filter((item) => {
    const header = (Array.isArray(item) ? item[0] : undefined) as { type?: unknown; filename?: unknown; attachment_type?: unknown } | undefined
    if (!header || typeof header.type !== 'string' || !ALLOWED_ENVELOPE_ITEMS.has(header.type)) return false
    return header.type !== 'attachment' || isAllowedAttachment({ filename: header.filename, attachmentType: header.attachment_type })
  })
  return items.length > 0 ? ([envelope[0], items] as E) : null
}

/**
 * 送る直前の transport を包み、filterEnvelope を通す。オフラインの置き場から後で送るもの（前の版がためたものも含む）も、
 * ここを通ってから送られる
 */
export function filterTransport<T extends { send: (envelope: never) => PromiseLike<unknown> }>(base: T): T {
  return {
    ...base,
    send: (envelope: never) => {
      const filtered = filterEnvelope(envelope)
      return filtered ? base.send(filtered) : Promise.resolve({})
    }
  }
}

/**
 * Sentry の transport を包む。allow() が false のあいだは何も送らない（セッション・renderer のイベントも含む）。
 * 送るときも filterEnvelope を通し、伏せ字を通らない項目（minidump・span など）を最後にもう一度落とす
 */
export function gateTransport<T extends { send: (envelope: never) => PromiseLike<unknown>; flush: (timeout?: number) => PromiseLike<boolean> }>(base: T, allow: () => boolean): T {
  return {
    ...base,
    send: (envelope: never) => {
      const filtered = allow() ? filterEnvelope(envelope) : null
      return filtered ? base.send(filtered) : Promise.resolve({})
    },
    flush: (timeout?: number) => base.flush(timeout)
  }
}

type NativeCrashLike = {
  platform?: unknown
  tags?: Record<string, unknown>
  contexts?: Record<string, unknown>
  [key: string]: unknown
}

/** Electron が V8 のメモリ不足で落ちたときに付ける crashpad の注釈があるか */
function isV8OomCrash(event: NativeCrashLike): boolean {
  const electron = event.contexts?.electron as Record<string, unknown> | undefined
  if (electron && Object.keys(electron).some((k) => k.includes('v8-oom'))) return true
  const values = (event.exception as { values?: Array<{ type?: unknown }> } | undefined)?.values
  return Array.isArray(values) && values.some((v) => v?.type === 'OutOfMemoryError')
}

/** ネイティブのクラッシュ（minidump から作られたイベント）か */
export function isNativeCrashEvent(event: { platform?: unknown; tags?: object }, hasMinidump: boolean): boolean {
  return hasMinidump || event.platform === 'native' || (event.tags as Record<string, unknown> | undefined)?.['event.environment'] === 'native'
}

const CRASH_VALUE = /^[A-Za-z0-9_.-]{1,40}$/
const crashValue = (v: unknown): string | undefined => (typeof v === 'string' && CRASH_VALUE.test(v) ? v : undefined)
/** ネイティブのクラッシュに残すタグ（どのプロセスが・なぜ・どの版と環境で） */
const NATIVE_CRASH_TAGS = ['os.platform', 'arch', 'electron', 'build', 'app.mode']
/** 落ちる前の main の様子（watchMainHealth が scope に付けた区分。memoryBucket・uptimeBucket の形だけ） */
const NATIVE_CRASH_BUCKET_TAGS = ['mem.rss', 'mem.heap', 'uptime']
/** ネイティブのクラッシュに残す flow のパンくずの数（直近から） */
export const NATIVE_CRASH_FLOW_LIMIT = 30
const FLOW_MESSAGE = /^[a-z][a-z0-9 :_-]{0,39}$/
const STACK_ENTRY = /^[a-z0-9_.+-]{1,40}\+0x[0-9a-f]{1,12}$/
const HEX_ID = /^[0-9A-F]{8,48}$/
const THREAD_NAME = /^[A-Za-z0-9 _.:#/-]{1,40}$/

/** 前の起動のパンくずから、Solocut の flow だけを形を確かめて残す */
function nativeCrashFlow(breadcrumbs: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(breadcrumbs) ? breadcrumbs : (breadcrumbs as { values?: unknown } | undefined)?.values
  if (!Array.isArray(list)) return []
  const out: Array<Record<string, unknown>> = []
  for (const b of list as Array<Record<string, unknown>>) {
    if (b?.category !== 'flow' || typeof b.message !== 'string' || !FLOW_MESSAGE.test(b.message)) continue
    const data = b.data && typeof b.data === 'object' ? flowData(b.data as Record<string, unknown>) : undefined
    out.push({ category: 'flow', message: b.message, ...(typeof b.timestamp === 'number' ? { timestamp: b.timestamp } : {}), ...(data && Object.keys(data).length ? { data } : {}) })
  }
  return out.slice(-NATIVE_CRASH_FLOW_LIMIT)
}

/** minidump から読んだ落ちた場所の手がかり（形を確かめたものだけ） */
function nativeCrashContext(dump: MinidumpCrash | null | undefined): Record<string, unknown> | null {
  if (!dump) return null
  const out: Record<string, unknown> = {}
  if (dump.module && crashValue(dump.module) && dump.offset && /^0x[0-9a-f]{1,12}$/.test(dump.offset)) out.location = `${dump.module}+${dump.offset}`
  if (dump.debugId && HEX_ID.test(dump.debugId)) out.debug_id = dump.debugId
  if (dump.codeId && HEX_ID.test(dump.codeId)) out.code_id = dump.codeId
  if (dump.thread && THREAD_NAME.test(dump.thread)) out.thread = dump.thread
  const stack = (dump.stack ?? []).filter((e) => STACK_ENTRY.test(e))
  if (stack.length) out.stack = stack
  return Object.keys(out).length ? out : null
}
const BUCKET_VALUES = new Set(['<256MB', '256-512MB', '512MB-1GB', '1-2GB', '2GB+', '<1m', '1-10m', '10-60m', '1-4h', '4-24h', '1d+'])

/**
 * ネイティブのクラッシュは「起きたこと」だけを送る：プロセスの種類・終了の理由・版（security-2 [13]）。
 * crashpad の注釈・クラッシュした画面の URL・スタックのメモリの中身は持たない。
 * 原因を追えるように、次の2つだけは残す（2026-10-07、FERRET-1Q で手がかりが無かったため）:
 *   - contexts.crash: minidump から読んだ、落ちた場所と、落ちたスレッドのスタックの中のモジュールの位置（`name+0xoffset`）・
 *     symbols を引く ID・スレッド名（@shared/minidump。アドレスそのもの・メモリの中身・パスは含まない）
 *   - 前の起動のパンくずのうち、Ferret 自身の flow（@shared/report の flow。固定の文と列挙した値）だけを直近 NATIVE_CRASH_FLOW_LIMIT 件。
 *     Electron が付けるパンくず（URL・ウインドウの題名を含みうる）は捨てる
 */
export function minimizeNativeCrash<E extends { tags?: object; contexts?: object }>(input: E, dump?: MinidumpCrash | null): E {
  const event = input as unknown as NativeCrashLike
  const proc = crashValue(event.tags?.['event.process']) ?? 'unknown'
  const electron = event.contexts?.electron as { details?: Record<string, unknown> } | undefined
  const reason = crashValue(event.tags?.['exit.reason']) ?? crashValue(electron?.details?.reason)
  const exitCode = electron?.details?.exitCode
  const tags: Record<string, string> = { 'event.environment': 'native', 'event.process': proc }
  if (reason) tags['exit.reason'] = reason
  for (const k of NATIVE_CRASH_TAGS) {
    const v = crashValue(event.tags?.[k])
    if (v) tags[k] = v
  }
  for (const k of NATIVE_CRASH_BUCKET_TAGS) {
    const v = event.tags?.[k]
    if (typeof v === 'string' && BUCKET_VALUES.has(v)) tags[k] = v
  }
  // なぜ落ちたか：minidump の例外の種類と落ちた場所のモジュール名、V8 のメモリ不足の印（注釈の有無だけ。中身は送らない）
  const oom = isV8OomCrash(event) || dump?.kind === 'oom'
  const code = crashValue(dump?.code)
  const module = crashValue(dump?.module)
  const kind = oom ? 'oom' : crashValue(dump?.kind)
  if (code) tags['crash.code'] = code
  if (kind) tags['crash.kind'] = kind
  if (module) tags['crash.module'] = module
  const exe = crashValue(dump?.executable)
  if (exe) tags['crash.exe'] = exe
  const app = event.contexts?.app as Record<string, unknown> | undefined
  const os = event.contexts?.os as Record<string, unknown> | undefined
  const contexts: Record<string, unknown> = {
    electron: { details: { reason: reason ?? 'unknown', ...(typeof exitCode === 'number' ? { exitCode } : {}) } }
  }
  if (app) contexts.app = { app_version: app.app_version, app_arch: app.app_arch }
  if (os) contexts.os = { name: os.name, version: os.version }
  const crash = nativeCrashContext(dump)
  if (crash) contexts.crash = crash
  const flow = nativeCrashFlow(event.breadcrumbs)
  const out: NativeCrashLike = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: 'fatal',
    platform: 'native',
    release: event.release,
    environment: event.environment,
    user: event.user,
    sdk: event.sdk,
    message: `Native crash (${proc}${reason ? `, ${reason}` : ''})${kind || module ? `: ${[kind, module].filter(Boolean).join(' in ')}` : ''}`,
    fingerprint: ['native-crash', proc, reason ?? 'unknown', ...(kind ? [kind] : []), ...(module ? [module] : [])],
    tags,
    contexts,
    ...(flow.length ? { breadcrumbs: flow } : {})
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as unknown as E
}

/** メモリの量のおおまかな区分（タグにする） */
export function memoryBucket(mb: number): string {
  if (mb < 256) return '<256MB'
  if (mb < 512) return '256-512MB'
  if (mb < 1024) return '512MB-1GB'
  if (mb < 2048) return '1-2GB'
  return '2GB+'
}

/** 起動からの時間のおおまかな区分（タグにする） */
export function uptimeBucket(seconds: number): string {
  if (seconds < 60) return '<1m'
  if (seconds < 600) return '1-10m'
  if (seconds < 3600) return '10-60m'
  if (seconds < 4 * 3600) return '1-4h'
  if (seconds < 24 * 3600) return '4-24h'
  return '1d+'
}

/** 意味の無い Electron の出来事（補助技術の切り替えの通知など）。同じものが続けて来るので捨てる */
const NOISY_BREADCRUMBS = new Set(['app.accessibility-support-changed'])

/** パンくずを間引く。騒がしい出来事は捨て、直前と同じもの（種類と文が同じ）が続くときは1つにする */
export function createBreadcrumbFilter() {
  let last = ''
  return (crumb: { category?: string; message?: string }): boolean => {
    if (crumb.category === 'electron' && crumb.message && NOISY_BREADCRUMBS.has(crumb.message)) return false
    const key = `${crumb.category ?? ''}\u0000${crumb.message ?? ''}`
    if (key === last) return false
    last = key
    return true
  }
}
