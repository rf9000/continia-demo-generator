# Continia Demo Generator

## What is this
Automated demo video generator for Continia Banking in Business Central. Produces in-product "how to use this feature" videos shown to end customers when they first open specific BC pages.

## Architecture

```
BC Page Scripting YAML  →  bc-replay (Playwright under the hood)  →  Raw .webm video
```

- **Demo specs**: BC Page Scripting YAML format — recorded in BC's built-in Page Scripting tool (Settings > Page Scripting) or hand-written
- **bc-replay** (`@microsoft/bc-replay`): Microsoft's npm package that replays page scripts in a real browser via Playwright. It understands BC's DOM natively — no brittle CSS selectors
- **Video recording**: bc-replay already has `video: "on"` in its Playwright config when `CI` env var is unset. Videos land in Playwright's `test-results/` directory. Our recorder just copies them to `output/`

## Key discovery: bc-replay internals

bc-replay is a thin Playwright test wrapper:
- `Replay.ps1` sets env vars and runs `npx playwright test` with its own config
- `player/dist/playwright.config.js` — line 35: `video: process.env.CI ? "retain-on-failure" : "on"` (video always on outside CI)
- `player/dist/player.spec.js` — glob-matches YAML files and runs each through `Commands.playRecording()`
- Configuration passes via `bc_player_*` environment variables
- Requires `@playwright/test` 1.55.1, uses Chromium

## What's built (Phase 1 scaffold)

| File | Purpose |
|------|---------|
| `src/config.ts` | Loads config from `.env` and CLI args |
| `src/recorder.ts` | Runs bc-replay, finds video in test-results, copies to output/ |
| `src/cli.ts` | CLI entry: `npx generate-demo <spec.yml> [--bc-url] [--output]` |
| `demo-specs/create-customer.yml` | Sample spec (placeholder — needs real BC recording) |

TypeScript compiles clean. CLI works (`node dist/cli.js --help`).

## What needs to happen next

### Immediate (to get first video)
1. **Set up a BC environment** — use continia-env skill or Docker container
2. **Grant Page Scripting permissions** — assign `PAGESCRIPTING - REC` and `PAGESCRIPTING - PLAY` permission sets to the user
3. **Record a real page script** in BC web client: Settings (gear) > Page Scripting > Start new > perform actions > Save as YAML
4. **Replace** `demo-specs/create-customer.yml` with the real recording
5. **Run**: `npx generate-demo demo-specs/create-customer.yml --bc-url http://your-bc-url/bc/`
6. **Verify**: `output/create-customer.webm` is a playable video with readable BC UI

### Phase 2 — Post-processing (future)
- FFmpeg: trim, speed adjustment, transitions
- TTS narration (ElevenLabs or OpenAI TTS) from spec metadata
- Subtitle generation (Whisper or from narration text)
- Compose: video + narration + subtitles → `demos/<name>.mp4`

### Phase 3 — In-product delivery (future)
- ControlAddIn video player (HTML/JS modal in BC pages)
- Teaching Tip or "Watch Demo" action integration
- Video hosting (CDN / Azure Blob Storage)
- First-visit tracking per user/page

### Phase 4 — Automation (future)
- Claude Code analyzes AL codebase → auto-generates page script YAMLs
- CI: on PR merge, auto-generate demos for changed features
- Multi-language narration

## CLI usage

```bash
# Generate a demo video
npx generate-demo demo-specs/create-customer.yml --bc-url http://localhost:8080/bc/

# With auth
npx generate-demo demo-specs/create-customer.yml --bc-url http://bc-url/ --bc-auth UserPassword

# Headless (no visible browser, still records video)
npx generate-demo demo-specs/create-customer.yml --no-headed
```

## Environment variables (.env)

```
BC_START_ADDRESS=http://localhost:8080/bc/
BC_AUTH=Windows
BC_USERNAME_KEY=BC_USER        # env var name containing the username
BC_PASSWORD_KEY=BC_PASS        # env var name containing the password
OUTPUT_DIR=./output
```

## Related project

This generator creates videos for **Continia Banking** (BC extension monorepo at `C:\GeneralDev\AL\Continia Banking Master\Continia Banking`). Phase 3 delivery will integrate back into that repo as a ControlAddIn.

## Design document

Full design with risk mitigations: see `C:\Users\rf\.claude\plans\expressive-swimming-taco.md` (from the planning session that created this project).

## Build

```bash
npm install
npx tsc          # compile TypeScript
node dist/cli.js --help
```
