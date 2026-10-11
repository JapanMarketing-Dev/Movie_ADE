# 04. テンプレートとエージェント

最終更新: 2026-10-11

## テンプレートの役割

テンプレートは「動画はこう作る」を1か所にまとめた定義。次の3つを兼ねる。

1. **見た目と仕様**: キャンバス、レイアウト、字幕のスタイル、音声、出力
2. **編集方針**: 何を切るか、どこまで詰めるか（自然言語のプロンプト）
3. **作業手順**: エージェントがどの順で何をするか（`pipeline`）と、各手順の合格条件

エージェントは毎回テンプレートから生成された指示書を読み、`solocut next` で次の手順を確認しながら進む。同じテンプレートなら、Claude Code でも Codex でも同じ手順・同じ品質基準で仕上がる。

**テンプレートは1つだけ（2026-10-11）。** アプリは常に標準テンプレート `tech` を使い、利用者がテンプレート・動画の種類・言語を選ぶ画面はない。1回の撮影から **16:9 の動画を1本**（YouTube 形式。画面収録＋人物のカメラ、字幕、カット、BGM・効果音）作る。同じファイルを YouTube にも TikTok にも投稿できる。縦型の別バージョン（TikTok / Shorts 用の派生）、告知用の投稿、「動画3本」は作らない（旧 docs/18 は廃止）。

## テンプレートの構成

```
templates/tech/
├── template.yaml          定義（スキーマで検証する）
├── rules.md               全体の編集方針（そのままエージェントに渡す）
└── prompts/
    ├── rough-cut.md       カットの方針（何を残し、何を切るか）
    ├── multicam.md        画面と顔・カメラの切り替え方（人物のカメラを優先）
    ├── captions.md        字幕の書き方
    ├── sfx.md             効果音・BGM・イラスト（いらすとや等の無料素材）
    ├── thumbnail.md       サムネイルの方向性と作り方（Codex / Gemini のサブスクリプションで作る）
    └── metadata.md        投稿の内容（publish.json）の書き方
```

- `solocut next` は手順ごとに、対応するプロンプトのファイルをエージェントに示す（「この手順では `prompts/multicam.md` に従う」）
- 利用者はプロンプトを書き換えるだけで編集の仕方を変えられる（`~/.solocut/templates/tech/` かプロジェクトの `templates/tech/` に `extends: tech` で上書きを置く）
- 旧テンプレートの id（`talk`、`talk-youtube`、`talk-tiktok`、`shorts-from-long`、`tech-tutorial`、`tech-short`）は既存のプロジェクトのために読み込めるが、一覧には出さない（`alias: true`）。どれも 16:9 の1本だけを作る。古い `outputs` の縦型の設定（`derive` など）は無視する

### 人物を中央に（顔を追う切り抜き）

カメラに人物が映る区間は、**顔がカメラの枠の中央に来るように切り抜く**（`features.faceReframe: true`。`tech` では既定で有効）。

- 顔の解析はアプリ（MediaPipe）が `derived/analysis/faces.<素材>.json` に書く（`fps` は解析の間隔、`f` は素材のフレーム、`t` は素材の秒）
- `solocut tracks apply` が、全画面のカメラ（camera-full）には `focus` と `scale`（cover の切り抜きを最大 1.35 倍に拡大）、丸ワイプには `cameraFocus` と `cameraScale`（最大 1.6 倍）を入れる。拡大は区間ごとに1つ（中央値。ズームが呼吸しない）、位置は one-euro フィルタでなめらかに追う。顔が枠の端にあって中央にできないときは、切り抜きの範囲でできるだけ寄せる
- 顔が複数映るときは、大きく確かな顔を人物とし、一度選んだ人物はほぼ同じ大きさで映っている間は替えない
- 顔が見えない区間・顔の解析がないカメラはそのまま（`tracks apply` の出力 `center.noFace` / `center.noTrack`）。手で決めた切り抜きを残すときは `--no-center`
- 計算は core の `centerPerson` / `faceCrop`（純関数）。描画は compile の cover 切り抜き（`scale=… force_original_aspect_ratio=increase,crop=…`）

### マルチカメラ（画角の切り替え）

複数のカメラで同時に撮った素材を、プロンプトに沿って切り替える。アプリは切り替えの判断をせず、**材料と部品**だけを出す。判定モデルは使わない。

