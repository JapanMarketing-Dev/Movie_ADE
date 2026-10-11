/**
 * Settings page sections and the search over them (ported from Ferret src/renderer/lib/settingsSections.ts, adapted
 * to the Solocut settings.json of docs/11). Pure functions only (unit-tested).
 *
 * Like the VS Code / Orca settings pages, a section can be found by the words of its items too (microphone, fps,
 * key…), in English and Japanese, so the same word works whatever the UI language is.
 */
export const SETTINGS_SECTIONS = [
  'general',
  'prompts',
  'agents',
  'accounts',
  'recording',
  'transcription',
  'appearance',
  'language',
  'layout',
  'updates',
  'crashReports',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

const SECTION_KEYWORDS: Record<SettingsSectionId, readonly string[]> = {
  general: ['folder', 'master folder', 'location', 'save', 'storage', 'videos', 'root', 'autopilot', 'auto start', 'automatic', 'after recording',
    'フォルダ', 'マスタフォルダ', '保存先', '保存', '場所', '動画', '自動', '撮影後', 'おまかせ'],
  prompts: ['prompt', 'startup', 'finish', 'publish', 'post', 'request', 'reset', 'default', 'template', 'thumbnail', 'illustration',
    'プロンプト', '起動', '完成', '投稿', '依頼', '既定', '戻す', 'サムネイル', 'イラスト'],
  agents: ['agent', 'claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'custom', 'order', 'failover', 'update', 'command', 'install',
    'エージェント', '順番', '優先', '切り替え', '引き継ぎ', 'カスタム', 'コマンド', '更新', 'インストール'],
  accounts: ['account', 'login', 'sign in', 'usage', 'limit', 'switch', 'claude', 'codex', 'youtube', 'tiktok', 'connect', 'publish',
    'アカウント', 'ログイン', '使用量', '上限', '切り替え', '連携', '接続', '投稿'],
  recording: ['recording', 'camera', 'screen', 'mic', 'microphone', 'fps', 'resolution', 'system audio', 'sync marker', 'hotkey', 'ng', 'keystroke',
    '撮影', '録画', 'カメラ', '画面', 'マイク', '解像度', 'PCの音', '同期', '目印', 'ホットキー', 'キー操作'],
  transcription: ['transcription', 'whisper', 'model', 'speech', 'language', 'large', 'small', '文字起こし', 'モデル', '言語'],
  appearance: ['ui scale', 'zoom', 'size', 'accent', 'dark', 'theme', '拡大', '大きさ', '文字の大きさ', '色', 'ダーク', '外観'],
  language: ['language', 'locale', 'english', 'japanese', 'interface', '言語', '英語', '日本語', '表示'],
  layout: ['layout', 'panel', 'sidebar', 'terminal', 'center', 'preview', 'shortcut', 'keyboard',
    'レイアウト', 'パネル', 'サイドバー', 'ターミナル', 'プレビュー', 'ショートカット', 'キー'],
  updates: ['update', 'version', 'channel', 'beta', 'stable', 'auto', '更新', 'バージョン', 'ベータ', '自動'],
  crashReports: ['crash', 'report', 'sentry', 'privacy', 'telemetry', 'クラッシュ', 'レポート', 'プライバシー'],
  about: ['about', 'version', 'solocut', 'license', 'mit', 'github', 'cli', 'onboarding', 'バージョン', 'について', 'ライセンス', 'はじめに'],
};

/** Fold full-width and case. */
function normalizeSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

/**
 * Sections matching the query, in list order (all for an empty query). Whitespace-separated words must all match
 * (AND) against the id, the current-language title and the keywords.
 */
export function filterSettingsSections(query: string, titleOf: (id: SettingsSectionId) => string): SettingsSectionId[] {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...SETTINGS_SECTIONS];
  return SETTINGS_SECTIONS.filter((id) => {
    const hay = normalizeSearch([id, titleOf(id), ...SECTION_KEYWORDS[id]].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/**
 * The section being read, from the section tops relative to the scroll box: the last one whose top has passed
 * `offset`. The first section when nothing has passed yet; null for no sections.
 */
export function activeSectionAt(tops: ReadonlyArray<{ id: SettingsSectionId; top: number }>, offset = 24): SettingsSectionId | null {
  let current: SettingsSectionId | null = tops[0]?.id ?? null;
  for (const { id, top } of tops) if (top <= offset) current = id;
  return current;
}

/** Read a dotted key from parsed settings (`recording.camera.fps`). */
export function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Parse settings text; comments are not allowed by the app, so invalid JSON is simply undefined. */
export function parseSettingsText(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to save for a prompt textarea (settings `prompts.finish` / `prompts.publish`): undefined (= remove the key, use
 * the built-in default) when the text is blank or the same as the default, else the text as typed.
 */
export function promptSettingValue(draft: string, defaultText: string): string | undefined {
  if (!draft.trim()) return undefined;
  if (draft.trim() === defaultText.trim()) return undefined;
  return draft;
}

/** Move an item up (-1) or down (+1) in a list; out-of-range moves return the same order. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [x] = next.splice(index, 1);
  next.splice(to, 0, x as T);
  return next;
}
