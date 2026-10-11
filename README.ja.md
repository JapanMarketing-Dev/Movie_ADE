<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/solocut-wordmark-dark.svg">
  <img src=".github/assets/solocut-wordmark-light.svg" alt="Solocut" height="64">
</picture>

**動画編集のための ADE。**<br>
ネタが浮かんだら撮るだけ。編集は勝手に進み、見て「OK」すれば YouTube や TikTok に投稿されます。<br>
編集するのは Claude Code や Codex などのターミナルのエージェント。お使いの AI のサブスクで動きます。（ADE = Agentic Development Environment）

[![GitHub stars](https://img.shields.io/github/stars/JapanMarketing-Dev/solocut?style=flat&color=ff4a3d&label=stars)](https://github.com/JapanMarketing-Dev/solocut/stargazers)
[![Download](https://img.shields.io/badge/download-macOS%20%7C%20Windows%20%7C%20Linux-4ade80?style=flat)](https://solocut.app/ja/download)
[![License: MIT](https://img.shields.io/badge/license-MIT-7c8cff?style=flat)](LICENSE)
[![X](https://img.shields.io/badge/X-@ai__agent__dev-000000?style=flat&logo=x&logoColor=white)](https://x.com/ai_agent_dev)

[サイト](https://solocut.app/ja) · [ダウンロード](https://solocut.app/ja/download) · [設計書](docs/) · [X](https://x.com/ai_agent_dev) · [JapanMarketing合同会社](https://www.japan-marketing.co.jp/)

[English](README.md) · **日本語**

</div>

<br>

## ネタ → 撮る → 勝手に編集 → 見る → OK で投稿

1. **ネタが浮かんだら**、ホームで新しい動画を作ります。選ぶのは保存する場所だけ（最初に決めたマスタフォルダの中に、動画ごとのフォルダができます）。
2. **撮る**。ディスプレイを選び、録画する範囲をドラッグで指定するので、メニューバーや Dock は映りません。カメラは何台でも。そのうち1台を「メイン（自分）」にします。マイクも同時に、それぞれ別のトラックで収録します。
3. **勝手に編集**。録画を止めると、テイクを登録し、「**動画を完成させて**」のプロンプトを Claude Code（または Codex、Gemini CLI など）に自動で送ります。ターミナルを開く必要もありません。エージェントは `solocut next` で「今やること」を確認しながら、同期、文字起こし、カット、顔が中央に来る切り抜き、字幕、効果音、モザイク、チェック、書き出し、サムネイル、投稿文まで進めます。
4. **見る**。完成した動画を、エージェントが書いたタイトル・説明・タグと一緒にアプリで確認します。気になるところはプレビューに喋って囲めば、タイムコード付きの修正指示になります。
5. **OK で投稿**。「OK・投稿する」を押すと、エージェントが `publish.json` を確かめて、アプリ経由で YouTube や TikTok に投稿します。OK を押すまで何も投稿されません。

## 1人で撮る。画面とカメラを同時に。

画面の必要な範囲だけ、カメラ（複数台）、マイクを、それぞれ別のトラックで同時に収録します。ミラーレスや iPhone で別に撮った素材も、取り込むと音声でフレーム単位に自動同期します（長尺の時計のズレも補正）。カウントダウンと、話しながら「今のNG」「ここ重要」を残すホットキーもあります。1秒ごとにファイルへ書き込むので、落ちても消えません。

## 1つのプロンプトで、動画が完成する

起動のプロンプトは「動画を完成させて」の1つだけ。録画を止めると自動で送られます。ほかに投稿用のプロンプトが1つ。どちらも設定で書き換えられます。サムネイルは、エージェントが ChatGPT（Codex）や Gemini のサブスクで動画の内容から作ります。API キーはどこにも要りません。

## 大事なフレームはチェックしてから

黒コマ、フリーズ、ラウドネス、書き出しの仕様、カットの境目、字幕のセーフエリア、画面に映った個人情報を機械的にチェックします。判定モデルでカットや字幕の前後のフレームを確かめることもできますが、使うかどうかは任意で、初期設定はオフ。なくても全体が動きます。

## 直してほしいところは、書かずに指す

プレビューを再生して、喋る・止める・囲む。端末内で文字起こしし、指摘ごとに「タイムコード、ペン入りのフレーム、あなたの言葉、指した字幕やクリップ」にまとめて、ワンクリックでエージェントへ送ります。

## 1本ずつ、好きな場所へ投稿

1つのプロジェクトで作るのは 16:9 の動画1本です。タイトル・説明・タグ・サムネイル・投稿先ごとの設定は、エージェントが `publish.json` に書きます。OK を押すと、同じファイルを YouTube と TikTok のどちらか、または両方に投稿します。YouTube と TikTok の連携は、それぞれボタンを押すだけです。

## そのほか

| | |
|---|---|
| **ぶれないテンプレート**。フォーマット、レイアウト、カット方針、字幕スタイル、チェック、手順に加え、編集方針をプロンプトで書けます。テンプレートは1つだけ。[設計](docs/04_templates_and_agents.md) | **型付きで情報量の多い `timeline.json`**。編集ごとに「何を・なぜ・誰が・どれくらいの確信で」、素材のライセンス、チェックの結果まで残るので、どのエージェントでも続きから作業できます。[設計](docs/15_timeline_schema.md) |
| **顔はいつも中央に**。カメラが複数あっても、「メイン（自分）」のカメラを、顔が画面の中央に来るように切り抜きます。 | **動画の内容からサムネイル**。エージェントが Codex（ChatGPT のサブスク）や Gemini に描かせます。日本語のタイトルは崩れないよう別に組みます。[設計](docs/10_thumbnails.md) |
| **モザイクも自動**。メール、通知、APIキー、映り込んだ他人の顔やナンバープレートを検出・追跡して隠します。[設計](docs/05_decision_model.md) | **更新は自動**。署名付きの更新を自動でダウンロードして入れ替えます。 |
| **初期設定でプライベート**。動画と音声は端末から出ません。文字起こしは whisper.cpp で端末内。 | **無料・オープンソース**。MIT ライセンス。アカウント登録、透かし、サブスクなし。macOS・Windows・Linux。 |

## 対応エージェント

Claude Code · Codex · Gemini CLI · OpenCode · Cursor CLI · GitHub Copilot CLI · 独自のコマンド。アプリの中の本物のターミナルで動き、タブで切り替えられます。使用量の上限に達したら、次のエージェントが引き継ぎメモから続けます。

## ダウンロード

**[solocut.app/ja/download](https://solocut.app/ja/download)** から、macOS・Windows・Linux 版を入手できます。インストール後は自動で更新されます。すべてのリリースに署名し、チェックサムを公開しています。

## 設計書

[docs/](docs/) に全体の設計があります（01 コンセプトと要件 〜 17 アーカイブ、実装の取り決めは [docs/dev/CONTRACTS.md](docs/dev/CONTRACTS.md)）。

## 開発

```bash
pnpm install
pnpm dev          # デスクトップアプリを起動
pnpm test         # 単体・結合テスト（ffmpeg が必要）
pnpm typecheck
```

## ライセンス

[MIT](LICENSE) © 2026 [JapanMarketing合同会社](https://www.japan-marketing.co.jp/)。FFmpeg や whisper.cpp などの外部ツールは、必要なときにダウンロードされ、それぞれのライセンスに従います。

最新情報は [X @ai_agent_dev](https://x.com/ai_agent_dev) で。
