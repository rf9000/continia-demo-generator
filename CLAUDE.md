# Continia Demo Generator

## What is this
Automated demo video generator for Continia Banking in Business Central. Produces narrated, subtitled "how to use this feature" videos from YAML spec files.

## Architecture

```
YAML spec → OpenAI TTS (per-step clips) → Playwright records BC (delays match audio)
                                                    ↓
                                          FFmpeg composes video + audio + subtitles → .mp4
```

| Module | Purpose |
|--------|---------|
| `src/player.ts` | Playwright-based browser automation — authenticates, navigates via pageId, clicks buttons/rows with animated cursor, records video |
| `src/step-audio.ts` | Generates per-step TTS clips, measures durations, builds stepDelays map |
| `src/narrator.ts` | OpenAI TTS wrapper with BC abbreviation expansion and audio duration probing |
| `src/subtitle-gen.ts` | ASS subtitle generation with fade-in/out effects |
| `src/composer.ts` | FFmpeg composition — concat audio track, burn subtitles, trim loading screen |
| `src/cursor.ts` | Animated cursor overlay (red dot with click pulse) injected into the page |
| `src/locale-voices.ts` | Locale → OpenAI voice/speed mapping |
| `src/recorder.ts` | Thin orchestrator between CLI and player |
| `src/config.ts` | Config from .env and CLI args |
| `src/cli.ts` | CLI entry point with full pipeline orchestration |

## How it works

1. **Audio-first**: TTS clips are generated per step BEFORE recording. Their durations determine video pacing.
2. **Two-context recording**: Authenticates in a non-recording context, transfers cookies, then starts recording on the loaded BC page (no login/loading screen in video).
3. **Real Playwright clicks**: Buttons and rows are clicked via Playwright locators (not BC's internal `DN.playRecording`), so clicks are visible in the video.
4. **Animated cursor**: A red dot glides to each click target with a ripple pulse effect.
5. **FFmpeg post-processing**: Trims the "Getting Ready" loading screen, concatenates step audio with silence gaps, burns ASS subtitles with fade effects.

## CLI usage

```bash
# Full pipeline: record + narrate + subtitle + compose
node dist/cli.js <spec.yml> --narrate

# Record only (no narration)
node dist/cli.js <spec.yml>

# Recompose with narration using existing video
node dist/cli.js <spec.yml> --skip-record --narrate

# Options
--voice <name>     # OpenAI voice: alloy, echo, fable, onyx, nova (default), shimmer
--no-subs          # Skip subtitle generation
--no-trim          # Keep BC loading screen in video
--no-headed        # Run headless (no visible browser)
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
