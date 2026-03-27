import { chromium, type Page, type Frame } from 'playwright';
import { readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve, parse as parsePath } from 'path';
import { DemoConfig } from './config.js';
import { injectCursor, cursorClickLocator, cursorClickAt, animateCursorTo } from './cursor.js';
import { info, debug, cleanDescription } from './log.js';
import type { PageType, AccessPathStep, StepDiscovery } from './types.js';

export interface Recording {
  description: string;
  name?: string;
  start?: {
    profile?: string;
    page?: string;
    pageId?: number;
    mode?: 'edit';
  };
  timeout?: number;
  steps: RecordingStep[];
  demo?: Record<string, unknown>;
}

export interface RecordingStep {
  type: string;
  target: Array<{ page?: string; field?: string }>;
  caption?: string;
  row?: number | string;
  value?: string;
  description?: string;
  assistEdit?: boolean;
  /** Nested steps for scope containers */
  steps?: RecordingStep[];
}

export interface StepTimingEntry {
  stepIndex: number;
  startMs: number;
  endMs: number;
}

export interface StepTimingMetadata {
  trimStartMs: number;
  steps: StepTimingEntry[];
}

export interface PlayResult {
  success: boolean;
  videoPath?: string;
  timing?: StepTimingMetadata;
  /** Per-step discovery metadata (populated in investigate mode) */
  discoveries?: StepDiscovery[];
  error?: string;
}

export interface PlayOptions {
  stepDelays?: Map<number, number>;
  /** 'record' (default) = normal recording with video+cursor; 'investigate' = headless dry run */
  mode?: 'record' | 'investigate';
  /** Discovery hints from a prior investigation run — used as fast-path in record mode */
  discoveries?: StepDiscovery[];
}

const NAV_DELAY_MS = 2000;
const END_DELAY_MS = 2000;
const NAV_TIMEOUT_MS = 120_000;

// ═══════════════════════════════════════════════════════════
// Unified Finder Functions
// ═══════════════════════════════════════════════════════════

/**
 * Finds a BC field by name in the frame DOM. Returns position, selector
 * description, and strategy name. This is the single source of truth for
 * field-finding logic — all other field functions use this.
 */
export async function findFieldInFrame(
  frame: Frame,
  fieldName: string,
): Promise<{ x: number; y: number; selector: string; strategy: string } | null> {
  return frame.evaluate((name: string) => {
    type FieldResult = { x: number; y: number; selector: string; strategy: string };

    function visible(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function center(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    // When BC enters edit mode it renders a second set of grids/fields on top
    // of the view-mode content WITHOUT wrapping them in [role="dialog"]. Both
    // sets stay in the DOM; the edit-mode elements come LAST in document order.
    // → For each strategy, keep the LAST visible match.

    // Strategy 1: BC grid cell — td[controlname] contains the input
    let last: FieldResult | null = null;
    for (const td of document.querySelectorAll(`td[controlname="${name}"]`)) {
      const input = td.querySelector(
        'input, textarea, select, [role="textbox"], [role="combobox"]',
      );
      if (input) {
        const c = center(input);
        if (c) last = { ...c, selector: `td[controlname="${name}"] input`, strategy: 'gridCell' };
      } else {
        const c = center(td);
        if (c) last = { ...c, selector: `td[controlname="${name}"]`, strategy: 'gridCell' };
      }
    }
    if (last) return last;

    // Strategy 2: Exact aria-label match
    for (const el of document.querySelectorAll(`[aria-label="${name}"]`)) {
      const c = center(el);
      if (c) last = { ...c, selector: `[aria-label="${name}"]`, strategy: 'exactAriaLabel' };
    }
    if (last) return last;

    // Strategy 3: Input elements with substring aria-label match
    for (const el of document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    )) {
      if (el.getAttribute('aria-label')?.includes(name)) {
        const c = center(el);
        if (c) last = { ...c, selector: `inputAriaLabel:${name}`, strategy: 'inputAriaLabel' };
      }
    }
    if (last) return last;

    // Strategy 4: Substring aria-label — pick shortest label (most specific)
    // Among shortest-label matches, prefer the last one
    const candidates: Array<{ el: Element; len: number }> = [];
    for (const el of document.querySelectorAll(`[aria-label*="${name}"]`)) {
      if (el.getAttribute('aria-label')?.startsWith('Open menu for')) continue;
      if (visible(el)) candidates.push({ el, len: el.getAttribute('aria-label')?.length ?? 0 });
    }
    if (candidates.length > 0) {
      const minLen = Math.min(...candidates.map((c) => c.len));
      const shortest = candidates.filter((c) => c.len === minLen);
      const c = center(shortest[shortest.length - 1].el);
      if (c) return { ...c, selector: `[aria-label*="${name}"]`, strategy: 'partialAriaLabel' };
    }

    // Strategy 5: Title attribute match (skip "Open Menu" links)
    for (const el of document.querySelectorAll(`[title*="${name}"]`)) {
      if (el.getAttribute('title') === 'Open Menu') continue;
      const c = center(el);
      if (c) last = { ...c, selector: `[title*="${name}"]`, strategy: 'titleAttr' };
    }
    if (last) return last;

    // Strategy 6: Caption label → sibling value element
    for (const cap of document.querySelectorAll('label, [class*="caption"], [class*="Caption"]')) {
      if (cap.textContent?.trim() === name || cap.textContent?.includes(name)) {
        const parent = cap.parentElement;
        if (parent) {
          const ctrl = parent.querySelector(
            'input, textarea, select, [role="textbox"], [role="combobox"], [contenteditable="true"]',
          );
          if (ctrl) {
            const c = center(ctrl);
            if (c) last = { ...c, selector: `caption:${name}`, strategy: 'caption' };
          }
          const sibling = cap.nextElementSibling;
          if (sibling) {
            const c = center(sibling);
            if (c) last = { ...c, selector: `caption:${name}`, strategy: 'caption' };
          }
        }
      }
    }
    return last;
  }, fieldName);
}

/**
 * Finds a row in a BC list grid by index or text match. Returns position,
 * row index, and matched text for discovery metadata.
 */
export async function findRowInFrame(
  frame: Frame,
  rowTarget: number | string,
): Promise<{
  x: number;
  y: number;
  matchedRowIndex: number;
  matchedRowText: string;
  selector: string;
} | null> {
  return frame.evaluate((target: number | string) => {
    function getScope(): Element {
      const dialogs = document.querySelectorAll(
        '[role="dialog"], [class*="ms-nav-popup"], [class*="modal-dialog"]',
      );
      for (let i = dialogs.length - 1; i >= 0; i--) {
        const d = dialogs[i] as HTMLElement;
        if (
          d.offsetWidth > 0 &&
          d.offsetHeight > 0 &&
          !d.className?.includes('TeachingBubble') &&
          d.querySelector('table, [role="grid"]')
        )
          return d;
      }
      return document.body;
    }
    const scope = getScope();

    // When BC enters edit mode, duplicate grids appear in the DOM.
    // The edit-mode grid comes LAST in document order. Iterate in
    // reverse so we pick the topmost (edit-mode) grid.
    function getDataRows(): Element[] {
      const tables = Array.from(
        scope.querySelectorAll(
          'table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]',
        ),
      );
      for (let i = tables.length - 1; i >= 0; i--) {
        const rows = Array.from(tables[i].querySelectorAll('tbody > tr, tr[role="row"]'));
        const data = rows.filter(
          (r) =>
            !r.querySelector('th') &&
            !r.querySelector('[role="columnheader"]') &&
            r.querySelector('td') &&
            Array.from(r.querySelectorAll('td')).some((c) =>
              (c as HTMLElement).textContent?.trim(),
            ),
        );
        if (data.length > 0) return data;
      }
      const grids = Array.from(scope.querySelectorAll('[role="grid"]'));
      for (let i = grids.length - 1; i >= 0; i--) {
        const rows = Array.from(grids[i].querySelectorAll('[role="row"]'));
        const data = rows.filter(
          (r) =>
            !r.querySelector('[role="columnheader"]') &&
            Array.from(r.querySelectorAll('[role="gridcell"]')).some((c) =>
              (c as HTMLElement).textContent?.trim(),
            ),
        );
        if (data.length > 0) return data;
      }
      return [];
    }

    const rows = getDataRows();
    let matchedIndex = -1;
    const row =
      typeof target === 'number'
        ? ((matchedIndex = target - 1), rows[target - 1] ?? null)
        : (rows.find((r, i) => {
            const search = target.toLowerCase();
            const found = Array.from(r.querySelectorAll('td, [role="gridcell"]')).some((c) =>
              (c.textContent?.trim().toLowerCase() ?? '').includes(search),
            );
            if (found) matchedIndex = i;
            return found;
          }) ?? null);
    if (!row) return null;

    // Collect row text
    const cells = Array.from(row.querySelectorAll('td, [role="gridcell"]'));
    const rowText = cells
      .map((c) => (c as HTMLElement).textContent?.trim())
      .filter(Boolean)
      .join(' - ');

    const link = row.querySelector('a');
    const el = link ?? row.querySelector('td') ?? row;
    const rect = (el as HTMLElement).getBoundingClientRect();
    return {
      x: rect.x + Math.min(rect.width * 0.3, 40),
      y: rect.y + rect.height / 2,
      matchedRowIndex: matchedIndex + 1, // 1-based
      matchedRowText: rowText.slice(0, 200),
      selector: `dataRow:${matchedIndex + 1}`,
    };
  }, rowTarget);
}

/**
 * Determines which strategy would find a BC action button, without clicking it.
 * Returns the strategy name and a selector description. Used by investigate mode
 * to capture which approach works for each action.
 */
export async function findActionStrategy(
  frame: Frame,
  page: Page,
  caption: string,
): Promise<{ strategy: string; selector: string } | null> {
  // Check dialog first
  const dialogLocator = frame.locator(
    '[role="dialog"]:visible:not([class*="TeachingBubble"]), [class*="ms-nav-popup"]:visible',
  );
  const hasDialog = (await dialogLocator.count()) > 0;

  if (hasDialog) {
    const dialog = dialogLocator.last();
    for (const role of ['button', 'menuitem', 'link'] as const) {
      const loc = dialog.getByRole(role, { name: caption, exact: true });
      if ((await loc.count()) > 0) {
        return {
          strategy: `dialog:exactAriaName:${role}`,
          selector: `getByRole:${role}:${caption}`,
        };
      }
    }
    const dialogText = dialog.getByText(caption, { exact: true });
    if ((await dialogText.count()) > 0) {
      return { strategy: 'dialog:getByText', selector: `getByText:${caption}` };
    }
  }

  const DIALOG_BUTTONS = ['ok', 'cancel', 'close', 'yes', 'no'];
  if (!hasDialog && DIALOG_BUTTONS.includes(caption.toLowerCase())) {
    return { strategy: 'dialogAlreadyClosed', selector: 'none' };
  }

  // Strategy 1: Exact role match
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption, exact: true });
    if ((await locator.count()) > 0) {
      return { strategy: `exactAriaName:${role}`, selector: `getByRole:${role}:${caption}` };
    }
  }

  // Strategy 2: Partial role match
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption });
    if ((await locator.count()) > 0) {
      return { strategy: `partialAriaName:${role}`, selector: `getByRole:${role}:*${caption}*` };
    }
  }

  // Strategy 3: CSS text content match
  const textLocator = frame.locator(
    `button:has-text("${caption}"), [role="button"]:has-text("${caption}"), [role="menuitem"]:has-text("${caption}"), a:has-text("${caption}"), span:has-text("${caption}")`,
  );
  if ((await textLocator.count()) > 0) {
    return { strategy: 'cssText', selector: `has-text:${caption}` };
  }

  // Strategy 4: getByText
  const byText = frame.getByText(caption, { exact: true });
  if ((await byText.count()) > 0) {
    return { strategy: 'getByText', selector: `getByText:${caption}` };
  }

  // Strategy 5: Top bar (main page, not frame)
  const pageLocator = page.locator(
    `button:has-text("${caption}"), [role="button"]:has-text("${caption}")`,
  );
  if ((await pageLocator.count()) > 0) {
    return { strategy: 'topBar', selector: `topBar:has-text:${caption}` };
  }

  return null;
}

