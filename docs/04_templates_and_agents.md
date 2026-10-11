# 04. テンプレートとエージェント

最終更新: 2026-10-11

## テンプレートの役割

テンプレートは「この種類の動画は、こう作る」を1か所にまとめた定義。次の3つを兼ねる。

1. **見た目と仕様**: キャンバス、レイアウト、字幕のスタイル、音声、出力先
2. **編集方針**: 何を切るか、どこまで詰めるか、判定モデルのしきい値
3. **作業手順**: エージェントがどの順で何をするか（`pipeline`）と、各手順の合格条件

エージェントは毎回テンプレートから生成された指示書を読み、`solocut next` で次の手順を確認しながら進む。同じテンプレートなら、Claude Code でも Codex でも同じ手順・同じ品質基準で仕上がる。

## テンプレートの構成

```
templates/tiktok-talk/
├── template.yaml      定義（スキーマで検証する）
├── rules.md           自由記述の編集方針（そのままエージェントに渡す）
├── layouts/           レイアウトの定義（YAML）
├── styles/            字幕のスタイル（ASS のスタイル定義＋アニメーション）
├── assets/            既定のフォント、ロゴの位置、効果音
└── examples/          良い例・悪い例のフレーム（判定モデルの参考画像に使う）
```

### template.yaml の例（TikTok 縦型トーク）

```yaml
id: tiktok-talk
name: TikTok 縦型トーク
extends: base-vertical           # 継承できる
targets: [tiktok, youtube-shorts, instagram-reels]
canvas: { width: 1080, height: 1920, fps: 30 }

record:
  tracks: [camera, mic]           # 撮影画面の初期設定
  camera: { width: 1920, height: 1080, fps: 30 }

layouts:
  default: camera-full
  allowed: [camera-full, screen-top-camera-bottom]

cut:
  silence: { minMs: 300, padMs: 80 }      # 300ms 以上の無音を詰める。前後に 80ms 残す
  fillers: [えー, えっと, あのー, まあ]
  retakes: keep-last                      # 言い直しは後のほうを残す
  ngMarkers: cut                          # 撮影時の NG の目印の区間は切る
  maxDurationSec: 60

captions:
  style: tiktok-bold
  highlight: word                         # 単語ごとのハイライト
  maxCharsPerLine: 12
  maxLines: 2
  emphasis: auto                          # 強調語を判定モデルが選ぶ
  position: { anchorY: 1350 }
  safeArea: tiktok

audio: { loudness: -14, truePeak: -1, denoise: light, bgm: { duckDb: -12 } }

decisions:
  cutKeep: { autoAbove: 0.7, autoBelow: 0.3 }   # この間の値は人の確認へ
  frameCheck: { passAbove: 0.8 }

checks: [black-frames, freeze, loudness, spec, cut-boundaries, caption-safe-area, caption-face-overlap, pii-on-screen]

pipeline:
  - ingest
  - sync
  - transcribe
  - rough-cut          # 合格条件: 要確認の区間がすべて決まっている
  - captions
  - layout
  - preview
  - check              # 合格条件: すべてのチェックに合格、または人が承認
  - review             # 人のフィードバックを待つ
  - final
```

### 組み込みテンプレート

| ID | 用途 | キャンバス | 主なレイアウト |
|---|---|---|---|
| `youtube-tutorial` | 画面操作の解説 | 1920×1080 | 画面＋右下にカメラのワイプ、要所でカメラのみ |
| `youtube-talk` | 顔出しのトーク、解説 | 1920×1080 | カメラのみ（ズームで変化をつける）、図解の挿入 |
| `youtube-vlog` | 別撮りカメラの素材が中心 | 1920×1080 / 3840×2160 | 素材のカット編集、BGM 中心 |
| `tiktok-talk` | 縦型のトーク | 1080×1920 | カメラのみ（16:9 から顔を追ってリフレーム） |
| `tiktok-screen` | 縦型の画面解説 | 1080×1920 | 上に画面、下にカメラ |
| `shorts-from-long` | 長尺から縦型ショートを切り出す | 1080×1920 | 見どころの候補を判定モデルが出し、人が選ぶ |

利用者は組み込みのものを `extends` して自分用のテンプレートを作れる（`~/.solocut/templates/` またはプロジェクトの中）。テンプレートの作成・変更自体もエージェントに頼める（スキーマがあるので検証できる）。

### レイアウトの定義

```yaml
# layouts/screen-top-camera-bottom.yaml
id: screen-top-camera-bottom
slots:
  screen: { x: 0, y: 0,   w: 1080, h: 960, fit: cover, focus: auto }   # focus: auto はマウスやカーソル周辺へ寄せる
  camera: { x: 0, y: 960, w: 1080, h: 960, fit: cover, focus: face }   # 顔の位置へ寄せる
```

`focus: face` と `focus: auto` の切り出し位置は、解析結果（顔の位置、マウスの位置）から作る。急に動かないよう平滑化し、シーンの切り替わりでだけ大きく動かす。

## エージェントへの指示書（AGENTS.md）

`solocut init` と、テンプレートを変えたときに自動生成する。`CLAUDE.md` は `@AGENTS.md` を読み込むだけのファイルにして、内容を1か所に保つ。

生成する内容:

1. **役割**: あなたはこのプロジェクトの動画編集者。テンプレート `tiktok-talk` の手順に従う
2. **最初にすること**: `solocut status --json` と `solocut next --json` を実行する
3. **守ること**
   - `media/` の中は変更しない
   - 編集は `solocut edit` で行う（`timeline.json` を直接編集したら、必ず `solocut validate`）
   - 手順の合格条件を満たすまで、次の手順に進まない
   - 迷ったら、判定モデル（`solocut decide`）の結果と `rules.md` に従う。それでも決まらなければ `.solocut/questions.md` に質問を書いて人に聞く
4. **テンプレートの編集方針**（`rules.md` の全文）
5. **CLI の使い方**（コマンド一覧と `--json` の出力例）
6. **終わったとき**: `.solocut/handoff.md` に、やったこと・残っていること・次の一手を書く

あわせて、Claude Code と Codex 向けに `solocut` スキル（CLI の詳しい使い方とよくある編集のレシピ）を入れる。

## `solocut next` の動き

`status.json` と各手順の合格条件から、次にやるべきことを1つだけ返す。

```json
{
  "step": "rough-cut",
  "state": "needs-human",
  "why": "判定モデルの確信度が中間（0.3〜0.7）の区間が4つあります",
  "do": "人の確認を待ってください。アプリの「確認」画面に表示済みです。待つ間に captions の手順へ進めます",
  "commands": ["solocut captions build"],
  "blocking": ["s14", "s22", "s23", "s31"]
}
```

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
