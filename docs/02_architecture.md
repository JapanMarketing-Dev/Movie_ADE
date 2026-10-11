# 02. アーキテクチャ

最終更新: 2026-10-11

## 設計の原則

1. **編集の正本はテキスト。** 編集内容はすべて `timeline.json` にある。GUI、CLI、エージェントは同じファイルを読み書きする。エージェントが扱いやすく、差分も取れて、元に戻すのも簡単になる。
2. **CLIが中心で、GUIはその上に乗る。** 処理はすべて `solocut` CLI と、その中核のライブラリに置く。デスクトップアプリは、撮影・プレビュー・ターミナル・フィードバックのための「操作卓」と位置づける。
3. **書き出しエンジンは1つ。** プレビューと本番の書き出しは、同じコンパイラ（timeline → ffmpeg の処理グラフ）から作る。解像度と画質が違うだけなので、プレビューで見たものがそのまま本番になる。
4. **元の素材には手を付けない。** 収録・取り込んだファイルは読み取り専用として扱う。作り直せる派生物（プロキシ、波形、文字起こし、キャッシュ）は、消しても作り直せる場所に置く。
5. **アプリに編集機能を作り込まない。** 編集の方針はテンプレートのプロンプトに、操作は CLI の部品に置く。アプリの UI は、撮影・確認・フィードバック・設定のためのもの（[01](./01_concept.md) の方針）。
6. **判断は判定モデル、生成はエージェント。** 採否・合否・信頼度のような「型の決まった判断」は判定モデルに任せる。編集の計画や修正は、エージェント（Claude Code / Codex）が担う。

## 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| デスクトップ | **Electron**＋TypeScript＋React | 3つのOSで、同じ Chromium の画面収録・カメラ・MediaRecorder・WebCodecs が使える。Tauri は Linux（WebKitGTK）で画面収録とカメラの対応が弱い |
| ターミナル | node-pty＋xterm.js | エージェントCLIを本物の端末として動かす定番の組み合わせ |
| 中核ライブラリ | TypeScript（Node 22 以上） | CLI とアプリで同じコードを使う。純粋な関数として書き、単体テストしやすくする |
| スキーマ | JSON Schema（生成元は zod） | `timeline.json`、テンプレート、判定モデルの入出力を検証する。エージェントにもスキーマを見せる |
| 映像処理 | **ffmpeg / ffprobe**（初回にダウンロード） | カット、合成、字幕の焼き込み（libass）、ラウドネス、品質チェックのフィルターまで1つで済む |
| 文字起こし | **whisper.cpp**（既定）、WhisperX（オプション） | 端末内で単語単位のタイムスタンプが取れる |
| 日本語の改行 | **BudouX**（Apache-2.0、JS） | 字幕を文節で自然に改行できる |
| 判定モデル | TypeSafe System One 形式のクライアント（複数のプロバイダに対応） | [05](./05_decision_model.md) |
| パッケージ構成 | pnpm の workspace | 下のモノレポ構成を参照 |

## モノレポ構成

```
solocut/
├── apps/
│   └── desktop/          Electron（main / preload / renderer）
├── packages/
│   ├── core/             timeline のスキーマ、編集操作（ops）、コンパイラ（timeline → ffmpeg グラフ）。純粋な TS
│   ├── media/            ffmpeg / ffprobe の呼び出し、解析（無音、シーン、ラウドネス、顔）、同期（相互相関）
│   ├── captions/         単語の時刻 → 字幕の行 → ASS / SRT。BudouX による改行
│   ├── decide/           判定モデルのクライアントと各プロバイダ、費用の上限管理
│   ├── toolchain/        ツールのダウンロード・検証・更新（ffmpeg、whisper.cpp、Remotion など）
│   ├── templates/        テンプレートの読み込み、継承、検証、指示書（AGENTS.md）の生成
│   ├── agents/           エージェントCLIの一覧、検出、起動コマンドの組み立て、更新の確認
│   ├── benchmark/        参考動画の解析（字幕・カット・音・効果音）とスタイルプロファイル
│   ├── imagegen/         画像生成のプロバイダ（Codex / Gemini CLI / 各社 API）とサムネイルの合成
│   ├── audiolib/         効果音・BGM のライブラリ、ライセンスの管理、クレジットの生成
│   ├── settings/         settings.json のスキーマ、読み込み、監視、エージェント向けスキルの生成
│   └── cli/              `solocut` コマンド（上のパッケージを束ねる）
├── templates/            組み込みテンプレート（[04](./04_templates_and_agents.md)）
├── site/                 solocut.app（Cloudflare Pages）
└── docs/
```

依存の向きは `cli` / `desktop` → 各パッケージ → `core` の一方向。`core` は ffmpeg にも Electron にも依存しない。

## プロジェクトフォルダ

1本の動画が1つのフォルダになる。エージェントはこのフォルダの中で作業する。

