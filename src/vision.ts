// src/vision.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LocateResult, VerifyResult } from './script-types.js';
import type { ScriptStepSource } from './script-types.js';
import { debug } from './log.js';

const SYSTEM_PROMPT = `You are a UI automation agent navigating a Microsoft Dynamics 365 Business Central (BC) web client.

## Viewport & Coordinates
- The viewport is 1920x1080 pixels.
- Return coordinates as {"x": <number>, "y": <number>} relative to the top-left corner of the viewport.
- Be PRECISE with coordinates. Aim for the CENTER of the target element. A button at x=370..390 should return x=380, not x=400.

## BC Page Structure
BC pages have these layers from top to bottom:
1. **Header bar** (dark blue, ~17px) — Dynamics 365 Business Central branding
2. **Navigation bar** (~40px) — Company name, menu items (Finance, Sales, etc.)
3. **Action bar** (~30px) — Page-specific buttons (New, Delete, Edit, Process, etc.)
4. **Notification bar** (optional, ~30px) — Blue/yellow info banners. These do NOT block interaction — content is pushed below them.
5. **Content area** — The actual page data (cards, lists, grids, fields)

## BC Page Types
- **List page**: Shows a grid/table of records. Action bar has New, Delete, etc.
- **Card page**: Shows a single record with FastTabs (collapsible sections) containing fields.
- **Document page**: Card with an embedded grid (header fields + line items).

## Important Behaviors
- Clicking "New" on a list page should navigate to a NEW blank card page.
- Clicking a row in a list opens that record's card page.
- Notification banners are informational — they don't block page changes.
- If a control add-in (custom iframe widget) is visible, provide coordinates based on visual position.

Always respond with ONLY a JSON object — no markdown, no explanation outside the JSON.`;

/** Builds the user prompt for a locate call (action or row step). */
export function buildLocatePrompt(source: ScriptStepSource): string {
  const responseFormat = `Respond with JSON: { "element": "<description>", "coordinates": {"x": <n>, "y": <n>}, "confidence": <0-1>, "prep": [<prep actions if needed>], "observation": "<describe the current page: what type of page, what elements are visible, where the target is>" }

Prep action format: { "action": "scroll"|"click"|"wait", "coordinates": {"x":<n>,"y":<n>}, "direction": "up"|"down"|"left"|"right", "px": <n>, "ms": <n>, "reason": "<why>" }

IMPORTANT: Describe what type of BC page you see (list, card, document, dialog) and what page it is (e.g., "Bank Accounts list", "Bank Account Card"). This helps track navigation.`;

  if (source.type === 'action' && source.assistEdit) {
    return `Find the field labeled "${source.caption}" on this Business Central page. I need to click its assist-edit "..." button. Return the coordinates of the field's value area (clicking it will reveal the "..." button).

The field should be on a Card or Document page, inside a FastTab section. If the field is not visible, it may be in a collapsed FastTab or below the fold — describe what prep is needed.

${responseFormat}`;
  }

  if (source.type === 'action' && source.row != null) {
    const rowDesc =
      typeof source.row === 'number'
        ? `row number ${source.row} (1-indexed from top, counting only DATA rows with content, not header rows)`
        : `the row containing the text "${source.row}" in any cell`;
    return `Find ${rowDesc} in the data grid/list on this Business Central page. Return the coordinates to click on that row (aim for the first text cell with content).

Clicking a row on a list page should open that record's card/detail page.

${responseFormat}`;
  }

  if (source.type === 'action' && source.caption) {
    return `Find the button, menu item, or action labeled "${source.caption}" on this Business Central page.

Look for it in these locations (in order):
1. The action bar (toolbar row below the navigation bar) — buttons like "+ New", "Delete", "Edit", "Post"
2. Menu items in an open dropdown
3. Dialog buttons (OK, Cancel, Yes, No)
4. Links or buttons in the content area

The text "${source.caption}" should match the visible label. In BC, the "New" button often shows as "+ New".

Return the EXACT center coordinates of the clickable element.

${responseFormat}`;
  }

  return `Describe what you see on this Business Central page.

${responseFormat}`;
}

/** Builds the user prompt for an input locate call. */
export function buildInputPrompt(source: ScriptStepSource): string {
  return `Find the input field labeled "${source.field}" on this Business Central page. I need to click on it and type "${source.value}".

BC fields on Card pages are laid out as "Caption: [Value]" pairs inside FastTab sections. The input area is the value part (right side). Look for the field label "${source.field}" and return the coordinates of its VALUE/INPUT area.

If the field is not visible:
- It may be in a collapsed FastTab — describe which FastTab to expand
- It may be below the fold — describe scrolling needed
- It may be on a DIFFERENT page than what's currently shown — describe what's wrong

IMPORTANT: First identify what page you're on. If this is a list page but the field belongs on a card page, the confidence should be very low and you should explain that we're on the wrong page.

Respond with JSON: { "element": "<description>", "coordinates": {"x": <n>, "y": <n>}, "confidence": <0-1>, "prep": [<prep actions if needed>], "observation": "<describe the current page type and what you see>" }

Prep action format: { "action": "scroll"|"click"|"wait", "coordinates": {"x":<n>,"y":<n>}, "direction": "up"|"down"|"left"|"right", "px": <n>, "ms": <n>, "reason": "<why>" }`;
}