- **人物のカメラ**: 収録の take.json で `role: 'main'` のカメラが人物のカメラ。取り込み（`solocut ingest`）で素材の role を `front` にし、ほかは `other`。`main` がなければ最初のカメラ
- `solocut multicam material` は区間ごとのカメラの材料（顔が映っている割合 faceVisible、目線、鮮明さ、発話、強調語）に加えて、`person`（人物のカメラ）と `suggestions`（決定的な目安: 基本は人物のカメラ。人物の顔が 30% 未満しか見えず、別のカメラがはっきり映しているときだけそちら、needsReview 付き）を返す
- エージェントは目安とプロンプトから自分で決め、`solocut edit split-for-switch` と `setCamera` で反映し、理由を `--reason` に書く。自信がない切り替えには needsReview を付ける
- `camera-switch` のチェックは、同じ画角が長すぎる・言葉の途中で切り替えている箇所を機械的に見つける

### template.yaml（tech の要点）

```yaml
id: tech
extends: base-horizontal
name: { ja: 動画（16:9・1本）, en: Video (16:9, one file) }
kind: tech
targets: [youtube]
canvas: { width: 1920, height: 1080, fps: 30 }
record: { tracks: [screen, camera, mic], cursorLog: true, keyLog: true }
layouts:
  default: screen-with-wipe
  allowed: [screen-with-wipe, screen-full, camera-full, scene]
  wipe: { shape: circle, corner: br, style: circle-gradient }
features: { autoZoom: true, faceReframe: true, keystrokes: true, cursorHighlight: true, piiMask: true }
outputs:
  youtube: { }            # 1本だけ（renders/youtube/final.mp4）
pipeline: [ingest, sync, analyze, transcribe, rough-cut, multicam, captions, sfx, layout, masks, preview, check, final, thumbnail, metadata]
```

- `review`（人の確認）は pipeline に置かない。人は完成した動画をアプリの投稿画面で見て、OK なら投稿する（[14](./14_publishing.md)）
- `publish` の手順・縦型の `derive:*` の手順はない。`solocut derive` と `--variant` も廃止（古いプロジェクトの `variants/` は読むだけ）

技術動画用の機能:

- **自動ズーム**: 収録時のマウスの位置とクリック・キー入力のログから、操作している箇所へ寄る。動きは平滑化し、操作が止まったら引く
- **キー操作の表示**: ショートカットキーを押したときに、画面の隅にキーを表示する（パスワード入力欄にいるときは記録しない）
- **カーソルの強調**: クリックの位置に輪を出す
- **個人情報**: ターミナルやブラウザに出たトークン・メールアドレスを自動でモザイクにする（要確認つき）

## エージェントへの指示書（AGENTS.md）

`solocut init` と、テンプレートを変えたときに自動生成する。`CLAUDE.md` は `@AGENTS.md` を読み込むだけのファイルにして、内容を1か所に保つ。

生成する内容:

1. **役割**: あなたはこのプロジェクトの動画編集者。テンプレート `tech` の手順に従う
2. **最初にすること**: `solocut status --json` と `solocut next --json` を実行する
3. **守ること**
   - `media/` の中は変更しない
   - 編集は `solocut edit` で行う（`timeline.json` を直接編集したら、必ず `solocut validate`）
   - 手順の合格条件を満たすまで、次の手順に進まない
   - 迷ったら編集方針に従って自分で決める（判定モデルは不要）。自信がない判断には needsReview を付けて先へ進み、人に聞きたいことは `.solocut/questions.md` に書く
   - 動画は 16:9 の1本だけ。投稿の内容は `publish.json` に書き、投稿はしない
4. **テンプレートの編集方針**（`rules.md` の全文）
5. **CLI の使い方**（コマンド一覧と `--json` の出力例）
6. **終わったとき**: `.solocut/handoff.md` に、やったこと・残っていること・次の一手を書く

## `solocut next` の動き

`status.json` と各手順の合格条件から、次にやるべきことを1つだけ返す。

```json
{
  "step": "metadata",
  "state": "ready",
  "why": "publish.json がないか、内容が足りません: description: 説明文がありません",
  "do": "prompts/metadata.md に沿って、タイトル・説明文・タグを publish.json に書く（投稿はしない）",
  "commands": ["solocut tl summary --json", "solocut meta set --title \"…\" --description \"…\" --tags a,b --json", "solocut meta check --json"],
  "prompt": "/…/templates/tech/prompts/metadata.md"
}
```

- **どの手順も判定モデル・API キーを必要としない**（[05](./05_decision_model.md)）。判断が要るところは `do` にエージェントへの問いとして書き、決定的な目安（無音・言いよどみの規則、`multicam material` の suggestions など）を出す。自信のない結果は needsReview
- `metadata` は `publish.json` が有効（タイトル・説明文・動画の場所・各上限）なら、印がなくても合格。`thumbnail` は `publish.json` の `thumbnail` が存在する PNG / JPEG を指していれば合格
- `check` で素材が原因の直せない不合格（マイクの音が小さいなど）は、`solocut step check needs-human --note "…"` にすると、自動操縦（`--autopilot`）では先へ進み、人が最後に確認する
- 全部終わると `state: done`（「動画ができました。人が投稿画面で確認し、OK なら投稿します」）。エージェントは handoff.md を書き、投稿はしない

