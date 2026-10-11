# Solocut

**Shoot alone. Your agent edits by template.**
1人で撮る。編集は、テンプレートどおりにAIエージェントが。

Solocut is a free, open-source (MIT) video-editing ADE (Agentic Development Environment) for YouTube and TikTok creators, on macOS, Windows and Linux.

- **Record** screen, camera and mic at once, each on its own track. Import footage from a separate camera later and Solocut syncs it to the frame by audio.
- **Templates** fix the format, layout, cut policy, caption style, checks and the step-by-step pipeline. Claude Code, Codex, Gemini CLI or any terminal agent follows them through the `solocut` CLI.
- **Decision model** decides cut-or-keep, caption breaks and emphasis, and checks the final video frame by frame (cut boundaries, caption safe areas, faces, personal info on screen, mosaic tracking). Only uncertain items go to you.
- **Mosaic** hides emails, notifications, API keys, bystanders' faces and plates automatically, and tracks them.
- **Feedback by video**: watch the preview, talk and circle on it. Solocut turns it into timecoded instructions for your agent.
- **Libraries on demand**: FFmpeg, whisper.cpp, Remotion, HyperFrames, Revideo, MediaPipe and more are downloaded when needed and verified by hash.
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

## License

[MIT](./LICENSE) © 2026 JapanMarketing-Dev
