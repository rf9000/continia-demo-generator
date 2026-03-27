# Vision-Based BC Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all hardcoded DOM navigation in the demo generator with a Claude Sonnet 4.6 vision model that looks at screenshots to locate elements and produce coordinate-based scripts.

**Architecture:** A vision-powered investigation phase takes screenshots of each YAML step, asks Claude Sonnet 4.6 to locate elements and verify actions, then emits a `.script.yml` with exact coordinates. The recording phase replays this script mechanically — no DOM queries, no strategy chains. The existing browser setup, auth, cookie transfer, and cursor animation code stays.

**Tech Stack:** TypeScript, Playwright (browser automation), `@anthropic-ai/sdk` (vision API), `yaml` (script format), `vitest` (testing)

**Spec:** `docs/superpowers/specs/2026-03-27-vision-based-navigation-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/script-types.ts` | Create | Types for `.script.yml` format — `ScriptStep`, `ScriptFile`, `LocateResult`, `VerifyResult` |
| `src/script-io.ts` | Create | Read/write `.script.yml`, compute spec hash, validate cache |
| `src/vision.ts` | Create | Anthropic API client — `locate()`, `verify()`, prompt construction, response parsing |
| `src/investigator.ts` | Create | See → act → verify loop — walks YAML steps, calls vision, executes in Playwright, emits script |
| `src/script-player.ts` | Create | Dumb recorder — reads `.script.yml`, moves cursor, clicks coordinates, types values |
| `src/browser.ts` | Create | Extract browser setup, auth, cookie transfer, `awaitBCFrame` from `player.ts` |
| `src/player.ts` | Delete | All functionality moved to `browser.ts`, `investigator.ts`, `script-player.ts` |
| `src/enricher.ts` | Delete | Replaced by `script-io.ts` |
| `src/types.ts` | Delete | Replaced by `script-types.ts` |
| `src/recorder.ts` | Modify | Orchestrate: investigator → env reset → script-player |
| `src/cli.ts` | Modify | New `--vision-model` and `--no-verify` flags, replace enricher pipeline with script pipeline |
| `src/config.ts` | Modify | Add `anthropicApiKey` and `visionModel` fields |
| `tests/script-io.test.ts` | Create | Tests for hash computation, cache validation, read/write |
| `tests/vision.test.ts` | Create | Tests for prompt construction and response parsing (mocked API) |

---

### Task 1: Install Anthropic SDK and update config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`

- [ ] **Step 1: Install `@anthropic-ai/sdk`**

Run:
```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Add config fields for Anthropic API**

In `src/config.ts`, add `anthropicApiKey` and `visionModel` to `DemoConfig` and `loadConfig`:

```typescript
import { config as loadEnv } from 'dotenv';

loadEnv({ quiet: true });

export interface DemoConfig {
  bcStartAddress: string;
  bcAuth: 'Windows' | 'AAD' | 'UserPassword';
  bcUsernameKey?: string;
  bcPasswordKey?: string;
  outputDir: string;
  headed: boolean;
  anthropicApiKey?: string;
  visionModel: string;
}

export function loadConfig(overrides?: Partial<DemoConfig>): DemoConfig {
  return {
    bcStartAddress:
      overrides?.bcStartAddress ?? process.env['BC_START_ADDRESS'] ?? 'http://localhost:8080/bc/',
    bcAuth: (overrides?.bcAuth ?? process.env['BC_AUTH'] ?? 'Windows') as DemoConfig['bcAuth'],
    bcUsernameKey: overrides?.bcUsernameKey ?? process.env['BC_USERNAME_KEY'],
    bcPasswordKey: overrides?.bcPasswordKey ?? process.env['BC_PASSWORD_KEY'],
    outputDir: overrides?.outputDir ?? process.env['OUTPUT_DIR'] ?? './output',
    headed: overrides?.headed ?? true,
    anthropicApiKey: overrides?.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'],
    visionModel: overrides?.visionModel ?? 'claude-sonnet-4-6-20250514',
  };
}
```

- [ ] **Step 3: Verify build passes**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat: add Anthropic SDK dependency and vision config fields"
```

---

### Task 2: Create script types (`src/script-types.ts`)

**Files:**
- Create: `src/script-types.ts`
- Create: `tests/script-io.test.ts` (partial — type imports)

- [ ] **Step 1: Write the types file**

```typescript
// src/script-types.ts

/** A prep action the vision model says to do before the main action. */
export interface PrepAction {
  action: 'scroll' | 'click' | 'wait';
  coordinates?: { x: number; y: number };
  direction?: 'up' | 'down' | 'left' | 'right';
  px?: number;
  ms?: number;
  reason?: string;
}

/** Result from the vision model's locate call. */
export interface LocateResult {
  element: string;
  coordinates: { x: number; y: number };
  confidence: number;
  prep: PrepAction[];
  observation: string;
}

/** Result from the vision model's verify call. */
export interface VerifyResult {
  success: boolean;
  observation: string;
  newState?: string;
}

/** The original YAML step, preserved in the script for debugging. */
export interface ScriptStepSource {
  type: string;
  caption?: string;
  field?: string;
  value?: string;
  row?: number | string;
  assistEdit?: boolean;
}

/** One step in the coordinate script. */
export interface ScriptStep {
  index: number;
  source: ScriptStepSource;
  action: 'click' | 'click-then-type' | 'double-click';
  coordinates: { x: number; y: number };
  value?: string;
  confidence: number;
  prep: PrepAction[];
  verification: VerifyResult;
  context?: string;
  screenshot: string;
}

/** The top-level .script.yml file. */
export interface ScriptFile {
  specHash: string;
  model: string;
  investigatedAt: string;
  viewportSize: { width: number; height: number };
  steps: ScriptStep[];
}
```

- [ ] **Step 2: Verify build passes**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/script-types.ts
git commit -m "feat: add script types for vision-based coordinate scripts"
```

---

### Task 3: Create script I/O (`src/script-io.ts`) with tests

**Files:**
- Create: `src/script-io.ts`
- Create: `tests/script-io.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/script-io.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { computeSpecHash, writeScript, readScript, isScriptValid } from '../src/script-io.js';
import type { ScriptFile } from '../src/script-types.js';

const tmpDir = resolve('./test-tmp-script');