/**
 * Detects the BC page type by checking DOM markers in the frame.
 */
export async function detectPageType(frame: Frame): Promise<PageType> {
  return frame.evaluate(() => {
    // Check for modal dialog first (highest priority)
    const dialogs = document.querySelectorAll('[role="dialog"]:not([class*="TeachingBubble"])');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const d = dialogs[i] as HTMLElement;
      if (d.offsetWidth > 0 && d.offsetHeight > 0) return 'Dialog' as const;
    }

    const hasCardForm = !!document.querySelector('div.ms-nav-cardform, [class*="ms-nav-card"]');
    const dataTable = document.querySelector(
      'table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]',
    );
    const hasGrid = !!dataTable || !!document.querySelector('[role="grid"]');

    // Document = Card with embedded grid (header + lines)
    if (hasCardForm && hasGrid) return 'Document' as const;

    // Card = Single-record form, no data grid
    if (hasCardForm) return 'Card' as const;

    // Worksheet = Full-page editable grid (journal-style)
    if (hasGrid) {
      // Check if rows are editable (worksheet/journal vs read-only list)
      const editableCells = document.querySelectorAll(
        '[role="grid"] input, [role="grid"] [contenteditable="true"], [role="grid"] [role="textbox"]',
      );
      if (editableCells.length > 0) return 'Worksheet' as const;
      return 'List' as const;
    }

    return 'Card' as const; // fallback
  }) as Promise<PageType>;
}

/**
 * Prepares access to a field by expanding collapsed FastTabs and clicking
 * "Show more" if needed. Returns the access path steps that were taken.
 * This is the shared implementation — both record and investigate mode use it.
 */
export async function prepareFieldAccess(
  frame: Frame,
  page: Page,
  fieldName: string,
): Promise<AccessPathStep[]> {
  const accessPath: AccessPathStep[] = [];

  // --- FastTab expansion ---
  const headerToClick = await frame.evaluate((name: string) => {
    function findFieldElement(): Element | null {
      for (const el of document.querySelectorAll(`[aria-label*="${name}"], [title*="${name}"]`)) {
        return el;
      }
      for (const el of document.querySelectorAll(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
      )) {
        if (el.getAttribute('aria-label')?.includes(name)) return el;
      }
      for (const cap of document.querySelectorAll(
        'label, [class*="caption"], [class*="Caption"]',
      )) {
        if (cap.textContent?.trim() === name || cap.textContent?.includes(name)) return cap;
      }
      return null;
    }

    const field = findFieldElement();
    if (!field) return null;

    const rect = (field as HTMLElement).getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return null;

    let el: Element | null = field;
    while (el) {
      const header = el.querySelector('[aria-expanded="false"]');
      if (header) {
        const headerRect = (header as HTMLElement).getBoundingClientRect();
        if (headerRect.width > 0 && headerRect.height > 0) {
          // Try to get the FastTab name from the header text
          const tabName = (header as HTMLElement).textContent?.trim().split('\n')[0]?.trim() ?? '';
          return {
            x: headerRect.x + headerRect.width / 2,
            y: headerRect.y + headerRect.height / 2,
            tabName,
          };
        }
      }
      if (
        el.classList?.contains('collapsibleTab') ||
        el.classList?.contains('collapsibleTab-container')
      ) {
        const hdr =
          el.querySelector('[aria-expanded="false"]') ??
          el.previousElementSibling?.querySelector('[aria-expanded="false"]') ??
          el.parentElement?.querySelector('[aria-expanded="false"]');
        if (hdr) {
          const headerRect = (hdr as HTMLElement).getBoundingClientRect();
          if (headerRect.width > 0 && headerRect.height > 0) {
            const tabName = (hdr as HTMLElement).textContent?.trim().split('\n')[0]?.trim() ?? '';
            return {
              x: headerRect.x + headerRect.width / 2,
              y: headerRect.y + headerRect.height / 2,
              tabName,
            };
          }
        }
      }
      el = el.parentElement;
    }
    return null;
  }, fieldName);

  if (headerToClick) {
    debug(`Expanding collapsed FastTab for field "${fieldName}"`);
    await frame.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      el?.click();
    }, headerToClick);
    await page.waitForTimeout(500);
    await awaitBCFrame(page, 10_000).catch(() => {});
    accessPath.push({ expandFastTab: headerToClick.tabName || fieldName });
  }

  // --- "Show more" click ---
  const showMoreToClick = await frame.evaluate((name: string) => {
    function findFieldElement(): Element | null {
      for (const el of document.querySelectorAll(`[aria-label*="${name}"], [title*="${name}"]`)) {
        return el;
      }
      for (const el of document.querySelectorAll(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
      )) {
        if (el.getAttribute('aria-label')?.includes(name)) return el;
      }
      for (const cap of document.querySelectorAll(
        'label, [class*="caption"], [class*="Caption"]',
      )) {
        if (cap.textContent?.trim() === name || cap.textContent?.includes(name)) return cap;
      }
      return null;
    }

    const field = findFieldElement();
    if (!field) return null;

    const rect = (field as HTMLElement).getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return null;

    let container: Element | null = field;
    while (container) {
      if (
        container.classList?.contains('collapsibleTab') ||
        container.classList?.contains('collapsibleTab-container') ||
        container.getAttribute('role') === 'tabpanel' ||
        container.getAttribute('role') === 'group'
      ) {
        break;
      }
      container = container.parentElement;
    }

    const scope = container ?? document;
    for (const el of scope.querySelectorAll('a, button, [role="button"], [role="link"], span')) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase();
      if (text === 'show more' || text === 'vis mere' || text === 'mehr anzeigen') {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
    }
    return null;
  }, fieldName);

  if (showMoreToClick) {
    debug(`Clicking "Show more" for field "${fieldName}"`);
    await frame.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      el?.click();
    }, showMoreToClick);
    await page.waitForTimeout(500);
    await awaitBCFrame(page, 10_000).catch(() => {});
    accessPath.push({ clickShowMore: true });
  }

  return accessPath;
}

