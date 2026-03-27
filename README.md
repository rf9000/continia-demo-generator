# Continia Demo Generator

Automated demo video generator for Continia Banking in Business Central. Produces narrated, subtitled screen recordings from YAML spec files — no manual video editing needed.

## What it does

Given a YAML spec describing a BC feature flow, the generator:

1. Opens Business Central in a real browser
2. Navigates to the right page and performs each step (clicking buttons, opening records)
3. Records the screen with an animated cursor showing each click
4. Generates voice narration synced to each step (OpenAI TTS)
5. Burns subtitles with fade effects into the video
6. Outputs a ready-to-use `.mp4` demo video

## Quick start

```bash
npm install
npx tsc
```

Set up `.env` (see `.env.example`):
```
BC_START_ADDRESS=https://your-bc-environment-url/
BC_AUTH=UserPassword
BC_USERNAME_KEY=BC_USER
BC_PASSWORD_KEY=BC_PASS
BC_USER=admin
BC_PASS=password
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=<key>
```

Generate a demo video:
```bash
node dist/cli.js path/to/spec.yml --narrate
```

Output lands in `output/<spec-name>.mp4`.

## CLI options

| Flag | Description |
|------|-------------|
| `--bc-url <url>` | Business Central web client URL (overrides `BC_START_ADDRESS` from `.env`) |
| `--bc-auth <type>` | Authentication type: `Windows`, `AAD`, or `UserPassword` (overrides `BC_AUTH` from `.env`) |
| `--narrate` | Generate per-step TTS narration and compose final video |
| `--voice <name>` | OpenAI voice: `alloy`, `echo`, `fable`, `onyx`, `nova` (default), `shimmer` |
| `--skip-record` | Skip browser recording, recompose from existing video |
| `--no-subs` | Skip subtitle generation |
| `--no-trim` | Keep BC loading screen in video |
| `--no-headed` | Run browser in headless mode |
| `--output <dir>` | Output directory (default: `./output`) |
| `--vision-model <id>` | Vision model override (default: `claude-sonnet-4-6-20250514`) |
| `--no-verify` | Skip verification during investigation |

## How it works

```
YAML spec
    |
    v
Generate TTS audio clips per step (OpenAI)
    |
    v
Measure clip durations --> build step delay map
    |
    v
Launch Chromium, authenticate to BC (off-camera)
    |
    v
Transfer session cookies to recording context
    |
    v
Record: navigate to page, execute steps with adapted delays
         (animated cursor shows each click)
    |
    v
Compose with FFmpeg:
  - Trim BC loading screen
  - Concatenate audio clips with silence gaps
  - Burn ASS subtitles with fade-in/out
  - Output final .mp4
```

## Demo spec format

Specs are YAML files combining step definitions with narration metadata:

```yaml
description: How to show additional columns on Bank Acc. Reconciliation
name: Show More Columns
start:
  profile: BUSINESS MANAGER
  page: Bank Acc. Reconciliation List    # informational
  pageId: 388                            # required — numeric BC page ID
steps:
  - type: action
    target:
      - page: Bank Acc. Reconciliation List
    row: 1                               # click first record in the list
    description: Open the first reconciliation

  - type: action
    target:
      - page: Bank Acc. Reconciliation
    caption: Page                        # exact visible button text
    description: Open the Page action bar

  - type: action
    target:
      - page: Bank Acc. Reconciliation
    caption: Show More Columns
    description: Click Show More Columns

demo:
  schemaVersion: 1
  feature: Show More Columns
  targetPage:
    id: 379
    name: Bank Acc. Reconciliation
  app: import
  stepNarration:
    0: First, open an existing bank account reconciliation.
    1: Open the Page action bar to access page-level actions.
    2: >-
      Click Show More Columns to reveal additional fields such as
      Account Type, Account No., End To End Id, and more.
  locale: da-DK
  prerequisites:
    - Continia Banking app is installed
    - At least one bank account reconciliation exists
```

See [Demo Spec Authoring Guide](docs/demo-spec-authoring-guide.md) for the full format reference.

## Tech stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| Browser automation | Playwright (Chromium) |
| TTS | OpenAI TTS API (`tts-1-hd`) |
| Video composition | FFmpeg (via `ffmpeg-static`) |
| Subtitles | ASS format with fade effects |
| CLI | Commander.js |
| Config | dotenv |

## Project structure

```
src/
  cli.ts              # CLI entry point and pipeline orchestration
  player.ts           # Playwright browser automation and video recording
  step-audio.ts       # Per-step TTS generation and duration measurement
  narrator.ts         # OpenAI TTS wrapper with BC abbreviation expansion
  subtitle-gen.ts     # ASS/SRT subtitle generation
  composer.ts         # FFmpeg video + audio + subtitle composition
  cursor.ts           # Animated cursor overlay
  locale-voices.ts    # Locale to TTS voice mapping
  recorder.ts         # Orchestrator between CLI and player
  config.ts           # Configuration loading
docs/
  demo-spec-authoring-guide.md          # How to write specs
  skill-guide-for-spec-generation.md    # Guide for the AL skill that generates specs
```

## Documentation

- **[Demo Spec Authoring Guide](docs/demo-spec-authoring-guide.md)** — Format reference, step types, what works and what doesn't
- **[Skill Guide for Spec Generation](docs/skill-guide-for-spec-generation.md)** — For the product-repo skill: required detail level, AL-to-spec mapping, narration guidelines
