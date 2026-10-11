# 16. 素材ライブラリ（効果音・BGM・イラスト・アニメーション）

最終更新: 2026-10-11（各サイトの規約は 2026-10 時点の調査。規約はよく変わるので、規約の要約は配信する JSON で更新する）

## 方針

- **使い回す前提**。毎回素材を探さない。よく使う効果音・BGM・イラスト・アニメーションを最初からそろえ、テンプレートとシーンのパターン（[15](./15_timeline_schema.md)）から決まったものを使う
- 素材の扱いは、規約によって3つに分ける

| 区分 | 条件 | 扱い |
|---|---|---|
| **A. 初期パック**（自動でダウンロード） | CC0、CC BY、MIT / Apache などで**再配布が許されている**もの | Solocut が R2 で配り、初回起動時にダウンロードする。クレジットが必要なものは自動で表記を作る |
| **B. 自分で取り込む** | 利用は無料だが**再配布は禁止**のもの | アプリ内のブラウザで公式サイトを開き、利用者が自分でダウンロードしたものを、ライブラリに自動で取り込む。Solocut はファイルを集めない・配らない |
| **C. 連携しない** | アプリとの連携・組み込みを規約で禁止している、または事前の相談が必要なもの | ボタンを置かない。OS の標準ブラウザで開くだけ。運営の許可が取れたら B に移す |

## 効果音・BGM

### A. 初期パック

| 素材元 | ライセンス | 入れるもの |
|---|---|---|
| Kenney（Interface / UI / Impact / Jingles など） | CC0 | クリック、通知、ポン、ドン、正解・不正解、ジングル |
| OtoLogic | CC BY 4.0（表記必須:「効果音提供 オトロジック(https://otologic.jp)」） | 厳選した数十〜100音（シュッ、キラーン、ピコーンなど）。**同梱前に公式の規約を人が確認する** |
| Freesound / OpenGameArt の CC0 | CC0 | 手作業で選んだタイピング音、ページめくり、whoosh（API で集めたものは R2 に置かない） |
| **Solocut 自作** | CC0 | シンセで作る whoosh、ピコーン、キラーン、ズーム音。Content ID の心配がない |
| BGM | 自作・作曲依頼の **CC0**（5〜10曲：Lo-fi、解説向けの落ち着いた曲、アップテンポ）＋ Kevin MacLeod（CC BY 4.0）の数曲 | 技術動画・語り動画向け |

- サイズの目安: 効果音 200〜400個（Opus）で 20〜40MB、BGM 10曲で約 30MB
- 効果音はインストーラーに入れ、BGM は初回起動時に R2 から取得する

### B. 自分で取り込む

Pixabay、Mixkit、Uppbeat（クレジット必須）、魔王魂（クレジット必須）、甘茶の音楽工房、ポケットサウンド（クレジット必須）、YouTube オーディオ ライブラリ（YouTube でのみ使える）など。

- ダウンロードするのは利用者。Solocut はダウンロードの完了を検知して取り込み、どのサイトの素材かを記録する
- **やらないこと**: ページのスクレイピング、ファイルの URL の組み立て、一括ダウンロード、直リンク

### C. 連携しない

効果音ラボ（アプリへの組み込みを再配布とみなす）、OpenTracks（旧 DOVA-SYNDROME。ツールへの組み込みは事前相談が必要）、Springin' Sound Stock、On-Jin（アプリからの URL の直接指定を禁止）。

## イラスト・アイコン・アニメーション

調査中（いらすとや、ちょうどいいイラスト、Loose Drawing、Open Peeps、Fluent Emoji、LottieFiles など）。結果が出たら A / B / C に振り分ける。

- いらすとやは「1つの制作物につき20点まで」などの規約がある（要確認）ため、**プロジェクトごとに使った点数を数える**機能を持つ
- 背景（波模様など）、枠（グラデーションの枠）、吹き出し、丸ワイプの縁取りは、**Solocut がシーンのパターンとして自作する**（SVG / CSS。MIT）。外部の素材に頼らない

## 素材ごとのライセンス情報

素材1つごとに、次の情報を持つ（`~/.solocut/library/index.sqlite` と、ファイルの横の JSON）。

```jsonc
{
  "id": "sfx_pop_03", "sha256": "…", "kind": "sfx", "category": "pop",
  "title": "Pop 3", "author": "Kenney", "sourceSite": "kenney.nl", "sourceUrl": "https://kenney.nl/assets/interface-sounds",
  "license": { "spdx": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/",
               "attributionRequired": false, "redistributable": true, "commercialOk": true,
               "restrictions": [], "limit": null },
  "contentIdRisk": "low",
  "acquiredAt": "2026-10-11", "tosCheckedAt": "2026-10-11",
  "features": { "durationMs": 180, "lufs": -18.2, "tags": ["ui", "light"] }
}
```

- `restrictions` の例: `no-contentid-registration`、`no-ai-training`、`youtube-only`、`no-game-use`
- `limit` の例: `{ "key": "irasutoya", "perProduction": 20 }`

## 書き出し・投稿時の処理

- **クレジットの自動作成**: タイムラインで使った素材のうち、表記が必要なものについて、各サイトの指定の書式で説明欄用の文を作る（`renders/<target>/credits.txt`。投稿時の説明文にも入れる）
- **警告**:
  - Content ID のリスクが中以上の曲を使ったとき
  - `restrictions` に反する使い方をしたとき（例: YouTube オーディオ ライブラリの曲を TikTok に使った）
  - 点数の上限を超えたとき（例: いらすとやを1作品で21点以上使った）
- **規約の要約の更新**: サイトごとの規約の要約は R2 の `library-terms.json`（署名付き）で配信し、アプリを更新せずに直せるようにする

## 素材の探し方（エージェント向け）

- `solocut sfx search pop --mood light` / `solocut bgm search --mood lofi --bpm 80-100` / `solocut asset search "ビジネスマン 線画"`
- テンプレートの `sfx.rules` と、シーンのパターンのスロット（`hint`）から、エージェントがライブラリを検索して当てはめる
- 新しい素材が必要なときは、エージェントは「どんな素材が要るか」を `.solocut/questions.md` に書き、人が B の方法で取り込む