/** Builds the user prompt for a verify call. */
export function buildVerifyPrompt(
  source: ScriptStepSource,
  coordinates: { x: number; y: number },
): string {
  const actionDesc =
    source.type === 'input'
      ? `typed "${source.value}" into the "${source.field}" field`
      : source.row != null
        ? `clicked row "${source.row}"`
        : `clicked "${source.caption}" at (${coordinates.x}, ${coordinates.y})`;

  // Build expected outcome based on the action type
  let expectedOutcome = '';
  if (source.type === 'action' && source.caption === 'New') {
    expectedOutcome = `Expected outcome: A NEW blank card/edit page should have opened. The page title and action bar should be different from the before screenshot. A notification banner appearing is NOT sufficient — the page layout itself must change.`;
  } else if (source.type === 'action' && source.caption === 'OK') {
    expectedOutcome = `Expected outcome: A dialog should have closed, or the page should have navigated back.`;
  } else if (source.type === 'action' && source.row != null) {
    expectedOutcome = `Expected outcome: A card/detail page for that record should have opened. The page layout should change from a list to a card with fields.`;
  } else if (source.type === 'input') {
    expectedOutcome = `Expected outcome: The field "${source.field}" should now show the value "${source.value}".`;
  } else if (source.type === 'action' && source.caption) {
    expectedOutcome = `Expected outcome: The action "${source.caption}" should have triggered a visible change — a menu opened, a page navigated, a dialog appeared, or a process started.`;
  }

  return `I just ${actionDesc} on this Business Central page.

Compare the BEFORE screenshot (first image) and AFTER screenshot (second image) carefully.

${expectedOutcome}

IMPORTANT verification rules:
- A notification banner appearing (blue/yellow bar) is NOT a page change. Notifications are informational overlays.
- For "New" and row-click actions: the PAGE TYPE must change (e.g., from list to card). Same page with a notification = FAILED.
- For input actions: the field's visible value must match what was typed.
- Identify the page type in BOTH screenshots (list, card, document, dialog).

Respond with JSON: {
  "success": <true|false>,
  "observation": "<describe what changed between before and after>",
  "beforePage": "<page type and name in the before screenshot>",
  "afterPage": "<page type and name in the after screenshot>",
  "newState": "<optional: dialog-open, page-navigated, card-opened, etc>"
}`;
}

/** Extracts JSON from a model response that may be wrapped in markdown code fences. */
function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text;
}

/** Parses a locate response from the vision model. */
export function parseLocateResponse(text: string): LocateResult {
  const json = JSON.parse(extractJson(text));
  return {
    element: json.element ?? 'unknown',
    coordinates: {
      x: Math.round(json.coordinates?.x ?? 0),
      y: Math.round(json.coordinates?.y ?? 0),
    },
    confidence: json.confidence ?? 0,
    prep: (json.prep ?? []).map((p: Record<string, unknown>) => ({
      action: p.action ?? 'wait',
      coordinates: p.coordinates as { x: number; y: number } | undefined,
      direction: p.direction as string | undefined,
      px: p.px as number | undefined,
      ms: p.ms as number | undefined,
      reason: p.reason as string | undefined,
    })),
    observation: json.observation ?? '',
  };
}

/** Parses a verify response from the vision model. */
export function parseVerifyResponse(text: string): VerifyResult {
  const json = JSON.parse(extractJson(text));
  return {
    success: json.success === true,
    beforePage: json.beforePage,
    afterPage: json.afterPage,
    observation: json.observation ?? '',
    newState: json.newState,
  };
}

/** Vision API client wrapping the Anthropic SDK. */
export class VisionClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  /** Sends a screenshot + prompt to the vision model and returns the raw text. */
  private async call(prompt: string, screenshots: Buffer[]): Promise<string> {
    const imageContent = screenshots.map((buf) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: buf.toString('base64'),
      },
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [...imageContent, { type: 'text', text: prompt }],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  /** Locates an element on screen given a screenshot and step source. */
  async locate(screenshot: Buffer, source: ScriptStepSource): Promise<LocateResult> {
    const prompt = source.type === 'input' ? buildInputPrompt(source) : buildLocatePrompt(source);
    debug(`Vision locate: ${source.caption ?? source.field ?? source.row ?? 'unknown'}`);
    const text = await this.call(prompt, [screenshot]);
    debug(`Vision response: ${text.slice(0, 200)}`);
    return parseLocateResponse(text);
  }

  /** Verifies an action by comparing before/after screenshots. */
  async verify(
    beforeScreenshot: Buffer,
    afterScreenshot: Buffer,
    source: ScriptStepSource,
    coordinates: { x: number; y: number },
  ): Promise<VerifyResult> {
    const prompt = buildVerifyPrompt(source, coordinates);
    debug(`Vision verify: ${source.caption ?? source.field ?? source.row ?? 'unknown'}`);
    const text = await this.call(prompt, [beforeScreenshot, afterScreenshot]);
    debug(`Vision verify response: ${text.slice(0, 200)}`);
    return parseVerifyResponse(text);
  }
}