export async function playDemo(
  specPath: string,
  config: DemoConfig,
  options?: PlayOptions,
): Promise<PlayResult> {
  const mode = options?.mode ?? 'record';
  const isInvestigate = mode === 'investigate';
  const discoveries: StepDiscovery[] = [];

  const absoluteSpecPath = resolve(specPath);
  const specContent = readFileSync(absoluteSpecPath, 'utf-8');
  const recording: Recording = parseYaml(specContent);
  const specName = parsePath(absoluteSpecPath).name.replace(/\.enriched$/, '');

  // Build BC URL with profile and optional page ID
  const bcUrl = new URL(config.bcStartAddress);
  if (recording.start?.profile) {
    bcUrl.searchParams.set('profile', recording.start.profile);
  }
  if (recording.start?.pageId) {
    bcUrl.searchParams.set('page', String(recording.start.pageId));
  }

  const outputDir = resolve(config.outputDir);
  mkdirSync(outputDir, { recursive: true });

  // Investigation runs headless regardless of config
  const browser = await chromium.launch({ headless: isInvestigate ? true : !config.headed });

  // --- Phase A: Authenticate in a non-recording context ---
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
  debug('BC is ready — transferring session to recording context');

  // Grab cookies and the authenticated URL
  const cookies = await authContext.cookies();
  const authenticatedUrl = authPage.url();
  await authContext.close();

  // --- Phase B: Create context (with or without video) ---
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1920, height: 1080 },
  };
  if (!isInvestigate) {
    contextOptions.recordVideo = { dir: outputDir, size: { width: 1920, height: 1080 } };
  }
  const context = await browser.newContext(contextOptions);
  await context.addCookies(cookies);
  const page = await context.newPage();
  let timing: StepTimingMetadata | undefined;

  try {
    // Navigate to the same URL — cookies skip the login, lands directly on the BC page
    await page.goto(authenticatedUrl);
    const videoStartMs = Date.now();

    // Wait for BC to be ready
    await page.waitForTimeout(200);
    const frame = await awaitBCFrame(page);

    // Click Edit/Edit List before recording content begins (trimmed with loading screen)
    if (recording.start?.mode === 'edit') {
      debug('start.mode=edit — switching page to edit mode');
      let clicked = false;
      for (const label of ['Edit', 'Edit List']) {
        const btn = frame.getByRole('menuitem', { name: label, exact: true });
        if ((await btn.count()) > 0) {
          await btn.first().click();
          info(`Clicked "${label}" to enter edit mode`);
          // Wait for BC to settle after mode switch (page may become modal)
          await awaitBCFrame(page, 10_000).catch(() => {});
          await page.waitForTimeout(300);
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        info('WARNING: Neither "Edit" nor "Edit List" found — page may already be in edit mode');
      }
    }

    const bcReadyMs = Date.now();

    // Only inject cursor and track timing in record mode
    if (!isInvestigate) {
      await injectCursor(page);
      // Brief pause so the first frame of the trimmed video shows the loaded page
      await page.waitForTimeout(500);
    }
    const trimStartMs = bcReadyMs - videoStartMs;
    if (!isInvestigate) {
      info(`BC loaded (trimming ${(trimStartMs / 1000).toFixed(1)}s of loading screen)`);
    } else {
      info('BC loaded — starting investigation');
    }

    const timingSteps: StepTimingEntry[] = [];

    // Take a snapshot to see what's on the page (verbose only)
    const snapshot = await frame.evaluate(() => {
      const buttons: string[] = [];
      document
        .querySelectorAll('button, [role="button"], [role="menuitem"], a[tabindex]')
        .forEach((el) => {
          const text = (el as HTMLElement).innerText?.trim();
          if (text && text.length < 80) buttons.push(text);
        });
      return { buttons: buttons.slice(0, 30), title: document.title };
    });
    debug(`Page title: ${snapshot.title}`);
    debug(`Available buttons/actions: ${snapshot.buttons.join(' | ')}`);

    // Debug: inspect grid/table structure (verbose only)
    const gridInfo = await frame.evaluate(() => {
      const items: string[] = [];
      document.querySelectorAll('[role="grid"]').forEach((g, gi) => {
        items.push(
          `grid[${gi}]: ${(g as HTMLElement).getAttribute('aria-label') || g.className.slice(0, 50)}`,
        );
        const rows = g.querySelectorAll('[role="row"]');
        items.push(`  rows: ${rows.length}`);
        rows.forEach((r, ri) => {
          if (ri < 3) {
            const cells = r.querySelectorAll('[role="gridcell"], [role="columnheader"]');
            const texts = Array.from(cells)
              .map((c) => (c as HTMLElement).innerText?.trim().slice(0, 30))
              .filter(Boolean);
            items.push(`  row[${ri}]: ${texts.join(' | ')}`);
          }
        });
      });
      document.querySelectorAll('table').forEach((t, ti) => {
        items.push(`table[${ti}]: rows=${t.rows.length}, class=${t.className.slice(0, 50)}`);
      });
      const links = document.querySelectorAll('a[href], a[tabindex]');
      const linkTexts: string[] = [];
      links.forEach((l) => {
        const text = (l as HTMLElement).innerText?.trim();
        if (text && text.length < 60 && text.length > 0) linkTexts.push(text);
      });
      if (linkTexts.length) items.push(`links: ${linkTexts.slice(0, 20).join(' | ')}`);
      return items;
    });
    debug('DOM structure:');
    gridInfo.forEach((line) => debug(`  ${line}`));

    // Execute each step
    for (let i = 0; i < recording.steps.length; i++) {
      const step = recording.steps[i];
      const stepStartTime = Date.now();
      const stepStartMs = stepStartTime - videoStartMs;
      const stepDesc = cleanDescription(step.description ?? step.caption ?? '');
      const prefix = isInvestigate ? '[investigate]' : `[${i + 1}/${recording.steps.length}]`;
      info(`${prefix} Step ${i + 1}/${recording.steps.length}: ${stepDesc}`);

      // Discovery metadata for this step (populated during execution)
      const stepDiscovery: StepDiscovery = {};
      const hint = options?.discoveries?.[i];

      let currentFrame: Frame;
      try {
        currentFrame = await awaitBCFrame(page, 10_000);
      } catch {
        currentFrame = frame;
      }

      // Detect page type for discovery
      try {
        stepDiscovery.pageType = await detectPageType(currentFrame);
      } catch {
        /* non-critical */
      }

      // In record mode with enrichments: pre-execute access path
      if (!isInvestigate && hint?.accessPath && hint.accessPath.length > 0) {
        debug('Applying discovery access path...');
        for (const pathStep of hint.accessPath) {
          if ('expandFastTab' in pathStep) {
            // Click the FastTab header to expand it
            const tabName = pathStep.expandFastTab;
            const clicked = await currentFrame.evaluate((name: string) => {
              for (const header of document.querySelectorAll('[aria-expanded="false"]')) {
                if ((header as HTMLElement).textContent?.includes(name)) {
                  (header as HTMLElement).click();
                  return true;
                }
              }
              return false;
            }, tabName);
            if (clicked) {
              await page.waitForTimeout(500);
              await awaitBCFrame(page, 10_000).catch(() => {});
            }
          } else if ('clickShowMore' in pathStep) {
            await currentFrame.evaluate(() => {
              for (const el of document.querySelectorAll('a, button, [role="button"], span')) {
                const text = (el as HTMLElement).innerText?.trim().toLowerCase();
                if (text === 'show more' || text === 'vis mere' || text === 'mehr anzeigen') {
                  (el as HTMLElement).click();
                  return;
                }
              }
            });
            await page.waitForTimeout(500);
            await awaitBCFrame(page, 10_000).catch(() => {});
          }
        }
      }

      try {
        if (step.type === 'action' && step.assistEdit && step.caption) {
          // Click the assist-edit "..." button on a field
          if (isInvestigate) {
            // Investigation: expand access, find field, click, find assist button
            const accessPath = await prepareFieldAccess(currentFrame, page, step.caption);
            stepDiscovery.accessPath = accessPath;
            const fieldResult = await findFieldInFrame(currentFrame, step.caption);
            if (fieldResult) {
              stepDiscovery.selector = fieldResult.selector;
              stepDiscovery.strategy = fieldResult.strategy;
              stepDiscovery.fieldFound = true;
            } else {
              stepDiscovery.fieldFound = false;
            }
          }
          if (isInvestigate) {
            // In investigate mode: click field then click assist-edit button
            // without cursor animation (cursor is not injected)
            const fieldPos = await findFieldInFrame(currentFrame, step.caption);
            if (fieldPos) {
              await currentFrame.evaluate(({ x, y }) => {
                const el = document.elementFromPoint(x, y) as HTMLElement | null;
                el?.click();
              }, fieldPos);
              await page.waitForTimeout(600);
              // Find and click the assist-edit "..." button
              const assistBtn = await currentFrame.evaluate((name: string) => {
                for (const el of document.querySelectorAll(
                  `[aria-label*="Choose a value for ${name}"], [aria-label*="choose a value for ${name}"]`,
                )) {
                  const rect = (el as HTMLElement).getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    (el as HTMLElement).click();
                    return true;
                  }
                }
                // Fallback: look for lookup button near active element
                const active = document.activeElement as HTMLElement | null;
                if (active?.parentElement) {
                  for (const sib of active.parentElement.querySelectorAll(
                    '[class*="lookupbutton"], [class*="MoreEllipsis"]',
                  )) {
                    const rect = (sib as HTMLElement).getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      (sib as HTMLElement).click();
                      return true;
                    }
                  }
                }
                return false;
              }, step.caption);
              if (!assistBtn) {
                await page.keyboard.press('F6');
              }
            }
          } else {
            await clickAssistEdit(currentFrame, page, step.caption);
          }
        } else if (step.type === 'action' && step.row) {
          // Click on a specific row in the list grid
          if (isInvestigate) {
            const rowResult = await findRowInFrame(currentFrame, step.row);
            if (rowResult) {
              stepDiscovery.selector = rowResult.selector;
              stepDiscovery.matchedRowIndex = rowResult.matchedRowIndex;
              stepDiscovery.matchedRowText = rowResult.matchedRowText;
              stepDiscovery.fieldFound = true;
              info(`  → matchedRowText: "${rowResult.matchedRowText}"`);
            } else {
              stepDiscovery.fieldFound = false;
            }
          }
          await clickBCRow(currentFrame, step.row, isInvestigate ? undefined : page);
        } else if (step.type === 'action' && step.caption) {
          // Click a button/action by caption text
          if (isInvestigate) {
            const actionResult = await findActionStrategy(currentFrame, page, step.caption);
            if (actionResult) {
              stepDiscovery.selector = actionResult.selector;
              stepDiscovery.strategy = actionResult.strategy;
              stepDiscovery.fieldFound = true;
              info(`  → strategy: ${actionResult.strategy}`);
            } else {
              stepDiscovery.fieldFound = false;
            }
          }

          let clicked = await clickBCAction(currentFrame, page, step.caption);

          // If not found and the previous step was a menu open, re-open it and retry
          if (!clicked && i > 0) {
            const prevStep = recording.steps[i - 1];
            if (prevStep.type === 'action' && prevStep.caption) {
              debug(`Re-opening menu "${prevStep.caption}" and retrying...`);
              await clickBCAction(currentFrame, page, prevStep.caption);
              await page.waitForTimeout(500);

              const allText = await currentFrame.evaluate(() => {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
                const results: string[] = [];
                let node: Node | null;
                while ((node = walker.nextNode())) {
                  const el = node as HTMLElement;
                  const own =
                    el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE
                      ? (el.childNodes[0].textContent?.trim() ?? '')
                      : '';
                  if (
                    own &&
                    own.length > 0 &&
                    own.length < 60 &&
                    (own.toLowerCase().includes('more') ||
                      own.toLowerCase().includes('column') ||
                      own.toLowerCase().includes('show'))
                  ) {
                    results.push(
                      `<${el.tagName.toLowerCase()} class="${el.className?.toString().slice(0, 40)}" role="${el.getAttribute('role')}">${own}`,
                    );
                  }
                }
                return [...new Set(results)].slice(0, 30);
              });
              debug(`DOM elements with "show/more/column": ${allText.join('\n    ')}`);

              clicked = await clickBCAction(currentFrame, page, step.caption);
            }
          }

          if (!clicked) {
            info(`  WARNING: Could not find "${step.caption}" — falling back to DN.playRecording`);
            const singleStep = { ...recording, steps: [step] };
            await currentFrame.evaluate((data) => {
              const DN = (window as unknown as Record<string, unknown>)['DN'] as Record<
                string,
                (...args: unknown[]) => unknown
              >;
              return DN['playRecording'](data);
            }, singleStep as unknown);
          }
        } else if (step.type === 'input' && step.value) {
          const fieldName = step.target?.find((t) => t.field)?.field;
          debug(`Filling field "${fieldName}" with "${step.value}"`);

          // Prepare field access (expand FastTab, Show More) — always needed
          if (fieldName) {
            const accessPath = await prepareFieldAccess(currentFrame, page, fieldName);
            if (isInvestigate) {
              stepDiscovery.accessPath = accessPath;
            }
          }

          // In record mode: scroll and animate cursor
          if (!isInvestigate && fieldName) {
            await scrollFieldToCenter(currentFrame, page, fieldName);
            await animateCursorToField(currentFrame, page, fieldName);
          }

          // Find field metadata for investigation
          if (isInvestigate && fieldName) {
            const fieldResult = await findFieldInFrame(currentFrame, fieldName);
            if (fieldResult) {
              stepDiscovery.selector = fieldResult.selector;
              stepDiscovery.strategy = fieldResult.strategy;
              stepDiscovery.fieldFound = true;
              info(`  → selector: ${fieldResult.selector} (${fieldResult.strategy})`);
            } else {
              stepDiscovery.fieldFound = false;
            }
          }

          // Try to fill via td[controlname] first, fall back to DN.playRecording.
          // In investigate mode, this determines inputMethod.
          let directFilled = false;
          if (fieldName) {
            // In record mode with discovery hint, use the known inputMethod
            if (!isInvestigate && hint?.inputMethod === 'dnPlayRecording') {
              debug(`Using discovery hint: dnPlayRecording for "${fieldName}"`);
              directFilled = false; // skip directly to fallback
            } else {
              // Boolean fields: look for checkbox first (use last match for edit-mode dupes)
              const isBoolValue =
                step.value.toLowerCase() === 'true' || step.value.toLowerCase() === 'false';
              if (isBoolValue) {
                const checkHandles = await currentFrame.$$(
                  `td[controlname="${fieldName}"] input[type="checkbox"], td[controlname="${fieldName}"] [role="checkbox"]`,
                );
                const checkHandle =
                  checkHandles.length > 0 ? checkHandles[checkHandles.length - 1] : null;
                if (checkHandle) {
                  const wantChecked = step.value.toLowerCase() === 'true';
                  const isChecked = await checkHandle
                    .isChecked()
                    .catch(() => checkHandle.evaluate((el) => (el as HTMLInputElement).checked));
                  if (isChecked !== wantChecked) {
                    await checkHandle.click();
                    debug(`Toggled checkbox "${fieldName}" → ${wantChecked}`);
                  } else {
                    debug(
                      `Checkbox "${fieldName}" already ${wantChecked ? 'checked' : 'unchecked'}`,
                    );
                  }
                  await page.waitForTimeout(100);
                  directFilled = true;
                }
              }
              // Text/other fields: fill via td[controlname] input (last match for edit-mode dupes)
              if (!directFilled) {
                const inputHandles = await currentFrame.$$(
                  `td[controlname="${fieldName}"] input, td[controlname="${fieldName}"] [role="textbox"]`,
                );
                const inputHandle =
                  inputHandles.length > 0 ? inputHandles[inputHandles.length - 1] : null;
                if (inputHandle) {
                  await inputHandle.click();
                  await page.waitForTimeout(100);
                  await inputHandle.fill(step.value);
                  await page.waitForTimeout(100);
                  await inputHandle.press('Tab');
                  directFilled = true;
                  debug(`Direct fill: entered "${step.value}" in "${fieldName}"`);
                }
              }
            }
          }

          if (!directFilled) {
            debug(`Falling back to DN.playRecording for "${fieldName}"`);
            const singleStep = { ...recording, steps: [step] };
            await currentFrame.evaluate((data) => {
              const DN = (window as unknown as Record<string, unknown>)['DN'] as Record<
                string,
                (...args: unknown[]) => unknown
              >;
              return DN['playRecording'](data);
            }, singleStep as unknown);
          }

          if (isInvestigate) {
            stepDiscovery.inputMethod = directFilled ? 'directFill' : 'dnPlayRecording';
            info(`  → inputMethod: ${stepDiscovery.inputMethod}`);
          }

          // In record mode: re-scroll to show the filled field and animate cursor
          if (!isInvestigate && fieldName) {
            await page.waitForTimeout(300);
            const postFrame = await awaitBCFrame(page, 5_000).catch(() => currentFrame);
            await scrollFieldToCenter(postFrame, page, fieldName);
            await animateCursorToField(postFrame, page, fieldName);
          }
        } else if (step.type === 'scope' && step.steps) {
          // Scope: execute inner steps sequentially within this timing slot
          debug(`Scope: executing ${step.steps.length} inner steps`);
          for (const innerStep of step.steps) {
            const innerDesc = cleanDescription(innerStep.description ?? innerStep.caption ?? '');
            debug(`  Scope inner: ${innerDesc}`);

            let innerFrame: Frame;
            try {
              innerFrame = await awaitBCFrame(page, 10_000);
            } catch {
              innerFrame = currentFrame;
            }

            if (innerStep.type === 'action' && innerStep.row) {
              await clickBCRow(innerFrame, innerStep.row, isInvestigate ? undefined : page);
            } else if (innerStep.type === 'action' && innerStep.caption) {
              const clicked = await clickBCAction(innerFrame, page, innerStep.caption);
              if (!clicked) {
                info(`  WARNING: Could not find "${innerStep.caption}" in scope`);
              }
            } else if (innerStep.type === 'input' && innerStep.value) {
              const innerFieldName = innerStep.target?.find((t) => t.field)?.field;
              if (innerFieldName) {
                if (!isInvestigate) {
                  await scrollFieldToCenter(innerFrame, page, innerFieldName);
                  await animateCursorToField(innerFrame, page, innerFieldName);
                }

                let innerFilled = false;
                // Boolean toggle
                const isBool =
                  innerStep.value.toLowerCase() === 'true' ||
                  innerStep.value.toLowerCase() === 'false';
                if (isBool) {
                  const checkHandles = await innerFrame.$$(
                    `td[controlname="${innerFieldName}"] input[type="checkbox"], td[controlname="${innerFieldName}"] [role="checkbox"]`,
                  );
                  const checkHandle =
                    checkHandles.length > 0 ? checkHandles[checkHandles.length - 1] : null;
                  if (checkHandle) {
                    const wantChecked = innerStep.value.toLowerCase() === 'true';
                    const isChecked = await checkHandle
                      .isChecked()
                      .catch(() => checkHandle.evaluate((el) => (el as HTMLInputElement).checked));
                    if (isChecked !== wantChecked) {
                      await checkHandle.click();
                      debug(`  Toggled checkbox "${innerFieldName}" → ${wantChecked}`);
                    }
                    await page.waitForTimeout(100);
                    innerFilled = true;
                  }
                }
                // Text fallback
                if (!innerFilled) {
                  const inputHandles = await innerFrame.$$(
                    `td[controlname="${innerFieldName}"] input, td[controlname="${innerFieldName}"] [role="textbox"]`,
                  );
                  const inputHandle =
                    inputHandles.length > 0 ? inputHandles[inputHandles.length - 1] : null;
                  if (inputHandle) {
                    await inputHandle.click();
                    await page.waitForTimeout(100);
                    await inputHandle.fill(innerStep.value);
                    await page.waitForTimeout(100);
                    await inputHandle.press('Tab');
                    innerFilled = true;
                  }
                }
                if (!innerFilled) {
                  debug(`  Scope inner: falling back to DN.playRecording for "${innerFieldName}"`);
                  const singleStep = { ...recording, steps: [innerStep] };
                  await innerFrame.evaluate((data) => {
                    const DN = (window as unknown as Record<string, unknown>)['DN'] as Record<
                      string,
                      (...args: unknown[]) => unknown
                    >;
                    return DN['playRecording'](data);
                  }, singleStep as unknown);
                }
              }
            }

            await page.waitForTimeout(isInvestigate ? 200 : 400);
            await awaitBCFrame(page, 10_000).catch(() => {});
          }
        }
      } catch (stepError) {
        const msg = stepError instanceof Error ? stepError.message : String(stepError);
        if (isInvestigate) {
          // In investigate mode: log warning, record partial discovery, continue
          info(`  WARNING: Step ${i + 1} failed: ${msg}`);
          stepDiscovery.fieldFound = false;
        } else {
          throw stepError; // In record mode: propagate errors as before
        }
      }

      // Collect discovery for this step
      if (isInvestigate) {
        discoveries.push(stepDiscovery);
      }

      // Wait for BC to respond to the click, then wait until idle
      await page.waitForTimeout(isInvestigate ? 200 : 500);

      // Wait for BC transition overlays (spa-dialog fadeout) to clear
      try {
        await page.waitForFunction(
          () => {
            const overlays = document.querySelectorAll('.spa-view.spa-dialog');
            for (const el of overlays) {
              const style = window.getComputedStyle(el);
              if (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                parseFloat(style.opacity) > 0
              ) {
                return false;
              }
            }
            return true;
          },
          { timeout: 10_000 },
        );
      } catch {
        debug('spa-dialog overlay still present after 10s — continuing');
      }

      try {
        const postFrame = await awaitBCFrame(page, 15_000);
        const postSnap = await postFrame.evaluate(() => {
          const btns: string[] = [];
          document.querySelectorAll('button, [role="button"], [role="menuitem"]').forEach((el) => {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.length > 0 && text.length < 60) btns.push(text);
          });
          return btns.slice(0, 25);
        });
        debug(`After step — buttons: ${postSnap.join(' | ')}`);
      } catch {
        debug('(page still loading after step...)');
      }

      // In record mode: overlap narration delay with BC load time
      if (!isInvestigate) {
        const delay = options?.stepDelays?.get(i) ?? NAV_DELAY_MS;
        const elapsed = Date.now() - stepStartTime;
        const remaining = Math.max(0, delay - elapsed);
        if (remaining > 0) {
          await page.waitForTimeout(remaining);
        }
        debug(
          `Step timing: ${elapsed}ms elapsed (BC load), ${remaining}ms extra wait, ${delay}ms target`,
        );
      }

      const stepEndMs = Date.now() - videoStartMs;
      timingSteps.push({ stepIndex: i, startMs: stepStartMs, endMs: stepEndMs });
    }

    if (!isInvestigate) {
      // Final delay so the video captures the end state
      debug('Recording complete, capturing final state...');
      await page.waitForTimeout(END_DELAY_MS);
    }

    // Build timing metadata
    timing = { trimStartMs, steps: timingSteps };

    if (!isInvestigate) {
      // Save timing JSON for --skip-record reuse
      const timingPath = resolve(outputDir, `${specName}.timing.json`);
      writeFileSync(timingPath, JSON.stringify(timing, null, 2));
      debug(`Timing saved: ${timingPath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Player error: ${message}`);
    if (!isInvestigate) {
      const videoPath = await page.video()?.path();
      await context.close();
      await browser.close();
      if (videoPath) {
        const finalPath = resolve(outputDir, `${specName}.webm`);
        copyFileSync(videoPath, finalPath);
      }
    } else {
      // Pad discoveries to match step count so enricher can map them 1:1
      while (discoveries.length < recording.steps.length) {
        discoveries.push({ fieldFound: false });
      }
      await context.close();
      await browser.close();
    }
    return { success: false, error: message, discoveries: isInvestigate ? discoveries : undefined };
  }

  // In investigate mode: clean up and return discoveries
  if (isInvestigate) {
    await context.close();
    await browser.close();
    info(`Investigation complete — ${discoveries.length} steps analyzed`);
    return { success: true, discoveries };
  }

  // Save video with proper name
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  if (videoPath) {
    const finalPath = resolve(outputDir, `${specName}.webm`);
    copyFileSync(videoPath, finalPath);
    info(`Video saved: ${parsePath(finalPath).base}`);
    return { success: true, videoPath: finalPath, timing };
  }

  return { success: false, error: 'No video was recorded' };
}

