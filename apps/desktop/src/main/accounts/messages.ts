// User-facing sentences of the accounts / usage / failover services (ja / en).
// Ported from Ferret src/shared/i18n/{ja,en}.ts (MIT): only the keys used by these services, with "Ferret"
// replaced by "Solocut".
import type { Lang } from '../../shared/types';

const ja = {
  'usage.errors.rateLimited': '{name} の使用量の取得が制限されています。しばらくしてから再読み込みしてください。',
  'usage.errors.staleToken': '{name} のログインの有効期限が切れている可能性があります。{name} を一度起動すると更新されます。',
  'usage.errors.http': '{name} の使用量を取得できませんでした（HTTP {status}）。',
  'usage.errors.network': '{name} の使用量を取得できませんでした（通信エラー）。',
  'usage.errors.keychain': 'Claude Code の使用量を読めません（キーチェーンの許可が必要）。再読み込みでもう一度試します。',
  'usage.errors.claudeNotLoggedIn': 'Claude Code にログインしていません。',
  'usage.errors.badFormat': '{name} の使用量の形式を読めませんでした。',
  'usage.errors.codexNotLoggedIn': 'Codex にログインしていません。',
  'usage.errors.accountFolderUnusable': '選択中のアカウントの設定フォルダを使えません。',
  'accounts.errors.unusable': '選択中の{agent}アカウントを使えません: {reason}（フッターのアカウント切り替えから選び直してください）',
  'accounts.errors.removeFailed': '{agent}アカウントのフォルダを消せなかったので、アカウントは残しました: {reason}。このアカウントを使っているターミナルのタブを閉じてから、もう一度試してください。',
  'accounts.plan.apiKey': 'API キー',
  'accounts.errors.invalidId': 'アカウントの id が正しくありません。',
  'accounts.errors.notDirectory': '設定フォルダがフォルダではありません。',
  'accounts.errors.folderMissing': '設定フォルダが見つかりません。もう一度ログインしてください。',
  'accounts.errors.pointsToDefault': '設定フォルダがシステムの既定アカウントのフォルダを指しています。',
  'accounts.errors.outsideStore': '設定フォルダが Solocut の置き場所の外を指しています。',
  'accounts.errors.markerBroken': '設定フォルダの所有の印が壊れています。',
  'accounts.errors.markerMismatch': '設定フォルダの所有の印がアカウントと一致しません。',
  'accounts.errors.markerMissing': '設定フォルダに所有の印がありません。',
  'accounts.errors.invalidAgent': 'エージェントの種類が正しくありません。',
  'accounts.errors.gone': 'そのアカウントはもうありません。',
  'accounts.errors.notSignedIn': 'ログインが済んでいないアカウントは選べません。ターミナルでログインを終えてから選んでください。',
  'accounts.errors.noCommand': '{agent} の起動コマンドが見つかりません。',
  'accounts.loginTabTitle': '{agent} ログイン',
  'failover.handoff.updateRequest': 'この作業を別のエージェントに引き継ぐ前に、次のエージェントが続けられるよう "{path}" を更新してください。目的、終わったこと、残りの作業（チェックリスト）、変えたファイル、次にやる一手、関係する feedback.md のパス、注意点を書いてください。短くまとめ、新しい作業は始めないでください。',
  'failover.handoff.readLimit': '{from} が利用上限に達したため、この作業を {to} が引き継ぎます。',
  'failover.handoff.readReturn': '{to} の利用上限が戻ったため、{from} からこの作業を {to} に戻します。',
  'failover.handoff.readSwitch': 'いまの作業を {to} のアカウントで続けます。',
  'failover.note.fileTitle': '引き継ぎ',
  'failover.note.title': 'Solocut による追記（{time}）',
  'failover.note.intro': '{agent} は切り替えの前にこのファイルを更新できませんでした（利用上限に達していたか、応答がありませんでした）。Solocut が分かる範囲を書きます:',
  'failover.note.lastRequest': '直前の依頼:',
  'failover.note.feedback': '対応中のフィードバック: {path}',
  'failover.note.changed': '変更されたファイル（git status）:',
  'failover.note.noChanges': 'コミットしていない変更はありません（git status）。',
  'failover.notice.account': '{agent} の利用上限のため、アカウント {account} で作業を続けます。',
  'failover.notice.switching': 'アカウントを {account} に切り替えます。開いている {agent} {count} 件は、作業が終わったものから引き継いで開き直します。',
  'failover.notice.switched': '{agent} をアカウント {account} に切り替えて、作業を引き継ぎました。',
  'failover.notice.agent': '{from} の利用上限のため、{to} に切り替えました。',
  'failover.notice.return': '{to} が使えるようになったため、{from} から作業を戻しました。',
  'failover.notice.accountForNewTabs': '{agent} が利用上限に近いため、新しい {agent} のタブはアカウント {account} で開きます。',
  'failover.notice.waiting': '{agent} が利用上限に達し、順番のほかのエージェントも上限です。上限が戻れば作業を続けられます。',
  'failover.notice.paused': '短い間に何度か切り替えたため、次の切り替えは {time} からです。',
  'failover.notice.notOpened': '新しい {agent} のタブを開けませんでした。今のタブはそのままです。',
  'failover.notice.notReady': '{agent} を新しいタブで開きました。まだ入力を受け付けていないため、そのタブを確かめてください。',
} as const;

