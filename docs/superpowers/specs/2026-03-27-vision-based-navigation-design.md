# Vision-Based BC Navigation

**Date:** 2026-03-27
**Status:** Approved

## Problem

The demo generator navigates BC using hardcoded DOM strategies — six field-finding strategies, five action-finding strategies, page type detection via CSS classes, FastTab expansion via aria-expanded attributes. This approach:

1. **Breaks across BC versions** — DOM structure, class names, and aria attributes change between updates
2. **Cannot handle control add-ins** — they render inside iframes with arbitrary custom HTML
3. **Requires manual maintenance** — every new BC page pattern needs new strategy code
4. **Fails on unfamiliar pages** — if no coded strategy matches, the step fails

The current investigative pre-run (2026-03-19 design) discovers metadata using these same DOM strategies, so it inherits all the same limitations.

## Solution

Replace all hardcoded DOM navigation with a vision model (Claude Sonnet 4.6) that looks at screenshots of BC and produces interaction coordinates. The YAML spec still describes *what* to do; the vision model figures out *how* by looking at pixels.

This makes the tool agnostic to BC's DOM structure, control add-in internals, and version-specific rendering differences.

## Architecture

```
YAML spec
    │
    ▼
┌─────────────────────────────────────┐
│  INVESTIGATION PHASE (headless)     │
│                                     │
│  For each step:                     │
│    1. Screenshot current state      │
│    2. Vision model: locate element  │
│    3. Execute action at coordinates │
│    4. Screenshot new state          │
│    5. Vision model: verify result   │
│    6. Retry up to 3x on failure     │
│    7. Emit step to .script.yml      │
│                                     │
│  Output: .script.yml                │
└─────────────────────────────────────┘
    │
    ▼
  Environment Reset (DemoPortal API)
    │
    ▼
┌─────────────────────────────────────┐
│  RECORDING PHASE (headed + video)   │
│                                     │
│  For each step in .script.yml:      │
│    1. Execute prep actions           │
│    2. Move animated cursor to (x,y) │
│    3. Click / type                  │
│    4. Wait for audio sync delay     │
│                                     │
│  Output: .webm video                │
└─────────────────────────────────────┘
    │
    ▼
  FFmpeg compose (audio + subtitles → .mp4)
```

## Vision Model Interface

All vision calls use Claude Sonnet 4.6 via the Anthropic API. Each call sends one or two screenshots plus a structured prompt, and expects structured JSON back.

### Locate Call

Sent before acting. Finds the target element and describes how to interact with it.

```
Input:  screenshot.png + "Find the 'Post' button on this page"
Output: {
  element: "Post button",
  coordinates: { x: 850, y: 120 },
  confidence: 0.92,
  prep: [
    { action: "scroll", direction: "down", px: 200, reason: "button partially off-screen" }
  ],
  observation: "BC card page, action bar visible at top, Post is the 3rd button"
}
```

### Verify Call

Sent after acting. Compares before/after screenshots to confirm the action worked.

```
Input:  before.png + after.png + "I clicked 'Post' at (850, 120). Did it work?"
Output: {
  success: true,
  observation: "A confirmation dialog appeared asking 'Do you want to post?'",
  newState: "dialog-open"
}
```

### Input Call

For type: input steps. Locates the field and describes how to fill it.

```
Input:  screenshot.png + "Find the 'Bank Name' field and describe how to fill it"
Output: {
  element: "Bank Name input field",
  coordinates: { x: 600, y: 340 },
  confidence: 0.88,
  inputMethod: "click-then-type",
  prep: [
    { action: "click", coordinates: { x: 600, y: 340 }, reason: "focus the field first" }
  ],
  observation: "Field is in the General FastTab, currently showing empty value"
}
```

### Prompt Design

Each call includes a system prompt establishing context:

