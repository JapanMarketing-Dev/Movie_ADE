/**
 * Settings page sections and the search over them (ported from Ferret src/renderer/lib/settingsSections.ts, adapted
 * to the Solocut settings.json of docs/11). Pure functions only (unit-tested).
 *
 * Like the VS Code / Orca settings pages, a section can be found by the words of its items too (microphone, fps,
 * key…), in English and Japanese, so the same word works whatever the UI language is.
 */
export const SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'language',
  'layout',
  'recording',
  'transcription',
  'decision',
  'imageGen',
  'agents',
  'accounts',
  'prompts',
  'library',
  'publishing',
  'updates',
  'crashReports',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

const SECTION_KEYWORDS: Record<SettingsSectionId, readonly string[]> = {
  general: ['settings.json', 'json', 'file', 'autopilot', 'stop before', 'fix loops', 'export', 'targets', 'archive', 'benchmark',
    '設定ファイル', 'オートパイロット', '書き出し', '出力先', 'アーカイブ', '過去の動画', 'ベンチマーク'],
  appearance: ['ui scale', 'zoom', 'size', 'accent', 'dark', 'theme', '拡大', '大きさ', '文字の大きさ', '色', 'ダーク', '外観'],
  language: ['language', 'locale', 'english', 'japanese', 'interface', '言語', '英語', '日本語', '表示'],
  layout: ['layout', 'panel', 'sidebar', 'terminal', 'center', 'preview', 'shortcut', 'keyboard',
    'レイアウト', 'パネル', 'サイドバー', 'ターミナル', 'プレビュー', 'ショートカット', 'キー'],
  recording: ['recording', 'camera', 'screen', 'mic', 'microphone', 'fps', 'resolution', 'system audio', 'sync marker', 'hotkey', 'ng', 'keystroke',
    '撮影', '録画', 'カメラ', '画面', 'マイク', '解像度', 'PCの音', '同期', '目印', 'ホットキー', 'キー操作'],
  transcription: ['transcription', 'whisper', 'model', 'speech', 'language', 'large', 'small', '文字起こし', 'モデル', '言語'],
  decision: ['decision', 'judge', 'check', 'subscription', 'claude', 'codex', 'gemini', 'ollama', 'openai', 'typesafe', 'budget', 'limit', 'cloud', 'consent', 'usd',
    '判定', '判定モデル', 'チェック', 'サブスク', '上限', '費用', '同意', 'クラウド'],
  imageGen: ['image', 'thumbnail', 'codex', 'gemini', 'openai', 'gpt-image', '画像', '画像生成', 'サムネイル'],
  agents: ['agent', 'claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'custom', 'order', 'failover', 'update', 'command',
    'エージェント', '順番', '優先', '切り替え', '引き継ぎ', 'カスタム', 'コマンド', '更新'],
  accounts: ['account', 'login', 'sign in', 'usage', 'limit', 'api key', 'key', 'youtube', 'oauth', 'keychain',
    'アカウント', 'ログイン', '使用量', '上限', 'キー', '保管庫'],
  prompts: ['prompt', 'prompts.json', 'request', 'autopilot', 'button', 'hide', 'プロンプト', '依頼', 'ボタン', '非表示'],
  library: ['library', 'tools', 'ffmpeg', 'ffprobe', 'whisper', 'fonts', 'download', 'install', 'cache', 'credits', 'assets', 'sfx', 'bgm',
    'ライブラリ', 'ツール', 'ダウンロード', 'インストール', 'キャッシュ', 'クレジット', '素材', '効果音'],
  publishing: ['publish', 'youtube', 'tiktok', 'shorts', 'instagram', 'x', 'threads', 'facebook', 'upload', 'client id',
    '投稿', '告知', 'アップロード', 'クライアント'],
  updates: ['update', 'version', 'channel', 'beta', 'stable', 'auto', '更新', 'バージョン', 'ベータ', '自動'],
  crashReports: ['crash', 'report', 'sentry', 'privacy', 'telemetry', 'クラッシュ', 'レポート', 'プライバシー'],
  about: ['about', 'version', 'solocut', 'license', 'mit', 'github', 'バージョン', 'について', 'ライセンス'],
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

/** Move `id` to the front of an order list (agents.order, imageGen.order), keeping the rest in order without duplicates. */
export function preferFirst(order: readonly string[], id: string): string[] {
  return [id, ...order.filter((x) => x !== id)];
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
