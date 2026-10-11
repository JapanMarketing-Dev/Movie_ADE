# 06. ライブラリとツール

最終更新: 2026-10-11（2026-10 時点の調査。バージョンは配布マニフェストで更新する）

## 方針

- アプリ本体（MIT）には、ライセンスの心配がない軽いものだけを入れる
- 重いもの・ライセンスに注意が要るものは、**必要になった時点でダウンロード**する。どのバージョンをどこから落とし、ハッシュ値はいくつかは、署名付きの `toolchain.json`（[07](./07_distribution.md)）で決める
- ダウンロードしたものは `~/.solocut/tools/<名前>/<バージョン>/` に置き、プロジェクトごとに使ったバージョンを `solocut.json` に記録する（書き出しの再現性のため）
- Python のツールは `uv` で専用の仮想環境を作って入れる。利用者の Python 環境を汚さない

## 分類

| 区分 | 対象 | 理由 |
|---|---|---|
| **アプリに同梱** | Solocut 本体、`solocut` CLI、組み込みテンプレート、Noto Sans JP / M PLUS など OFL のフォント、BudouX、ライセンスの一覧 | 軽く、ライセンスの懸念がない |
| **初回に自動でダウンロード（必須）** | ffmpeg / ffprobe、whisper.cpp と既定のモデル | すべての処理の土台。3つのOS分を同梱すると重い |
| **使うときにダウンロード** | auto-editor、PySceneDetect、MediaPipe（顔検出・リフレーム）、PaddleOCR / Tesseract（モザイク・チェック）、OpenTimelineIO（Premiere / DaVinci / FCPX への書き出し） | 一部のテンプレートや機能でだけ使う |
| **オプション（利用者が選ぶ）** | Remotion、HyperFrames、Revideo（モーショングラフィックス）、WhisperX / faster-whisper（高精度の文字起こし、GPU 向け）、Ollama（ローカルの判定モデル） | 大きい、GPU が要る、またはライセンスの同意が要る |
| 使わない | Editly、Motion Canvas（更新が止まっている）、ffmpeg-static（npm。中の FFmpeg が 6.1 と古い）、YOLO 系（AGPL） | ― |

## 主要なツール

| ツール | 用途 | ライセンス | 入手先 |
|---|---|---|---|
| **FFmpeg / ffprobe** 9.0 系 | カット、合成、字幕の焼き込み（libass）、ラウドネス、品質チェック | GPL ビルドを使う（x264 の画質のため）。nonfree のビルドは使わない | Windows / Linux: BtbN/FFmpeg-Builds、macOS arm64: martin-riedl.de、macOS Intel: evermeet.cx |
| **whisper.cpp** 1.9 系 | 端末内の文字起こし、単語のタイムスタンプ | MIT | Windows / Linux: 公式のビルド済み。macOS: Solocut の CI で Metal 版をビルドして R2 で配る（MIT なので再配布できる） |
| whisper のモデル | 既定は `large-v3-turbo` の量子化版（日本語の精度のため）。性能の低い PC には `small` | MIT | Hugging Face（ハッシュ値を固定） |
| auto-editor 31 系 | 無音カットの別の実装、各編集ソフト向けの XML | Unlicense | GitHub Releases（単体の実行ファイル） |
| PySceneDetect 0.7 | シーンの切り替わりの検出 | BSD-3 | uv |
| MediaPipe | 顔の検出・追跡（リフレーム、モザイク） | Apache-2.0 | uv |
| PaddleOCR / Tesseract | 画面の文字の読み取り（個人情報の検出） | Apache-2.0 | uv / 各公式 |
| OpenTimelineIO 0.18 | 他の編集ソフトへの受け渡し（任意） | Apache-2.0 | uv |
| **Remotion** 4.0 系 | React によるモーショングラフィックス | **独自ライセンス**: 個人、従業員3人以下の営利組織、非営利は無料。それ以外は有料の企業ライセンスが必要 | npm（プロジェクト内） |
| HyperFrames | HTML / CSS / GSAP による動画の生成。エージェント向けのスキルが充実している | Apache-2.0 | npm |
| Revideo | TypeScript によるモーショングラフィックス | MIT | npm |

### FFmpeg のライセンスについて

- Solocut は FFmpeg を**別のプロセスとして呼び出す**だけで、リンクはしない。MIT のアプリと GPL の FFmpeg は、別の著作物として扱える
- Solocut は FFmpeg のバイナリを自分では配らず、**上流の配布元から利用者の端末へ直接ダウンロード**させる（ハッシュ値で検証する）。ソースの入手先とライセンス文は、「ライブラリ」画面と `THIRD_PARTY_NOTICES.md` に示す
- H.264 / AAC の特許の扱いは国によって異なる。README に記載する

### Remotion のライセンスについて

- インストールするときに、ライセンスの条件（無料の範囲と企業ライセンス）を表示し、同意してもらう。同意は `~/.solocut/settings.json` に記録する
- Solocut 自体には Remotion を同梱しない。Remotion を使うのはモーショングラフィックスのクリップを作る場面だけで、書き出しエンジンは FFmpeg なので、Remotion がなくてもすべての機能が使える
- 企業の利用者には、同じ用途の HyperFrames（Apache-2.0）や Revideo（MIT）を先に案内する

## 書き出しのプリセット

| 項目 | YouTube（16:9） | TikTok / Shorts / Reels（9:16） |
|---|---|---|
| 解像度 | 1920×1080（素材が 4K なら 3840×2160） | 1080×1920 |
| fps | 素材に合わせる（24 / 25 / 30 / 50 / 60） | 30（動きが激しいものは 60） |
| 映像 | H.264 High、4:2:0、BT.709、Bフレーム 2、closed GOP（fps の半分）、faststart。8 Mbps（30fps）/ 12 Mbps（60fps）、4K は 35〜45 Mbps | H.264 High、4:2:0、BT.709、10 Mbps 前後 |
| 音声 | AAC-LC 48kHz ステレオ 384 kbps | AAC 48kHz 256 kbps |
| ラウドネス | -14 LUFS、トゥルーピーク -1 dBTP（2パス） | 同左 |
| 字幕 | SRT を別ファイルで出す（YouTube に字幕としてアップロードする）。焼き込みもテンプレートで選べる | 焼き込み |
| セーフエリア | タイトルセーフ 90% | 上 220 px、下 440 px、左 80 px、右 180 px（公式の数値がないため、保守的な値を採用。プリセットで更新できるようにする） |
| 長さの確認 | ― | TikTok 10分、Shorts 3分、Reels 3分（出力先ごとに警告） |

同時に出すメタデータ: タイトルの候補、説明文、チャプター（`00:00 はじめに` の形式）、タグ、サムネイルの候補の画像。エージェントが書き、`renders/<target>/metadata.md` に置く。