async function scrollFieldToCenter(frame: Frame, page: Page, fieldName: string): Promise<void> {
  const viewportWidth = 1920;
  const viewportHeight = 1080;
  const comfortZoneTop = viewportHeight * 0.25;
  const comfortZoneBottom = viewportHeight * 0.75;
  const comfortZoneLeft = viewportWidth * 0.1;
  const comfortZoneRight = viewportWidth * 0.9;

  const result = await frame.evaluate(
    ({ name, zoneTop, zoneBottom, zoneLeft, zoneRight }) => {
      // Find the field element in BC DOM.
      // NOTE: This duplicates strategies from findFieldInFrame() because
      // we need find + scroll in a single evaluate() round-trip. When
      // adding new strategies, update findFieldInFrame() as the canonical list.
      // Prefers the LAST visible match (edit-mode elements come last in DOM).
      function findField(): Element | null {
        function visible(el: Element) {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        // Strategy 1: BC grid cell — td[controlname] contains the input
        let last: Element | null = null;
        for (const td of document.querySelectorAll(`td[controlname="${name}"]`)) {
          const input = td.querySelector(
            'input, textarea, select, [role="textbox"], [role="combobox"]',
          );
          if (input && visible(input)) last = input;
          else if (visible(td)) last = td;
        }
        if (last) return last;
        // Strategy 2: Exact aria-label match
        for (const el of document.querySelectorAll(`[aria-label="${name}"]`)) {
          if (visible(el)) last = el;
        }
        if (last) return last;
        // Strategy 3: Input elements with substring aria-label match
        for (const el of document.querySelectorAll(
          'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
        )) {
          if (el.getAttribute('aria-label')?.includes(name)) {
            if (visible(el)) last = el;
          }
        }
        if (last) return last;
        // Strategy 4: Substring aria-label — pick shortest label (most specific), last of those
        const candidates: Element[] = [];
        for (const el of document.querySelectorAll(`[aria-label*="${name}"]`)) {
          if (el.getAttribute('aria-label')?.startsWith('Open menu for')) continue;
          if (visible(el)) candidates.push(el);
        }
        if (candidates.length > 0) {
          const minLen = Math.min(
            ...candidates.map((c) => c.getAttribute('aria-label')?.length ?? 0),
          );
          const shortest = candidates.filter(
            (c) => (c.getAttribute('aria-label')?.length ?? 0) === minLen,
          );
          return shortest[shortest.length - 1];
        }
        // Strategy 5: Title attribute match (skip "Open Menu" links)
        for (const el of document.querySelectorAll(`[title*="${name}"]`)) {
          if (el.getAttribute('title') === 'Open Menu') continue;
          if (visible(el)) last = el;
        }
        return last;
      }

      const el = findField();
      if (!el) return { found: false } as const;

      const elRect = (el as HTMLElement).getBoundingClientRect();
      const elCenterX = elRect.left + elRect.width / 2;
      const elCenterY = elRect.top + elRect.height / 2;

      const needsVertical = elCenterY < zoneTop || elCenterY > zoneBottom;
      const needsHorizontal = elCenterX < zoneLeft || elCenterX > zoneRight;

      if (!needsVertical && !needsHorizontal) {
        return {
          found: true,
          scrolledV: false,
          scrolledH: false,
          fieldX: Math.round(elCenterX),
          fieldY: Math.round(elCenterY),
          needsH: false,
          needsV: false,
        };
      }

      // Walk up to find scrollable ancestors for each axis
      let vScrollParent: Element | null = null;
      let hScrollParent: Element | null = null;
      let ancestor: Element | null = el.parentElement;
      while (ancestor && (!vScrollParent || !hScrollParent)) {
        const style = window.getComputedStyle(ancestor);
        if (
          !vScrollParent &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          ancestor.scrollHeight > ancestor.clientHeight
        ) {
          vScrollParent = ancestor;
        }
        if (
          !hScrollParent &&
          (style.overflowX === 'auto' ||
            style.overflowX === 'scroll' ||
            style.overflowX === 'hidden') &&
          ancestor.scrollWidth > ancestor.clientWidth
        ) {
          hScrollParent = ancestor;
        }
        ancestor = ancestor.parentElement;
      }

      let scrolledV = false;
      let scrolledH = false;

      // Vertical scroll
      if (needsVertical && vScrollParent) {
        const parentRect = vScrollParent.getBoundingClientRect();
        const elCenterInContainer =
          elRect.top - parentRect.top + vScrollParent.scrollTop + elRect.height / 2;
        const targetScrollTop = elCenterInContainer - vScrollParent.clientHeight / 2;
        vScrollParent.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        scrolledV = true;
      }

      // Horizontal scroll — use direct scrollLeft assignment (scrollTo with
      // behavior:'smooth' silently fails on overflow:hidden containers in Chromium).
      // BC grids have paired header/data scroll containers under a common
      // ms-nav-grid-horizontal-container; scroll ALL children so they stay in sync.
      if (needsHorizontal && hScrollParent) {
        const parentRect = hScrollParent.getBoundingClientRect();
        const elCenterInContainer =
          elRect.left - parentRect.left + hScrollParent.scrollLeft + elRect.width / 2;
        const targetScrollLeft = Math.max(0, elCenterInContainer - hScrollParent.clientWidth / 2);

        // Find the BC grid container ancestor that holds header + data scroll children
        let gridContainer: Element | null = null;
        let walk: Element | null = hScrollParent;
        while (walk) {
          if (walk.classList?.contains('ms-nav-grid-horizontal-container')) {
            gridContainer = walk;
            break;
          }
          walk = walk.parentElement;
        }

        if (gridContainer) {
          // Scroll descendant DIVs that are actual scroll containers (not tiny
          // TH/TD/BUTTON cells). The scrollable divs may be nested inside
          // ms-nav-grid-vertical-container wrappers, so direct children alone
          // aren't enough. Filter to DIVs with meaningful overflow (>50px).
          for (const desc of Array.from(gridContainer.querySelectorAll('div'))) {
            if (desc.scrollWidth - desc.clientWidth > 50) {
              desc.scrollLeft = targetScrollLeft;
            }
          }
        } else {
          // Fallback: scroll the single hScrollParent directly
          hScrollParent.scrollLeft = targetScrollLeft;
        }
        scrolledH = true;
      }

      return {
        found: true,
        scrolledV,
        scrolledH,
        fieldX: Math.round(elCenterX),
        fieldY: Math.round(elCenterY),
        needsH: needsHorizontal,
        needsV: needsVertical,
        hParentFound: !!hScrollParent,
        vParentFound: !!vScrollParent,
      };
    },
    {
      name: fieldName,
      zoneTop: comfortZoneTop,
      zoneBottom: comfortZoneBottom,
      zoneLeft: comfortZoneLeft,
      zoneRight: comfortZoneRight,
    },
  );

  if (result && !('found' in result && !result.found)) {
    debug(
      `Scroll-to-center: field "${fieldName}" at (${result.fieldX}, ${result.fieldY}), needsH=${result.needsH}, needsV=${result.needsV}, hParentFound=${result.hParentFound}, vParentFound=${result.vParentFound}`,
    );
  } else {
    debug(`Scroll-to-center: field "${fieldName}" NOT FOUND in DOM`);
  }

  if (result?.scrolledV) {
    debug(`Scroll-to-center: centering "${fieldName}" vertically`);
  }
  if (result?.scrolledH) {
    debug(`Scroll-to-center: centering "${fieldName}" horizontally`);
  }
  if (result?.scrolledV || result?.scrolledH) {
    await page.waitForTimeout(500);
  }
}

/**
 * Tries to find a BC field by name and animate the cursor to it.
 * Returns true if the cursor was moved, false if the field wasn't found or visible.
 */
async function animateCursorToField(frame: Frame, page: Page, fieldName: string): Promise<boolean> {
  const fieldBox = await findFieldInFrame(frame, fieldName);

  if (fieldBox) {
    debug(
      `Cursor -> field "${fieldName}" at (${fieldBox.x}, ${fieldBox.y}) [${fieldBox.strategy}]`,
    );
    await cursorClickAt(page, frame, fieldBox.x, fieldBox.y);
    return true;
  }
  return false;
}

/**
 * Clicks the assist-edit "..." button on a BC field.  The workflow:
 * 1. Locate the field by its caption label (reuses field-finding strategies).
 * 2. Click the field value cell so BC reveals the assist-edit dots.
 * 3. Find and click the "..." button that appeared next to the value.
 */
async function clickAssistEdit(frame: Frame, page: Page, fieldCaption: string): Promise<void> {
  debug(`Assist-edit: locating field "${fieldCaption}"...`);

  // Expand FastTab / Show More if the field is hidden
  await prepareFieldAccess(frame, page, fieldCaption);
  await scrollFieldToCenter(frame, page, fieldCaption);

  // Step 1: Find the field value element and click it to give it focus.
  // This makes BC render the assist-edit button.
  const fieldBox = await findFieldInFrame(frame, fieldCaption);

  if (!fieldBox) {
    info(`  WARNING: Assist-edit — could not find field "${fieldCaption}"`);
    return;
  }

  // Animate cursor to field and click to give it focus
  debug(`Assist-edit: clicking field value at (${fieldBox.x}, ${fieldBox.y})`);
  await cursorClickAt(page, frame, fieldBox.x, fieldBox.y);
  await frame.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    el?.click();
  }, fieldBox);
  await page.waitForTimeout(600);

  // Step 2: Now find and click the assist-edit "..." button.
  // BC renders it as an <a> with class "icon-MoreEllipsis ms-nav-lookupbutton-embedded"
  // and aria-label "Choose a value for <FieldName>".  No visible text — icon only.
  const assistBtn = await frame.evaluate((name: string) => {
    function center(el: Element) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    // Strategy 1: Element with aria-label "Choose a value for <FieldName>"
    for (const el of document.querySelectorAll(
      `[aria-label*="Choose a value for ${name}"], [aria-label*="choose a value for ${name}"]`,
    )) {
      const c = center(el);
      if (c) return c;
    }

    // Strategy 2: Lookup button class near a field matching the name
    for (const el of document.querySelectorAll(`[aria-label*="${name}"]`)) {
      const parent = el.parentElement;
      if (!parent) continue;
      for (const sib of parent.querySelectorAll(
        '[class*="lookupbutton"], [class*="MoreEllipsis"]',
      )) {
        const c = center(sib);
        if (c) return c;
      }
    }

    // Strategy 3: Any visible lookup button near the active element
    const active = document.activeElement as HTMLElement | null;
    if (active) {
      const parent = active.parentElement;
      if (parent) {
        for (const sib of parent.querySelectorAll(
          '[class*="lookupbutton"], [class*="MoreEllipsis"], [role="button"]',
        )) {
          if (sib === active) continue;
          const ariaLabel = sib.getAttribute('aria-label')?.toLowerCase() ?? '';
          const title = sib.getAttribute('title')?.toLowerCase() ?? '';
          if (
            ariaLabel.includes('choose a value') ||
            title.includes('choose a value') ||
            sib.classList.contains('icon-MoreEllipsis') ||
            sib.className?.toString().includes('lookupbutton')
          ) {
            const c = center(sib);
            if (c) return c;
          }
        }
      }
    }

    return null;
  }, fieldCaption);

  if (assistBtn) {
    debug(`Assist-edit: clicking "..." button at (${assistBtn.x}, ${assistBtn.y})`);
    await cursorClickAt(page, frame, assistBtn.x, assistBtn.y);
    await frame.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      el?.click();
    }, assistBtn);
  } else {
    info(`  WARNING: Assist-edit — could not find "..." button for "${fieldCaption}"`);
    // Fallback: try keyboard shortcut (F6 or Ctrl+F6 opens assist edit in some BC versions)
    debug('Assist-edit: trying F6 keyboard fallback');
    await page.keyboard.press('F6');
  }
}

