import { chromium, type Page, type Frame } from 'playwright';
import { readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve, parse as parsePath } from 'path';
import { DemoConfig } from './config.js';
import { injectCursor, cursorClickLocator, cursorClickAt, animateCursorTo } from './cursor.js';
import { info, debug, cleanDescription } from './log.js';

export interface Recording {
  description: string;
  name?: string;
  start?: {
    profile?: string;
    page?: string;
    pageId?: number;
  };
  timeout?: number;
  steps: RecordingStep[];
  demo?: Record<string, unknown>;
}

export interface RecordingStep {
  type: string;
  target: Array<{ page?: string; field?: string }>;
  caption?: string;
  row?: number;
  value?: string;
  description?: string;
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
  error?: string;
}

export interface PlayOptions {
  stepDelays?: Map<number, number>;
}

const NAV_DELAY_MS = 2000;
const END_DELAY_MS = 2000;
const NAV_TIMEOUT_MS = 120_000;

export async function playDemo(
  specPath: string,
  config: DemoConfig,
  options?: PlayOptions,
): Promise<PlayResult> {
  const absoluteSpecPath = resolve(specPath);
  const specContent = readFileSync(absoluteSpecPath, 'utf-8');
  const recording: Recording = parseYaml(specContent);
  const specName = parsePath(absoluteSpecPath).name;

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

  const browser = await chromium.launch({ headless: !config.headed });

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

  // --- Phase B: Record in a fresh context with video enabled ---
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: outputDir, size: { width: 1920, height: 1080 } },
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  let timing: StepTimingMetadata | undefined;

  try {
    // Navigate to the same URL — cookies skip the login, lands directly on the BC page
    await page.goto(authenticatedUrl);
    const videoStartMs = Date.now();

    // Wait for BC to be ready in the recording context (skips "Getting Ready" screen)
    await page.waitForTimeout(200);
    const frame = await awaitBCFrame(page);
    const bcReadyMs = Date.now();
    await injectCursor(page);
    // Brief pause so the first frame of the trimmed video shows the loaded page
    await page.waitForTimeout(500);
    const trimStartMs = bcReadyMs - videoStartMs;
    info(`BC loaded (trimming ${(trimStartMs / 1000).toFixed(1)}s of loading screen)`);

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

    // Execute each step using Playwright clicks with delays
    for (let i = 0; i < recording.steps.length; i++) {
      const step = recording.steps[i];
      const stepStartTime = Date.now();
      const stepStartMs = stepStartTime - videoStartMs;
      const stepDesc = cleanDescription(step.description ?? step.caption ?? '');
      info(`[${i + 1}/${recording.steps.length}] ${stepDesc}`);

      const currentFrame = await awaitBCFrame(page, 10_000).catch(() => frame);

      if (step.type === 'action' && step.row) {
        // Click on a specific row in the list grid
        await clickBCRow(currentFrame, step.row, page);
      } else if (step.type === 'action' && step.caption) {
        // Click a button/action by caption text
        let clicked = await clickBCAction(currentFrame, page, step.caption);

        // If not found and the previous step was a menu open, re-open it and retry
        if (!clicked && i > 0) {
          const prevStep = recording.steps[i - 1];
          if (prevStep.type === 'action' && prevStep.caption) {
            debug(`Re-opening menu "${prevStep.caption}" and retrying...`);
            await clickBCAction(currentFrame, page, prevStep.caption);
            await page.waitForTimeout(500); // Wait for dropdown to render

            // Dump all text in the frame to find the element
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
                  own.toLowerCase().includes('more')
                ) {
                  results.push(
                    `<${el.tagName.toLowerCase()} class="${el.className?.toString().slice(0, 40)}" role="${el.getAttribute('role')}">${own}`,
                  );
                }
                if (
                  own &&
                  own.length > 0 &&
                  own.length < 60 &&
                  own.toLowerCase().includes('column')
                ) {
                  results.push(
                    `<${el.tagName.toLowerCase()} class="${el.className?.toString().slice(0, 40)}" role="${el.getAttribute('role')}">${own}`,
                  );
                }
                if (
                  own &&
                  own.length > 0 &&
                  own.length < 60 &&
                  own.toLowerCase().includes('show')
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

        // Animate cursor to the target field so viewers see which field is being edited.
        // BC fields may be in a collapsed FastTab (0x0 rect) until DN.playRecording
        // navigates there, so we try before AND after filling.
        let cursorMoved = false;
        if (fieldName) {
          cursorMoved = await animateCursorToField(currentFrame, page, fieldName);
        }

        const singleStep = { ...recording, steps: [step] };
        await currentFrame.evaluate((data) => {
          const DN = (window as unknown as Record<string, unknown>)['DN'] as Record<
            string,
            (...args: unknown[]) => unknown
          >;
          return DN['playRecording'](data);
        }, singleStep as unknown);

        // After DN.playRecording, BC may have scrolled the field into view but
        // only just barely (at the edge). Try to center it in the viewport.
        if (fieldName) {
          await scrollFieldToCenter(currentFrame, page, fieldName);
        }

        // If the field wasn't visible before filling, animate cursor to the
        // now-focused field so the viewer still sees where data was entered.
        if (!cursorMoved && fieldName) {
          // Brief wait for BC to settle after filling
          await page.waitForTimeout(300);
          const postFrame = await awaitBCFrame(page, 5_000).catch(() => currentFrame);
          cursorMoved = await animateCursorToField(postFrame, page, fieldName);
          if (!cursorMoved) {
            // Last resort: animate to whatever element is currently focused
            const activeBox = await postFrame.evaluate(() => {
              const el = document.activeElement as HTMLElement | null;
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return null;
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            });
            if (activeBox) {
              debug(`Cursor fallback: using focused element`);
              await cursorClickAt(page, postFrame, activeBox.x, activeBox.y);
              cursorMoved = true;
            }
          }
          if (!cursorMoved) {
            debug(`Could not find field "${fieldName}" for cursor animation`);
          }
        }
      }

      // Wait for BC to respond to the click, then wait until idle
      await page.waitForTimeout(500);
      try {
        const postFrame = await awaitBCFrame(page, 15_000);
        // Log what's on the page after this step
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

      // Overlap narration delay with BC load time — only wait the remainder
      const delay = options?.stepDelays?.get(i) ?? NAV_DELAY_MS;
      const elapsed = Date.now() - stepStartTime;
      const remaining = Math.max(0, delay - elapsed);
      if (remaining > 0) {
        await page.waitForTimeout(remaining);
      }
      debug(
        `Step timing: ${elapsed}ms elapsed (BC load), ${remaining}ms extra wait, ${delay}ms target`,
      );

      const stepEndMs = Date.now() - videoStartMs;
      timingSteps.push({ stepIndex: i, startMs: stepStartMs, endMs: stepEndMs });
    }

    // Final delay so the video captures the end state
    debug('Recording complete, capturing final state...');
    await page.waitForTimeout(END_DELAY_MS);

    // Build timing metadata — trim the "Getting Ready" loading screen
    timing = { trimStartMs, steps: timingSteps };

    // Save timing JSON for --skip-record reuse
    const timingPath = resolve(outputDir, `${specName}.timing.json`);
    writeFileSync(timingPath, JSON.stringify(timing, null, 2));
    debug(`Timing saved: ${timingPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Player error: ${message}`);
    const videoPath = await page.video()?.path();
    await context.close();
    await browser.close();
    if (videoPath) {
      const finalPath = resolve(outputDir, `${specName}.webm`);
      copyFileSync(videoPath, finalPath);
    }
    return { success: false, error: message };
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

/**
 * After BC navigates to a field (e.g. via DN.playRecording), the field may be
 * barely in view at the edge of the viewport. This function finds the field,
 * checks if it's outside the middle ~60% of the viewport, and if so scrolls
 * its nearest scrollable ancestor to center it.
 */
async function scrollFieldToCenter(frame: Frame, page: Page, fieldName: string): Promise<void> {
  const viewportHeight = 1080;
  const comfortZoneTop = viewportHeight * 0.25;
  const comfortZoneBottom = viewportHeight * 0.75;

  const result = await frame.evaluate(
    ({ name, zoneTop, zoneBottom }) => {
      // Find the field element
      function findField(): Element | null {
        for (const el of document.querySelectorAll(`[aria-label*="${name}"]`)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return el;
        }
        for (const el of document.querySelectorAll(`[title*="${name}"]`)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return el;
        }
        for (const el of document.querySelectorAll(
          'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
        )) {
          if (el.getAttribute('aria-label')?.includes(name)) {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
          }
        }
        return null;
      }

      const el = findField();
      if (!el) return null;

      const elRect = (el as HTMLElement).getBoundingClientRect();
      const elCenterY = elRect.top + elRect.height / 2;

      // Already in the comfort zone — no scroll needed
      if (elCenterY >= zoneTop && elCenterY <= zoneBottom) {
        return { scrolled: false, fieldY: Math.round(elCenterY) };
      }

      // Walk up to find the nearest scrollable ancestor
      let scrollParent: Element | null = el.parentElement;
      while (scrollParent) {
        const style = window.getComputedStyle(scrollParent);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          scrollParent.scrollHeight > scrollParent.clientHeight
        ) {
          break;
        }
        scrollParent = scrollParent.parentElement;
      }

      if (!scrollParent) return { scrolled: false, fieldY: Math.round(elCenterY) };

      // Scroll so the field ends up at the vertical center of the container
      const parentRect = scrollParent.getBoundingClientRect();
      const elCenterInContainer =
        elRect.top - parentRect.top + scrollParent.scrollTop + elRect.height / 2;
      const targetScrollTop = elCenterInContainer - scrollParent.clientHeight / 2;
      scrollParent.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

      return { scrolled: true, fieldY: Math.round(elCenterY) };
    },
    { name: fieldName, zoneTop: comfortZoneTop, zoneBottom: comfortZoneBottom },
  );

  if (result?.scrolled) {
    debug(`Scroll-to-center: field "${fieldName}" was at y=${result.fieldY}, centering...`);
    await page.waitForTimeout(500);
  }
}

/**
 * Tries to find a BC field by name and animate the cursor to it.
 * Returns true if the cursor was moved, false if the field wasn't found or visible.
 */
async function animateCursorToField(frame: Frame, page: Page, fieldName: string): Promise<boolean> {
  const fieldBox = await frame.evaluate((name: string) => {
    function center(el: Element) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    // Strategy 1: Any element with matching aria-label
    for (const el of document.querySelectorAll(`[aria-label*="${name}"]`)) {
      const c = center(el);
      if (c) return c;
    }

    // Strategy 2: Element with matching title attribute
    for (const el of document.querySelectorAll(`[title*="${name}"]`)) {
      const c = center(el);
      if (c) return c;
    }

    // Strategy 3: Standard inputs + role="textbox" / role="combobox"
    for (const el of document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    )) {
      if (el.getAttribute('aria-label')?.includes(name)) {
        const c = center(el);
        if (c) return c;
      }
    }

    // Strategy 4: Find caption text, target its sibling value element
    for (const cap of document.querySelectorAll('label, [class*="caption"], [class*="Caption"]')) {
      if (cap.textContent?.trim() === name || cap.textContent?.includes(name)) {
        const parent = cap.parentElement;
        if (parent) {
          const ctrl = parent.querySelector(
            'input, textarea, select, [role="textbox"], [role="combobox"], [contenteditable="true"]',
          );
          if (ctrl) {
            const c = center(ctrl);
            if (c) return c;
          }
          const sibling = cap.nextElementSibling;
          if (sibling) {
            const c = center(sibling);
            if (c) return c;
          }
        }
      }
    }

    return null;
  }, fieldName);

  if (fieldBox) {
    debug(`Cursor -> field "${fieldName}" at (${fieldBox.x}, ${fieldBox.y})`);
    await cursorClickAt(page, frame, fieldBox.x, fieldBox.y);
    return true;
  }
  return false;
}

/**
 * Clicks on a specific row in a BC list grid. BC renders lists as
 * grids with role="grid" containing role="row" elements. The first
 * clickable cell (usually a link) in the data row opens the record.
 */
async function clickBCRow(frame: Frame, rowNumber: number, page?: Page): Promise<void> {
  debug(`Clicking row ${rowNumber} in list grid...`);

  // Animate cursor to the first link in the target data row
  if (page) {
    const rowBox = await frame.evaluate((targetRow: number) => {
      // Find data rows, skipping headers (rows with <th> or columnheader)
      function getDataRows(): Element[] {
        const tables = document.querySelectorAll(
          'table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]',
        );
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll('tbody > tr, tr[role="row"]'));
          const data = rows.filter(
            (r) =>
              !r.querySelector('th') &&
              !r.querySelector('[role="columnheader"]') &&
              r.querySelector('td'),
          );
          if (data.length > 0) return data;
        }
        const grids = document.querySelectorAll('[role="grid"]');
        for (const grid of grids) {
          const rows = Array.from(grid.querySelectorAll('[role="row"]'));
          return rows.filter((r) => !r.querySelector('[role="columnheader"]'));
        }
        return [];
      }
      const rows = getDataRows();
      const row = rows[targetRow - 1];
      if (!row) return null;

      const link = row.querySelector('a');
      const el = link ?? row.querySelector('td') ?? row;
      const rect = (el as HTMLElement).getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width * 0.3, 40), y: rect.y + rect.height / 2 };
    }, rowNumber);

    if (rowBox) {
      await cursorClickAt(page, frame, rowBox.x, rowBox.y);
    }
  }

  // Actually click the row — same data-row filtering as cursor positioning
  const clicked = await frame.evaluate((targetRow: number) => {
    function getDataRows(): Element[] {
      const tables = document.querySelectorAll(
        'table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]',
      );
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tbody > tr, tr[role="row"]'));
        const data = rows.filter(
          (r) =>
            !r.querySelector('th') &&
            !r.querySelector('[role="columnheader"]') &&
            r.querySelector('td'),
        );
        if (data.length > 0) return data;
      }
      const grids = document.querySelectorAll('[role="grid"]');
      for (const grid of grids) {
        const rows = Array.from(grid.querySelectorAll('[role="row"]'));
        return rows.filter((r) => !r.querySelector('[role="columnheader"]'));
      }
      return [];
    }
    const rows = getDataRows();
    const row = rows[targetRow - 1];
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
  }, rowNumber);

  if (clicked) {
    debug(clicked);
  } else {
    info(`  WARNING: Could not find data row ${rowNumber} in any grid`);
  }
}

