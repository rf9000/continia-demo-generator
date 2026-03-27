# HTML DOM Interpreter with Self-Learning Knowledge Bank

**Date:** 2026-03-27
**Status:** Approved

## Problem

The pure vision approach to BC page navigation has fundamental limitations:
1. **Coordinate imprecision** — vision models return approximate pixel coordinates that miss small UI elements by 50-100px
2. **Can't see what's off-screen** — fields in collapsed FastTabs or below the scroll fold are invisible in screenshots
3. **Expensive and slow** — each screenshot is ~1500 image tokens, multiple retries per step
4. **No structural understanding** — the model guesses at page structure from pixels instead of reading it directly

Meanwhile, the browser has full access to BC's DOM which contains exact element locations, states, and structure — but hardcoded DOM selectors break across BC versions and require manual maintenance.

## Solution

Send **cleaned HTML** from BC's DOM to Claude as text for interpretation. Claude reads the page structure, identifies elements, and returns exact CSS selectors and interaction instructions. A **knowledge bank** of learned patterns improves accuracy over time.

- **HTML extraction**: pure function, no AI — strips noise, keeps semantically meaningful elements
- **Claude interprets HTML**: understands page structure dynamically, no hardcoded selectors
- **Knowledge bank**: YAML files with learned BC patterns, updated automatically from success/failure
- **Vision for verification only**: before/after screenshots confirm actions worked
- **Vision for control add-ins**: falls back to pure vision when DOM is opaque (iframes)

## HTML Extraction

A pure function (`domExtract`) takes a Playwright `Frame` and returns a cleaned HTML string of ~2,000-5,000 tokens.

### What it keeps
- Element tag, `role`, `aria-label`, `aria-expanded`, `controlname`, `title`, `type`
- First meaningful CSS class (not the full BC class chain)
- Text content (trimmed, max 50 chars)
- Nesting structure (collapsed empty wrapper divs)
- Input elements and their current values

### What it strips
- `<script>`, `<style>`, SVG, hidden elements (`display:none`, zero dimensions)
- Deeply nested decorative divs (flatten single-child div chains)
- Inline styles, data attributes, event handlers
- Elements with no text, no role, no aria attributes (pure layout containers)

### Scroll state
For every scrollable container:
- Current scroll position (scrollTop, scrollLeft)
- Total scrollable dimensions (scrollHeight, scrollWidth)
- Visible viewport size (clientHeight, clientWidth)
- Boolean flags: canScrollDown, canScrollUp, canScrollLeft, canScrollRight

### Layer/overlay awareness
BC opens record cards as modal overlays on top of list pages. The extraction must:
- Identify ALL visible layers (dialogs, modal pages, overlays) in the DOM
- Mark the **topmost active layer** (highest z-index, visible, interactive)
- Extract detailed HTML only from the topmost layer
- Include a brief summary of background layers

### Example output

```html
<!-- BACKGROUND LAYER: Bank Accounts list (non-interactive) -->
<!-- ACTIVE LAYER: Bank Account Card (modal overlay) -->
<header role="banner">Bank Account Card</header>
<nav role="menubar">
  <button role="menuitem">Edit</button>
  <button role="menuitem">New</button>
  <button role="menuitem">Delete</button>
</nav>
<section aria-expanded="true" aria-label="General"
         scroll-y="0/1200" scroll-x="0/1920">
  <div controlname="No."><input aria-label="No." value="B030"/></div>
  <div controlname="Name"><input aria-label="Name" value=""/></div>
  <div controlname="Bank Sort Code"><input aria-label="Bank Sort Code" value=""/></div>
  ...
</section>
<section aria-expanded="false" aria-label="Posting"/>
<section aria-expanded="false" aria-label="Transfer"/>
<!-- scroll: vertical 0/1200px, no horizontal scroll -->
```

## Claude DOM Interpreter

Sends cleaned HTML to Claude's text API (not vision) and receives structured page understanding and interaction instructions.

### Mode 1: Page Survey

"What is this page? What's on it?"

```
Input:  cleaned HTML
Output: {
  pageType: "card",
  pageTitle: "Bank Account Card",
  isOverlay: true,
  backgroundPage: "Bank Accounts list",
  sections: [
    { name: "General", expanded: true, fields: ["No.", "Name", "Bank Sort Code", ...] },
    { name: "Posting", expanded: false, fields: [] },
    { name: "Transfer", expanded: false, fields: [] },
  ],
  actionBar: ["Edit", "New", "Delete"],
  scroll: { canScrollDown: true, canScrollRight: false },
}
```

### Mode 2: Locate Element

"How do I interact with Currency Code?"

```
Input:  cleaned HTML + field name + knowledge bank patterns
Output: {
  found: true,
  section: "Posting",
  sectionExpanded: false,
  stepsToReach: [
    { action: "expandSection", selector: "[aria-label='Posting'][aria-expanded='false']" },
    { action: "scrollTo", selector: "[controlname='Currency Code']" },
  ],
  interactSelector: "[controlname='Currency Code'] input",
  confidence: "high",
  reasoning: "Field 'Currency Code' is in the Posting FastTab which is currently collapsed."
}
```

### Mode 3: Confirm

After executing preparation steps, re-extract HTML and ask Claude to confirm the element is now reachable.