describe('computeSpecHash', () => {
  test('returns consistent hash for same steps', () => {
    const steps = [
      { type: 'action', target: [{ page: 'Test' }], caption: 'OK' },
      { type: 'input', target: [{ page: 'Test', field: 'Name' }], value: 'X' },
    ];
    const hash1 = computeSpecHash(steps);
    const hash2 = computeSpecHash(steps);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  test('returns different hash when steps change', () => {
    const steps1 = [{ type: 'action', caption: 'OK' }];
    const steps2 = [{ type: 'action', caption: 'Cancel' }];
    expect(computeSpecHash(steps1)).not.toBe(computeSpecHash(steps2));
  });
});

describe('writeScript / readScript', () => {
  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const sampleScript: ScriptFile = {
    specHash: 'abc123',
    model: 'claude-sonnet-4-6-20250514',
    investigatedAt: '2026-03-27T14:00:00Z',
    viewportSize: { width: 1920, height: 1080 },
    steps: [
      {
        index: 0,
        source: { type: 'action', caption: 'Post' },
        action: 'click',
        coordinates: { x: 850, y: 120 },
        confidence: 0.92,
        prep: [],
        verification: { success: true, observation: 'Dialog appeared' },
        screenshot: 'step-00-before.png',
      },
    ],
  };

  test('round-trips a script through write and read', () => {
    const path = resolve(tmpDir, 'test.script.yml');
    writeScript(sampleScript, path);
    const loaded = readScript(path);
    expect(loaded.specHash).toBe('abc123');
    expect(loaded.steps).toHaveLength(1);
    expect(loaded.steps[0].coordinates).toEqual({ x: 850, y: 120 });
  });
});

describe('isScriptValid', () => {
  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('returns true when spec hash matches', () => {
    const specPath = resolve(tmpDir, 'spec.yml');
    const scriptPath = resolve(tmpDir, 'spec.script.yml');
    const specContent = 'description: test\nsteps:\n  - type: action\n    caption: OK\n';
    writeFileSync(specPath, specContent);

    // Compute hash from the spec steps and write a matching script
    const steps = [{ type: 'action', caption: 'OK' }];
    const hash = computeSpecHash(steps);
    const script: ScriptFile = {
      specHash: hash,
      model: 'test',
      investigatedAt: 'now',
      viewportSize: { width: 1920, height: 1080 },
      steps: [],
    };
    writeScript(script, scriptPath);

    expect(isScriptValid(specPath, scriptPath)).toBe(true);
  });

  test('returns false when spec has changed', () => {
    const specPath = resolve(tmpDir, 'spec.yml');
    const scriptPath = resolve(tmpDir, 'spec.script.yml');
    writeFileSync(specPath, 'description: test\nsteps:\n  - type: action\n    caption: Cancel\n');

    const script: ScriptFile = {
      specHash: 'stale-hash',
      model: 'test',
      investigatedAt: 'now',
      viewportSize: { width: 1920, height: 1080 },
      steps: [],
    };
    writeScript(script, scriptPath);

    expect(isScriptValid(specPath, scriptPath)).toBe(false);
  });

  test('returns false when script file does not exist', () => {
    const specPath = resolve(tmpDir, 'spec.yml');
    writeFileSync(specPath, 'description: test\nsteps:\n  - type: action\n    caption: OK\n');
    expect(isScriptValid(specPath, resolve(tmpDir, 'missing.yml'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run tests/script-io.test.ts
```
Expected: FAIL — `script-io.js` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/script-io.ts
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ScriptFile } from './script-types.js';
import { info } from './log.js';

/**
 * Computes a hash of the original spec's steps array.
 * Used to detect when the spec has changed and re-investigation is needed.
 */
export function computeSpecHash(steps: unknown[]): string {
  const content = JSON.stringify(
    steps.map((s) => {
      const step = s as Record<string, unknown>;
      return {
        type: step.type,
        target: step.target,
        caption: step.caption,
        row: step.row,
        value: step.value,
        assistEdit: step.assistEdit,
      };
    }),
  );
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Writes a ScriptFile to disk as YAML. */
export function writeScript(script: ScriptFile, path: string): void {
  writeFileSync(path, stringifyYaml(script, { lineWidth: 120 }));
  info(`Script written to: ${path}`);
}

/** Reads a ScriptFile from disk. */
export function readScript(path: string): ScriptFile {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as ScriptFile;
}

/**
 * Checks whether an existing .script.yml is still valid by comparing
 * its specHash against the current original spec.
 */
export function isScriptValid(specPath: string, scriptPath: string): boolean {
  try {
    const specContent = parseYaml(readFileSync(specPath, 'utf-8')) as { steps: unknown[] };
    const script = readScript(scriptPath);
    if (!script.specHash) return false;
    const currentHash = computeSpecHash(specContent.steps);
    return currentHash === script.specHash;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run tests/script-io.test.ts
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/script-io.ts tests/script-io.test.ts
git commit -m "feat: add script I/O with hash validation and tests"
```

---

### Task 4: Create vision module (`src/vision.ts`) with tests

**Files:**
- Create: `src/vision.ts`
- Create: `tests/vision.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/vision.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { buildLocatePrompt, buildVerifyPrompt, buildInputPrompt, parseLocateResponse, parseVerifyResponse } from '../src/vision.js';

describe('buildLocatePrompt', () => {
  test('builds prompt for action step with caption', () => {
    const prompt = buildLocatePrompt({ type: 'action', caption: 'Post' });
    expect(prompt).toContain('Post');
    expect(prompt).toContain('button');
  });

  test('builds prompt for action step with row', () => {
    const prompt = buildLocatePrompt({ type: 'action', row: 'PMT JNL' });
    expect(prompt).toContain('PMT JNL');
    expect(prompt).toContain('row');
  });

  test('builds prompt for input step', () => {
    const prompt = buildInputPrompt({ type: 'input', field: 'Bank Name', value: 'Danske Bank' });
    expect(prompt).toContain('Bank Name');
    expect(prompt).toContain('input');
  });

  test('builds prompt for assistEdit step', () => {
    const prompt = buildLocatePrompt({ type: 'action', caption: 'Batch Name', assistEdit: true });
    expect(prompt).toContain('Batch Name');
    expect(prompt).toContain('assist');
  });
});

describe('parseLocateResponse', () => {
  test('parses valid JSON response', () => {
    const json = {
      element: 'Post button',
      coordinates: { x: 850, y: 120 },
      confidence: 0.92,
      prep: [],
      observation: 'Found the Post button in the action bar',
    };
    const result = parseLocateResponse(JSON.stringify(json));
    expect(result.coordinates).toEqual({ x: 850, y: 120 });
    expect(result.confidence).toBe(0.92);
  });

  test('parses response with prep actions', () => {
    const json = {
      element: 'Bank Name field',
      coordinates: { x: 600, y: 340 },
      confidence: 0.88,
      prep: [{ action: 'scroll', direction: 'down', px: 200, reason: 'field below fold' }],
      observation: 'Field is in General FastTab',
    };
    const result = parseLocateResponse(JSON.stringify(json));
    expect(result.prep).toHaveLength(1);
    expect(result.prep[0].action).toBe('scroll');
  });

  test('extracts JSON from markdown code block', () => {
    const response = 'Here is the result:\n```json\n{"element":"OK","coordinates":{"x":100,"y":200},"confidence":0.9,"prep":[],"observation":"found"}\n```';
    const result = parseLocateResponse(response);
    expect(result.coordinates).toEqual({ x: 100, y: 200 });
  });

  test('throws on unparseable response', () => {
    expect(() => parseLocateResponse('I cannot find anything')).toThrow();
  });
});

describe('parseVerifyResponse', () => {
  test('parses successful verification', () => {
    const json = { success: true, observation: 'Dialog appeared' };
    const result = parseVerifyResponse(JSON.stringify(json));
    expect(result.success).toBe(true);
  });

  test('parses failed verification', () => {
    const json = { success: false, observation: 'Nothing changed on the page' };
    const result = parseVerifyResponse(JSON.stringify(json));
    expect(result.success).toBe(false);
    expect(result.observation).toContain('Nothing changed');
  });
});

describe('buildVerifyPrompt', () => {
  test('includes step description', () => {
    const prompt = buildVerifyPrompt(
      { type: 'action', caption: 'Post' },
      { x: 850, y: 120 },
    );
    expect(prompt).toContain('Post');
    expect(prompt).toContain('850');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run tests/vision.test.ts
```
Expected: FAIL — `vision.js` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
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
    const rowDesc = typeof source.row === 'number'
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
  const actionDesc = source.type === 'input'
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
  // Try to extract from ```json ... ``` block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find a raw JSON object
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
  private async call(
    prompt: string,
    screenshots: Buffer[],
  ): Promise<string> {
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
          content: [
            ...imageContent,
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  /** Locates an element on screen given a screenshot and step source. */
  async locate(screenshot: Buffer, source: ScriptStepSource): Promise<LocateResult> {
    const prompt = source.type === 'input'
      ? buildInputPrompt(source)
      : buildLocatePrompt(source);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run tests/vision.test.ts
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/vision.ts tests/vision.test.ts
git commit -m "feat: add vision module with Anthropic API client and prompt builders"
```

---

### Task 5: Extract browser setup into `src/browser.ts`

**Files:**
- Create: `src/browser.ts`

This extracts the reusable Playwright logic from `player.ts` — browser launch, BC authentication, cookie transfer, `awaitBCFrame`. Both `investigator.ts` and `script-player.ts` will import from here.

- [ ] **Step 1: Create `src/browser.ts`**

```typescript
// src/browser.ts
import { chromium, type Page, type Frame, type BrowserContext, type Browser } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { DemoConfig } from './config.js';
import { info, debug } from './log.js';

const NAV_TIMEOUT_MS = 120_000;

export interface BCSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  frame: Frame;
  authenticatedUrl: string;
}

/**
 * Waits for BC's execution context to be idle in both the main page
 * and the iframe, then returns the BC iframe.
 */
export async function awaitBCFrame(page: Page, timeout = NAV_TIMEOUT_MS): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const isIdle = await page.evaluate(() => {
      const ns = window as unknown as Record<string, unknown>;
      const namespace = (ns['BC'] ?? ns['DN']) as
        | { ExecutionContext?: { Instance?: { IsIdle?: () => boolean } } }
        | undefined;
      return namespace?.ExecutionContext?.Instance?.IsIdle?.() ?? false;
    });

    if (isIdle) {
      const frames = page.frames();
      const bcFrame = frames.find(
        (f) => f !== page.mainFrame() && f.url().includes('/BC/'),
      );
      if (bcFrame) return bcFrame;
      // Some environments don't use an iframe — return main frame
      return page.mainFrame();
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`BC did not become idle within ${timeout}ms`);
}

/**
 * Launches a browser, authenticates with BC, transfers cookies,
 * and returns a ready-to-use session with the BC frame loaded.
 *
 * @param config - BC connection config
 * @param options.headless - force headless mode
 * @param options.recordVideo - directory for video recording (omit for no video)
 * @param options.pageId - BC page ID to navigate to
 * @param options.profile - BC role center profile
 * @param options.editMode - switch to edit mode after loading
 */
export async function launchBCSession(
  config: DemoConfig,
  options: {
    headless?: boolean;
    recordVideoDir?: string;
    pageId?: number;
    profile?: string;
    editMode?: boolean;
  } = {},
): Promise<BCSession> {
  const bcUrl = new URL(config.bcStartAddress);
  if (options.profile) {
    bcUrl.searchParams.set('profile', options.profile);
  }
  if (options.pageId) {
    bcUrl.searchParams.set('page', String(options.pageId));
  }

  const headless = options.headless ?? !config.headed;
  const browser = await chromium.launch({ headless });

  // Phase A: Authenticate in a non-recording context
  debug(`Navigating to: ${bcUrl.toString()}`);
  const authContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const authPage = await authContext.newPage();
  await authPage.goto(bcUrl.toString());

  if (config.bcAuth === 'UserPassword' && config.bcUsernameKey && config.bcPasswordKey) {
    const username = process.env[config.bcUsernameKey];
    const password = process.env[config.bcPasswordKey] ?? '';
    if (username) {
      info(`Auth: ${username} (UserPassword)`);
      await authPage.fill('input[name=UserName]', username);
      await authPage.fill('input[name=Password]', password);
      await Promise.all([
        authPage.click('button[type=submit]', { timeout: NAV_TIMEOUT_MS }),
        authPage.waitForNavigation({ timeout: NAV_TIMEOUT_MS }),
      ]);
    }
  }

  info('Waiting for BC to load...');
  await authPage.waitForTimeout(200);
  await awaitBCFrame(authPage);
  debug('BC is ready — transferring session');

  const cookies = await authContext.cookies();
  const authenticatedUrl = authPage.url();
  await authContext.close();

  // Phase B: Create the real context (with or without video)
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1920, height: 1080 },
  };
  if (options.recordVideoDir) {
    mkdirSync(resolve(options.recordVideoDir), { recursive: true });
    contextOptions.recordVideo = {
      dir: resolve(options.recordVideoDir),
      size: { width: 1920, height: 1080 },
    };
  }
  const context = await browser.newContext(contextOptions);
  await context.addCookies(cookies);
  const page = await context.newPage();

  await page.goto(authenticatedUrl);
  await page.waitForTimeout(200);
  const frame = await awaitBCFrame(page);

  // Optional: switch to edit mode
  if (options.editMode) {
    debug('Switching to edit mode...');
    for (const label of ['Edit', 'Edit List']) {
      const btn = frame.getByRole('menuitem', { name: label, exact: true });
      if ((await btn.count()) > 0) {
        await btn.first().click();
        info(`Clicked "${label}" to enter edit mode`);
        await awaitBCFrame(page, 10_000).catch(() => {});
        await page.waitForTimeout(300);
        break;
      }
    }
  }

  return { browser, context, page, frame, authenticatedUrl };
}

/** Closes the browser session. */
export async function closeBCSession(session: BCSession): Promise<string | undefined> {
  let videoPath: string | undefined;
  try {
    await session.page.close();
    videoPath = await session.page.video()?.path() ?? undefined;
  } catch { /* ignore */ }
  await session.context.close();
  await session.browser.close();
  return videoPath;
}
```

- [ ] **Step 2: Verify build passes**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/browser.ts
git commit -m "feat: extract browser setup and BC auth into shared browser module"
```

---

### Task 6: Create investigator (`src/investigator.ts`)

**Files:**
- Create: `src/investigator.ts`

- [ ] **Step 1: Write the investigator**

```typescript
// src/investigator.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, parse as parsePath } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Page, Frame } from 'playwright';
import { VisionClient } from './vision.js';
import { launchBCSession, closeBCSession, awaitBCFrame } from './browser.js';
import { computeSpecHash, writeScript } from './script-io.js';
import type { ScriptFile, ScriptStep, ScriptStepSource, PrepAction, LocateResult } from './script-types.js';
import { DemoConfig } from './config.js';
import { info, debug } from './log.js';

const MAX_RETRIES = 3;
const POST_ACTION_WAIT_MS = 2000;

interface YamlSpec {
  description?: string;
  name?: string;
  start?: {
    profile?: string;
    page?: string;
    pageId?: number;
    mode?: 'edit';
  };
  steps: Array<{
    type: string;
    target?: Array<{ page?: string; field?: string }>;
    caption?: string;
    row?: number | string;
    value?: string;
    description?: string;
    assistEdit?: boolean;
    steps?: Array<{ type: string; target?: Array<{ page?: string; field?: string }>; caption?: string; row?: number | string; value?: string; description?: string; assistEdit?: boolean }>;
  }>;
}

/** Converts a YAML step to a ScriptStepSource for vision prompts. */
function toSource(step: YamlSpec['steps'][0]): ScriptStepSource {
  return {
    type: step.type,
    caption: step.caption,
    field: step.target?.find((t) => t.field)?.field,
    value: step.value,
    row: step.row,
    assistEdit: step.assistEdit,
  };
}

/** Takes a screenshot and saves it to disk, returning the buffer. */
async function captureScreenshot(page: Page, outputDir: string, name: string): Promise<Buffer> {
  const buffer = await page.screenshot({ type: 'png' });
  const path = resolve(outputDir, name);
  writeFileSync(path, buffer);
  return buffer;
}

/** Executes a prep action (scroll, click, wait) on the page. */
async function executePrepAction(page: Page, prep: PrepAction): Promise<void> {
  if (prep.action === 'scroll' && prep.direction && prep.px) {
    const deltaX = prep.direction === 'left' ? -prep.px : prep.direction === 'right' ? prep.px : 0;
    const deltaY = prep.direction === 'up' ? -prep.px : prep.direction === 'down' ? prep.px : 0;
    await page.mouse.wheel(deltaX, deltaY);
    await page.waitForTimeout(500);
  } else if (prep.action === 'click' && prep.coordinates) {
    await page.mouse.click(prep.coordinates.x, prep.coordinates.y);
    await page.waitForTimeout(500);
  } else if (prep.action === 'wait') {
    await page.waitForTimeout(prep.ms ?? 1000);
  }
}

/** Runs a single step through the see → act → verify loop. */
async function investigateStep(
  vision: VisionClient,
  page: Page,
  source: ScriptStepSource,
  stepIndex: number,
  outputDir: string,
  skipVerify: boolean,
): Promise<ScriptStep> {
  let lastLocate: LocateResult | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      info(`  Retry ${attempt}/${MAX_RETRIES - 1}...`);
    }

    // SCREENSHOT
    const beforeBuf = await captureScreenshot(
      page,
      outputDir,
      `step-${String(stepIndex).padStart(2, '0')}-before${attempt > 0 ? `-retry${attempt}` : ''}.png`,
    );

    // LOCATE
    const locateResult = await vision.locate(beforeBuf, source);
    lastLocate = locateResult;
    info(`  → ${locateResult.element} at (${locateResult.coordinates.x}, ${locateResult.coordinates.y}) [confidence: ${locateResult.confidence}]`);

    if (locateResult.confidence < 0.3) {
      info(`  Confidence too low (${locateResult.confidence}), retrying...`);
      continue;
    }

    // PREP
    if (locateResult.prep.length > 0) {
      debug(`  Executing ${locateResult.prep.length} prep actions...`);
      for (const prep of locateResult.prep) {
        debug(`    ${prep.action}: ${prep.reason ?? ''}`);
        await executePrepAction(page, prep);
      }

      // Re-locate after prep changed the page
      const afterPrepBuf = await captureScreenshot(page, outputDir, `step-${String(stepIndex).padStart(2, '0')}-after-prep.png`);
      const reLocate = await vision.locate(afterPrepBuf, source);
      lastLocate = reLocate;
      info(`  → Re-located: (${reLocate.coordinates.x}, ${reLocate.coordinates.y}) [confidence: ${reLocate.confidence}]`);
    }

    // ACT
    const coords = lastLocate.coordinates;
    if (source.type === 'input' && source.value) {
      // Click to focus, then type
      await page.mouse.click(coords.x, coords.y);
      await page.waitForTimeout(300);
      // Triple-click to select existing content, then type over it
      await page.mouse.click(coords.x, coords.y, { clickCount: 3 });
      await page.waitForTimeout(100);
      await page.keyboard.type(source.value, { delay: 50 });
      await page.keyboard.press('Tab');
    } else if (source.assistEdit) {
      // Click field to focus, wait for assist button to appear, then click it
      await page.mouse.click(coords.x, coords.y);
      await page.waitForTimeout(600);
      // The assist-edit "..." button typically appears to the right of the field
      // Take a new screenshot and ask vision to find the "..." button
      const assistBuf = await captureScreenshot(page, outputDir, `step-${String(stepIndex).padStart(2, '0')}-assist.png`);
      const assistSource: ScriptStepSource = {
        type: 'action',
        caption: `assist-edit "..." button for ${source.caption}`,
      };
      const assistLocate = await vision.locate(assistBuf, assistSource);
      if (assistLocate.confidence > 0.3) {
        await page.mouse.click(assistLocate.coordinates.x, assistLocate.coordinates.y);
      } else {
        // Fallback: press F6 which BC uses to open assist-edit
        await page.keyboard.press('F6');
      }
    } else {
      await page.mouse.click(coords.x, coords.y);
    }

    await page.waitForTimeout(POST_ACTION_WAIT_MS);

    // Wait for BC to settle
    try {
      await awaitBCFrame(page, 10_000);
    } catch { /* non-critical */ }

    // VERIFY
    if (skipVerify) {
      return {
        index: stepIndex,
        source,
        action: source.type === 'input' ? 'click-then-type' : 'click',
        coordinates: coords,
        value: source.value,
        confidence: lastLocate.confidence,
        prep: lastLocate.prep,
        verification: { success: true, observation: 'verification skipped' },
        screenshot: `step-${String(stepIndex).padStart(2, '0')}-before.png`,
      };
    }

    const afterBuf = await captureScreenshot(
      page,
      outputDir,
      `step-${String(stepIndex).padStart(2, '0')}-after.png`,
    );
    const verifyResult = await vision.verify(beforeBuf, afterBuf, source, coords);
    info(`  → Verify: ${verifyResult.success ? 'SUCCESS' : 'FAILED'} — ${verifyResult.observation}`);

    if (verifyResult.success) {
      return {
        index: stepIndex,
        source,
        action: source.type === 'input' ? 'click-then-type' : 'click',
        coordinates: coords,
        value: source.value,
        confidence: lastLocate.confidence,
        prep: lastLocate.prep,
        verification: verifyResult,
        screenshot: `step-${String(stepIndex).padStart(2, '0')}-before.png`,
      };
    }
  }

  // All retries exhausted
  const fallbackCoords = lastLocate?.coordinates ?? { x: 0, y: 0 };
  return {
    index: stepIndex,
    source,
    action: source.type === 'input' ? 'click-then-type' : 'click',
    coordinates: fallbackCoords,
    value: source.value,
    confidence: lastLocate?.confidence ?? 0,
    prep: lastLocate?.prep ?? [],
    verification: { success: false, observation: `Failed after ${MAX_RETRIES} attempts` },
    screenshot: `step-${String(stepIndex).padStart(2, '0')}-before.png`,
  };
}

/**
 * Runs the full investigation pipeline: opens BC, walks each YAML step
 * through the vision see→act→verify loop, and writes a .script.yml.
 */
export async function investigate(
  specPath: string,
  config: DemoConfig,
  outputDir: string,
  options: { skipVerify?: boolean } = {},
): Promise<{ scriptPath: string; script: ScriptFile }> {
  const specContent = readFileSync(resolve(specPath), 'utf-8');
  const spec = parseYaml(specContent) as YamlSpec;
  const specName = parsePath(specPath).name;

  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for vision-based investigation');
  }

  const vision = new VisionClient(config.anthropicApiKey, config.visionModel);
  const screenshotDir = resolve(outputDir, 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });

  // Launch headless BC session
  info('Launching headless BC session for investigation...');
  const session = await launchBCSession(config, {
    headless: true,
    pageId: spec.start?.pageId,
    profile: spec.start?.profile,
    editMode: spec.start?.mode === 'edit',
  });

  const scriptSteps: ScriptStep[] = [];

  try {
    // Flatten scope steps into a linear sequence
    const linearSteps: Array<{ step: YamlSpec['steps'][0]; originalIndex: number }> = [];
    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      if (step.type === 'scope' && step.steps) {
        for (const inner of step.steps) {
          linearSteps.push({ step: inner, originalIndex: i });
        }
      } else {
        linearSteps.push({ step, originalIndex: i });
      }
    }

    for (let i = 0; i < linearSteps.length; i++) {
      const { step } = linearSteps[i];
      const source = toSource(step);
      const desc = step.description ?? step.caption ?? source.field ?? `step ${i + 1}`;
      info(`[investigate] Step ${i + 1}/${linearSteps.length}: ${desc}`);

      const scriptStep = await investigateStep(
        vision,
        session.page,
        source,
        i,
        screenshotDir,
        options.skipVerify ?? false,
      );
      scriptSteps.push(scriptStep);
    }
  } finally {
    await closeBCSession(session);
  }

  // Build and write the script
  const specHash = computeSpecHash(spec.steps as unknown[]);
  const script: ScriptFile = {
    specHash,
    model: config.visionModel,
    investigatedAt: new Date().toISOString(),
    viewportSize: { width: 1920, height: 1080 },
    steps: scriptSteps,
  };

  const scriptPath = resolve(outputDir, `${specName}.script.yml`);
  writeScript(script, scriptPath);

  // Summary
  const passed = scriptSteps.filter((s) => s.verification.success).length;
  const failed = scriptSteps.filter((s) => !s.verification.success).length;
  info(`Investigation complete: ${passed} passed, ${failed} failed out of ${scriptSteps.length} steps`);

  return { scriptPath, script };
}
```

- [ ] **Step 2: Verify build passes**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/investigator.ts
git commit -m "feat: add vision-based investigator with see-act-verify loop"
```

---

### Task 7: Create script player (`src/script-player.ts`)

**Files:**
- Create: `src/script-player.ts`

- [ ] **Step 1: Write the script player**

```typescript
// src/script-player.ts
import type { Page } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { launchBCSession, closeBCSession, awaitBCFrame } from './browser.js';
import { readScript } from './script-io.js';
import { injectCursor, animateCursorTo } from './cursor.js';
import type { ScriptFile, ScriptStep, PrepAction } from './script-types.js';
import { DemoConfig } from './config.js';
import { info, debug } from './log.js';
import { parse as parseYaml } from 'yaml';

export interface ScriptPlayResult {
  success: boolean;
  videoPath?: string;
  timing?: {
    trimStartMs: number;
    steps: Array<{ stepIndex: number; startMs: number; endMs: number }>;
  };
  error?: string;
}

/** Executes a prep action during recording. */
async function executePrepAction(page: Page, prep: PrepAction): Promise<void> {
  if (prep.action === 'scroll' && prep.direction && prep.px) {
    const deltaX = prep.direction === 'left' ? -prep.px : prep.direction === 'right' ? prep.px : 0;
    const deltaY = prep.direction === 'up' ? -prep.px : prep.direction === 'down' ? prep.px : 0;
    await page.mouse.wheel(deltaX, deltaY);
    await page.waitForTimeout(500);
  } else if (prep.action === 'click' && prep.coordinates) {
    await page.mouse.click(prep.coordinates.x, prep.coordinates.y);
    await page.waitForTimeout(500);
  } else if (prep.action === 'wait') {
    await page.waitForTimeout(prep.ms ?? 1000);
  }
}

/**
 * Replays a .script.yml by clicking coordinates and typing values.
 * No DOM queries, no element finding — purely mechanical replay.
 */
export async function playScript(
  scriptPath: string,
  specPath: string,
  config: DemoConfig,
  options: {
    stepDelays?: Map<number, number>;
  } = {},
): Promise<ScriptPlayResult> {
  const script = readScript(scriptPath);

  // Parse original spec for start config
  const specContent = readFileSync(resolve(specPath), 'utf-8');
  const spec = parseYaml(specContent) as {
    start?: { profile?: string; pageId?: number; mode?: 'edit' };
  };

  info('Launching BC session for recording...');
  const session = await launchBCSession(config, {
    headless: false,
    recordVideoDir: config.outputDir,
    pageId: spec.start?.pageId,
    profile: spec.start?.profile,
    editMode: spec.start?.mode === 'edit',
  });

  const videoStartMs = Date.now();
  const stepTimings: Array<{ stepIndex: number; startMs: number; endMs: number }> = [];

  try {
    // Inject cursor overlay
    await injectCursor(session.page);
    await session.page.waitForTimeout(500);

    const trimStartMs = Date.now() - videoStartMs;
    info(`BC loaded (trimming ${(trimStartMs / 1000).toFixed(1)}s of loading screen)`);

    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i];
      const stepStartMs = Date.now() - videoStartMs;
      const desc = step.source.caption ?? step.source.field ?? `step ${i + 1}`;
      info(`[${i + 1}/${script.steps.length}] ${desc}`);

      // Execute prep actions
      for (const prep of step.prep) {
        debug(`  Prep: ${prep.action} — ${prep.reason ?? ''}`);
        await executePrepAction(session.page, prep);
      }

      // Animate cursor to target
      await animateCursorTo(session.page, step.coordinates.x, step.coordinates.y);

      // Execute the action
      if (step.action === 'click-then-type' && step.value) {
        await session.page.mouse.click(step.coordinates.x, step.coordinates.y);
        await session.page.waitForTimeout(300);
        await session.page.mouse.click(step.coordinates.x, step.coordinates.y, { clickCount: 3 });
        await session.page.waitForTimeout(100);
        await session.page.keyboard.type(step.value, { delay: 50 });
        await session.page.keyboard.press('Tab');
      } else if (step.action === 'double-click') {
        await session.page.mouse.dblclick(step.coordinates.x, step.coordinates.y);
      } else {
        await session.page.mouse.click(step.coordinates.x, step.coordinates.y);
      }

      // Wait for BC to settle
      try {
        await awaitBCFrame(session.page, 10_000);
      } catch { /* non-critical */ }

      // Apply audio sync delay if provided
      const delay = options.stepDelays?.get(i) ?? 2000;
      await session.page.waitForTimeout(delay);

      const stepEndMs = Date.now() - videoStartMs;
      stepTimings.push({ stepIndex: i, startMs: stepStartMs, endMs: stepEndMs });
    }

    // Final pause so the last state is visible
    await session.page.waitForTimeout(3000);

    const videoPath = await closeBCSession(session);
    return {
      success: true,
      videoPath: videoPath ?? undefined,
      timing: { trimStartMs: Date.now() - videoStartMs, steps: stepTimings },
    };
  } catch (error) {
    await closeBCSession(session).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
```

- [ ] **Step 2: Verify build passes**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/script-player.ts
git commit -m "feat: add coordinate-based script player for mechanical recording"
```

---

### Task 8: Update recorder (`src/recorder.ts`)

**Files:**
- Modify: `src/recorder.ts`

- [ ] **Step 1: Rewrite recorder to orchestrate investigation → script player**

```typescript
// src/recorder.ts
import { resolve, parse } from 'path';
import { existsSync } from 'fs';
import { DemoConfig } from './config.js';
import { investigate } from './investigator.js';
import { playScript, type ScriptPlayResult } from './script-player.js';
import { isScriptValid } from './script-io.js';
import { info, debug } from './log.js';

export interface RecordResult {
  success: boolean;
  videoPath?: string;
  timing?: ScriptPlayResult['timing'];
  scriptPath?: string;
  error?: string;
}

/**
 * Orchestrates the full demo recording pipeline:
 * 1. Investigate (if needed) — vision-based discovery
 * 2. Record — mechanical replay of coordinate script
 */
export async function recordDemo(
  specPath: string,
  config: DemoConfig,
  options?: {
    stepDelays?: Map<number, number>;
    mode?: 'investigate' | 'record' | 'full';
    skipVerify?: boolean;
  },
): Promise<RecordResult> {
  const absoluteSpecPath = resolve(specPath);
  const specName = parse(absoluteSpecPath).name;
  const outputDir = resolve(config.outputDir);
  const scriptPath = resolve(outputDir, `${specName}.script.yml`);
  const mode = options?.mode ?? 'full';

  if (!existsSync(absoluteSpecPath)) {
    return { success: false, error: `Spec file not found: ${absoluteSpecPath}` };
  }

  info(`Demo: ${specName}`);
  info(`BC: ${config.bcStartAddress}`);

  try {
    // Investigation phase
    if (mode === 'investigate' || mode === 'full') {
      const needsInvestigation = mode === 'investigate' ||
        !existsSync(scriptPath) ||
        !isScriptValid(absoluteSpecPath, scriptPath);

      if (needsInvestigation) {
        info('Starting vision-based investigation...');
        const result = await investigate(absoluteSpecPath, config, outputDir, {
          skipVerify: options?.skipVerify,
        });

        if (mode === 'investigate') {
          return { success: true, scriptPath: result.scriptPath };
        }
      } else {
        info('Script cache is valid — skipping investigation');
      }
    }

    // Recording phase
    if (mode === 'record' || mode === 'full') {
      if (!existsSync(scriptPath)) {
        return { success: false, error: `No script found at ${scriptPath}. Run investigation first.` };
      }

      info('Starting coordinate-based recording...');
      const result = await playScript(scriptPath, absoluteSpecPath, config, {
        stepDelays: options?.stepDelays,
      });

      return {
        success: result.success,
        videoPath: result.videoPath,
        timing: result.timing,
        scriptPath,
        error: result.error,
      };
    }

    return { success: true, scriptPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
```

- [ ] **Step 2: Update the existing recorder test**

In `tests/recorder.test.ts`, the test for "nonexistent spec file" should still pass. The test for "BC unreachable" may need updating since the recorder now tries investigation first. Update the second test to pass `mode: 'record'` so it skips investigation:

Replace the second test's `recordDemo` call:
```typescript
  test('returns error when script file is missing', { timeout: 10_000 }, async () => {
    const specFile = join(tmpDir, 'test-spec.yml');
    writeFileSync(
      specFile,
      'description: test\nsteps:\n  - type: action\n    target:\n      - page: Test\n    caption: OK',
    );

    const result = await recordDemo(specFile, {
      bcStartAddress: 'http://localhost:19222/bc/',
      bcAuth: 'Windows',
      outputDir: join(tmpDir, 'output'),
      headed: false,
      visionModel: 'claude-sonnet-4-6-20250514',
    }, { mode: 'record' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No script found');
  });
```

- [ ] **Step 3: Run tests**

Run:
```bash
npx vitest run tests/recorder.test.ts
```
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/recorder.ts tests/recorder.test.ts
git commit -m "feat: rewrite recorder to orchestrate vision investigation and script playback"
```

---

### Task 9: Update CLI (`src/cli.ts`)

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Rewrite CLI to use new pipeline**

Replace the full CLI implementation. Key changes:
- Remove imports of `enricher.ts` and `types.ts`
- Add `--vision-model` and `--no-verify` flags
- Replace the enricher pipeline with script pipeline
- Replace `enrichedSpecPath` references with `scriptPath`
- Use `mode: 'investigate'` | `'record'` | `'full'` instead of the old enricher flow

```typescript
#!/usr/bin/env node

import { Command } from 'commander';
import { resolve, parse as parsePath } from 'path';
import { existsSync, readFileSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from './config.js';
import { recordDemo } from './recorder.js';
import { generateNarration } from './narrator.js';
import { composeVideo, composeWithStepAudio } from './composer.js';
import { generateStepAudio } from './step-audio.js';
import { generateSubtitles } from './subtitle-gen.js';
import { getVoiceForLocale, type VoiceConfig } from './locale-voices.js';
import { setVerbose, header, info } from './log.js';
import { isScriptValid } from './script-io.js';
import { resetEnvironment, extractEnvId } from './env-reset.js';
import type { ScriptPlayResult } from './script-player.js';

const program = new Command();

program
  .name('generate-demo')
  .description('Generate demo videos from BC Page Scripting YAML specs')
  .version('0.5.0');

program
  .argument('<spec>', 'Path to the BC Page Scripting YAML spec file')
  .option('--bc-url <url>', 'Business Central web client URL')
  .option('--bc-auth <type>', 'Authentication type: Windows, AAD, or UserPassword')
  .option('--output <dir>', 'Output directory for generated videos', './output')
  .option('--no-headed', 'Run in headless mode (no visible browser)')
  .option('--narrate', 'Generate TTS narration and compose with video')
  .option('--voice <voice>', 'OpenAI TTS voice (overrides locale default)')
  .option('--skip-record', 'Skip recording, only generate narration and compose')
  .option('--no-subs', 'Skip subtitle generation and burn-in')
  .option('--no-trim', 'Keep login/auth in the video (debugging)')
  .option('--investigate-only', 'Run investigation only — write script and exit')
  .option('--no-investigate', 'Skip investigation — use existing script')
  .option('--vision-model <model>', 'Vision model for investigation (default: claude-sonnet-4-6-20250514)')
  .option('--no-verify', 'Skip verification step during investigation')
  .option('-v, --verbose', 'Show detailed debug output')
  .action(
    async (
      spec: string,
      options: {
        bcUrl?: string;
        bcAuth?: string;
        output?: string;
        headed?: boolean;
        narrate?: boolean;
        voice?: string;
        skipRecord?: boolean;
        subs?: boolean;
        trim?: boolean;
        investigateOnly?: boolean;
        investigate?: boolean;
        visionModel?: string;
        verify?: boolean;
        verbose?: boolean;
      },
    ) => {
      setVerbose(options.verbose ?? false);
      const specPath = resolve(spec);

      if (!existsSync(specPath)) {
        console.error(`Error: Spec file not found: ${specPath}`);
        process.exit(1);
      }

      if (!specPath.endsWith('.yml') && !specPath.endsWith('.yaml')) {
        console.error('Error: Spec file must be a YAML file (.yml or .yaml)');
        process.exit(1);
      }

      const config = loadConfig({
        bcStartAddress: options.bcUrl,
        bcAuth: options.bcAuth as 'Windows' | 'AAD' | 'UserPassword' | undefined,
        outputDir: options.output,
        headed: options.headed,
        visionModel: options.visionModel,
      });

      const specName = parsePath(specPath).name;
      const outputDir = resolve(config.outputDir, specName);
      config.outputDir = outputDir;

      let videoPath = resolve(outputDir, `${specName}.webm`);
      const finalPath = resolve(outputDir, `${specName}.mp4`);
      const srtPath = resolve(outputDir, `${specName}.srt`);
      const scriptPath = resolve(outputDir, `${specName}.script.yml`);

      // Parse spec for metadata
      const specContent = readFileSync(specPath, 'utf-8');
      const recording = parseYaml(specContent);
      const demo = recording?.demo as Record<string, unknown> | undefined;
      const stepNarration = demo?.stepNarration as Record<string, string> | undefined;
      const narrationText = demo?.narration as string | undefined;
      const locale = demo?.locale as string | undefined;

      // Resolve voice config
      let voiceConfig: VoiceConfig;
      if (options.voice) {
        voiceConfig = { voice: options.voice as VoiceConfig['voice'], speed: 1.0 };
      } else {
        voiceConfig = getVoiceForLocale(locale);
      }

      console.log('Continia Demo Generator');
      info(`Spec: ${specName}`);

      const skipInvestigate = options.investigate === false;
      const investigateOnly = options.investigateOnly === true;
      const skipVerify = options.verify === false;

      if (skipInvestigate && investigateOnly) {
        console.error('Error: --no-investigate and --investigate-only are mutually exclusive');
        process.exit(1);
      }

      // Determine mode
      let mode: 'investigate' | 'record' | 'full';
      if (investigateOnly) {
        mode = 'investigate';
      } else if (skipInvestigate || options.skipRecord) {
        mode = 'record';
      } else {
        // Auto-skip investigation if script cache is valid
        if (existsSync(scriptPath) && isScriptValid(specPath, scriptPath)) {
          info('Script cache is valid — skipping investigation');
          mode = 'record';
        } else {
          mode = 'full';
        }
      }

      // Determine pipeline: per-step narration or single narration
      const useStepNarration =
        options.narrate && stepNarration && Object.keys(stepNarration).length > 0;
      const useSingleNarration = options.narrate && !useStepNarration && narrationText;

      let timing: ScriptPlayResult['timing'] | undefined;

      // ── Phase A: Generate per-step audio (before recording) ──
      let stepAudioPlan: Awaited<ReturnType<typeof generateStepAudio>> | undefined;
      if (useStepNarration && !options.skipRecord) {
        header('Narration');
        stepAudioPlan = await generateStepAudio(stepNarration!, specName, outputDir, voiceConfig);
      }

      // ── Phase B: Investigation + Recording ──
      if (!options.skipRecord) {
        if (mode === 'full' || mode === 'investigate') {
          header('Investigation');
        }
        if (mode === 'full' || mode === 'record') {
          // Environment reset between investigation and recording
          if (mode === 'full') {
            header('Environment Reset');
            const envId = extractEnvId(config.bcStartAddress);
            if (envId) {
              try {
                const resetResult = await resetEnvironment(envId, config.bcStartAddress);
                config.bcStartAddress = resetResult.bcStartAddress;
                info(`New environment: ${resetResult.envId}`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`\nEnvironment reset failed: ${msg}`);
                info('Proceeding with recording on current environment...');
              }
            } else {
              info('Cannot determine envId from URL — skipping environment reset');
            }
          }

          header('Recording');
        }

        const result = await recordDemo(specPath, config, {
          stepDelays: stepAudioPlan?.stepDelays,
          mode,
          skipVerify,
        });

        if (investigateOnly) {
          if (result.success) {
            info(`Script written to: ${result.scriptPath}`);
            console.log('\nDone! (investigate-only)');
          } else {
            console.error(`\nInvestigation failed: ${result.error}`);
            process.exit(1);
          }
          process.exit(0);
        }

        if (result.success) {
          timing = result.timing;
          if (result.videoPath) videoPath = result.videoPath;
        } else {
          console.error(`\nFailed: ${result.error}`);
          process.exit(1);
        }
      } else {
        // --skip-record: use existing video
        if (!existsSync(videoPath)) {
          console.error(`Error: --skip-record but no video found at ${videoPath}`);
          process.exit(1);
        }
        info(`Using existing video: ${videoPath}`);

        if (useStepNarration && !stepAudioPlan) {
          header('Narration');
          stepAudioPlan = await generateStepAudio(stepNarration!, specName, outputDir, voiceConfig);
        }
      }

      // ── Phase C: Compose with narration ──
      if (useStepNarration && stepAudioPlan && timing) {
        header('Composing');

        let subtitlePath: string | undefined;
        if (options.subs !== false) {
          // timing shape is compatible — both have trimStartMs and steps[]
          subtitlePath = generateSubtitles(stepAudioPlan.clips, timing as Parameters<typeof generateSubtitles>[1], srtPath);
        }

        const compResult = await composeWithStepAudio({
          videoPath,
          clips: stepAudioPlan.clips,
          timing: timing as Parameters<typeof composeWithStepAudio>[0]['timing'],
          subtitlePath,
          outputPath: finalPath,
          trimLogin: options.trim !== false,
        });

        if (compResult.success) {
          info(`Saved: ${parsePath(compResult.videoPath!).base}`);
        } else {
          console.error(`\nFailed to compose: ${compResult.error}`);
          process.exit(1);
        }
      } else if (useSingleNarration) {
        header('Narration (single track)');
        const audioPath = resolve(outputDir, `${specName}.mp3`);
        const narResult = await generateNarration(narrationText!.trim(), audioPath, {
          voice: voiceConfig.voice,
          speed: voiceConfig.speed,
        });
        if (!narResult.success) {
          console.error(`\nFailed to generate narration: ${narResult.error}`);
          process.exit(1);
        }

        header('Composing');
        const compResult = await composeVideo(videoPath, audioPath, finalPath);
        if (compResult.success) {
          info(`Saved: ${parsePath(compResult.videoPath!).base}`);
        } else {
          console.error(`\nFailed to compose: ${compResult.error}`);
          process.exit(1);
        }
      }

      // ── Cleanup intermediate files ──
      if (existsSync(finalPath)) {
        const keep = new Set([finalPath, scriptPath]);
        for (const file of readdirSync(outputDir)) {
          const fullPath = resolve(outputDir, file);
          if (keep.has(fullPath)) continue;
          if (file === 'narration' || file === 'screenshots') {
            rmSync(fullPath, { recursive: true, force: true });
          } else if (
            file.endsWith('.webm') ||
            file.endsWith('.ass') ||
            file.endsWith('.srt') ||
            file.endsWith('.mp3') ||
            file.endsWith('.timing.json')
          ) {
            unlinkSync(fullPath);
          }
        }
        info('Cleaned up intermediate files');
      }

      console.log('\nDone!');
    },
  );

program.parse();
```

- [ ] **Step 2: Verify build passes**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors (there may be warnings about unused imports from old modules — those get cleaned up in Task 10)

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: update CLI with vision pipeline, --vision-model and --no-verify flags"
```

---

### Task 10: Delete old modules and clean up player.ts

**Files:**
- Delete: `src/player.ts`
- Delete: `src/enricher.ts`
- Delete: `src/types.ts`

- [ ] **Step 1: Delete obsolete files**

```bash
git rm src/player.ts src/enricher.ts src/types.ts
```

- [ ] **Step 2: Remove stale imports from any remaining files**

Check for any remaining imports of the deleted modules:
```bash
npx tsc --noEmit
```

Fix any import errors — `recorder.ts` previously imported from `player.ts` and `types.ts`. Those imports were already replaced in Task 8. If `cli.ts` still references `enricher.ts`, those were replaced in Task 9.

- [ ] **Step 3: Run full test suite**

Run:
```bash
npx vitest run
```
Expected: all tests PASS

- [ ] **Step 4: Verify the build compiles cleanly**

Run:
```bash
npx tsc
```
Expected: no errors, `dist/` output is generated

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove old DOM-based player, enricher, and types modules"
```

---

### Task 11: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README.md CLI flags**

Add `--vision-model` and `--no-verify` to the flags table. Update the description to mention vision-based navigation.

- [ ] **Step 2: Update CLAUDE.md architecture table**

Replace the module table to reflect new modules:

| Module | Purpose |
|--------|---------|
| `src/browser.ts` | Playwright browser launch, BC authentication, cookie transfer, `awaitBCFrame` |
| `src/vision.ts` | Claude Sonnet 4.6 vision API client — locate, verify, prompt builders |
| `src/investigator.ts` | See → act → verify loop — walks YAML steps, produces `.script.yml` |
| `src/script-player.ts` | Coordinate-based recorder — replays `.script.yml` with cursor animation |
| `src/script-types.ts` | Types for `.script.yml` format |
| `src/script-io.ts` | Read/write `.script.yml`, spec hash, cache validation |
| `src/recorder.ts` | Thin orchestrator — investigation → env reset → script playback |
| `src/cli.ts` | CLI entry point with full pipeline orchestration |
| `src/cursor.ts` | Animated cursor overlay (red dot with click pulse) |
| `src/step-audio.ts` | Per-step TTS clip generation and duration measurement |
| `src/narrator.ts` | OpenAI TTS wrapper |
| `src/subtitle-gen.ts` | ASS subtitle generation |
| `src/composer.ts` | FFmpeg video composition |
| `src/locale-voices.ts` | Locale → voice mapping |
| `src/config.ts` | Config from .env and CLI args |
| `src/env-reset.ts` | DemoPortal environment delete/create/poll |
| `src/log.ts` | Logging utilities |

Also update the "How it works" section to describe the vision pipeline instead of DOM strategies.

Add `ANTHROPIC_API_KEY=<key>` to the environment variables section.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update README and CLAUDE.md for vision-based architecture"
```

---

### Task 12: End-to-end smoke test

This is a manual verification step. No code changes.

- [ ] **Step 1: Build**

Run:
```bash
npx tsc
```

- [ ] **Step 2: Run investigation-only on an existing spec**

Run:
```bash
node dist/cli.js <path-to-a-real-spec.yml> --investigate-only -v
```

Verify:
- Screenshots are saved in `output/<spec>/screenshots/`
- `.script.yml` is written with coordinates and verification results
- Console output shows locate/verify results for each step

- [ ] **Step 3: Run full pipeline with narration**

Run:
```bash
node dist/cli.js <path-to-a-real-spec.yml> --narrate -v
```

Verify:
- Investigation runs first (or uses cached script)
- Environment resets
- Recording replays coordinates with cursor animation
- Final .mp4 is produced

- [ ] **Step 4: Run with --no-investigate to use cached script**

Run:
```bash
node dist/cli.js <path-to-a-real-spec.yml> --no-investigate --narrate
```

Verify: skips investigation, uses existing `.script.yml`, produces video.