/**
 * Attempts to click a BC action/button by caption text using Playwright.
 * Tries multiple strategies since BC renders actions as various element types.
 */
async function clickBCAction(frame: Frame, page: Page, caption: string): Promise<boolean> {
  // Strategy 1: Exact match button/menuitem by accessible name
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption, exact: true });
    if ((await locator.count()) > 0) {
      debug(`Clicking [${role}] "${caption}"`);
      await animateCursorToLocator(page, frame, locator);
      await locator.first().click();
      return true;
    }
  }

  // Strategy 2: Partial text match (caption might be part of a longer label)
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption });
    if ((await locator.count()) > 0) {
      debug(`Clicking [${role}] containing "${caption}" (partial match)`);
      await animateCursorToLocator(page, frame, locator);
      await locator.first().click();
      return true;
    }
  }

  // Strategy 3: CSS text content match (broad — catches action bar items)
  const textLocator = frame.locator(
    `button:has-text("${caption}"), [role="button"]:has-text("${caption}"), [role="menuitem"]:has-text("${caption}"), a:has-text("${caption}"), span:has-text("${caption}")`,
  );
  if ((await textLocator.count()) > 0) {
    debug(`Clicking element containing text "${caption}"`);
    await animateCursorToLocator(page, frame, textLocator);
    await textLocator.first().click();
    return true;
  }

  // Strategy 4: getByText — finds any visible text match in the frame
  const byText = frame.getByText(caption, { exact: true });
  if ((await byText.count()) > 0) {
    debug(`Clicking text "${caption}" (getByText)`);
    await animateCursorToLocator(page, frame, byText);
    await byText.first().click();
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
