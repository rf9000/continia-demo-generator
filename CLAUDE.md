# Continia Demo Generator

## What is this
Automated demo video generator for Continia Banking in Business Central. Produces narrated, subtitled "how to use this feature" videos from YAML spec files.

## Architecture

```
YAML spec → OpenAI TTS (per-step clips) → Vision investigation (screenshots → Claude Sonnet 4.6)
                                                    ↓
                                          .script.yml (coordinates)
                                                    ↓
                                          Environment reset (DemoPortal API)
                                                    ↓
                                          Playwright records BC (replays coordinates)
                                                    ↓
                                          FFmpeg composes video + audio + subtitles → .mp4
```

| Module | Purpose |
|--------|---------|
| `src/browser.ts` | Playwright browser launch, BC authentication, cookie transfer, `awaitBCFrame` |
| `src/dom-extract.ts` | Pure function: Frame → cleaned HTML. Overlay detection, scroll state, layer awareness. |
| `src/dom-interpreter.ts` | Claude text API for HTML interpretation. Survey, locate, confirm modes. |
| `src/knowledge.ts` | Read/write knowledge bank YAML patterns. Self-learning from success/failure. |
| `src/vision.ts` | Claude Sonnet 4.6 vision API — verify (before/after screenshots) and control add-in locate only |
| `src/investigator.ts` | DOM-based 9-step loop: extract → survey → locate → prepare → confirm → act → verify → learn → emit |
| `src/script-player.ts` | Coordinate-based recorder — replays `.script.yml` with cursor animation |
| `src/script-types.ts` | Types for `.script.yml` format |
| `src/script-io.ts` | Read/write `.script.yml`, spec hash, cache validation |
| `src/recorder.ts` | Thin orchestrator — investigation → env reset → script playback |
| `src/cli.ts` | CLI entry point with full pipeline orchestration |
| `src/cursor.ts` | Animated cursor overlay (red dot with click pulse) injected into the page |
| `src/step-audio.ts` | Generates per-step TTS clips, measures durations, builds stepDelays map |
| `src/narrator.ts` | OpenAI TTS wrapper with BC abbreviation expansion and audio duration probing |
| `src/subtitle-gen.ts` | ASS subtitle generation with fade-in/out effects |
| `src/composer.ts` | FFmpeg composition — concat audio track, burn subtitles, trim loading screen |
| `src/locale-voices.ts` | Locale → OpenAI voice/speed mapping |
| `src/config.ts` | Config from .env and CLI args |
| `src/env-reset.ts` | DemoPortal environment delete/create/poll |
| `src/log.ts` | Logging utilities |

## How it works

1. **Audio-first**: TTS clips are generated per step BEFORE recording. Their durations determine video pacing.
2. **DOM investigation**: A headless browser opens BC, extracts cleaned HTML from the DOM, and Claude interprets the HTML to locate elements via CSS selectors. A knowledge bank of learned BC patterns improves accuracy over time. Vision (screenshots) is used only for action verification and control add-in fallback.
3. **Environment reset**: BC environment is deleted and recreated between investigation and recording so data is fresh.
4. **Coordinate replay**: The recording phase replays the `.script.yml` mechanically — clicking coordinates, typing values. No DOM queries.
5. **Animated cursor**: A red dot glides to each click target with a ripple pulse effect.
6. **FFmpeg post-processing**: Trims the "Getting Ready" loading screen, concatenates step audio with silence gaps, burns ASS subtitles with fade effects.

## CLI usage

```bash
# Full pipeline: record + narrate + subtitle + compose
node dist/cli.js <spec.yml> --narrate

# Record only (no narration)
node dist/cli.js <spec.yml>

# Recompose with narration using existing video
node dist/cli.js <spec.yml> --skip-record --narrate

# Options
--voice <name>       # OpenAI voice: alloy, echo, fable, onyx, nova (default), shimmer
--no-subs            # Skip subtitle generation
--no-trim            # Keep BC loading screen in video
--no-headed          # Run headless (no visible browser)
--vision-model <id>  # Vision model override (default: claude-sonnet-4-6-20250514)
--no-verify          # Skip verification during investigation
```

## Environment variables (.env)

```
BC_START_ADDRESS=https://demoportaldev.continiaonline.com/<envId>/
BC_AUTH=UserPassword
BC_USERNAME_KEY=BC_USER
BC_PASSWORD_KEY=BC_PASS
BC_USER=<username>
BC_PASS=<password>
OPENAI_API_KEY=<key>
ANTHROPIC_API_KEY=<key>
OUTPUT_DIR=./output
```

Note: DemoPortal BC URLs do NOT use a `/bc/` suffix.

## Documentation

| Doc | Purpose |
|-----|---------|
| `docs/demo-spec-authoring-guide.md` | How to write YAML specs that work with the player |
| `docs/skill-guide-for-spec-generation.md` | Guide for the product-repo skill that generates specs from AL source |
| `docs/superpowers/specs/2026-03-14-demo-spec-output-format-design.md` | Original spec format design |

## Feedback Loop: Improving the Spec Generation Skill

**IMPORTANT**: When a video recording fails or produces incorrect results due to a spec issue that the product-repo skill could have prevented, update `docs/skill-guide-for-spec-generation.md` with:

1. What went wrong (e.g., "Show More Columns not found")
2. Why it went wrong (e.g., "action is inside Page tab, needed an extra click step")
3. What the skill should do differently (e.g., "check `area()` in AL to determine if a tab-click step is needed")

This creates a feedback loop: each failed recording makes future spec generation better. The skill guide is the single source of truth for what the generator needs.

## Build

```bash
npm install
npx tsc          # compile TypeScript
node dist/cli.js --help
```

## Related project

This generator creates videos for **Continia Banking** (BC extension monorepo at `C:\GeneralDev\AL\Continia Banking Master\Continia Banking`). The product-repo has a skill that generates spec YAML files from AL source analysis.
