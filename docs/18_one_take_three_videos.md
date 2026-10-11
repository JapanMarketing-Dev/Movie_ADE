# 18. 1本の素材から3本（YouTube・TikTok・YouTube Shorts）

最終更新: 2026-10-11

## 方針

**1つの素材（1回の撮影）から、自動で3本の動画を作り、3本とも投稿する。**

| 出力 | 形 | 中身 | 長さの目安 |
|---|---|---|---|
| **YouTube** | 16:9 横長 | 本編（テンプレートどおりに全体を編集したもの） | 素材に応じて（10〜20分の撮影なら 6〜15分） |
| **TikTok** | 9:16 縦 | 本編から見どころを選んで縦に組み替えた版。大きな強調字幕と効果音 | 30〜90秒（テンプレートで設定。上限10分） |
| **YouTube Shorts** | 9:16 縦 | 縦の版。既定は TikTok と同じ切り出しで、冒頭のつかみと説明文を Shorts 向けにする。別の見どころにする設定も選べる | 〜60秒（上限3分） |

利用者は「動画を完成させて」と頼むだけでよい。3本がそろい、「投稿して」で3本が投稿され、続けて SNS で告知される。

## 仕組み: 本編と、派生した版（バリアント）

```
project/
├── timeline.json                    本編（YouTube、16:9）
└── variants/
    ├── tiktok/timeline.json         本編から派生（9:16）
    └── youtube-shorts/timeline.json 本編から派生（9:16）
```

- 派生した版の `timeline.json` も同じ型（[15](./15_timeline_schema.md)）。`meta.derivedFrom` に、元の本編と、どの区間をどう選んだかを残す
- 本編を直すと、派生した版に「本編が変わりました。作り直しますか」の印が付く（`solocut derive` で作り直せる。人が派生した版だけを直した部分は保つ）
- すべてのコマンドが `--variant tiktok|youtube-shorts` を受け付ける（指定しなければ本編）。`solocut render --all`、`solocut check --all` で3本まとめて処理できる

## 縦型への組み替え（`solocut derive --target tiktok`）

1. **区間を選ぶ**: 章の要点（`outline`）、区間の役割（hook / explain / demo / summary）、判定モデルの「単体で見て面白い・分かるか」のスコアから、テンプレートの長さに収まるように選ぶ。冒頭は必ずつかみ（hook）から始める
2. **画面を組み替える**:
   - カメラのみ → 顔を追って 9:16 に切り出す
   - 画面＋ワイプ（技術動画） → 上に画面（操作している箇所を追って切り出す）、下に顔
   - シーンのパターン → 9:16 用の配置で描き直す
3. **字幕を作り直す**: 縦型用のスタイル（大きく、1行の文字数を少なく、単語ハイライト）。セーフエリアは TikTok と Shorts の両方に収まる位置にする
4. **効果音・BGM**: テンプレートの縦型用のルールで付け直す
5. **チェック**: 3本それぞれに、フレーム単位のチェックを行う

選び方の方針は、テンプレートのプロンプト `prompts/vertical.md` に書く（例:「結論を先に言っている区間をつかみにする」「1つの動画で1つのことだけを言う」「60秒以内」）。

## テンプレート

テンプレートは「技術動画」と「語り動画」の2系統を基本にし、どちらも既定で3本を出す。

```yaml
# templates/tech/template.yaml
id: tech
kind: tech
outputs:
  youtube:        { canvas: { width: 1920, height: 1080, fps: 30 }, layout: screen-with-wipe }
  tiktok:         { derive: vertical, maxSec: 90, captions: tiktok-bold, layout: split-v }
  youtube-shorts: { derive: same-as: tiktok, maxSec: 60, hook: shorts }
```

出力を減らしたい人は、テンプレートやプロジェクトの設定で外せる（例: TikTok だけ作らない）。

## 手順（`solocut next`）

```
ingest → sync → transcribe → rough-cut → multicam → captions → sfx → layout → preview → check
  → derive(tiktok) → check(tiktok) → derive(youtube-shorts) → check(youtube-shorts)
  → thumbnail(3本分) → metadata(3本分) → review → final(3本) → publish（人の承認）
```

## 投稿

- 「投稿して」で、3本の投稿内容を1つの確認画面に並べる（YouTube の本編、TikTok、YouTube Shorts）。それぞれのタイトル・説明文・サムネイル・公開範囲・予約日時を確認し、まとめて承認できる
- 承認されたら3本を投稿し、URL がそろったら SNS で告知する（[14](./14_publishing.md)）
- 本編と Shorts は相互にリンクを入れる（Shorts の関連動画に本編を指定し、本編の説明文に Shorts を載せる。できる範囲で）

## サムネイル・メタデータ

- 本編: 16:9 のサムネイル3案（Test & Compare 用）
- TikTok: カバーにするフレームの時刻（TikTok の API はカバーを時刻で指定する）
- Shorts: 9:16 のサムネイル
- タイトル・説明文・タグ・ハッシュタグは、出力先ごとにエージェントが書き分ける