export type MessageKey = keyof typeof ja;

const en: Record<MessageKey, string> = {
  'usage.errors.rateLimited': '{name} usage requests are rate-limited. Reload in a while.',
  'usage.errors.staleToken': 'Your {name} login may have expired. Launch {name} once to refresh it.',
  'usage.errors.http': "Couldn't fetch {name} usage (HTTP {status}).",
  'usage.errors.network': "Couldn't fetch {name} usage (network error).",
  'usage.errors.keychain': "Can't read Claude Code usage (Keychain permission required). Refresh to try again.",
  'usage.errors.claudeNotLoggedIn': 'Not signed in to Claude Code.',
  'usage.errors.badFormat': "Couldn't read the {name} usage format.",
  'usage.errors.codexNotLoggedIn': 'Not signed in to Codex.',
  'usage.errors.accountFolderUnusable': "The selected account's config folder can't be used.",
  'accounts.errors.unusable': "Can't use the selected {agent} account: {reason} (choose another from the account switcher in the footer)",
  'accounts.errors.removeFailed': "Couldn't delete the {agent} account folder, so the account was kept: {reason}. Close the terminal tabs that use this account and try again.",
  'accounts.plan.apiKey': 'API key',
  'accounts.errors.invalidId': 'Invalid account ID.',
  'accounts.errors.notDirectory': "The config folder isn't a folder.",
  'accounts.errors.folderMissing': 'Config folder not found. Sign in again.',
  'accounts.errors.pointsToDefault': "The config folder points to the system default account's folder.",
  'accounts.errors.outsideStore': "The config folder points outside Solocut's storage.",
  'accounts.errors.markerBroken': "The config folder's ownership marker is corrupted.",
  'accounts.errors.markerMismatch': "The config folder's ownership marker doesn't match the account.",
  'accounts.errors.markerMissing': 'The config folder has no ownership marker.',
  'accounts.errors.invalidAgent': 'Invalid agent type.',
  'accounts.errors.gone': 'That account no longer exists.',
  'accounts.errors.notSignedIn': "You can't select an account that hasn't finished signing in. Finish signing in from the terminal first.",
  'accounts.errors.noCommand': 'No launch command found for {agent}.',
  'accounts.loginTabTitle': '{agent} Login',
  'failover.handoff.updateRequest': 'Before this work moves to another agent: update "{path}" so the next agent can continue. Write the goal, what is done, the remaining work as a checklist, the files you changed, the next step, the related feedback.md paths, and anything to watch out for. Keep it short and do not start new work.',
  'failover.handoff.readLimit': '{from} reached its usage limit, so {to} is taking over this work.',
  'failover.handoff.readReturn': 'The usage limit of {to} has reset, so {to} is taking this work back from {from}.',
  'failover.handoff.readSwitch': 'This work continues with the account {to}.',
  'failover.note.fileTitle': 'Handoff',
  'failover.note.title': 'Added by Solocut ({time})',
  'failover.note.intro': '{agent} did not update this file before the switch (it was at its usage limit or not responding). This is what Solocut knows:',
  'failover.note.lastRequest': 'Last request:',
  'failover.note.feedback': 'Feedback being worked on: {path}',
  'failover.note.changed': 'Changed files (git status):',
  'failover.note.noChanges': 'No uncommitted changes (git status).',
  'failover.notice.account': '{agent} reached its usage limit, so the work continues with the account {account}.',
  'failover.notice.switching': 'Switching to the account {account}. {count} open {agent} tab(s) reopen with it as soon as they finish their current work.',
  'failover.notice.switched': 'Switched {agent} to the account {account} and handed over the work.',
  'failover.notice.agent': '{from} reached its usage limit, so {to} took over the work.',
  'failover.notice.return': '{to} is available again, so it took the work back from {from}.',
  'failover.notice.accountForNewTabs': '{agent} is close to its usage limit, so new {agent} tabs now use the account {account}.',
  'failover.notice.waiting': '{agent} reached its usage limit, and the other agents in the order are at their limits too. The work can continue when a limit resets.',
  'failover.notice.paused': 'It switched several times in a short while, so the next switch is possible from {time}.',
  'failover.notice.notOpened': 'A new {agent} tab could not be opened. The current tab is left as it is.',
  'failover.notice.notReady': '{agent} was opened in a new tab. It was not ready for input yet, so please check that tab.',
};

const TABLE: Record<Lang, Record<MessageKey, string>> = { ja, en };

export function msg(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return TABLE[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Error whose message is meant for the user (shown as is; not a bug report). */
export class AccountsUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountsUserError';
  }
}
