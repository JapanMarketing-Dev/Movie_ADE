<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/solocut-wordmark-dark.svg">
  <img src=".github/assets/solocut-wordmark-light.svg" alt="Solocut" height="64">
</picture>

**The ADE for video editing.**<br>
Have an idea, hit record, and the video edits itself. Watch it, say OK, and it is posted to YouTube or TikTok.<br>
Claude Code, Codex or any terminal agent does the editing on the AI subscription you already have. (ADE = Agentic Development Environment.)

[![GitHub stars](https://img.shields.io/github/stars/JapanMarketing-Dev/solocut?style=flat&color=ff4a3d&label=stars)](https://github.com/JapanMarketing-Dev/solocut/stargazers)
[![Download](https://img.shields.io/badge/download-macOS%20%7C%20Windows%20%7C%20Linux-4ade80?style=flat)](https://solocut.app/download)
[![License: MIT](https://img.shields.io/badge/license-MIT-7c8cff?style=flat)](LICENSE)
[![X](https://img.shields.io/badge/X-@ai__agent__dev-000000?style=flat&logo=x&logoColor=white)](https://x.com/ai_agent_dev)

[Website](https://solocut.app) · [Download](https://solocut.app/download) · [Design docs](docs/) · [X](https://x.com/ai_agent_dev) · [JapanMarketing](https://www.japan-marketing.co.jp/)

**English** · [日本語](README.ja.md)

</div>

<br>

## Idea → record → it edits itself → watch → OK, posted

1. **Have an idea.** Create a video from Home: pick where it is saved (one folder per video inside your master folder) and you are ready.
2. **Record.** Pick a display and drag the area to record, so the menu bar and Dock stay out of the shot. Add one or more cameras (mark one as “main (you)”) and your mic. Each source is its own track.
3. **It edits itself.** When you stop, Solocut registers the take and sends one prompt, **“Finish the video”**, to Claude Code (or Codex, Gemini CLI…) in a terminal it opens for you. The agent follows the template step by step (`solocut next` tells it what to do now): sync, transcribe, cut, keep your face centered, captions, sound effects, mosaic, checks, export, thumbnail and the post text.
4. **Watch it.** The finished video plays in the app, with the title, description and tags the agent wrote. Not happy? Talk over the preview and circle what bothers you; it becomes a timecoded fix for the agent.
5. **OK, posted.** Press “OK · Post”. The agent checks `publish.json` and posts the video to YouTube and/or TikTok through the app. Nothing goes out until you press OK.

## Shoot alone. Screen and cameras at once.

Record only the part of the screen you want, one or more cameras and your mic together, each on its own track. Shot something on a mirrorless camera or an iPhone too? Import it and Solocut syncs it to the frame by audio, with drift correction for long takes. A countdown and hotkeys mark “bad take” or “important” while you talk. Files are written every second, so a crash never loses the take.

## One prompt to a finished video

There is one startup prompt, “Finish the video”, sent automatically when you stop recording, and one posting prompt. Both are yours to rewrite in Settings. Thumbnails are made by your agent through your ChatGPT (Codex) or Gemini subscription; no API key is needed anywhere.

## Checks on the frames that matter

Machine checks look at black frames, freezes, loudness, the export spec, cut boundaries, caption safe areas and personal info on screen. A decision model can double-check the frames around cuts and captions, but it is optional and off by default; everything works without it.

## Don’t type the fix. Point at it.

Play the preview, talk, pause and circle. Solocut transcribes on your machine and turns each remark into a timecode, a frame with your pen, your words and the exact caption or clip you meant. One click sends it to your agent.

## One video, posted where you want

Each project makes one 16:9 video. The agent writes the title, description, tags, thumbnail and per-platform options into `publish.json`; after you press OK it posts the same file to YouTube and/or TikTok. Connecting YouTube and TikTok is one button each.

## More

| | |
|---|---|
| **One template that holds the line.** Format, layout, cut policy, caption style, checks and the pipeline, with the editing rules written as prompts. [Design](docs/04_templates_and_agents.md) | **A typed, information-rich `timeline.json`.** Every edit records what, why, who decided and how sure, plus licenses and check results, so any agent can pick up the project cold. [Design](docs/15_timeline_schema.md) |
| **Your face stays centered.** With several cameras, the one marked “main (you)” is cropped so your face sits in the middle of the frame. | **Thumbnails from the video’s content.** Your agent asks Codex (ChatGPT subscription) or Gemini to draw them. Japanese titles are typeset separately so they never break. [Design](docs/10_thumbnails.md) |
| **Mosaic, automatically.** Emails, notifications, API keys, bystanders’ faces and plates are detected, tracked and hidden. [Design](docs/05_decision_model.md) | **Updates itself.** Signed updates are downloaded and installed automatically. |
| **Private by default.** Video and audio stay on your machine. Transcription runs on-device with whisper.cpp. | **Free and open source.** MIT. No account, no watermark, no subscription. macOS, Windows and Linux. |

## Supported agents

Claude Code · Codex · Gemini CLI · OpenCode · Cursor CLI · GitHub Copilot CLI · or any command you register. Agents run in real terminals inside Solocut; switch between them in tabs, and when one hits its usage limit the next one picks up from the handoff note.

## Download

Get Solocut for macOS, Windows and Linux at **[solocut.app/download](https://solocut.app/download)**. It updates itself; every release is signed and its checksums are published.

## Documentation

The full design (Japanese) lives in [docs/](docs/):

| | |
|---|---|
| [01 Concept and requirements](docs/01_concept.md) | [10 Thumbnails](docs/10_thumbnails.md) |
| [02 Architecture](docs/02_architecture.md) | [11 Settings](docs/11_settings.md) |
| [03 Recording and sync](docs/03_recording_and_sync.md) | [12 Premiere, CapCut, Resolve](docs/12_competitors.md) |
| [04 Templates and agents](docs/04_templates_and_agents.md) | [13 Prompts and autopilot](docs/13_prompts_and_autopilot.md) |
| [05 Decision model, checks, mosaic](docs/05_decision_model.md) | [14 Publishing](docs/14_publishing.md) |
| [06 Libraries and export presets](docs/06_libraries.md) | [15 timeline.json](docs/15_timeline_schema.md) |
| [07 Distribution and updates](docs/07_distribution.md) | [16 Asset library](docs/16_asset_library.md) |
| [08 Quality and risks](docs/08_quality.md) | [17 Archive](docs/17_archive.md) |
| [09 Benchmark](docs/09_benchmark.md) | [Implementation contracts](docs/dev/CONTRACTS.md) |

## Development

```bash
pnpm install
pnpm dev          # run the desktop app
pnpm test         # unit and integration tests (needs ffmpeg on PATH)
pnpm typecheck
```

Monorepo: `packages/core` (timeline types, edit ops, render compiler), `media` (ffmpeg, sync, checks), `captions`, `toolchain`, `settings`, `templates`, `agents`, `archive`, `decide`, `cli` (`solocut`), and `apps/desktop` (Electron).

## License and credits

[MIT](LICENSE) © 2026 [JapanMarketing LLC](https://www.japan-marketing.co.jp/). Third-party tools (FFmpeg, whisper.cpp and others) are downloaded on demand under their own licenses.

Follow updates on [X @ai_agent_dev](https://x.com/ai_agent_dev).
