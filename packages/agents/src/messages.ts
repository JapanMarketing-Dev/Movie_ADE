// Launch error messages (Ferret used its i18n table; the package has no UI language, so messages carry both).

const MESSAGES = {
  unclosedQuote: 'クォートが閉じていません。 / Unclosed quote.',
  badArgs: '起動引数を解釈できません / Could not parse the launch arguments: {error}',
  noCommand: '起動コマンドが空です。 / The launch command is empty.',
  flagInCommand:
    '{flag} はコマンドの欄ではなく起動引数の欄に書いてください。 / Put {flag} in the arguments field, not the command field (the command field holds only the program and subcommands).',
  disguisedFlag: '{flag} は引用符やバックスラッシュを使わずに起動引数の欄に書いてください。 / Write {flag} in the arguments field without quotes or backslashes.',
} as const;

export type LaunchErrorKey = keyof typeof MESSAGES;

export function launchError(key: LaunchErrorKey, vars: Record<string, string> = {}): string {
  let s: string = MESSAGES[key];
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}
