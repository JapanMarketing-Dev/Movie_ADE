# Solocut

**Shoot alone. Your agent edits by template.**
1人で撮る。編集は、テンプレートどおりにAIエージェントが。

Solocut is a free, open-source (MIT) video-editing ADE (Agentic Development Environment) for tech tutorials and talking-head videos on YouTube and TikTok, on macOS, Windows and Linux.

- **Record** screen, camera and mic at once, each on its own track. Import footage from a separate camera later and Solocut syncs it to the frame by audio.
- **Templates** fix the format, layout, cut policy, caption style, checks and the step-by-step pipeline. Claude Code, Codex, Gemini CLI or any terminal agent follows them through the `solocut` CLI.
- **Decision model** decides cut-or-keep, caption breaks and emphasis, and checks the final video frame by frame (cut boundaries, caption safe areas, faces, personal info on screen, mosaic tracking). Only uncertain items go to you.
- **Mosaic** hides emails, notifications, API keys, bystanders' faces and plates automatically, and tracks them.
- **Feedback by video**: watch the preview, talk and circle on it. Solocut turns it into timecoded instructions for your agent.
- **Libraries on demand**: FFmpeg, whisper.cpp, Remotion, HyperFrames, Revideo, MediaPipe and more are downloaded when needed and verified by hash.
- **One prompt to finish**: shoot 10–20 minutes, say “finish the video”, and get a publish-ready video. Ready-made prompts are editable as JSON.
- **Publish from the editor** to YouTube and TikTok, and announce it on X, Instagram, Threads and Facebook.
- **Benchmark** any YouTube or TikTok video by URL: caption style, sound effects, music level and pacing become a template.
- **Thumbnails** with image generation through your Codex or Gemini subscription or an API key.
- **Archive**: every past video and its `timeline.json` stay searchable, so your agent can say “make it like that one”.
- **Every setting is JSON**, with a public schema your agent can edit.
- **Auto-update** from Cloudflare (solocut.app), signed.

> Status: in design. See [docs/](./docs/) for the full design (Japanese).

## Design documents

| | |
|---|---|
| [01 コンセプトと要件](./docs/01_concept.md) | What Solocut is, for whom, and every requirement |
| [02 アーキテクチャ](./docs/02_architecture.md) | Tech stack, monorepo, project folder, `timeline.json`, render engine, CLI |
| [03 収録と同期](./docs/03_recording_and_sync.md) | Multi-track recording, external camera import and audio sync |
| [04 テンプレートとエージェント](./docs/04_templates_and_agents.md) | Templates, `AGENTS.md`, `solocut next`, agent terminals, video feedback |
| [05 判定モデル・チェック・モザイク](./docs/05_decision_model.md) | Decision model, frame-level checks, mosaic |
| [06 ライブラリとツール](./docs/06_libraries.md) | FFmpeg, whisper.cpp, Remotion and others; export presets |
| [07 配布・自動更新・サイト](./docs/07_distribution.md) | Cloudflare R2 / Pages, signed updates |
| [08 品質・テスト・リスク](./docs/08_quality.md) | Test policy and risks |
| [09 ベンチマーク](./docs/09_benchmark.md) | Extract patterns from reference videos |
| [10 サムネイル](./docs/10_thumbnails.md) | Image generation and title typesetting |
| [11 設定](./docs/11_settings.md) | Everything is JSON |
| [12 既存ソフトとの比較](./docs/12_competitors.md) | Premiere, CapCut, DaVinci Resolve |
| [13 プロンプトとオートパイロット](./docs/13_prompts_and_autopilot.md) | Ready-made prompts, one prompt to finish |
| [14 投稿](./docs/14_publishing.md) | YouTube, TikTok, X, Instagram, Threads, Facebook |
| [15 timeline.json](./docs/15_timeline_schema.md) | The typed, information-rich edit plan; scene patterns |
| [16 素材ライブラリ](./docs/16_asset_library.md) | Sound effects, music, illustrations, licenses and credits |
| [17 アーカイブ](./docs/17_archive.md) | Past videos and their timelines, always at hand for reference |

## License

[MIT](./LICENSE) © 2026 JapanMarketing-Dev
