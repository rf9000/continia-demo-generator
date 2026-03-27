// src/vision.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LocateResult, VerifyResult } from './script-types.js';
import type { ScriptStepSource } from './script-types.js';
import { debug } from './log.js';

const SYSTEM_PROMPT = `You are a UI automation agent navigating a Microsoft Dynamics 365 Business Central (BC) web client.
The viewport is 1920x1080 pixels.
Return coordinates as {"x": <number>, "y": <number>} relative to the top-left corner of the viewport.
If the element is not visible, describe what preparation is needed (scroll, expand section, wait) in the "prep" array.
If the element is inside a control add-in (custom embedded widget/iframe), still provide coordinates based on its visual position.
Always respond with ONLY a JSON object — no markdown, no explanation outside the JSON.`;

/** Builds the user prompt for a locate call (action or row step). */
export function buildLocatePrompt(source: ScriptStepSource): string {
  if (source.type === 'action' && source.assistEdit) {
    return `Find the field labeled "${source.caption}" on this Business Central page. I need to click its assist-edit "..." button. Return the coordinates of the field's value area (clicking it will reveal the "..." button).

Respond with JSON: { "element": "<description>", "coordinates": {"x": <n>, "y": <n>}, "confidence": <0-1>, "prep": [<prep actions if needed>], "observation": "<what you see>" }

Prep action format: { "action": "scroll"|"click"|"wait", "coordinates": {"x":<n>,"y":<n>}, "direction": "up"|"down"|"left"|"right", "px": <n>, "ms": <n>, "reason": "<why>" }`;
  }

  if (source.type === 'action' && source.row != null) {
    const rowDesc =
      typeof source.row === 'number'
        ? `row number ${source.row} (1-indexed from top)`
        : `the row containing the text "${source.row}"`;
    return `Find ${rowDesc} in the data grid/list on this Business Central page. Return the coordinates to click on that row to open it.

Respond with JSON: { "element": "<description>", "coordinates": {"x": <n>, "y": <n>}, "confidence": <0-1>, "prep": [<prep actions if needed>], "observation": "<what you see>" }`;
  }

  if (source.type === 'action' && source.caption) {
    return `Find the button, menu item, or action labeled "${source.caption}" on this Business Central page. Return its coordinates so I can click it.

Respond with JSON: { "element": "<description>", "coordinates": {"x": <n>, "y": <n>}, "confidence": <0-1>, "prep": [<prep actions if needed>], "observation": "<what you see>" }

Prep action format: { "action": "scroll"|"click"|"wait", "coordinates": {"x":<n>,"y":<n>}, "direction": "up"|"down"|"left"|"right", "px": <n>, "ms": <n>, "reason": "<why>" }`;
  }

  return `Describe what you see on this Business Central page and identify any interactive elements.

Respond with JSON: { "element": "unknown", "coordinates": {"x": 0, "y": 0}, "confidence": 0, "prep": [], "observation": "<what you see>" }`;
}

/** Builds the user prompt for an input locate call. */
export function buildInputPrompt(source: ScriptStepSource): string {
  return `Find the input field labeled "${source.field}" on this Business Central page. I need to click on it and type "${source.value}".

Return the coordinates of the field's input area (where I should click to focus it, then type).

Respond with JSON: { "element": "<description>", "coordinates": {"x": <n>, "y": <n>}, "confidence": <0-1>, "prep": [<prep actions if needed>], "observation": "<what you see>" }

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

  return `I just ${actionDesc} on this Business Central page.

Compare the two screenshots (before and after) and tell me if the action was successful.

Signs of success: a new page/dialog opened, a field value changed, a menu appeared, a confirmation message showed, the page navigated.
Signs of failure: nothing changed, an error message appeared, the wrong element was clicked.

Respond with JSON: { "success": <true|false>, "observation": "<what changed or didn't>", "newState": "<optional: dialog-open, page-navigated, etc>" }`;
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