```
my-video/
├── solocut.json          プロジェクトの設定（使うテンプレート、出力先、fps など）
├── timeline.json         編集の正本
├── AGENTS.md             テンプレートから自動生成したエージェント向けの指示書（CLAUDE.md は同じ内容を参照）
├── script.md             台本（任意）
├── media/                ★元の素材（読み取り専用）
│   ├── takes/<take-id>/
│   │   ├── screen.mp4 / camera-1.mp4 / mic-1.wav / system.wav
│   │   ├── take.json     各トラックの開始時刻、デバイス、目印（NG・重要）
│   │   └── sync.json     トラック間のオフセット、ドリフト補正、信頼度
│   └── imports/<id>/     別撮りカメラなど、あとから取り込んだ素材
├── assets/               BGM、効果音、画像、ロゴ、フォント
├── derived/              ☆作り直せる派生物（消してもよい）
│   ├── proxies/          編集用の固定フレームレート素材と低解像度のプロキシ
│   ├── transcripts/      単語単位の文字起こし（JSON）
│   ├── analysis/         無音、シーン、ラウドネス、顔の位置
│   └── cache/            プレビューの区間ごとのキャッシュ
├── captions/             字幕の正本（JSON）と生成した ASS / SRT
├── checks/<run-id>/      チェックのレポート（report.md、report.json、フレーム画像）
├── feedback/<id>/        動画フィードバック（feedback.md、ペン入りの画像）
├── renders/              書き出した動画とメタデータ（タイトル・説明文・チャプター）
└── .solocut/
    ├── history.jsonl     編集操作のログ（元に戻す・やり直し・誰が何をしたか）
    ├── status.json       テンプレートの手順の進み具合
    ├── decisions.jsonl   判定モデルへの問い合わせと答え、費用
    └── handoff.md        エージェントを切り替えるときの引き継ぎメモ
```

プロジェクトは `git init` しておく（`media/`、`derived/`、`renders/` は `.gitignore` に入れる）。エージェントの編集は `timeline.json` の差分として見え、いつでも戻せる。

## タイムラインのモデル（timeline.json）

> 型の完全な定義と、持たせる情報の一覧は [15](./15_timeline_schema.md)。ここでは概略だけを示す。

```jsonc
{
  "schema": 1,
  "canvas": { "width": 1080, "height": 1920, "fps": { "num": 30, "den": 1 } },
  "sources": {
    "t1.screen": { "path": "media/takes/t1/screen.mp4", "kind": "screen", "offsetFrames": 0 },
    "t1.cam":    { "path": "media/takes/t1/camera-1.mp4", "kind": "camera", "offsetFrames": 3 },
    "imp1":      { "path": "media/imports/imp1/C0012.MP4", "kind": "camera", "offsetFrames": -128, "drift": 1.00002 }
  },
  "segments": [
    // 本編の並び。1区間 = 元素材の時間範囲（in/out）＋その区間のレイアウト
    { "id": "s1", "in": 120, "out": 412, "layout": "camera-full", "camera": "imp1", "reason": "keep" },
    { "id": "s2", "in": 455, "out": 980, "layout": "screen-top-camera-bottom", "screen": "t1.screen", "camera": "imp1" }
  ],
  "captions": { "ref": "captions/main.json", "style": "tiktok-bold" },
  "overlays": [
    { "id": "o1", "at": 0, "dur": 45, "kind": "title", "text": "3分で分かる○○" },
    { "id": "o2", "at": 300, "dur": 90, "kind": "clip", "path": "assets/motion/lower-third.mov" }
  ],
  "audio": { "loudness": -14, "truePeak": -1, "bgm": { "path": "assets/bgm.mp3", "duckDb": -12 } },
  "markers": [{ "at": 610, "kind": "chapter", "label": "設定の手順" }]
}
```

- 時間は**タイムラインのフレーム番号（整数）**で持つ。秒の小数は使わない（丸め誤差でカットが1フレームずれるのを防ぐ）。元素材の時刻は、有理数のタイムベースから変換する。
- 編集は、ファイルを直接書き換えるのではなく **ops（操作）**として適用する。`cut`、`trim`、`split`、`move`、`setLayout`、`setCaption`、`addOverlay` など。各 op は `history.jsonl` に「誰が（人／エージェント名／判定モデル）・なぜ」と一緒に残る。エージェントが `timeline.json` を直接書き換えた場合も、`solocut validate` で検証してから差分を op として記録する。
- `segments` は「元素材のどこを、どの順で、どのレイアウトで使うか」だけを表す。レイアウトの中身（ワイプの位置や大きさ）は、テンプレートのレイアウト定義から引く。

## 書き出しエンジン

```
timeline.json ＋ テンプレート
   │  core/compiler（純粋関数）
   ▼
RenderPlan（区間ごとの ffmpeg filter_complex、入力の一覧、字幕の ASS、音声のグラフ）
   │  media/render
   ▼
ffmpeg（区間ごとに並列でエンコード → 継ぎ目なしで連結）
```

