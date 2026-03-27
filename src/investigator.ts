// src/investigator.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, parse as parsePath } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Page } from 'playwright';
import { VisionClient, type PageSurvey } from './vision.js';
import { launchBCSession, closeBCSession, awaitBCFrame } from './browser.js';
import { computeSpecHash, writeScript } from './script-io.js';
import type {
  ScriptFile,
  ScriptStep,
  ScriptStepSource,
  PrepAction,
  LocateResult,
} from './script-types.js';
import { DemoConfig } from './config.js';
import { info, debug } from './log.js';

const MAX_RETRIES = 3;
const POST_ACTION_WAIT_MS = 4000;
const SURVEY_SCROLL_STEPS = 4; // number of scroll positions to capture
const SURVEY_SCROLL_PX = 400; // pixels to scroll per step

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
    steps?: Array<{
      type: string;
      target?: Array<{ page?: string; field?: string }>;
      caption?: string;
      row?: number | string;
      value?: string;
      description?: string;
      assistEdit?: boolean;
    }>;
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

/**
 * Surveys the current BC page by expanding all FastTabs, scrolling through,
 * and taking screenshots at multiple positions. Returns a structured description
 * of the COMPLETE page layout including all fields in all sections.
 */
async function surveyCurrentPage(
  vision: VisionClient,
  page: Page,
  outputDir: string,
  label: string,
): Promise<PageSurvey> {
  // Step 1: On card/document pages, expand collapsed FastTabs and "Show more"
  // so the survey sees every field. Skip this on list pages to avoid navigating away.
  try {
    const frame = await awaitBCFrame(page, 5_000);
    const hasCardForm = await frame.evaluate(
      () =>
        !!document.querySelector(
          'div.ms-nav-cardform, [class*="ms-nav-card"], [class*="collapsibleTab"]',
        ),
    );

    if (hasCardForm) {
      // Expand collapsed FastTabs (scoped to the card form area)
      const expandedCount = await frame.evaluate(() => {
        let count = 0;
        const cardForm =
          document.querySelector('div.ms-nav-cardform, [class*="ms-nav-card"]') ?? document.body;
        for (const header of cardForm.querySelectorAll('[aria-expanded="false"]')) {
          const rect = (header as HTMLElement).getBoundingClientRect();
          if (rect.width > 100 && rect.height > 10 && rect.height < 60) {
            (header as HTMLElement).click();
            count++;
          }
        }
        return count;
      });
      if (expandedCount > 0) {
        info(`  Expanded ${expandedCount} collapsed FastTab(s)`);
        await page.waitForTimeout(1500);
        try {
          await awaitBCFrame(page, 5_000);
        } catch {
          /* */
        }
      }

      // Click "Show more" links
      const showMoreCount = await frame.evaluate(() => {
        let count = 0;
        for (const el of document.querySelectorAll('a, button, [role="button"], span')) {
          const text = (el as HTMLElement).innerText?.trim().toLowerCase();
          if (text === 'show more' || text === 'vis mere' || text === 'mehr anzeigen') {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              (el as HTMLElement).click();
              count++;
            }
          }
        }
        return count;
      });
      if (showMoreCount > 0) {
        info(`  Clicked ${showMoreCount} "Show more" link(s)`);
        await page.waitForTimeout(1000);
        try {
          await awaitBCFrame(page, 5_000);
        } catch {
          /* */
        }
      }
    } else {
      debug('  Not a card page — skipping FastTab expansion');
    }
  } catch {
    /* non-critical */
  }

  // Step 3: Scroll to top
  try {
    const frame = await awaitBCFrame(page, 5_000);
    await frame.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  } catch {
    /* non-critical */
  }

  // Step 4: Capture screenshots at multiple scroll positions
  const screenshots: Buffer[] = [];
  for (let i = 0; i <= SURVEY_SCROLL_STEPS; i++) {
    const buf = await captureScreenshot(page, outputDir, `survey-${label}-scroll${i}.png`);
    screenshots.push(buf);

    if (i < SURVEY_SCROLL_STEPS) {
      await page.mouse.wheel(0, SURVEY_SCROLL_PX);
      await page.waitForTimeout(500);
    }
  }

  // Step 5: Scroll back to top for subsequent steps
  try {
    const frame = await awaitBCFrame(page, 5_000);
    await frame.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  } catch {
    /* non-critical */
  }

  // Step 6: Send all screenshots to vision model for analysis
  const survey = await vision.surveyPage(screenshots);
  info(`  Page survey: ${survey.pageType} "${survey.pageTitle}"`);
  info(
    `  FastTabs: ${survey.fastTabs.map((ft) => `${ft.name}(${ft.expanded ? 'open' : 'closed'}, ${ft.fields.length} fields)`).join(', ')}`,
  );
  for (const ft of survey.fastTabs) {
    if (ft.fields.length > 0) {
      info(`    ${ft.name}: ${ft.fields.join(', ')}`);
    }
  }

  return survey;
}