/**
 * Clicks on a specific row in a BC list grid. BC renders lists as
 * grids with role="grid" containing role="row" elements. The first
 * clickable cell (usually a link) in the data row opens the record.
 *
 * When a modal dialog is open, searches within the dialog first.
 */
async function clickBCRow(frame: Frame, rowTarget: number | string, page?: Page): Promise<void> {
  debug(
    `Clicking row ${typeof rowTarget === 'string' ? `"${rowTarget}"` : rowTarget} in list grid...`,
  );

  // Animate cursor to the target row
  if (page) {
    const rowBox = await frame.evaluate((target: number | string) => {
      // Prefer the topmost modal dialog that contains a data grid
      function getScope(): Element {
        const dialogs = document.querySelectorAll(
          '[role="dialog"], [class*="ms-nav-popup"], [class*="modal-dialog"]',
        );
        for (let i = dialogs.length - 1; i >= 0; i--) {
          const d = dialogs[i] as HTMLElement;
          if (
            d.offsetWidth > 0 &&
            d.offsetHeight > 0 &&
            !d.className?.includes('TeachingBubble') &&
            d.querySelector('table, [role="grid"]')
          )
            return d;
        }
        return document.body;
      }
      const scope = getScope();

      // Reverse iteration: edit-mode grid comes last in DOM order
      function getDataRows(): Element[] {
        const tables = Array.from(
          scope.querySelectorAll(
            'table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]',
          ),
        );
        for (let i = tables.length - 1; i >= 0; i--) {
          const rows = Array.from(tables[i].querySelectorAll('tbody > tr, tr[role="row"]'));
          const data = rows.filter(
            (r) =>
              !r.querySelector('th') &&
              !r.querySelector('[role="columnheader"]') &&
              r.querySelector('td') &&
              Array.from(r.querySelectorAll('td')).some((c) =>
                (c as HTMLElement).textContent?.trim(),
              ),
          );
          if (data.length > 0) return data;
        }
        const grids = Array.from(scope.querySelectorAll('[role="grid"]'));
        for (let i = grids.length - 1; i >= 0; i--) {
          const rows = Array.from(grids[i].querySelectorAll('[role="row"]'));
          const data = rows.filter(
            (r) =>
              !r.querySelector('[role="columnheader"]') &&
              Array.from(r.querySelectorAll('[role="gridcell"]')).some((c) =>
                (c as HTMLElement).textContent?.trim(),
              ),
          );
          if (data.length > 0) return data;
        }
        return [];
      }

      const rows = getDataRows();
      const row =
        typeof target === 'number'
          ? (rows[target - 1] ?? null)
          : (rows.find((r) => {
              const search = target.toLowerCase();
              return Array.from(r.querySelectorAll('td, [role="gridcell"]')).some((c) =>
                (c.textContent?.trim().toLowerCase() ?? '').includes(search),
              );
            }) ?? null);
      if (!row) return null;

      const link = row.querySelector('a');
      const el = link ?? row.querySelector('td') ?? row;
      const rect = (el as HTMLElement).getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width * 0.3, 40), y: rect.y + rect.height / 2 };
    }, rowTarget);

    if (rowBox) {
      await cursorClickAt(page, frame, rowBox.x, rowBox.y);
    }
  }

  // Actually click the row
  const clicked = await frame.evaluate((target: number | string) => {
    function getScope(): Element {
      const dialogs = document.querySelectorAll(
        '[role="dialog"], [class*="ms-nav-popup"], [class*="modal-dialog"]',
      );
      for (let i = dialogs.length - 1; i >= 0; i--) {
        const d = dialogs[i] as HTMLElement;
        if (
          d.offsetWidth > 0 &&
          d.offsetHeight > 0 &&
          !d.className?.includes('TeachingBubble') &&
          d.querySelector('table, [role="grid"]')
        )
          return d;
      }
      return document.body;
    }
    const scope = getScope();

    // When BC enters edit mode, duplicate grids appear in the DOM.
    // The edit-mode grid comes LAST in document order. Iterate in
    // reverse so we pick the topmost (edit-mode) grid.
    function getDataRows(): Element[] {
      const tables = Array.from(
        scope.querySelectorAll(
          'table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]',
        ),
      );
      for (let i = tables.length - 1; i >= 0; i--) {
        const rows = Array.from(tables[i].querySelectorAll('tbody > tr, tr[role="row"]'));
        const data = rows.filter(
          (r) =>
            !r.querySelector('th') &&
            !r.querySelector('[role="columnheader"]') &&
            r.querySelector('td') &&
            Array.from(r.querySelectorAll('td')).some((c) =>
              (c as HTMLElement).textContent?.trim(),
            ),
        );
        if (data.length > 0) return data;
      }
      const grids = Array.from(scope.querySelectorAll('[role="grid"]'));
      for (let i = grids.length - 1; i >= 0; i--) {
        const rows = Array.from(grids[i].querySelectorAll('[role="row"]'));
        const data = rows.filter(
          (r) =>
            !r.querySelector('[role="columnheader"]') &&
            Array.from(r.querySelectorAll('[role="gridcell"]')).some((c) =>
              (c as HTMLElement).textContent?.trim(),
            ),
        );
        if (data.length > 0) return data;
      }
      return [];
    }

    const rows = getDataRows();
    const row =
      typeof target === 'number'
        ? (rows[target - 1] ?? null)
        : (rows.find((r) => {
            const search = target.toLowerCase();
            return Array.from(r.querySelectorAll('td, [role="gridcell"]')).some((c) =>
              (c.textContent?.trim().toLowerCase() ?? '').includes(search),
            );
          }) ?? null);
    if (!row) return null;

    const link = row.querySelector('a');
    if (link) {
      (link as HTMLElement).click();
      return `clicked link: ${link.textContent?.trim()}`;
    }
    const cell = row.querySelector('td');
    if (cell) {
      (cell as HTMLElement).click();
      return `clicked cell: ${cell.textContent?.trim()}`;
    }
    return null;
  }, rowTarget);

  if (clicked) {
    debug(clicked);
  } else {
    info(
      `  WARNING: Could not find data row ${typeof rowTarget === 'string' ? `"${rowTarget}"` : rowTarget} in any grid`,
    );
  }
}

