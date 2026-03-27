// src/dom-interpreter.ts
import Anthropic from '@anthropic-ai/sdk';
import { debug } from './log.js';
import { patternsToPromptContext, type KnowledgePattern } from './knowledge.js';
/** Describes what a YAML step wants to do — used to build locate prompts. */
export interface StepSource {
  type: string;
  caption?: string;
  field?: string;
  value?: string;
  row?: number | string;
  assistEdit?: boolean;
}

const SYSTEM_PROMPT = `You are an expert Business Central (BC) DOM navigator. You interpret cleaned HTML from BC's web client and return precise CSS selectors and interaction instructions.

## Your Role
You act as a co-pilot for a Playwright-based automation system. You read the page HTML and advise:
1. What page/state we're on
2. Where target elements are (or what needs to happen first to reveal them)
3. Exact CSS selectors that Playwright can use

## BC Page Types
- **List page**: Grid/table of records. Action bar has New, Delete, etc. Grid uses \`table.ms-nav-grid-data-table\` or \`[role="grid"]\`.
- **Card page**: Single record with FastTab sections. Fields are \`<div controlname="X"><input/></div>\`.
- **Document page**: Card + embedded grid (header fields + line items).
- **Worksheet page**: Full-page editable grid (journal-style). Has \`[role="grid"]\` with editable inputs in cells.
- **Dialog**: Modal overlay with \`[role="dialog"]\` or \`[class*="ms-nav-popup"]\`.

## CRITICAL: Edit Mode Duplication
When BC enters edit mode, it renders a SECOND set of elements (grids, fields, buttons) on top of view-mode content WITHOUT wrapping them in \`[role="dialog"]\`. Both sets stay in the DOM. **Always target the LAST visible match** in document order — that's the edit-mode (interactive) version.

## CRITICAL: Overlay/Dialog Handling
BC opens records as modal overlays stacked on top of list pages. Multiple overlays can stack.
- \`[role="dialog"]\`, \`[class*="ms-nav-popup"]\`, \`[class*="modal-dialog"]\` mark overlays
- Ignore \`[class*="TeachingBubble"]\` — those are tooltips
- **Always interact with the TOPMOST (last in DOM order) visible overlay**
- The HTML will be annotated with \`<!-- ACTIVE LAYER -->\` and \`<!-- BACKGROUND LAYER -->\` comments

## Field Finding (priority order)
1. \`td[controlname="FieldName"] input\` — grid cells (most reliable for worksheets/documents)
2. \`[controlname="FieldName"] input\` — card fields
3. \`[aria-label="FieldName"]\` — exact aria-label on the element
4. \`input[aria-label*="FieldName"]\` — partial aria-label on inputs
5. \`[aria-label*="FieldName"]\` — partial match (prefer shortest label = most specific)
6. \`[title*="FieldName"]\` — title attribute (skip elements titled "Open Menu")
7. Caption text → adjacent sibling input — label element with matching text

## Action Button Finding (priority order)
1. Dialog scope first: \`[role="dialog"]:last-of-type button[role="menuitem"][aria-label="X"]\`
2. Exact role: \`button[role="menuitem"][aria-label="X"]\`, \`[role="button"][aria-label="X"]\`, \`a[role="link"][aria-label="X"]\`
3. Partial name: same roles without exact match
4. CSS text: \`button:has-text("X")\`, \`[role="menuitem"]:has-text("X")\`
5. getByText: any element containing the text
For OK/Cancel/Close/Yes/No: if no dialog is visible, the dialog already closed — skip.

## FastTab Patterns
- Headers: elements with \`aria-expanded="true|false"\` inside card form containers
- Container classes: \`collapsibleTab\`, \`collapsibleTab-container\`
- **CRITICAL**: Collapsed FastTabs (aria-expanded="false") do NOT render child fields in the DOM. You MUST expand the tab first, then re-read HTML to find the fields.
- "Show more" links: \`a\` or \`span\` with text "Show more" / "Vis mere" / "Mehr anzeigen", SCOPED to the FastTab container

## Grid/Row Patterns
- Data tables: \`table.ms-nav-grid-data-table\`, \`table[class*="ms-nav-grid"][class*="data"]\`
- ARIA grids: \`[role="grid"]\` with \`[role="row"]\` children
- Iterate tables in REVERSE (edit-mode grid is last in DOM order)
- Data rows: exclude \`th\`, \`[role="columnheader"]\`, and empty rows
- Click the row's \`<a>\` link if available, otherwise the first \`<td>\`

## Input Patterns
- Text: click to focus → fill/type → Tab to confirm
- Boolean: \`input[type="checkbox"]\` or \`[role="checkbox"]\` — check current state, click to toggle
- Combobox: \`[role="combobox"]\` — type value, Tab to auto-match
- Concealed: \`input[type="password"]\` (e.g., IBAN) — same as text
- Assist-edit: click field to focus → "..." button appears → click it (or F6 shortcut)

## Scroll State
Annotated at bottom: \`<!-- scroll: vertical X/Ypx, horizontal X/Ypx -->\`

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
  source: StepSource,
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

// --- Advise (co-pilot mode) ---

export interface DomAdvice {
  pageType: string;
  pageTitle: string;
  elementVisible: boolean;
  preparation: Array<{
    action: 'expandSection' | 'scrollTo' | 'clickShowMore';
    selector: string;
    reason: string;
  }>;
  suggestedSelector: string;
  confidence: string;
  reasoning: string;
}

export function buildAdvisePrompt(
  html: string,
  source: StepSource,
  patterns: KnowledgePattern[],
): string {
  const patternContext = patternsToPromptContext(patterns);
  const target =
    source.type === 'input'
      ? `input field "${source.field}" (to type "${source.value}")`
      : source.row != null
        ? `row ${typeof source.row === 'number' ? `#${source.row}` : `"${source.row}"`} in the grid`
        : source.assistEdit
          ? `assist-edit "..." button for "${source.caption}"`
          : `action/button "${source.caption}"`;

  return `You are advising a Playwright automation system about how to reach ${target} on this BC page.

