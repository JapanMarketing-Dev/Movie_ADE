// Text of the terminal pane (Japanese / English). Kept next to the terminal code instead of i18n.ts so the
// terminal port does not touch the shared dictionary. Wording follows Ferret's terminal.* / quickLaunch.* keys.
import { useContext } from 'react';
import { LangContext } from '../i18n';

const ja = {
  label: 'ターミナル',
  shell: 'シェル',
  newTab: '新しいタブ',
  newTerminal: '新しいターミナル',
  splitRight: '右に分割',
  splitDown: '下に分割',
  closePane: '区画を閉じる',
  closeTab: 'タブを閉じる',
  closeNamed: '{title} を閉じる',
  paneMenu: '区画のメニュー',
  splitInto: '{count} 区画に分割',
  emptyTitle: 'ターミナルがありません',
  emptyDescription: 'シェルかエージェントを開いてください。',
  openShell: 'シェルを開く',
  jumpToBottom: '一番下へ',
  processExited: 'プロセスが終了しました（終了コード {code}）',
  startFailed: 'ターミナルを開けませんでした: {message}',
  nodePtyHint: 'node-pty が Electron 向けにビルドされていない可能性があります。',
  confirmCloseRunning: 'エージェントが作業中です。閉じると作業が止まります。閉じますか？',
  'state.working': '作業中',
  'state.blocked': '確認待ち',
  'state.done': '終わりました（未確認）',
  'state.idle': '待機中',
  search: '検索（エージェント・タブ・インストール）',
  noMatches: '見つかりません',
  launchAgent: '{agent} を起動',
  tab: 'タブ',
  install: 'インストール',
  installHint: '{agent} をインストール（コマンドを入れます。Enter で実行）',
  fontBigger: '文字を大きく',
  fontSmaller: '文字を小さく',
  fontReset: '文字の大きさを戻す',
} as const;

export type TermKey = keyof typeof ja;

const en: Record<TermKey, string> = {
  label: 'Terminal',
  shell: 'Shell',
  newTab: 'New tab',
  newTerminal: 'New terminal',
  splitRight: 'Split right',
  splitDown: 'Split down',
  closePane: 'Close pane',
  closeTab: 'Close tab',
  closeNamed: 'Close {title}',
  paneMenu: 'Pane menu',
  splitInto: 'Split into {count} panes',
  emptyTitle: 'No terminals',
  emptyDescription: 'Open a shell or an agent.',
  openShell: 'Open a shell',
  jumpToBottom: 'Jump to bottom',
  processExited: 'Process exited (code {code})',
  startFailed: "Couldn't open the terminal: {message}",
  nodePtyHint: 'node-pty may not be built for this Electron.',
  confirmCloseRunning: 'An agent is still working. Closing stops it. Close anyway?',
  'state.working': 'Working',
  'state.blocked': 'Waiting for you',
  'state.done': 'Finished (not seen yet)',
  'state.idle': 'Idle',
  search: 'Search agents, tabs, installs',
  noMatches: 'No matches',
  launchAgent: 'Start {agent}',
  tab: 'Tab',
  install: 'Install',
  installHint: 'Install {agent} (types the command; press Enter to run)',
  fontBigger: 'Bigger text',
  fontSmaller: 'Smaller text',
  fontReset: 'Reset text size',
};

export type TermT = (key: TermKey, vars?: Record<string, string | number>) => string;

let currentLang: 'ja' | 'en' = 'ja';

export function termText(lang: 'ja' | 'en', key: TermKey, vars: Record<string, string | number> = {}): string {
  const text: string = (lang === 'en' ? en : ja)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

/** Outside React (terminalClient writes into xterm): the language the pane last rendered with. */
export function termNow(key: TermKey, vars?: Record<string, string | number>): string {
  return termText(currentLang, key, vars);
}

export function useTermT(): TermT {
  const lang = useContext(LangContext);
  currentLang = lang === 'en' ? 'en' : 'ja';
  return (key, vars) => termText(currentLang, key, vars);
}
