# 13. プロンプトは2つだけ（起動と投稿）

最終更新: 2026-10-11

## 目指す使い方

```
撮る
  → 撮影が終わると、アプリが「起動プロンプト」をエージェントに自動で送る（人がターミナルを開いたりしない）
  → エージェントがテンプレートの手順を最後まで進める（判定モデルは不要）
     取り込み → 同期 → 文字起こし → カット → 人物を中央に → 字幕 → 効果音・BGM → チェック → 書き出し
     → サムネイル（Codex / Gemini のサブスクで生成） → publish.json（タイトル・説明文・タグ・チャプター）
  → 人が完成した動画を見る。「OK・投稿する」を押すと、アプリが「投稿プロンプト」を送る
  → エージェントが publish.json を確かめて `solocut publish upload` を実行し、URL を報告する（[14](./14_publishing.md)）
```

## 2つのプロンプト

| ID | 名前 | いつ送るか |
|---|---|---|
| `finish` | 起動プロンプト（動画を完成させて） | 撮影の取り込みが終わったとき（設定 `autopilot.autoStart`、既定はオン） |
| `publish` | 投稿プロンプト（投稿して） | 人が投稿画面で「OK・投稿する」を押したとき |

ほかのプロンプト（粗カットだけ・字幕を整えて・告知など）はない。細かい直しは、ターミナルでエージェントに直接頼む。

- 本文はアプリに組み込み（`packages/settings/src/prompts.ts`）。設定画面の「プロンプト」で書き換えられ、`settings.json` の `prompts.finish` / `prompts.publish`（文字列）に保存される。空にするか「既定に戻す」で組み込みの文に戻る
- `prompts.json` のファイル（`~/.solocut/prompts.json`、`<project>/.solocut/prompts.json`）は使わない
- 使える変数: `{{project}}`（動画の名前）、`{{template}}`、`{{date}}`
- 送り先は既定のエージェント（Claude Code）。動いていなければアプリが起動してから送る

### 起動プロンプトの中身（要点）

- `solocut next --autopilot --json` を、done か投稿の手前で人を待つ状態になるまで繰り返す
- 判定モデルは要らない。迷うところは自分で決め、`needsReview` を付けて `.solocut/questions.md` に「要確認」として残し、先へ進む
- 人物（メインのカメラ）は顔が画面の中央に来るように切り抜く
- イラスト・写真は前もってダウンロードしない。使うものだけをその場で取得し、出典・ライセンスを `credits.md` に記録する。プロンプトに載せている無料のライブラリ: いらすとや（1作品20点まで商用無料）、ソコスト、ICOOON MONO、Loose Drawing、unDraw、Openverse、Pixabay / Unsplash / Pexels（写真）
- サムネイルは動画の内容（文字起こし・話題）から作る。フレームをそのまま使う必要はない。画像生成はサブスクの中で行い、API キーは使わない
  1. Codex（ChatGPT のサブスクの組み込み画像生成）: `codex exec --skip-git-repo-check -s workspace-write -C <project> '$imagegen …1280x720…thumbnails/thumb-1.png に保存'`。画像は `~/.codex/generated_images/` にも残る
  2. Gemini CLI（Gemini のサブスク）: `gemini extensions list` で、ログインのまま使える画像生成の拡張があるときだけ
  3. どちらも使えなければ、HTML / SVG や ffmpeg で自作して「要確認」にする
- `publish.json` を書く（形式は [14](./14_publishing.md)）。投稿はしない
- 最後に `.solocut/handoff.md` を更新し、3行で報告する

### 投稿プロンプトの中身（要点）

- `publish.json` を最終の動画と照らし合わせる（タイトル100字以内、説明文5000バイト以内で `<` `>` なし、タグ合計500字以内、サムネイルの有無と大きさ、公開範囲、チャプター）
- 直したうえで `solocut publish upload --json` を実行し、投稿先ごとの URL を報告する

## オートパイロット

`solocut next --autopilot` では、人の確認を待たずに最後まで進む。

| 場面 | 振る舞い |
|---|---|
| 迷う判断 | 一番ありそうな答えで進め、「要確認」の印を付けて一覧に残す |
| チェックの不合格 | 直す。3回直しても合格しなければ、印を付けて先に進む |
| 同期の信頼度が低い | 待つ（ずれた同期は全体を壊すため）。それ以外の手順は先に進める |
| 投稿 | **必ず止まる**。投稿は人が完成した動画を見て OK してから |

```jsonc
// settings.json
"autopilot": {
  "autoStart": true,                  // 撮影後に起動プロンプトを自動で送る
  "stopBefore": ["publish"],
  "maxFixLoops": 3,
  "notify": ["done", "needs-human"]
},
"prompts": {
  "finish": "…",                      // 省略 = 組み込みの文
  "publish": "…"
}
```
