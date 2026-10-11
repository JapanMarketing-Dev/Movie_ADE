# 11. 設定（すべて JSON）

最終更新: 2026-10-11

## 方針

- **設定の正本は JSON ファイル**。ただしアプリでは JSON を見せない。設定画面は Ferret と同じ、ふつうの項目（スイッチ・選択・入力欄）だけで、変えるとすぐこのファイルに保存される
- JSON Schema を公開し、エディタの補完・検証と、エージェントによる変更に使う
- アプリはファイルの変更を監視し、手で書き換えても、エージェントが書き換えても、すぐに反映する
- 不正な値は読み込まずにエラーを表示し、最後に正しく読めた設定で動き続ける（壊れた JSON でアプリが起動しない、を防ぐ）

## ファイルの階層

| ファイル | 範囲 | 例 |
|---|---|---|
| `~/.solocut/settings.json` | 利用者全体 | 保存先のマスタフォルダ、撮影後の自動編集、2つのプロンプト、言語、エージェントの優先順位、文字起こし、録画のデバイス、更新、クラッシュレポート |
| `<project>/solocut.json` | プロジェクト | 使うテンプレート、出力先、ツールのバージョン、プロジェクトだけの上書き |
| `templates/<id>/template.yaml` | テンプレート | 見た目、編集方針、手順（[04](./04_templates_and_agents.md)） |

プロジェクトの設定は、利用者全体の設定を上書きする（同じキーならプロジェクトの値が優先）。

アプリは API キーを扱わない。画像生成はエージェントが Codex（ChatGPT のサブスク）や Gemini CLI（Gemini のサブスク）に頼んで行い、判定モデルは使わなくても全体が動く（既定はオフ）。OS の安全な保管庫に置くのは、投稿先（YouTube・TikTok）の OAuth のトークンだけ。

## settings.json の例

```jsonc
{
  "$schema": "https://solocut.app/schema/settings.v1.json",
  "language": "ja",
  "appearance": { "uiScale": 1.0, "accent": "red" },        // テーマはダークのみ（選択肢なし）
  "agents": {
    "order": ["claude", "codex", "gemini"],
    "failover": { "enabled": true },
    "custom": [{ "id": "custom:my-agent", "label": "My Agent", "command": "my-agent" }],
    "checkUpdates": true
  },
  "recording": {
    "screen": { "fps": 30 },
    "camera": { "deviceId": "default", "width": 1920, "height": 1080, "fps": 30 },
    "mic": { "deviceId": "default" },
    "systemAudio": true,
    "syncMarker": false,
    "hotkeys": { "markNg": "CmdOrCtrl+Shift+N", "markImportant": "CmdOrCtrl+Shift+M" },
    "keystrokeOverlay": true
  },
  "transcription": { "engine": "whisper.cpp", "model": "large-v3-turbo-q5", "language": "ja" },
  "videos": { "root": "~/Movies/Solocut" },                // マスタフォルダ。動画ごとに <root>/<日付>-<名前>/ を作る
  "autopilot": { "autoStart": true },                      // 撮影後に起動プロンプトを自動で送る（docs/13）
  "prompts": { "finish": "…", "publish": "…" },            // 省略 = 組み込みの文（docs/13）
  "decision": { "provider": "off" },                       // 任意。既定はオフで、なくても全体が動く（画面には出さない）
  "library": { "catalog": "solocut-default", "download": "on-demand", "cacheLimitGB": 2, "autoCredits": true },
  "archive": { "autoRegister": ["export", "publish"], "keepPreview": true, "analytics": { "youtube": false } },
  "benchmark": { "keepThumbnails": false, "maxMinutes": 3 },
  "export": { "defaultTargets": ["youtube"], "hwEncodePreview": true },
  "updates": { "channel": "stable", "auto": true },
  "telemetry": { "crashReports": true }
}
```

## エージェントからの変更

- `solocut config get <key>` / `solocut config set <key> <value>` / `solocut config schema` を用意する（JSON をそのまま編集してもよい）
- Claude Code と Codex に `solocut-settings` スキルを入れる。スキルの本文は JSON Schema から自動生成し、各キーの意味と取りうる値を載せる
- 利用者は「カメラを 60fps にして」「字幕のフォントを丸ゴシックに」と頼むだけでよい。エージェントが JSON を書き換え、Solocut が検証して反映する
- 設定の変更も `~/.solocut/settings.history.jsonl` に記録し、戻せるようにする
