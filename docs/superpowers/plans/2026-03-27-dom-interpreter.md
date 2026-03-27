# DOM Interpreter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vision-based page discovery with Claude text interpretation of cleaned HTML from BC's DOM, with a self-learning knowledge bank.

**Architecture:** A DOM extraction function produces cleaned HTML from the BC iframe. A Claude text-API interpreter reads the HTML to survey pages, locate elements, and confirm actions. A YAML-based knowledge bank stores learned patterns. Vision is retained only for visual verification (before/after screenshots) and control add-in fallback.

**Tech Stack:** TypeScript, Playwright (DOM access), `@anthropic-ai/sdk` (text API), `yaml` (knowledge bank), `vitest` (testing)

**Spec:** `docs/superpowers/specs/2026-03-27-dom-interpreter-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/dom-extract.ts` | Create | Pure function: Frame → cleaned HTML string. Overlay detection, scroll state, layer awareness. |
| `src/dom-interpreter.ts` | Create | Claude text API: survey, locate, confirm. Reads HTML, returns structured JSON with selectors. |
| `src/knowledge.ts` | Create | Read/write `knowledge/patterns/*.yml`. Load patterns for prompts, save after success/failure. |
| `src/investigator.ts` | Rewrite | New 9-step flow: extract → survey → locate → prepare → confirm → act → verify → learn → emit. |
| `src/vision.ts` | Modify | Remove survey/locate functions. Keep verify + control add-in locate only. |
| `tests/dom-extract.test.ts` | Create | Tests for HTML cleaning, overlay detection, scroll state. |
| `tests/dom-interpreter.test.ts` | Create | Tests for prompt construction and response parsing. |
| `tests/knowledge.test.ts` | Create | Tests for pattern read/write/deprecate lifecycle. |
| `knowledge/patterns/.gitkeep` | Create | Empty dir for knowledge bank patterns. |

---

### Task 1: Create knowledge bank module (`src/knowledge.ts`) with tests

**Files:**
- Create: `src/knowledge.ts`
- Create: `tests/knowledge.test.ts`
- Create: `knowledge/patterns/.gitkeep`

- [ ] **Step 1: Create the knowledge directory**

```bash
mkdir -p knowledge/patterns
touch knowledge/patterns/.gitkeep
```

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/knowledge.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import {
  loadPatterns,
  savePattern,
  incrementSuccess,
  deprecatePattern,
  type KnowledgePattern,
} from '../src/knowledge.js';

const tmpDir = resolve('./test-tmp-knowledge');
const patternsDir = resolve(tmpDir, 'patterns');

