// src/dom-interpreter.ts
import Anthropic from '@anthropic-ai/sdk';
import { debug } from './log.js';
import { patternsToPromptContext, type KnowledgePattern } from './knowledge.js';
import type { ScriptStepSource } from './script-types.js';

const SYSTEM_PROMPT = `You are interpreting the HTML DOM of a Microsoft Dynamics 365 Business Central (BC) web client page.

You receive cleaned HTML that has been stripped of scripts, styles, and decorative elements. What remains is the semantic structure: elements with roles, aria-labels, controlnames, and text content.

## BC Page Structure in the DOM
- **List pages**: Contain a grid/table with rows of records. Action bar has menuitem buttons.
- **Card pages**: Contain FastTab sections (\`<section aria-expanded="true|false" aria-label="...">\`) with field pairs (\`<div controlname="FieldName"><input value="..."/></div>\`).
- **Overlays**: BC opens cards as modal overlays. The HTML will be annotated with \`<!-- ACTIVE LAYER -->\` comments. Always work with the active layer.
- **Scroll state**: Annotated at the bottom of the HTML as \`<!-- scroll: vertical X/Ypx -->\`.

## Key DOM Patterns
- FastTab header: element with \`aria-expanded="true|false"\` and \`aria-label="TabName"\`
- Field: \`<div controlname="FieldName"><input value="..."/></div>\`
- Action button: \`<button role="menuitem" aria-label="ActionName">\`
- Grid row: \`<tr>\` or \`[role="row"]\` inside a table or \`[role="grid"]\`

Always respond with ONLY a JSON object.`;

// --- Survey ---

export interface DomSurvey {
  pageType: string;
  pageTitle: string;
  isOverlay: boolean;
  backgroundPage?: string;
  sections: Array<{
    name: string;
    expanded: boolean;
    fields: string[];
  }>;
  actionBar: string[];
  scroll: { canScrollDown: boolean; canScrollRight: boolean };
}

export function buildSurveyPrompt(html: string, patterns: KnowledgePattern[]): string {
  const patternContext = patternsToPromptContext(patterns);

  return `Analyze this Business Central page HTML and describe its complete structure.

${patternContext}

## HTML
\`\`\`html
${html}
\`\`\`

Return JSON:
{
  "pageType": "list|card|document|dialog",
  "pageTitle": "<title from banner or page header>",
  "isOverlay": <true if annotated as ACTIVE LAYER>,
  "backgroundPage": "<description if there's a background layer>",
  "sections": [
    { "name": "<section/FastTab name>", "expanded": true|false, "fields": ["<field1>", ...] }
  ],
  "actionBar": ["<button1>", "<button2>", ...],
  "scroll": { "canScrollDown": <bool>, "canScrollRight": <bool> }
}

List EVERY field you find in the HTML (from controlname or aria-label attributes on input elements).`;
}

export function parseSurveyResponse(text: string): DomSurvey {
  const json = JSON.parse(extractJson(text));
  return {
    pageType: json.pageType ?? 'unknown',
    pageTitle: json.pageTitle ?? '',
    isOverlay: json.isOverlay ?? false,
    backgroundPage: json.backgroundPage,
    sections: (json.sections ?? []).map((s: Record<string, unknown>) => ({
      name: (s.name as string) ?? '',
      expanded: s.expanded === true,
      fields: (s.fields as string[]) ?? [],
    })),
    actionBar: json.actionBar ?? [],
    scroll: {
      canScrollDown: json.scroll?.canScrollDown ?? false,
      canScrollRight: json.scroll?.canScrollRight ?? false,
    },
  };
}

// --- Locate ---

export interface DomLocateResult {
  found: boolean;
  section?: string;
  sectionExpanded?: boolean;
  stepsToReach: Array<{
    action: 'expandSection' | 'scrollTo' | 'clickShowMore' | 'click';
    selector: string;
    reason?: string;
  }>;
  interactSelector: string;
  confidence: string;
  reasoning: string;
}

