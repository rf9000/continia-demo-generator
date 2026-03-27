# Investigative Pre-Run for Demo Video Recording

**Date:** 2026-03-19
**Status:** Approved

## Problem

The demo generator pipeline discovers page layout, field visibility, and element locations *during* video recording. This works but causes janky recordings (FastTab expansions, scroll jumps, failed element searches visible on video). Scaling to complex videos autonomously requires the tool to discover these details beforehand.

## Solution

A headless investigative pre-run executes the full spec as a dry run, discovers field locations, page types, access paths, and element selectors, then writes an enriched YAML spec. The BC environment is then recreated with clean data, and the real recording reads the enriched spec to navigate confidently.

## Enriched Spec Format

Each step gets an optional `discovery` block with:
- `pageType` — Card, List, Document, Worksheet, Dialog
- `selector` — the Playwright selector string that found the element
- `strategy` — which find-strategy won (gridCell, exactAriaName, partialText, cssText, getByText, topBar)
- `accessPath` — ordered list of preparation steps (expandFastTab, clickShowMore, scroll)
- `menuPath` — for actions: which tab/group to click first
- `matchedRowIndex` / `matchedRowText` — for row clicks
- `inputMethod` — directFill or dnPlayRecording
- `fieldFound` — boolean, false if investigation couldn't locate the field

The `discovery` block is entirely optional — the player works exactly as today if it's missing.

## Investigation Mode

Investigation is a **full dry run** — clicks actions, types inputs, navigates pages. Same as recording except:
- No video recording (no `recordVideo`)
- No cursor injection (no animated red dot)
- No timing delays (no audio sync)
- No TTS generation
- Metadata capture after each step

On failure: log warning, record partial discovery, continue to next step.

## Environment Reset

Since investigation modifies BC data, the environment is deleted and recreated between investigation and recording via the DemoPortal CLI.

## Recording Uses Enrichments as Hints

1. Pre-emptive access path execution (expandFastTab → clickShowMore → scroll)
2. Selector fast-path with fallback to normal strategy chain
3. Input method selection (directFill vs dnPlayRecording)
4. Menu navigation (click tab first)
5. Cursor position re-queried at recording time (never stale)

## Cache Invalidation

`discoveryHash` computed from original spec steps. Re-investigate if spec changed.

## CLI

```
node dist/cli.js <spec.yml> --narrate              # Full pipeline
node dist/cli.js <spec.yml> --investigate-only      # Investigation only
node dist/cli.js <spec.yml> --no-investigate --narrate  # Skip investigation
```

## Files

| File | Change |
|------|--------|
| `src/types.ts` | New — discovery types |
| `src/player.ts` | Unified find functions, investigate/record mode, page type detection |
| `src/enricher.ts` | New — merge discoveries, compute hash, write enriched YAML |
| `src/env-reset.ts` | New — environment delete/create/poll |
| `src/cli.ts` | New flags, pipeline orchestration |