/**
 * Clicks an element in BC by caption/label using Playwright locators on the frame.
 * Vision coordinates can be imprecise (off by 50-100px), so we use the element's
 * text content to find it via Playwright's locator API which clicks the exact center.
 * Falls back to page.mouse.click() at the given coordinates if no label is available.
 */
async function clickByLabel(
  page: Page,
  label: string | undefined,
  pageX: number,
  pageY: number,
): Promise<void> {
  if (label) {
    try {
      const frame = await awaitBCFrame(page, 5_000);
      // Try role-based locators first (most reliable for BC actions)
      for (const role of ['menuitem', 'button', 'link'] as const) {
        const loc = frame.getByRole(role, { name: label, exact: true });
        if ((await loc.count()) > 0) {
          await loc.last().click();
          debug(`  Clicked [${role}] "${label}" via locator`);
          return;
        }
      }
      // Try partial match
      for (const role of ['menuitem', 'button', 'link'] as const) {
        const loc = frame.getByRole(role, { name: label });
        if ((await loc.count()) > 0) {
          await loc.last().click();
          debug(`  Clicked [${role}] ~"${label}" via partial locator`);
          return;
        }
      }
      // Try getByText
      const textLoc = frame.getByText(label, { exact: true });
      if ((await textLoc.count()) > 0) {
        await textLoc.last().click();
        debug(`  Clicked text "${label}" via locator`);
        return;
      }
    } catch {
      // Fall through to coordinate click
    }
  }
  // Fallback: coordinate click
  debug(`  Clicking at coordinates (${pageX}, ${pageY})`);
  await page.mouse.click(pageX, pageY);
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
  pageSurvey?: PageSurvey,
): Promise<ScriptStep> {
  let lastLocate: LocateResult | null = null;
  const pad = String(stepIndex).padStart(2, '0');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      info(`  Retry ${attempt}/${MAX_RETRIES - 1}...`);
    }

    // SCREENSHOT
    const beforeBuf = await captureScreenshot(
      page,
      outputDir,
      `step-${pad}-before${attempt > 0 ? `-retry${attempt}` : ''}.png`,
    );

    // LOCATE — use page survey context if available for more accurate results
    const locateResult = pageSurvey
      ? await vision.locateWithContext(beforeBuf, source, pageSurvey)
      : await vision.locate(beforeBuf, source);
    lastLocate = locateResult;
    info(
      `  → ${locateResult.element} at (${locateResult.coordinates.x}, ${locateResult.coordinates.y}) [confidence: ${locateResult.confidence}]`,
    );

    // PREP — execute prep actions even if confidence is low, because the model
    // may be saying "element isn't visible yet, do this first" (scroll, expand, etc.)
    if (locateResult.prep.length > 0) {
      debug(`  Executing ${locateResult.prep.length} prep actions...`);
      for (const prep of locateResult.prep) {
        debug(`    ${prep.action}: ${prep.reason ?? ''}`);
        await executePrepAction(page, prep);
      }

      // Wait for BC to settle after prep
      await page.waitForTimeout(500);
      try {
        await awaitBCFrame(page, 5_000);
      } catch {
        /* non-critical */
      }

      // Re-locate after prep changed the page
      const afterPrepBuf = await captureScreenshot(
        page,
        outputDir,
        `step-${pad}-after-prep${attempt > 0 ? `-retry${attempt}` : ''}.png`,
      );
      const reLocate = pageSurvey
        ? await vision.locateWithContext(afterPrepBuf, source, pageSurvey)
        : await vision.locate(afterPrepBuf, source);
      lastLocate = reLocate;
      info(
        `  → Re-located: (${reLocate.coordinates.x}, ${reLocate.coordinates.y}) [confidence: ${reLocate.confidence}]`,
      );
    }

    // Skip action if confidence is still too low after prep
    if (lastLocate.confidence < 0.3) {
      info(`  Confidence too low (${lastLocate.confidence}), retrying...`);
      continue;
    }

    // ACT — use clickByLabel() which finds elements via Playwright locators
    // for precise clicking, falling back to coordinates if no label is available
    const coords = lastLocate.coordinates;
    const label = source.caption ?? source.field;

    if (source.type === 'input' && source.value) {
      // For input fields: click the field by label, then type
      await clickByLabel(page, source.field, coords.x, coords.y);
      await page.waitForTimeout(300);
      // Select all and type over
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(100);
      await page.keyboard.type(source.value, { delay: 50 });
      await page.keyboard.press('Tab');
    } else if (source.assistEdit) {
      await clickByLabel(page, source.caption, coords.x, coords.y);
      await page.waitForTimeout(600);
      const assistBuf = await captureScreenshot(page, outputDir, `step-${pad}-assist.png`);
      const assistSource: ScriptStepSource = {
        type: 'action',
        caption: `assist-edit "..." button for ${source.caption}`,
      };
      const assistLocate = await vision.locate(assistBuf, assistSource);
      if (assistLocate.confidence > 0.3) {
        await page.mouse.click(assistLocate.coordinates.x, assistLocate.coordinates.y);
      } else {
        await page.keyboard.press('F6');
      }
    } else if (source.row != null) {
      // For row clicks: use coordinates (no text label to match)
      await page.mouse.click(coords.x, coords.y);
    } else {
      await clickByLabel(page, label, coords.x, coords.y);
    }

    await page.waitForTimeout(POST_ACTION_WAIT_MS);

    // Wait for BC to settle
    try {
      await awaitBCFrame(page, 10_000);
    } catch {
      /* non-critical */
    }

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
        screenshot: `step-${pad}-before.png`,
      };
    }

    const afterBuf = await captureScreenshot(page, outputDir, `step-${pad}-after.png`);
    const verifyResult = await vision.verify(beforeBuf, afterBuf, source, coords);
    info(
      `  → Verify: ${verifyResult.success ? 'SUCCESS' : 'FAILED'} — ${verifyResult.observation}`,
    );

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
        screenshot: `step-${pad}-before.png`,
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
    screenshot: `step-${pad}-before.png`,
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

    // Survey the initial page
    let currentSurvey: PageSurvey | undefined;
    info('Surveying initial page...');
    currentSurvey = await surveyCurrentPage(vision, session.page, screenshotDir, 'initial');

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
        currentSurvey,
      );
      scriptSteps.push(scriptStep);

      // If the step verified a page change, re-survey the new page
      if (
        scriptStep.verification.success &&
        scriptStep.verification.afterPage &&
        scriptStep.verification.beforePage !== scriptStep.verification.afterPage
      ) {
        info('Page changed — surveying new page...');
        currentSurvey = await surveyCurrentPage(
          vision,
          session.page,
          screenshotDir,
          `after-step${i}`,
        );
      }
    }
  } finally {
    await closeBCSession(session);
  }

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

  const passed = scriptSteps.filter((s) => s.verification.success).length;
  const failed = scriptSteps.filter((s) => !s.verification.success).length;
  info(
    `Investigation complete: ${passed} passed, ${failed} failed out of ${scriptSteps.length} steps`,
  );

  return { scriptPath, script };
}