エージェントは、この出力を見て次のコマンドを実行する。テンプレートの手順をエージェントの記憶に頼らず、ツールの側で強制できる。

## エージェントCLIの管理

### 対応するエージェント

組み込みの一覧（`packages/agents/catalog.ts`）を持つ。

| ID | エージェント | 起動 | 非対話モード（フィードバックの整理などに使う） |
|---|---|---|---|
| `claude` | Claude Code | `claude` | `claude -p --output-format json` |
| `codex` | Codex CLI | `codex` | `codex exec --json` |
| `gemini` | Gemini CLI | `gemini` | `gemini -p` |
| `opencode` | OpenCode | `opencode` | `opencode run` |
| `cursor` | Cursor CLI | `cursor-agent` | `cursor-agent -p` |
| `copilot` | GitHub Copilot CLI | `copilot` | `copilot -p` |
| `custom:*` | 利用者が登録したコマンド | 任意 | 任意 |

各項目には、検出用のコマンド、OSごとのインストール方法、更新コマンド、使用量の上限に達したときの出力の特徴（引き継ぎ用）を持たせる。コマンドの細かい引数はバージョンで変わるので、一覧は配布マニフェスト（[07](./07_distribution.md)）で更新できるようにする。

### ターミナル

- node-pty でエージェントを本物の端末として起動する（ログインシェル経由。利用者の PATH や設定がそのまま効く）
- タブでエージェントを切り替える。同じプロジェクトで複数のエージェントを並べることもできる
- エージェントの状態（作業中／入力待ち／完了）を、出力と端末のタイトルから推定し、タブに表示する
- アプリからエージェントへの送信（フィードバック、チェックの結果）は、ブラケットペーストで本文を一度に書き込み、少し待ってから Enter を送る

### 切り替えと引き継ぎ

- 状態はすべてプロジェクトのファイルにあるので、どのエージェントでも `solocut status` から再開できる
- 使用量の上限に達したことを出力から検出したら、次の優先順位のエージェントのタブを開き、「`.solocut/handoff.md` と `solocut next` を見て続けて」と送る（優先順位は設定で決める）

### エージェントCLIの更新

- 起動時と6時間ごとに、インストール済みのエージェントCLIのバージョンを確認する（`claude --version` など、各公式の更新確認の手段を使う）
- 新しいものがあればタブに印を出し、ワンクリックで各公式の更新コマンド（`claude update`、`npm i -g @openai/codex@latest` など）を端末で実行する。勝手には更新しない（作業中の端末を壊さないため）

## 動画フィードバック

### 流れ

```
① 確認画面でプレビューを再生する
② 収録ボタン → 喋りながら、再生・一時停止・シークし、映像の上にペンで囲む・文字を書く
③ 停止
④ 端末内で文字起こし（whisper.cpp）→ 発話とペンの時刻から指摘ごとに分ける
⑤ 指摘ごとに、次の情報を集める
   - タイムコード（タイムラインのフレーム番号）
   - その時点のフレーム画像（ペン入り。solocut frame で本番と同じ画質で取り出す）
   - 発話（原文）
   - その位置・時刻にあるタイムラインの要素（区間 s14、字幕 c52、オーバーレイ o2 など）
     → コンパイラが各要素の画面上の位置を知っているので、ペンで囲んだ範囲と重なる要素を特定できる
⑥ エージェントの非対話モードで、指摘を「要望」の文にまとめる（引用の本文は LLM に書かせず、時刻だけを返させて原文から引く）
⑦ 一覧で確認・修正 → 送信
```

### エージェントに届くもの（feedback/<id>/feedback.md）

```markdown
## 3. [00:01:23:12] 字幕が顔にかかっている
- 要望: この区間の字幕を下へずらし、顔と重ならないようにする
- 発話（原文）: 「ここ、字幕が顔にかぶってて見づらい」
- 画像: ./03.png   ← ペンの囲み入り
- 対象: 字幕 c52（「この設定を変えると」）、区間 s14（レイアウト camera-full）
- 関連するチェック: caption-face-overlap（判定モデルのスコア 0.62、要確認だった）
```

エージェントの端末には「`feedback/<id>/feedback.md` を読んで対応して。終わったら `solocut render --preview` と `solocut check`」という1行を送る。動画そのものは送らない。