describe('knowledge bank', () => {
  beforeEach(() => {
    mkdirSync(patternsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loadPatterns returns empty array for empty directory', () => {
    const patterns = loadPatterns(patternsDir);
    expect(patterns).toEqual([]);
  });

  test('savePattern writes a YAML file and loadPatterns reads it back', () => {
    const pattern: KnowledgePattern = {
      name: 'bc-fasttab-expand',
      description: 'How to expand a collapsed FastTab',
      discovered: '2026-03-27',
      successCount: 1,
      lastUsed: '2026-03-27',
      pattern: {
        identify: 'section with aria-expanded="false"',
        interact: 'click the section header',
        verify: 'aria-expanded changes to "true"',
      },
    };

    savePattern(patternsDir, pattern);

    const files = readdirSync(patternsDir).filter((f) => f.endsWith('.yml'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('bc-fasttab-expand.yml');

    const loaded = loadPatterns(patternsDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('bc-fasttab-expand');
    expect(loaded[0].successCount).toBe(1);
  });

  test('incrementSuccess updates count and lastUsed', () => {
    const pattern: KnowledgePattern = {
      name: 'test-pattern',
      description: 'test',
      discovered: '2026-03-20',
      successCount: 5,
      lastUsed: '2026-03-20',
      pattern: { identify: 'x', interact: 'y', verify: 'z' },
    };
    savePattern(patternsDir, pattern);

    incrementSuccess(patternsDir, 'test-pattern');

    const loaded = loadPatterns(patternsDir);
    expect(loaded[0].successCount).toBe(6);
    expect(loaded[0].lastUsed).not.toBe('2026-03-20');
  });

  test('deprecatePattern sets deprecated flag', () => {
    const pattern: KnowledgePattern = {
      name: 'old-pattern',
      description: 'outdated',
      discovered: '2026-03-10',
      successCount: 3,
      lastUsed: '2026-03-15',
      pattern: { identify: 'a', interact: 'b', verify: 'c' },
    };
    savePattern(patternsDir, pattern);

    deprecatePattern(patternsDir, 'old-pattern', 'replaced by new approach');

    const loaded = loadPatterns(patternsDir);
    expect(loaded[0].deprecated).toBe(true);
    expect(loaded[0].deprecatedReason).toBe('replaced by new approach');
  });

  test('loadPatterns excludes deprecated patterns by default', () => {
    savePattern(patternsDir, {
      name: 'active',
      description: 'works',
      discovered: '2026-03-27',
      successCount: 1,
      lastUsed: '2026-03-27',
      pattern: { identify: 'x', interact: 'y', verify: 'z' },
    });
    savePattern(patternsDir, {
      name: 'old',
      description: 'broken',
      discovered: '2026-03-10',
      successCount: 1,
      lastUsed: '2026-03-10',
      deprecated: true,
      deprecatedReason: 'no longer works',
      pattern: { identify: 'a', interact: 'b', verify: 'c' },
    });

    const active = loadPatterns(patternsDir);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('active');

    const all = loadPatterns(patternsDir, { includeDeprecated: true });
    expect(all).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/knowledge.test.ts
```
Expected: FAIL — `knowledge.js` does not exist

- [ ] **Step 4: Write the implementation**

```typescript
// src/knowledge.ts
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface KnowledgePattern {
  name: string;
  description: string;
  discovered: string;
  successCount: number;
  lastUsed: string;
  deprecated?: boolean;
  deprecatedReason?: string;
  pattern: {
    identify: string;
    interact: string;
    verify: string;
    failureContext?: string;
  };
}

/** Loads all knowledge patterns from a directory of YAML files. */
export function loadPatterns(
  dir: string,
  options?: { includeDeprecated?: boolean },
): KnowledgePattern[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  const patterns: KnowledgePattern[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(resolve(dir, file), 'utf-8');
      const pattern = parseYaml(content) as KnowledgePattern;
      if (options?.includeDeprecated || !pattern.deprecated) {
        patterns.push(pattern);
      }
    } catch {
      // Skip malformed files
    }
  }

  return patterns;
}

/** Saves a knowledge pattern to a YAML file. */
export function savePattern(dir: string, pattern: KnowledgePattern): void {
  const path = resolve(dir, `${pattern.name}.yml`);
  writeFileSync(path, stringifyYaml(pattern, { lineWidth: 120 }));
}

/** Increments the success count and updates lastUsed for a pattern. */
export function incrementSuccess(dir: string, name: string): void {
  const path = resolve(dir, `${name}.yml`);
  if (!existsSync(path)) return;

  const content = readFileSync(path, 'utf-8');
  const pattern = parseYaml(content) as KnowledgePattern;
  pattern.successCount += 1;
  pattern.lastUsed = new Date().toISOString().split('T')[0];
  writeFileSync(path, stringifyYaml(pattern, { lineWidth: 120 }));
}

/** Marks a pattern as deprecated with a reason. */
export function deprecatePattern(dir: string, name: string, reason: string): void {
  const path = resolve(dir, `${name}.yml`);
  if (!existsSync(path)) return;

  const content = readFileSync(path, 'utf-8');
  const pattern = parseYaml(content) as KnowledgePattern;
  pattern.deprecated = true;
  pattern.deprecatedReason = reason;
  writeFileSync(path, stringifyYaml(pattern, { lineWidth: 120 }));
}

/** Formats patterns into a text block for inclusion in Claude prompts. */
export function patternsToPromptContext(patterns: KnowledgePattern[]): string {
  if (patterns.length === 0) return '';

  const lines = patterns.map(
    (p) =>
      `- **${p.name}** (used ${p.successCount}x): identify: ${p.pattern.identify} | interact: ${p.pattern.interact} | verify: ${p.pattern.verify}`,
  );

  return `## Known BC Patterns (learned from previous investigations)\n${lines.join('\n')}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/knowledge.test.ts
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/knowledge.ts tests/knowledge.test.ts knowledge/
git commit -m "feat: add knowledge bank for self-learning BC patterns"
```

---

### Task 2: Create DOM extraction module (`src/dom-extract.ts`) with tests

**Files:**
- Create: `src/dom-extract.ts`
- Create: `tests/dom-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dom-extract.test.ts
import { describe, test, expect } from 'vitest';
import { cleanHtml, detectLayers, extractScrollState } from '../src/dom-extract.js';

describe('cleanHtml', () => {
  test('strips script and style tags', () => {
    const html = '<div><script>alert(1)</script><style>.x{}</style><span>Hello</span></div>';
    const result = cleanHtml(html);
    expect(result).not.toContain('script');
    expect(result).not.toContain('style');
    expect(result).toContain('Hello');
  });

  test('keeps aria attributes and role', () => {
    const html = '<button role="menuitem" aria-label="New">+ New</button>';
    const result = cleanHtml(html);
    expect(result).toContain('role="menuitem"');
    expect(result).toContain('aria-label="New"');
    expect(result).toContain('New');
  });

  test('keeps controlname attribute', () => {
    const html = '<div controlname="Bank Name"><input value="Test"/></div>';
    const result = cleanHtml(html);
    expect(result).toContain('controlname="Bank Name"');
    expect(result).toContain('value="Test"');
  });

  test('keeps aria-expanded state', () => {
    const html = '<section aria-expanded="false" aria-label="Posting"></section>';
    const result = cleanHtml(html);
    expect(result).toContain('aria-expanded="false"');
    expect(result).toContain('aria-label="Posting"');
  });

  test('collapses empty wrapper divs', () => {
    const html = '<div><div><div><span>Content</span></div></div></div>';
    const result = cleanHtml(html);
    // Should not have 3 nested divs — just the content
    const divCount = (result.match(/<div/g) || []).length;
    expect(divCount).toBeLessThan(3);
  });

  test('strips hidden elements', () => {
    const html = '<div style="display:none">Hidden</div><div>Visible</div>';
    const result = cleanHtml(html);
    expect(result).not.toContain('Hidden');
    expect(result).toContain('Visible');
  });

  test('truncates long text content', () => {
    const longText = 'A'.repeat(200);
    const html = `<span>${longText}</span>`;
    const result = cleanHtml(html);
    expect(result.length).toBeLessThan(html.length);
  });
});

describe('detectLayers', () => {
  test('detects dialog overlay', () => {
    const html = '<div><div role="dialog" style="z-index:1000">Dialog content</div><div>Background</div></div>';
    const layers = detectLayers(html);
    expect(layers.length).toBeGreaterThanOrEqual(1);
    expect(layers[0].isActive).toBe(true);
  });
});

describe('extractScrollState', () => {
  test('parses scroll attributes from cleaned HTML', () => {
    const html = '<section scroll-y="100/800" scroll-x="0/1920">content</section>';
    const state = extractScrollState(html);
    expect(state.canScrollDown).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/dom-extract.test.ts
```

- [ ] **Step 3: Write the implementation**

```typescript
// src/dom-extract.ts
import type { Frame } from 'playwright';
import { debug } from './log.js';

/** Attributes to keep during HTML cleaning. */
const KEEP_ATTRS = [
  'role', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-checked',
  'aria-disabled', 'aria-haspopup', 'controlname', 'title', 'type', 'value',
  'placeholder', 'name',
];

/** Tags to strip entirely (including contents). */
const STRIP_TAGS = ['script', 'style', 'svg', 'noscript', 'link', 'meta'];

/** Max text content length per element. */
const MAX_TEXT_LENGTH = 50;

export interface LayerInfo {
  description: string;
  isActive: boolean;
}

export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

/**
 * Extracts cleaned, semantically meaningful HTML from the BC iframe.
 * Detects overlays, strips noise, keeps interactive attributes.
 * This runs entirely in the browser via frame.evaluate().
 */
export async function extractPageHtml(frame: Frame): Promise<{
  html: string;
  layers: LayerInfo[];
  scroll: ScrollState;
}> {
  const result = await frame.evaluate(() => {
    const KEEP = [
      'role', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-checked',
      'aria-disabled', 'aria-haspopup', 'controlname', 'title', 'type', 'value',
      'placeholder', 'name',
    ];
    const STRIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'LINK', 'META']);
    const MAX_TEXT = 50;

    // Detect overlay layers
    const layers: Array<{ description: string; isActive: boolean }> = [];
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [class*="ms-nav-popup"], [class*="modal-dialog"]',
    );
    let activeLayer: Element | null = null;
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const d = dialogs[i] as HTMLElement;
      if (d.offsetWidth > 0 && d.offsetHeight > 0) {
        if (!activeLayer) {
          activeLayer = d;
          layers.push({
            description: d.getAttribute('aria-label') || d.textContent?.slice(0, 40) || 'dialog',
            isActive: true,
          });
        } else {
          layers.push({
            description: d.getAttribute('aria-label') || d.textContent?.slice(0, 40) || 'dialog',
            isActive: false,
          });
        }
      }
    }

    // Determine the root element to extract from
    const root = activeLayer ?? document.body;

    // Recursive HTML cleaning
    function cleanNode(node: Node, depth: number): string {
      if (depth > 30) return ''; // prevent infinite nesting

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (!text) return '';
        return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '...' : text;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node as HTMLElement;
      const tag = el.tagName;

      // Strip tags
      if (STRIP.has(tag)) return '';

      // Skip hidden elements
      if (el.style.display === 'none' || el.style.visibility === 'hidden') return '';
      if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.querySelector('input, select, textarea')) return '';

      // Collect kept attributes
      const attrs: string[] = [];
      for (const attr of KEEP) {
        const val = el.getAttribute(attr);
        if (val != null && val !== '') {
          attrs.push(`${attr}="${val}"`);
        }
      }

      // Add first meaningful class (skip BC's generated hash classes)
      const className = el.className?.toString() || '';
      const classes = className.split(/\s+/).filter(
        (c) => c.length > 3 && c.length < 40 && !c.includes('--') && !/^[a-z]{5,}$/.test(c),
      );
      if (classes.length > 0) {
        attrs.push(`class="${classes[0]}"`);
      }

      // Get children HTML
      const childrenHtml = Array.from(el.childNodes)
        .map((child) => cleanNode(child, depth + 1))
        .filter(Boolean)
        .join('\n');

      // Collapse empty wrapper divs
      const isWrapper =
        tag === 'DIV' &&
        attrs.length === 0 &&
        el.childElementCount === 1 &&
        !el.textContent?.trim();
      if (isWrapper) return childrenHtml;

      // Skip purely decorative elements with no content or attributes
      if (attrs.length === 0 && !childrenHtml && !el.textContent?.trim()) return '';

      const tagLower = tag.toLowerCase();
      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

      if (!childrenHtml && !el.textContent?.trim()) {
        return `<${tagLower}${attrStr}/>`;
      }

      const textContent = !childrenHtml ? el.textContent?.trim().slice(0, MAX_TEXT) || '' : '';
      const inner = childrenHtml || textContent;

      return `<${tagLower}${attrStr}>${inner}</${tagLower}>`;
    }

    const html = cleanNode(root, 0);

    // Scroll state of the main scrollable container
    const scrollContainer = root.querySelector('[style*="overflow"]') ?? root;
    const sc = scrollContainer as HTMLElement;
    const scroll = {
      scrollTop: sc.scrollTop,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      scrollLeft: sc.scrollLeft,
      scrollWidth: sc.scrollWidth,
      clientWidth: sc.clientWidth,
      canScrollDown: sc.scrollTop + sc.clientHeight < sc.scrollHeight - 10,
      canScrollUp: sc.scrollTop > 10,
      canScrollLeft: sc.scrollLeft > 10,
      canScrollRight: sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 10,
    };

    // Add layer annotations
    let annotatedHtml = html;
    if (layers.length > 0) {
      const bgLayers = layers
        .filter((l) => !l.isActive)
        .map((l) => `<!-- BACKGROUND LAYER: ${l.description} -->`)
        .join('\n');
      const activeDesc = layers.find((l) => l.isActive)?.description || 'active';
      annotatedHtml = `${bgLayers}\n<!-- ACTIVE LAYER: ${activeDesc} -->\n${html}`;
    }

    // Add scroll annotation
    annotatedHtml += `\n<!-- scroll: vertical ${sc.scrollTop}/${sc.scrollHeight}px, horizontal ${sc.scrollLeft}/${sc.scrollWidth}px -->`;

    return { html: annotatedHtml, layers, scroll };
  });

  debug(`DOM extract: ${result.html.length} chars, ${result.layers.length} layers`);
  return result;
}

/**
 * Cleans raw HTML string (for testing without a browser).
 * Simplified version of the in-browser extraction.
 */
export function cleanHtml(rawHtml: string): string {
  // Strip tags
  let html = rawHtml;
  for (const tag of STRIP_TAGS) {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    html = html.replace(regex, '');
    html = html.replace(new RegExp(`<${tag}[^>]*/>`, 'gi'), '');
  }

  // Strip hidden elements
  html = html.replace(/<[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Strip attributes not in KEEP_ATTRS list (keep the element, remove the attr)
  html = html.replace(/\s+(?!role|aria-|controlname|title|type|value|placeholder|name)[a-z][\w-]*="[^"]*"/gi, '');

  // Collapse empty wrapper divs: <div><div><span>X</span></div></div> → <span>X</span>
  let prev = '';
  while (prev !== html) {
    prev = html;
    html = html.replace(/<div>\s*(<(?:div|span|section|input|button|nav|header)[^>]*>[\s\S]*?<\/(?:div|span|section|input|button|nav|header)>)\s*<\/div>/gi, '$1');
  }

  // Truncate long text
  html = html.replace(/>([^<]{51,})</g, (_, text) => '>' + text.slice(0, MAX_TEXT_LENGTH) + '...<');

  return html.trim();
}

/** Detects overlay layers from HTML string (for testing). */
export function detectLayers(html: string): LayerInfo[] {
  const layers: LayerInfo[] = [];
  const dialogRegex = /role="dialog"[^>]*>([^<]*)/g;
  let match;
  let first = true;
  while ((match = dialogRegex.exec(html)) !== null) {
    layers.push({
      description: match[1].trim().slice(0, 40) || 'dialog',
      isActive: first,
    });
    first = false;
  }
  return layers;
}

/** Extracts scroll state from annotated HTML (for testing). */
export function extractScrollState(html: string): ScrollState {
  const yMatch = html.match(/scroll-y="(\d+)\/(\d+)"/);
  const xMatch = html.match(/scroll-x="(\d+)\/(\d+)"/);
  const scrollTop = yMatch ? parseInt(yMatch[1]) : 0;
  const scrollHeight = yMatch ? parseInt(yMatch[2]) : 0;
  const scrollLeft = xMatch ? parseInt(xMatch[1]) : 0;
  const scrollWidth = xMatch ? parseInt(xMatch[2]) : 0;

  return {
    scrollTop,
    scrollHeight,
    clientHeight: 1080,
    scrollLeft,
    scrollWidth,
    clientWidth: 1920,
    canScrollDown: scrollTop + 1080 < scrollHeight,
    canScrollUp: scrollTop > 0,
    canScrollLeft: scrollLeft > 0,
    canScrollRight: scrollLeft + 1920 < scrollWidth,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/dom-extract.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dom-extract.ts tests/dom-extract.test.ts
git commit -m "feat: add DOM extraction with overlay detection and HTML cleaning"
```

---

### Task 3: Create DOM interpreter module (`src/dom-interpreter.ts`) with tests

**Files:**
- Create: `src/dom-interpreter.ts`
- Create: `tests/dom-interpreter.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dom-interpreter.test.ts
import { describe, test, expect } from 'vitest';
import {
  buildSurveyPrompt,
  buildLocatePrompt,
  buildConfirmPrompt,
  parseSurveyResponse,
  parseLocateResponse,
  parseConfirmResponse,
} from '../src/dom-interpreter.js';

describe('buildSurveyPrompt', () => {
  test('includes HTML in the prompt', () => {
    const html = '<section aria-label="General"><input controlname="Name"/></section>';
    const prompt = buildSurveyPrompt(html, []);
    expect(prompt).toContain('General');
    expect(prompt).toContain('Name');
  });

  test('includes knowledge patterns when provided', () => {
    const prompt = buildSurveyPrompt('<div>page</div>', [
      {
        name: 'bc-fasttab',
        description: 'FastTab pattern',
        discovered: '2026-03-27',
        successCount: 5,
        lastUsed: '2026-03-27',
        pattern: { identify: 'aria-expanded', interact: 'click', verify: 'expanded' },
      },
    ]);
    expect(prompt).toContain('bc-fasttab');
    expect(prompt).toContain('aria-expanded');
  });
});

describe('buildLocatePrompt', () => {
  test('includes field name and HTML', () => {
    const html = '<section aria-label="Posting"><div controlname="Currency Code"><input/></div></section>';
    const prompt = buildLocatePrompt(html, { type: 'input', field: 'Currency Code', value: 'EUR' }, []);
    expect(prompt).toContain('Currency Code');
    expect(prompt).toContain('Posting');
  });

  test('includes action caption for action steps', () => {
    const html = '<button role="menuitem" aria-label="Post">Post</button>';
    const prompt = buildLocatePrompt(html, { type: 'action', caption: 'Post' }, []);
    expect(prompt).toContain('Post');
    expect(prompt).toContain('selector');
  });
});

describe('buildConfirmPrompt', () => {
  test('includes previous locate result', () => {
    const html = '<div controlname="Currency Code"><input value="EUR"/></div>';
    const prompt = buildConfirmPrompt(html, 'Currency Code', '[controlname="Currency Code"] input');
    expect(prompt).toContain('Currency Code');
    expect(prompt).toContain('controlname');
  });
});

describe('parseSurveyResponse', () => {
  test('parses valid survey JSON', () => {
    const json = JSON.stringify({
      pageType: 'card',
      pageTitle: 'Bank Account Card',
      isOverlay: false,
      sections: [
        { name: 'General', expanded: true, fields: ['No.', 'Name'] },
        { name: 'Posting', expanded: false, fields: [] },
      ],
      actionBar: ['Edit', 'New'],
      scroll: { canScrollDown: true, canScrollRight: false },
    });
    const result = parseSurveyResponse(json);
    expect(result.pageType).toBe('card');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].fields).toContain('No.');
  });
});

describe('parseLocateResponse', () => {
  test('parses locate result with steps', () => {
    const json = JSON.stringify({
      found: true,
      section: 'Posting',
      sectionExpanded: false,
      stepsToReach: [
        { action: 'expandSection', selector: '[aria-label="Posting"]' },
      ],
      interactSelector: '[controlname="Currency Code"] input',
      confidence: 'high',
      reasoning: 'Field is in collapsed Posting FastTab.',
    });
    const result = parseLocateResponse(json);
    expect(result.found).toBe(true);
    expect(result.interactSelector).toContain('Currency Code');
    expect(result.stepsToReach).toHaveLength(1);
  });
});

describe('parseConfirmResponse', () => {
  test('parses confirmed result', () => {
    const json = JSON.stringify({
      confirmed: true,
      selector: '[controlname="Currency Code"] input',
      visible: true,
      reasoning: 'Posting FastTab is now expanded.',
    });
    const result = parseConfirmResponse(json);
    expect(result.confirmed).toBe(true);
    expect(result.selector).toContain('Currency Code');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/dom-interpreter.test.ts
```

- [ ] **Step 3: Write the implementation**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/dom-interpreter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dom-interpreter.ts tests/dom-interpreter.test.ts
git commit -m "feat: add DOM interpreter with Claude text API for page analysis"
```

---

### Task 4: Slim down vision.ts — keep verify + control add-in only

**Files:**
- Modify: `src/vision.ts`
- Modify: `tests/vision.test.ts`

- [ ] **Step 1: Remove survey and locate functions from vision.ts**

Remove these exports:
- `buildSurveyPrompt`, `parseSurveyResponse`, `PageSurvey`, `surveyPage`
- `buildLocatePrompt`, `buildInputPrompt`, `locateWithContext`

Keep these exports:
- `buildVerifyPrompt`, `parseVerifyResponse`, `VisionClient` (with `verify` and `locate` methods)
- `parseLocateResponse`, `LocateResult` (used by control add-in fallback)
- The `SYSTEM_PROMPT` and `extractJson` utility

The `locate` method stays for control add-in fallback. The `locateWithContext` method is removed.

- [ ] **Step 2: Update tests**

Remove tests for `buildSurveyPrompt` (which was never tested). Keep tests for `buildLocatePrompt`, `buildInputPrompt`, `parseLocateResponse`, `parseVerifyResponse`, `buildVerifyPrompt` since `locate` is still used for control add-in fallback.

- [ ] **Step 3: Verify build and tests**

```bash
npx tsc --noEmit
npx vitest run tests/vision.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/vision.ts tests/vision.test.ts
git commit -m "refactor: slim vision.ts to verify + control add-in locate only"
```

---

### Task 5: Rewrite investigator.ts with the 9-step DOM flow

**Files:**
- Modify: `src/investigator.ts`

This is the largest task — replaces the vision-based investigation loop with the DOM-based flow:

1. EXTRACT — `extractPageHtml(frame)`
2. SURVEY — `interpreter.survey(html, patterns)`
3. LOCATE — `interpreter.locate(html, source, patterns)`
4. PREPARE — execute stepsToReach (expand FastTab, scroll, Show more)
5. CONFIRM — re-extract HTML, `interpreter.confirm(html, target, selector)`
6. ACT — use confirmed selector via Playwright locator
7. VERIFY — screenshot before/after, `vision.verify()`
8. LEARN — save successful patterns to knowledge bank
9. EMIT — `element.boundingBox()` → coordinates for .script.yml

- [ ] **Step 1: Rewrite investigator.ts**

Replace the entire file. Key changes from current version:
- Import `DomInterpreter` and `extractPageHtml` instead of vision survey/locate
- Import `loadPatterns`, `savePattern`, `incrementSuccess` from knowledge
- Remove `surveyCurrentPage`, `captureScreenshot` (for survey), scroll constants
- Keep `captureScreenshot` (for verify), `clickByLabel`, `toSource`, `YamlSpec`
- New `investigateStep` follows the 9-step flow
- New `executePrepStep` handles expandSection, scrollTo, clickShowMore via Playwright selectors
- `investigate()` function loads knowledge bank at start, surveys on page change

The full implementation should:
- Use `extractPageHtml(frame)` to get cleaned HTML (fast, no screenshots)
- Send HTML to `DomInterpreter.survey()` for page understanding
- Send HTML to `DomInterpreter.locate()` with the step source and knowledge patterns
- Execute returned preparation steps using Playwright selectors (`frame.locator(selector).click()`)
- Re-extract HTML and send to `DomInterpreter.confirm()` to verify the element is reachable
- Use the confirmed selector to interact (`frame.locator(selector).click()` or `.fill()`)
- Take before/after screenshots and use `VisionClient.verify()` for visual confirmation
- On success: save/increment knowledge pattern
- Get coordinates from `frame.locator(selector).boundingBox()` for the script file

- [ ] **Step 2: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add src/investigator.ts
git commit -m "feat: rewrite investigator with DOM-based 9-step flow and knowledge bank"
```

---

### Task 6: Update CLAUDE.md and commit knowledge directory

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update module table in CLAUDE.md**

Add new modules:
- `src/dom-extract.ts` — Pure function: Frame → cleaned HTML. Overlay detection, scroll state.
- `src/dom-interpreter.ts` — Claude text API for HTML interpretation. Survey, locate, confirm.
- `src/knowledge.ts` — Read/write knowledge bank YAML patterns. Self-learning from success/failure.

Update existing:
- `src/vision.ts` — Claude Sonnet 4.6 vision API — verify (before/after screenshots) and control add-in locate only.
- `src/investigator.ts` — DOM-based 9-step loop: extract → survey → locate → prepare → confirm → act → verify → learn → emit.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md knowledge/
git commit -m "docs: update CLAUDE.md for DOM interpreter architecture"
```

---

### Task 7: Smoke test

Manual verification. No code changes.

- [ ] **Step 1: Build**

```bash
npx tsc
```

- [ ] **Step 2: Run investigation on a real spec**

```bash
node dist/cli.js "<path-to-spec.yml>" --investigate-only -v
```

Verify:
- DOM extraction produces cleaned HTML (logged in verbose)
- Survey correctly identifies page type and fields
- Locate finds the right selectors for fields and actions
- Preparation steps expand FastTabs as needed
- Confirm verifies elements are reachable after preparation
- Vision verify confirms actions worked
- Knowledge patterns are written to `knowledge/patterns/`
- Script is written with coordinates from bounding boxes