- **区間ごとのキャッシュ**: RenderPlan を区間ごとにハッシュ化し、変わった区間だけを作り直す。プレビュー（540p、高速設定）では、カット1つの修正なら数秒で反映される。
- **本番の書き出し**は出力先ごとのプリセット（[06](./06_libraries.md) の仕様表）で行う。音声のラウドネスは全体を2パスで測ってから合わせる。
- **フレーム単位の静止画**: `solocut frame --at <フレーム番号>` で、本番と同じグラフから任意の1フレームを正確に取り出す。チェック、フィードバック、サムネイル候補はすべてこれを使う。
- **モーショングラフィックス**: Remotion / HyperFrames / Revideo などで作ったものは、透過付きのクリップ（ProRes 4444 / VP9 alpha）としてレンダリングし、overlay として ffmpeg で重ねる。書き出しエンジンを外部ライブラリに依存させない。

## デスクトップアプリの画面

| 画面 | 内容 |
|---|---|
| **撮影** | 画面（ディスプレイと録画する範囲）・カメラ（メインの指定）・マイクの選択、プレビュー、レベルメーター、目印ホットキー |
| **編集** | 左: プレビュー（区間キャッシュの再生、フレーム送り）／下: タイムラインの表示（区間、字幕、レイアウト、目印、要確認の印）／右: エージェントのターミナル（タブで切り替え） |
| **確認** | チェックのレポート、判定モデルの「要確認」一覧（その場で採否を決められる）、フィードバックの収録 |
| **書き出し** | 出力先の選択、仕様の確認、メタデータ（タイトル、説明文、チャプター、タグ） |
| **ベンチマーク** | 参考動画の URL を開いて解析し、スタイルプロファイルを作る（[09](./09_benchmark.md)） |
| **サムネイル** | フレームの候補、画像生成、文字入れ、書き出し（[10](./10_thumbnails.md)） |
| **素材** | 効果音・BGM・フォントのライブラリ（カテゴリ、試聴、ライセンス、クレジット） |
| **ライブラリ** | ツールのインストール状況、更新、ライセンスの同意 |
| **設定** | `settings.json` の窓口（[11](./11_settings.md)） |

UI は**ダークテーマのみ**。プレビューの周りは無彩色の暗いグレーにして、動画の色の見え方に影響しないようにする。

タイムラインは**表示と、判定の確認（区間の採否の切り替え）**だけを持つ。手作業の編集機能は作らない。直したいことは、エージェントに言葉で頼むか、フィードバックで伝える。

## プロセス構成（デスクトップ）

| プロセス | 役割 |
|---|---|
| main | ウィンドウ、PTY（エージェントのターミナル）、ファイル監視、ツールの起動、更新 |
| 収録ウィンドウ（非表示） | getDisplayMedia / getUserMedia / MediaRecorder による収録（[03](./03_recording_and_sync.md)） |
| renderer | UI。`timeline.json` の変更を監視して表示を作り直す |
| ワーカー（子プロセス） | `solocut` の処理（ffmpeg、whisper、判定モデル）。UIを止めない |

IPC のチャネルは1か所で型として宣言し、preload は宣言済みのものだけを通す（contextIsolation 有効、nodeIntegration 無効）。

## CLI（solocut）

エージェントもアプリもこの CLI を使う。全コマンドで `--json` を付けると機械向けの出力になる。

| コマンド | 内容 |
|---|---|
| `solocut init --template <id>` | プロジェクトを作り、指示書（AGENTS.md）を生成する |
| `solocut status` / `solocut next` | テンプレートの手順のどこまで進んだか／次に何をするか（エージェントはまずこれを見る） |
| `solocut takes` / `solocut import <file>` | テイクの一覧／別撮り素材の取り込み |
| `solocut sync [--take t1]` | トラック間の同期 |
| `solocut transcribe` / `solocut analyze` | 文字起こし／無音・シーン・ラウドネス・顔の解析 |
| `solocut propose cuts` | カットの候補を作り、判定モデルで採否を決める |
| `solocut edit <op> ...` / `solocut edit --ops ops.json` | 編集操作を適用する |
| `solocut captions build` | 字幕を作る |
| `solocut render --preview` / `--final --target tiktok` | 書き出し |
| `solocut frame --at <frame>` | 1フレームの静止画 |
| `solocut check` | 機械的チェックとフレーム単位の判定（[05](./05_decision_model.md)） |
| `solocut feedback list / show <id>` | 届いたフィードバック |
| `solocut undo` / `solocut redo` / `solocut history` | 操作の取り消し・やり直し・履歴 |
| `solocut validate` | timeline.json とテンプレートの検証 |
| `solocut lib list / install / update` | ライブラリの管理 |
| `solocut bench <url>` / `solocut bench apply <id>` | 参考動画の解析／テンプレートへの取り込み |
| `solocut thumb candidates` / `solocut thumb gen` | サムネイルのフレーム候補／画像生成と文字入れ |
| `solocut sfx search <kind>` / `solocut bgm search <mood>` | 効果音・BGM を探す |
| `solocut config get / set / schema` | 設定の読み書き |
| `solocut doctor` | 環境の診断（ツール、権限、GPU、フォント） |