```
Input:  updated HTML + target element + previous locate result
Output: {
  confirmed: true,
  selector: "[controlname='Currency Code'] input",
  visible: true,
  reasoning: "Posting FastTab is now expanded, Currency Code input is visible with an empty value."
}
```

### Mode 4: Verify (stays as vision)

Before/after screenshots sent to Claude vision API to confirm the action produced the expected outcome. Unchanged from current implementation.

## Knowledge Bank

### Storage

YAML files in `knowledge/patterns/*.yml`. One file per learned pattern. Version-controlled, human-readable, manually editable (option D).

### Pattern format

```yaml
name: bc-fasttab-expand
description: How to expand a collapsed FastTab section in BC
discovered: 2026-03-27
successCount: 3
lastUsed: 2026-03-27
pattern:
  identify: "section with aria-expanded='false' and aria-label matching the tab name"
  interact: "click the section header element"
  verify: "aria-expanded changes to 'true', child field elements become visible"
```

### Learning triggers

**On success (after verify confirms action worked):**
- If a new pattern was used, create a new YAML file
- If an existing pattern was used, increment `successCount` and update `lastUsed`

**On failure (after verify says action failed):**
- Claude attempts alternative approaches from the HTML
- When recovery succeeds, save the new pattern and deprecate the old one with `deprecated: true`

**Manual override (option D):**
- Edit or delete any YAML file directly
- System reads knowledge bank fresh at the start of each investigation

### Usage in prompts

When the DOM interpreter gets a locate request, all non-deprecated knowledge bank patterns are included in the prompt as context. Claude reads them and applies relevant patterns to the current page.

## Investigation Flow

```
For each YAML step:

  1. EXTRACT  — get cleaned HTML from topmost active layer
  2. SURVEY   — send HTML to Claude text API: "what page is this?"
  3. LOCATE   — send HTML + step instruction + knowledge bank:
               "how do I reach Currency Code?"
  4. PREPARE  — execute the returned steps (expand FastTab, scroll)
  5. CONFIRM  — re-extract HTML, send back for confirmation
  6. ACT      — click/type using confirmed Playwright selector
  7. VERIFY   — screenshot before/after → vision confirms action worked
  8. LEARN    — save successful patterns to knowledge bank
  9. EMIT     — write step to .script.yml
               (coordinates from element.boundingBox() for recording)
```

### Key properties

- Steps 1-5 use **text (HTML)** — fast, cheap, precise
- Step 6 uses **Playwright locators** from confirmed selectors — exact targeting
- Step 7 uses **vision** — visual verification is genuinely better as images
- Step 9 gets coordinates from **element.boundingBox()** — pixel-perfect for recording
- After CONFIRM, the investigator does NOT immediately act — it double-checks first

### Control add-in fallback

Step 1 detects an iframe with unknown content (no `controlname`, no `aria-label` on children). Steps 2-6 switch to pure vision (screenshots + coordinate clicking). Steps 7-9 stay the same.

## Module Architecture

| Module | Purpose |
|--------|---------|
| `src/dom-extract.ts` | Pure function: Frame → cleaned HTML string. Handles overlays, scroll state, layer detection. No AI calls. |
| `src/dom-interpreter.ts` | Claude text API client for HTML interpretation. Survey, locate, confirm modes. Includes knowledge bank context in prompts. |
| `src/knowledge.ts` | Read/write knowledge bank YAML files. Increment success counts, deprecate failed patterns, provide patterns for prompts. |
| `src/investigator.ts` | Rewrite: orchestrates extract → survey → locate → prepare → confirm → act → verify → learn loop. |
| `src/vision.ts` | Slimmed down: only verify (before/after screenshots) and control add-in locate. |
| `src/script-player.ts` | Unchanged — replays .script.yml coordinates mechanically. |
| `src/browser.ts` | Unchanged — browser setup, auth, awaitBCFrame. |

### Changes to existing modules

**vision.ts** — Remove: `buildSurveyPrompt`, `parseSurveyResponse`, `surveyPage`, `buildLocatePrompt`, `buildInputPrompt`, `locateWithContext`, `PageSurvey`. Keep: `buildVerifyPrompt`, `parseVerifyResponse`, `verify`, `VisionClient.call`, `locate` (for control add-in fallback).

**investigator.ts** — Rewrite `investigateStep` to use the 9-step flow. Replace `surveyCurrentPage` with `domExtract` + `domInterpreter.survey`. Keep `clickByLabel` for Playwright locator-based clicking. Remove hardcoded FastTab expansion (now done via confirmed selectors from Claude).

## Cost Comparison

Per step, current pure vision approach:
- 2-6 vision API calls (locate + retry + verify) × ~1500 image tokens = 3,000-9,000 input tokens

Per step, new hybrid approach:
- 2-3 text API calls (survey + locate + confirm) × ~3,000 text tokens = 6,000-9,000 input tokens
- 1 vision API call (verify) × ~3,000 image tokens (two screenshots) = 3,000 input tokens
- Total: ~9,000-12,000 input tokens

Token count is similar but **text tokens are ~10x cheaper than image tokens** at Claude's pricing, and the results are dramatically more accurate (exact selectors vs approximate coordinates).