/**
 * Attempts to click a BC action/button by caption text using Playwright.
 * Tries multiple strategies since BC renders actions as various element types.
 */
async function clickBCAction(frame: Frame, page: Page, caption: string): Promise<boolean> {
  // Strategy 0: If a modal dialog is open, search inside it first.
  // BC renders dialogs after the main content, so unscoped .first() picks the wrong element.
  const dialogLocator = frame.locator(
    '[role="dialog"]:visible:not([class*="TeachingBubble"]), [class*="ms-nav-popup"]:visible',
  );
  const hasDialog = (await dialogLocator.count()) > 0;
  if (hasDialog) {
    const dialog = dialogLocator.last(); // topmost non-tooltip dialog
    for (const role of ['button', 'menuitem', 'link'] as const) {
      const loc = dialog.getByRole(role, { name: caption, exact: true });
      if ((await loc.count()) > 0) {
        debug(`Clicking [${role}] "${caption}" (in dialog)`);
        await animateCursorToLocator(page, frame, loc);
        await loc.first().click();
        return true;
      }
    }
    // Also try text match inside dialog
    const dialogText = dialog.getByText(caption, { exact: true });
    if ((await dialogText.count()) > 0) {
      debug(`Clicking text "${caption}" (in dialog)`);
      await animateCursorToLocator(page, frame, dialogText);
      await dialogText.first().click();
      return true;
    }
  }

  // If this is a common dialog button (OK, Cancel, etc.) and no dialog was found above,
  // don't fall through to the main page — the dialog was likely already closed.
  const DIALOG_BUTTONS = ['ok', 'cancel', 'close', 'yes', 'no'];
  if (hasDialog === false && DIALOG_BUTTONS.includes(caption.toLowerCase())) {
    debug(`"${caption}" looks like a dialog button but no dialog is open — skipping`);
    return true; // Return true to avoid fallback/warning — the dialog already closed
  }

  // When BC enters edit mode, it renders duplicate buttons/menuitems.
  // The edit-mode versions come last in DOM order → use .last() to
  // target the topmost (interactive) instance.

  // Strategy 1: Exact match button/menuitem by accessible name
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption, exact: true });
    if ((await locator.count()) > 0) {
      debug(`Clicking [${role}] "${caption}"`);
      await animateCursorToLocator(page, frame, locator.last());
      await locator.last().click();
      return true;
    }
  }

  // Strategy 2: Partial text match (caption might be part of a longer label)
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption });
    if ((await locator.count()) > 0) {
      debug(`Clicking [${role}] containing "${caption}" (partial match)`);
      await animateCursorToLocator(page, frame, locator.last());
      await locator.last().click();
      return true;
    }
  }

  // Strategy 3: CSS text content match (broad — catches action bar items)
  const textLocator = frame.locator(
    `button:has-text("${caption}"), [role="button"]:has-text("${caption}"), [role="menuitem"]:has-text("${caption}"), a:has-text("${caption}"), span:has-text("${caption}")`,
  );
  if ((await textLocator.count()) > 0) {
    debug(`Clicking element containing text "${caption}"`);
    await animateCursorToLocator(page, frame, textLocator.last());
    await textLocator.last().click();
    return true;
  }

  // Strategy 4: getByText — finds any visible text match in the frame
  const byText = frame.getByText(caption, { exact: true });
  if ((await byText.count()) > 0) {
    debug(`Clicking text "${caption}" (getByText)`);
    await animateCursorToLocator(page, frame, byText.last());
    await byText.last().click();
    return true;
  }

  // Strategy 5: Try the main page (not just the frame) — some actions are in the top bar
  const pageLocator = page.locator(
    `button:has-text("${caption}"), [role="button"]:has-text("${caption}")`,
  );
  if ((await pageLocator.count()) > 0) {
    debug(`Clicking top-bar element "${caption}"`);
    await cursorClickLocator(page, pageLocator);
    await pageLocator.first().click();
    return true;
  }

  debug(`Could not find "${caption}" in any strategy`);
  return false;
}

