import { chromium, type Page, type Frame } from 'playwright';
import { readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve, parse as parsePath } from 'path';
import { DemoConfig } from './config.js';

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
const END_DELAY_MS = 3000;
const NAV_TIMEOUT_MS = 120_000;

export async function playDemo(specPath: string, config: DemoConfig, options?: PlayOptions): Promise<PlayResult> {
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  let timing: StepTimingMetadata | undefined;

  try {
    // Navigate to BC
    console.log(`Navigating to: ${bcUrl.toString()}`);
    await page.goto(bcUrl.toString());
    const videoStartMs = Date.now();

    // Authenticate
    if (config.bcAuth === 'UserPassword' && config.bcUsernameKey && config.bcPasswordKey) {
      const username = process.env[config.bcUsernameKey];
      const password = process.env[config.bcPasswordKey] ?? '';
      if (username) {
        console.log(`Authenticating as: ${username}`);
        await page.fill('input[name=UserName]', username);
        await page.fill('input[name=Password]', password);
        await Promise.all([
          page.click('button[type=submit]', { timeout: NAV_TIMEOUT_MS }),
          page.waitForNavigation({ timeout: NAV_TIMEOUT_MS }),
        ]);
      }
    }

    // Wait for BC to be ready (matching bc-replay's awaitFrame approach)
    console.log('Waiting for BC to load...');
    await page.waitForTimeout(200); // Same 200ms delay as bc-replay
    const frame = await awaitBCFrame(page);
    const authCompleteMs = Date.now();
    console.log('BC is ready');

    const timingSteps: StepTimingEntry[] = [];

    // Log step info
    for (let i = 0; i < recording.steps.length; i++) {
      const step = recording.steps[i];
      console.log(`  Step ${i + 1}: [${step.type}] ${step.description ?? step.caption ?? ''}`);
    }

    // Take a snapshot to see what's on the page
    const snapshot = await frame.evaluate(() => {
      // Collect all buttons and actions visible on the page
      const buttons: string[] = [];
      document.querySelectorAll('button, [role="button"], [role="menuitem"], a[tabindex]').forEach(el => {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length < 80) buttons.push(text);
      });
      return { buttons: buttons.slice(0, 30), title: document.title };
    });
    console.log(`Page title: ${snapshot.title}`);
    console.log(`Available buttons/actions: ${snapshot.buttons.join(' | ')}`);

    // Debug: inspect grid/table structure
    const gridInfo = await frame.evaluate(() => {
      const info: string[] = [];
      // Check for grids
      document.querySelectorAll('[role="grid"]').forEach((g, gi) => {
        info.push(`grid[${gi}]: ${(g as HTMLElement).getAttribute('aria-label') || g.className.slice(0, 50)}`);
        const rows = g.querySelectorAll('[role="row"]');
        info.push(`  rows: ${rows.length}`);
        rows.forEach((r, ri) => {
          if (ri < 3) {
            const cells = r.querySelectorAll('[role="gridcell"], [role="columnheader"]');
            const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim().slice(0, 30)).filter(Boolean);
            info.push(`  row[${ri}]: ${texts.join(' | ')}`);
          }
        });
      });
      // Check for tables
      document.querySelectorAll('table').forEach((t, ti) => {
        info.push(`table[${ti}]: rows=${t.rows.length}, class=${t.className.slice(0, 50)}`);
      });
      // Check for any clickable links in the main content area
      const links = document.querySelectorAll('a[href], a[tabindex]');
      const linkTexts: string[] = [];
      links.forEach(l => {
        const text = (l as HTMLElement).innerText?.trim();
        if (text && text.length < 60 && text.length > 0) linkTexts.push(text);
      });
      if (linkTexts.length) info.push(`links: ${linkTexts.slice(0, 20).join(' | ')}`);
      return info;
    });
    console.log('DOM structure:');
    gridInfo.forEach(line => console.log(`  ${line}`));

    // Execute each step using Playwright clicks with delays
    for (let i = 0; i < recording.steps.length; i++) {
      const step = recording.steps[i];
      const stepStartMs = Date.now() - videoStartMs;
      console.log(`\nStep ${i + 1}/${recording.steps.length}: [${step.type}] ${step.description ?? step.caption ?? ''}`);

      const currentFrame = await awaitBCFrame(page, 10_000).catch(() => frame);

      if (step.type === 'action' && step.row) {
        // Click on a specific row in the list grid
        await clickBCRow(currentFrame, step.row);
      } else if (step.type === 'action' && step.caption) {
        // Click a button/action by caption text
        const clicked = await clickBCAction(currentFrame, page, step.caption);
        if (!clicked) {
          console.log(`  WARNING: Could not find "${step.caption}" — falling back to DN.playRecording`);
          const singleStep = { ...recording, steps: [step] };
          await currentFrame.evaluate((data) => {
            const DN = (window as unknown as Record<string, unknown>)['DN'] as Record<string, Function>;
            return DN['playRecording'](data);
          }, singleStep as unknown);
        }
      } else if (step.type === 'input' && step.value) {
        const fieldName = step.target?.find(t => t.field)?.field;
        console.log(`  Filling field "${fieldName}" with "${step.value}"`);
        const singleStep = { ...recording, steps: [step] };
        await currentFrame.evaluate((data) => {
          const DN = (window as unknown as Record<string, unknown>)['DN'] as Record<string, Function>;
          return DN['playRecording'](data);
        }, singleStep as unknown);
      }

      // Wait for any navigation/rendering triggered by the click
      await page.waitForTimeout(1500);
      try {
        const postFrame = await awaitBCFrame(page, 15_000);
        // Log what's on the page after this step
        const postSnap = await postFrame.evaluate(() => {
          const btns: string[] = [];
          document.querySelectorAll('button, [role="button"], [role="menuitem"]').forEach(el => {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.length > 0 && text.length < 60) btns.push(text);
          });
          return btns.slice(0, 25);
        });
        console.log(`  After step — buttons: ${postSnap.join(' | ')}`);
      } catch {
        console.log('  (page still loading after step...)');
      }

      // Delay between steps — use dynamic delay if provided, otherwise default
      const delay = options?.stepDelays?.get(i) ?? NAV_DELAY_MS;
      await page.waitForTimeout(delay);

      const stepEndMs = Date.now() - videoStartMs;
      timingSteps.push({ stepIndex: i, startMs: stepStartMs, endMs: stepEndMs });
    }

    // Final delay so the video captures the end state
    console.log('Recording complete, capturing final state...');
    await page.waitForTimeout(END_DELAY_MS);

    // Build timing metadata
    const trimStartMs = Math.max(0, (authCompleteMs - videoStartMs) - 1000);
    timing = { trimStartMs, steps: timingSteps };

    // Save timing JSON for --skip-record reuse
    const timingPath = resolve(outputDir, `${specName}.timing.json`);
    writeFileSync(timingPath, JSON.stringify(timing, null, 2));
    console.log(`Timing saved: ${timingPath}`);

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
    console.log(`Video saved: ${finalPath}`);
    return { success: true, videoPath: finalPath, timing };
  }

  return { success: false, error: 'No video was recorded' };
}