export function buildLocatePrompt(
  html: string,
  source: ScriptStepSource,
  patterns: KnowledgePattern[],
): string {
  const patternContext = patternsToPromptContext(patterns);
  const target =
    source.type === 'input'
      ? `the input field "${source.field}" (I need to type "${source.value}" into it)`
      : source.row != null
        ? `row ${source.row} in the data grid`
        : source.assistEdit
          ? `the assist-edit "..." button for field "${source.caption}"`
          : `the button/action "${source.caption}"`;

  return `Find ${target} in this Business Central page HTML.

${patternContext}

## HTML
\`\`\`html
${html}
\`\`\`

Return the CSS selector to interact with it, and any preparation steps needed (expand FastTab, scroll, click Show more).

Return JSON:
{
  "found": true|false,
  "section": "<FastTab name if applicable>",
  "sectionExpanded": true|false,
  "stepsToReach": [
    { "action": "expandSection"|"scrollTo"|"clickShowMore"|"click", "selector": "<CSS selector>", "reason": "<why>" }
  ],
  "interactSelector": "<CSS selector for the element to click/type into>",
  "confidence": "high|medium|low",
  "reasoning": "<explain where you found it and how to reach it>"
}

IMPORTANT:
- Use actual CSS selectors that Playwright can execute (e.g., \`[controlname="Currency Code"] input\`, \`[role="menuitem"][aria-label="New"]\`)
- If the element is in a collapsed section (aria-expanded="false"), include an expandSection step
- If the element is not in the current HTML at all, set found=false and explain what's missing`;
}

export function parseLocateResponse(text: string): DomLocateResult {
  const json = JSON.parse(extractJson(text));
  return {
    found: json.found === true,
    section: json.section,
    sectionExpanded: json.sectionExpanded,
    stepsToReach: (json.stepsToReach ?? []).map((s: Record<string, unknown>) => ({
      action: s.action as string,
      selector: (s.selector as string) ?? '',
      reason: s.reason as string | undefined,
    })),
    interactSelector: json.interactSelector ?? '',
    confidence: json.confidence ?? 'low',
    reasoning: json.reasoning ?? '',
  };
}

// --- Confirm ---

export interface DomConfirmResult {
  confirmed: boolean;
  selector: string;
  visible: boolean;
  reasoning: string;
}

export function buildConfirmPrompt(
  html: string,
  targetName: string,
  previousSelector: string,
): string {
  return `I just executed preparation steps to reach "${targetName}" on a Business Central page. Confirm the element is now accessible.

## Updated HTML (after preparation)
\`\`\`html
${html}
\`\`\`

Previous selector: \`${previousSelector}\`

Return JSON:
{
  "confirmed": true|false,
  "selector": "<CSS selector — same as before or updated if element moved>",
  "visible": true|false,
  "reasoning": "<explain what you see — is the section expanded? is the element present?>"
}

IMPORTANT: Do NOT just trust the previous selector. Verify the element actually exists in this HTML with the right controlname/aria-label. If the section is still collapsed or the element is missing, set confirmed=false.`;
}

export function parseConfirmResponse(text: string): DomConfirmResult {
  const json = JSON.parse(extractJson(text));
  return {
    confirmed: json.confirmed === true,
    selector: json.selector ?? '',
    visible: json.visible === true,
    reasoning: json.reasoning ?? '',
  };
}

// --- Client ---

/** Extracts JSON from a response that may have markdown code fences. */
function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

/** DOM interpreter client wrapping the Anthropic SDK. */
export class DomInterpreter {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  private async call(prompt: string, maxTokens = 2048): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  async survey(html: string, patterns: KnowledgePattern[]): Promise<DomSurvey> {
    const prompt = buildSurveyPrompt(html, patterns);
    debug(`DOM survey: ${html.length} chars HTML`);
    const text = await this.call(prompt, 4096);
    debug(`DOM survey response: ${text.slice(0, 200)}`);
    return parseSurveyResponse(text);
  }

  async locate(
    html: string,
    source: ScriptStepSource,
    patterns: KnowledgePattern[],
  ): Promise<DomLocateResult> {
    const prompt = buildLocatePrompt(html, source, patterns);
    debug(`DOM locate: ${source.caption ?? source.field ?? source.row ?? 'unknown'}`);
    const text = await this.call(prompt);
    debug(`DOM locate response: ${text.slice(0, 200)}`);
    return parseLocateResponse(text);
  }

  async confirm(
    html: string,
    targetName: string,
    previousSelector: string,
  ): Promise<DomConfirmResult> {
    const prompt = buildConfirmPrompt(html, targetName, previousSelector);
    debug(`DOM confirm: ${targetName}`);
    const text = await this.call(prompt);
    debug(`DOM confirm response: ${text.slice(0, 200)}`);
    return parseConfirmResponse(text);
  }
}