The system has its own hardcoded strategies for finding elements, but it needs your help to:
1. Understand what page/state we're on
2. Identify if preparation is needed BEFORE the system tries its strategies (expand FastTab, scroll, click Show more)
3. Suggest the best CSS selector if you can see the element

${patternContext}

## Current Page HTML
\`\`\`html
${html}
\`\`\`

Return JSON:
{
  "pageType": "list|card|document|worksheet|dialog",
  "pageTitle": "<page title>",
  "elementVisible": <true if the target element is present in the current HTML>,
  "preparation": [
    { "action": "expandSection"|"scrollTo"|"clickShowMore", "selector": "<CSS selector to click/scroll>", "reason": "<why>" }
  ],
  "suggestedSelector": "<CSS selector for the target element, or best guess if not yet visible>",
  "confidence": "high|medium|low",
  "reasoning": "<explain: what page are we on, is the element visible, what needs to happen first>"
}

IMPORTANT:
- If the element is in a collapsed FastTab (aria-expanded="false"), the HTML WON'T contain its fields — include an expandSection prep step
- If the element is already visible in the HTML, set preparation to [] and provide the direct selector
- For actions: check if a dialog is open (search inside dialog first)
- For fields: check controlname attribute first (most reliable)
- Always use .last() or :last-of-type hints when edit-mode duplication is possible`;
}

export function parseAdviseResponse(text: string): DomAdvice {
  const json = JSON.parse(extractJson(text));
  return {
    pageType: json.pageType ?? 'unknown',
    pageTitle: json.pageTitle ?? '',
    elementVisible: json.elementVisible === true,
    preparation: (json.preparation ?? []).map((p: Record<string, unknown>) => ({
      action: p.action as string,
      selector: (p.selector as string) ?? '',
      reason: (p.reason as string) ?? '',
    })),
    suggestedSelector: json.suggestedSelector ?? '',
    confidence: json.confidence ?? 'low',
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
    source: StepSource,
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

  /**
   * Co-pilot mode: advises the player on what preparation is needed
   * before running its hardcoded strategies, and suggests a selector.
   */
  async advise(html: string, source: StepSource, patterns: KnowledgePattern[]): Promise<DomAdvice> {
    const prompt = buildAdvisePrompt(html, source, patterns);
    debug(`DOM advise: ${source.caption ?? source.field ?? source.row ?? 'unknown'}`);
    const text = await this.call(prompt);
    debug(`DOM advise response: ${text.slice(0, 200)}`);
    return parseAdviseResponse(text);
  }
}