/**
 * Clicks on a specific row in a BC list grid. BC renders lists as
 * grids with role="grid" containing role="row" elements. The first
 * clickable cell (usually a link) in the data row opens the record.
 */
async function clickBCRow(frame: Frame, rowNumber: number): Promise<void> {
  console.log(`  Clicking row ${rowNumber} in list grid...`);

  // BC grids use: div[role="grid"] > table.ms-nav-grid-data-table > tbody > tr
  // The header table comes first, then the data table.
  const clicked = await frame.evaluate((targetRow: number) => {
    // Strategy 1: Find the data table inside a BC grid container
    const dataTables = document.querySelectorAll('table.ms-nav-grid-data-table, table[class*="ms-nav-grid"][class*="data"]');
    for (const table of dataTables) {
      const rows = table.querySelectorAll('tbody > tr, tr[role="row"]');
      const row = rows[targetRow - 1]; // 1-indexed
      if (!row) continue;

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
    }

    // Strategy 2: Find data rows in role="grid" with role="row" (non-header)
    const grids = document.querySelectorAll('[role="grid"]');
    for (const grid of grids) {
      const allRows = grid.querySelectorAll('[role="row"]');
      const dataRows = Array.from(allRows).filter(
        r => !r.querySelector('[role="columnheader"]')
      );
      const row = dataRows[targetRow - 1];
      if (!row) continue;

      const link = row.querySelector('a');
      if (link) {
        (link as HTMLElement).click();
        return `clicked link: ${link.textContent?.trim()}`;
      }
      (row as HTMLElement).click();
      return `clicked row element`;
    }

    return null;
  }, rowNumber);

  if (clicked) {
    console.log(`  ${clicked}`);
  } else {
    console.log(`  WARNING: Could not find row ${rowNumber} in any grid`);
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
    if (await locator.count() > 0) {
      console.log(`  Clicking [${role}] "${caption}"`);
      await locator.first().click();
      return true;
    }
  }

  // Strategy 2: Partial text match (caption might be part of a longer label)
  for (const role of ['button', 'menuitem', 'link'] as const) {
    const locator = frame.getByRole(role, { name: caption });
    if (await locator.count() > 0) {
      console.log(`  Clicking [${role}] containing "${caption}" (partial match)`);
      await locator.first().click();
      return true;
    }
  }

  // Strategy 3: CSS text content match
  const textLocator = frame.locator(`button:has-text("${caption}"), [role="button"]:has-text("${caption}"), [role="menuitem"]:has-text("${caption}")`);
  if (await textLocator.count() > 0) {
    console.log(`  Clicking element containing text "${caption}"`);
    await textLocator.first().click();
    return true;
  }

  // Strategy 4: Try the main page (not just the frame) — some actions are in the top bar
  const pageLocator = page.locator(`button:has-text("${caption}"), [role="button"]:has-text("${caption}")`);
  if (await pageLocator.count() > 0) {
    console.log(`  Clicking top-bar element "${caption}"`);
    await pageLocator.first().click();
    return true;
  }

  console.log(`  Could not find "${caption}" in any strategy`);
  return false;
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
      const ns = (window as unknown as Record<string, unknown>);
      const namespace = (ns['BC'] ?? ns['DN']) as { ExecutionContext?: { Instance?: { IsIdle?: () => boolean } } } | undefined;
      return namespace?.ExecutionContext?.Instance?.IsIdle?.() ?? false;
    });

    if (isIdle) {
      const frames = page.frames();
      if (frames.length > 1) {
        const frameIdle = await frames[1].evaluate(() => {
          const DN = (window as unknown as Record<string, unknown>)['DN'] as { ExecutionContext?: { Instance?: { IsIdle?: () => boolean } } } | undefined;
          return DN?.ExecutionContext?.Instance?.IsIdle?.() ?? false;
        }).catch(() => false);
        if (frameIdle) return frames[1];
      }
    }

    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for BC to become idle');
}
