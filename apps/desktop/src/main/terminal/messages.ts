/**
 * Messages the terminal and agent-send code in main returns to the renderer (Japanese and English).
 * Ported from Ferret src/shared/i18n (the terminal.* / agent.send.* keys) (MIT).
 * Electron-free so the unit tests can load it; index.ts sets the language from settings.
 */
const ja = {
  'agent.send.permission': 'エージェントが確認を待っています。ターミナルで応答してから送ってください。',
  'agent.send.notReady': 'エージェントの入力欄がまだ準備できていません。少し待ってから送ってください。',
  'agent.send.empty': '送る内容がありません。',
  'agent.send.partial': '本文は入れましたが送信できませんでした。ターミナルで Enter を押してください。',
  'agent.send.writeFailed': 'ターミナルへ書き込めませんでした。',
  'terminal.errors.nodePty': 'node-pty を読み込めませんでした。Electron 向けに再ビルドしてください。',
  'terminal.errors.launch': '{{agent}} を起動できません: {{error}}',
  'terminal.send.openTerminal': 'ターミナルを開いてください。',
  'terminal.send.busy': '送っている途中です。',
  'terminal.send.noAgent': 'このプロジェクトのターミナルで動いているエージェントがありません。',
  'terminal.send.pastedNoEnter': '{{agent}} に貼り付けました。内容を確かめて、ターミナルで Enter を押すと送られます。',
  'terminal.send.blocked': 'エージェントが確認を待っています。ターミナルで応答してください。',
  'terminal.send.queued': '作業中のエージェントに送りました。今の作業が終わったら読みます。',
  'terminal.send.exited': 'ターミナルが終了しました。',
  'terminal.send.done': 'エージェントに送りました。結果はターミナルで確かめてください。',
  'terminal.send.doneUnverified': '貼り付けて Enter を送りました。このエージェントは状態を読み取れないので、届いたかはターミナルで確かめてください。',
  'platform.errors.cmdNewline': 'cmd.exe には改行を含む引数を渡せません。',
} as const

export type MessageKey = keyof typeof ja

const en: Record<MessageKey, string> = {
  'agent.send.permission': 'The agent is waiting for confirmation. Respond in the terminal, then send.',
  'agent.send.notReady': "The agent's input isn't ready yet. Wait a moment, then send.",
  'agent.send.empty': 'Nothing to send.',
  'agent.send.partial': 'The text was entered but not sent. Press Enter in the terminal.',
  'agent.send.writeFailed': "Couldn't write to the terminal.",
  'terminal.errors.nodePty': "Couldn't load node-pty. Rebuild it for Electron.",
  'terminal.errors.launch': "Can't start {{agent}}: {{error}}",
  'terminal.send.openTerminal': 'Open a terminal first.',
  'terminal.send.busy': 'Already sending.',
  'terminal.send.noAgent': "No agent is running in this project's terminals.",
  'terminal.send.pastedNoEnter': 'Pasted into {{agent}}. Check it, then press Enter in the terminal to send.',
  'terminal.send.blocked': 'The agent is waiting for confirmation. Respond in the terminal.',
  'terminal.send.queued': 'Sent to the agent while it works. It reads this after the current task.',
  'terminal.send.exited': 'The terminal has exited.',
  'terminal.send.done': 'Sent to the agent. Check the result in the terminal.',
  'terminal.send.doneUnverified': "Pasted and pressed Enter. Solocut can't read this agent's state, so check the terminal.",
  'platform.errors.cmdNewline': "Can't pass arguments containing newlines to cmd.exe.",
}

let language: () => 'ja' | 'en' = () => 'ja'

/** index.ts passes the settings language (read on every message, so a settings change applies at once). */
export function setMessageLanguage(get: () => 'ja' | 'en'): void {
  language = get
}

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const text: string = (language() === 'en' ? en : ja)[key]
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''))
}