- "You are navigating a Microsoft Dynamics 365 Business Central web client"
- "The viewport is 1920x1080 pixels"
- "Return coordinates as {x, y} relative to the top-left corner of the viewport"
- "If the element is not visible, describe what preparation is needed (scroll, expand section, etc.)"
- "If the element is inside a control add-in (custom embedded widget), still provide coordinates based on visual position"

The per-step prompt includes the YAML step's type, caption/field, and value so the model knows exactly what to find.

## Coordinate Script Format (.script.yml)

The investigation produces a human-readable YAML file containing every interaction with exact coordinates.

```yaml
specHash: "a3f8c2e1"
model: "claude-sonnet-4-6"
investigatedAt: "2026-03-27T14:30:00Z"
viewportSize: { width: 1920, height: 1080 }

steps:
  - index: 0
    source:
      type: action
      caption: Post
    action: click
    coordinates: { x: 850, y: 120 }
    confidence: 0.92
    prep:
      - action: scroll
        direction: down
        px: 200
    verification:
      success: true
      observation: "Confirmation dialog appeared"
    screenshot: step-00-before.png

  - index: 1
    source:
      type: input
      field: Bank Name
      value: Danske Bank
    action: click-then-type
    coordinates: { x: 600, y: 340 }
    value: "Danske Bank"
    confidence: 0.88
    prep:
      - action: click
        coordinates: { x: 600, y: 340 }
        reason: "focus field"
    verification:
      success: true
      observation: "Field now shows 'Danske Bank'"
    screenshot: step-01-before.png

  - index: 2
    source:
      type: action
      caption: Custom Widget Button
    action: click
    coordinates: { x: 400, y: 500 }
    confidence: 0.78
    context: "control-add-in iframe"
    verification:
      success: true
      observation: "Widget responded, new data displayed"
    screenshot: step-02-before.png
```

### Field descriptions

- **`source`** — the original YAML step, preserved for debugging
- **`action`** — what to do: `click`, `click-then-type`, `double-click`
- **`coordinates`** — viewport-relative pixel position
- **`confidence`** — model's self-assessed confidence (0-1)
- **`prep`** — ordered list of actions to take before the main action (scroll, click to expand, wait)
- **`verification`** — result of the verify call after executing
- **`screenshot`** — filename of the screenshot the model used for the locate call
- **`context`** — notes from the model about the element (e.g., "control-add-in iframe")
- **`viewportSize`** — coordinates are only valid for this viewport size

### Cache invalidation

`specHash` is computed from the original YAML spec's steps (same approach as current `discoveryHash`). If the spec changes, the script is regenerated.

## Investigation Loop Detail

```
investigateStep(step, page):
  attempts = 0
  while attempts < 3:
    screenshot_before = page.screenshot()

    // LOCATE
    locate_result = vision.locate(screenshot_before, step)
    if locate_result.confidence < 0.5:
      log warning, increment attempts, continue

    // PREP
    for prep_action in locate_result.prep:
      execute(prep_action)

    // If prep changed the page, re-screenshot and re-locate
    if locate_result.prep.length > 0:
      screenshot_after_prep = page.screenshot()
      locate_result = vision.locate(screenshot_after_prep, step)

    // ACT
    execute_click_or_type(locate_result.coordinates, step.value)

    // VERIFY
    screenshot_after = page.screenshot()
    verify_result = vision.verify(screenshot_before, screenshot_after, step)

    if verify_result.success:
      return scriptStep(locate_result, verify_result)

    // RETRY
    attempts++
    log "Step failed: ${verify_result.observation}, retrying..."

  // All attempts failed
  return scriptStep(locate_result, { success: false, observation: "..." })
```

**Retry budget:** 3 attempts per step. On each retry, a fresh screenshot is taken (the page state may have changed from the failed attempt). The model receives the failure context so it can try a different approach.

**On permanent failure:** The step is written to the script with `verification.success: false` and the model's observation explaining what went wrong. This lets the user debug without re-running investigation.

## Recording Phase

The recorder becomes minimal. It reads `.script.yml` and replays mechanically:

```
for each step in script.steps:
  // Safety check: compare current page to investigation screenshot
  // Flag warning if drastically different (optional drift detection)

  for prep in step.prep:
    execute(prep)

  animateCursorTo(step.coordinates)
  click(step.coordinates)  // or type(step.value)
  wait(stepDelay)          // audio sync timing
```

No vision calls during recording in the happy path. If drift is detected (page looks very different from investigation screenshot), the recorder can optionally re-run a single vision locate call for that step as a fallback.

### What gets deleted from player.ts

| Function | Lines | Reason |
|----------|-------|--------|
| `findFieldInFrame` | ~100 | Replaced by vision locate |
| `findActionStrategy` | ~70 | Replaced by vision locate |
| `detectPageType` | ~30 | Replaced by vision observation |
| `prepareFieldAccess` | ~200 | Replaced by vision prep actions |
| `findRowInFrame` | ~80 | Replaced by vision locate |
| DOM strategy chains in `executeStep` | ~300 | Replaced by coordinate click |

Total: ~780 lines of DOM strategy code removed.

## New Modules

| Module | Purpose |
|--------|---------|
| `src/vision.ts` | Claude Sonnet 4.6 API client. Takes screenshot buffer + prompt, returns structured JSON. Handles locate, verify, and input calls. Single responsibility: vision API communication. |
| `src/investigator.ts` | The see → act → verify loop. Walks through YAML steps, calls vision module, executes actions via Playwright, writes `.script.yml`. Owns the retry logic and screenshot capture. |
| `src/script.ts` | Types and utilities for `.script.yml` — read, write, hash validation, confidence summary. |
| `src/script-player.ts` | The recording-phase player. Reads `.script.yml`, moves cursor, clicks coordinates, types values. No element finding logic. |

### Modules that change

| Module | Change |
|--------|--------|
| `src/player.ts` | Gutted. Browser setup, auth, cookie transfer stay. All DOM finder functions and step execution logic removed. |
| `src/recorder.ts` | Orchestrates investigator → env reset → script-player instead of current monolithic playDemo. |
| `src/cli.ts` | New `--vision-model` and `--no-verify` flags. Pipeline calls investigator then script-player. |
| `src/enricher.ts` | Deleted — replaced by `src/script.ts`. |
| `src/types.ts` | Replaced with script types. |

## CLI Changes

### Pipeline

```
node dist/cli.js <spec.yml> --narrate

  1. Parse YAML spec
  2. Check for cached .script.yml (hash match?)
     → if valid cache: skip to step 5
  3. INVESTIGATE: open BC headless, run vision loop, produce .script.yml
  4. Reset environment (DemoPortal API)
  5. RECORD: open BC headed, replay .script.yml with cursor + video
  6. Narrate + subtitle + compose (unchanged)
```

### New/changed flags

| Flag | Purpose |
|------|---------|
| `--investigate-only` | Run investigation, write script, exit |
| `--no-investigate` | Use existing `.script.yml`, skip to recording |
| `--vision-model <id>` | Override vision model (default: `claude-sonnet-4-6`) |
| `--no-verify` | Skip verify step in investigation (faster, less reliable) |

Existing flags unchanged: `--narrate`, `--skip-record`, `--no-subs`, `--no-trim`, `--voice`, `--bc-url`, `--bc-auth`, `-v`.

### Environment variable

`ANTHROPIC_API_KEY` added to `.env` alongside `OPENAI_API_KEY`.

## Cost Estimate

Per investigation step: 1 locate call + 1 verify call = 2 vision API calls.
With retries (worst case): 6 calls per step.

At Claude Sonnet 4.6 pricing (~$3/M input tokens, ~$15/M output tokens):
- One screenshot ≈ 1500 tokens input
- Structured response ≈ 200 tokens output
- Per call: ~$0.005-0.01
- 15-step spec, happy path: ~$0.15-0.30
- 15-step spec, worst case (all retries): ~$0.90

Negligible given this is a one-time investigation cached until the spec changes.