/**
 * Animates the cursor to a Playwright locator. boundingBox() returns
 * page-level coordinates already, so we animate directly — no iframe offset.
 */
async function animateCursorToLocator(
  page: Page,
  _frame: Frame,
  locator: import('playwright').Locator,
): Promise<void> {
  try {
    const box = await locator.first().boundingBox();
    if (box) {
      await animateCursorTo(page, box.x + box.width / 2, box.y + box.height / 2);
    }
  } catch {
    // Element might not be visible — skip cursor animation
  }
}

/**
 * Waits for BC's execution context to be idle in both the main page
 * and the iframe, then returns the BC iframe. Matches bc-replay's
 * awaitFrame() logic exactly.
 */
async function awaitBCFrame(page: Page, timeout = NAV_TIMEOUT_MS): Promise<Frame> {
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
      if (frames.length > 1) {
        const frameIdle = await frames[1]
          .evaluate(() => {
            const DN = (window as unknown as Record<string, unknown>)['DN'] as
              | { ExecutionContext?: { Instance?: { IsIdle?: () => boolean } } }
              | undefined;
            return DN?.ExecutionContext?.Instance?.IsIdle?.() ?? false;
          })
          .catch(() => false);
        if (frameIdle) return frames[1];
      }
    }

    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for BC to become idle');
}
