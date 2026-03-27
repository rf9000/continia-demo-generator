// src/investigator.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, parse as parsePath } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Page, Frame } from 'playwright';
import { VisionClient } from './vision.js';
import { DomInterpreter } from './dom-interpreter.js';
import { extractPageHtml } from './dom-extract.js';
import { loadPatterns, savePattern, incrementSuccess, type KnowledgePattern } from './knowledge.js';
import { launchBCSession, closeBCSession, awaitBCFrame } from './browser.js';
import { computeSpecHash, writeScript } from './script-io.js';
import type { ScriptFile, ScriptStep, ScriptStepSource, VerifyResult } from './script-types.js';
import { DemoConfig } from './config.js';
import { info, debug } from './log.js';

const MAX_RETRIES = 3;
const POST_ACTION_WAIT_MS = 4000;
const BC_IDLE_TIMEOUT_MS = 10_000;

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

/** Converts a YAML step to a ScriptStepSource for prompts. */
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
 * Clicks an element in BC by caption/label using Playwright locators on the frame.
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

/**
 * Computes page-level coordinates from a frame-level bounding box by adding
 * the iframe offset. Returns the center of the element.
 */
async function getPageCoordinates(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<{ x: number; y: number }> {
  const iframeOffset = await page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    if (!iframe) return { x: 0, y: 0 };
    const rect = iframe.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });

  const box = await frame.locator(selector).boundingBox();
  return {
    x: Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2 + iframeOffset.x),
    y: Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2 + iframeOffset.y),
  };
}

/**
 * Waits for BC to become idle after an action. Non-critical — silently
 * ignores timeout so the investigation can continue.
 */
async function waitForBCIdle(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  try {
    await awaitBCFrame(page, BC_IDLE_TIMEOUT_MS);
  } catch {
    /* non-critical */
  }
}

/**
 * Derives a stable pattern name from a step source, suitable for use as
 * a file-system-safe knowledge pattern identifier.
 */
function patternNameFromSource(source: ScriptStepSource): string {
  const base =
    source.type === 'input'
      ? `input-${source.field ?? 'unknown'}`
      : source.type === 'action' && source.row != null
        ? `row-${source.row}`
        : `action-${source.caption ?? 'unknown'}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

/** Runs a single step through the 9-step DOM-based investigation flow. */
async function investigateStep(
  interpreter: DomInterpreter,
  vision: VisionClient,
  page: Page,
  source: ScriptStepSource,
  stepIndex: number,
  outputDir: string,
  knowledgeDir: string,
  patterns: KnowledgePattern[],
  skipVerify: boolean,
): Promise<ScriptStep> {
  const pad = String(stepIndex).padStart(2, '0');
  const targetName =
    source.caption ??
    source.field ??
    (source.row != null ? `row ${source.row}` : `step ${stepIndex}`);
  const frame = await awaitBCFrame(page, BC_IDLE_TIMEOUT_MS);

  // ─── 1. EXTRACT ──────────────────────────────────────────────────────
  const { html } = await extractPageHtml(frame);
  debug(`  [EXTRACT] ${html.length} chars HTML`);

  // ─── 2. SURVEY ───────────────────────────────────────────────────────
  try {
    const survey = await interpreter.survey(html, patterns);
    info(
      `  [SURVEY] ${survey.pageType} "${survey.pageTitle}" — ${survey.sections.length} sections, ${survey.actionBar.length} actions`,
    );
  } catch (err) {
    info(`  [SURVEY] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ─── 3. LOCATE ───────────────────────────────────────────────────────
  let locateResult = await interpreter.locate(html, source, patterns);
  info(
    `  [LOCATE] found=${locateResult.found} selector="${locateResult.interactSelector}" confidence=${locateResult.confidence}`,
  );
  debug(`  [LOCATE] reasoning: ${locateResult.reasoning}`);

  // If not found, emit a failed step immediately
  if (!locateResult.found) {
    info(`  [LOCATE] WARNING: element not found — "${locateResult.reasoning}"`);
    return {
      index: stepIndex,
      source,
      action: source.type === 'input' ? 'click-then-type' : 'click',
      coordinates: { x: 0, y: 0 },
      value: source.value,
      confidence: 0,
      prep: [],
      verification: { success: false, observation: `Element not found: ${locateResult.reasoning}` },
      screenshot: `step-${pad}-before.png`,
    };
  }

  // ─── 4. PREPARE ──────────────────────────────────────────────────────
  if (locateResult.stepsToReach.length > 0) {
    info(`  [PREPARE] ${locateResult.stepsToReach.length} prep step(s)`);
    for (const prep of locateResult.stepsToReach) {
      debug(`    ${prep.action}: ${prep.selector} — ${prep.reason ?? ''}`);
      try {
        switch (prep.action) {
          case 'expandSection':
            await frame.locator(prep.selector).click();
            await waitForBCIdle(page);
            break;
          case 'scrollTo':
            await frame.locator(prep.selector).scrollIntoViewIfNeeded();
            break;
          case 'clickShowMore':
            await frame.locator(prep.selector).click();
            await waitForBCIdle(page);
            break;
          case 'click':
            await frame.locator(prep.selector).click();
            await waitForBCIdle(page);
            break;
        }
      } catch (err) {
        info(`    Prep step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ─── 5. CONFIRM ──────────────────────────────────────────────────────
  let confirmedSelector = locateResult.interactSelector;
  for (let confirmAttempt = 0; confirmAttempt < MAX_RETRIES; confirmAttempt++) {
    const freshFrame = await awaitBCFrame(page, BC_IDLE_TIMEOUT_MS);
    const { html: freshHtml } = await extractPageHtml(freshFrame);
    const confirmResult = await interpreter.confirm(freshHtml, targetName, confirmedSelector);
    info(`  [CONFIRM] confirmed=${confirmResult.confirmed} selector="${confirmResult.selector}"`);
    debug(`  [CONFIRM] reasoning: ${confirmResult.reasoning}`);

    if (confirmResult.confirmed) {
      confirmedSelector = confirmResult.selector;
      break;
    }

    // Not confirmed — retry locate with updated HTML
    if (confirmAttempt < MAX_RETRIES - 1) {
      info(
        `  [CONFIRM] Not confirmed, re-locating (attempt ${confirmAttempt + 2}/${MAX_RETRIES})...`,
      );
      locateResult = await interpreter.locate(freshHtml, source, patterns);
      if (!locateResult.found) {
        info(`  [LOCATE] Element still not found after re-locate`);
        break;
      }
      confirmedSelector = locateResult.interactSelector;

      // Execute any new prep steps
      if (locateResult.stepsToReach.length > 0) {
        for (const prep of locateResult.stepsToReach) {
          try {
            switch (prep.action) {
              case 'expandSection':
                await freshFrame.locator(prep.selector).click();
                await waitForBCIdle(page);
                break;
              case 'scrollTo':
                await freshFrame.locator(prep.selector).scrollIntoViewIfNeeded();
                break;
              case 'clickShowMore':
                await freshFrame.locator(prep.selector).click();
                await waitForBCIdle(page);
                break;
              case 'click':
                await freshFrame.locator(prep.selector).click();
                await waitForBCIdle(page);
                break;
            }
          } catch (err) {
            info(`    Retry prep step failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  // ─── 6. ACT ──────────────────────────────────────────────────────────
  // Take before screenshot for verification
  const beforeBuf = await captureScreenshot(page, outputDir, `step-${pad}-before.png`);
  const actFrame = await awaitBCFrame(page, BC_IDLE_TIMEOUT_MS);

  try {
    if (source.type === 'input' && source.value) {
      // Input: click field, fill, tab out
      await actFrame.locator(confirmedSelector).click();
      await page.waitForTimeout(300);
      await actFrame.locator(confirmedSelector).fill(source.value);
      await page.keyboard.press('Tab');
    } else if (source.assistEdit) {
      // Assist-edit: click the field, wait for assist button to appear
      await actFrame.locator(confirmedSelector).click();
      await page.waitForTimeout(600);
      // Look for the assist-edit "..." button near the field
      try {
        const assistBtn = actFrame.locator(
          `${confirmedSelector} ~ [aria-label*="assist"], [aria-haspopup="dialog"]`,
        );
        if ((await assistBtn.count()) > 0) {
          await assistBtn.first().click();
        } else {
          // Fallback: press F6 to trigger assist-edit
          await page.keyboard.press('F6');
        }
      } catch {
        await page.keyboard.press('F6');
      }
    } else if (source.row != null) {
      // Row click: click using confirmed selector
      await actFrame.locator(confirmedSelector).click();
    } else {
      // Action: try selector first, fall back to clickByLabel
      try {
        await actFrame.locator(confirmedSelector).click();
      } catch {
        const coords = await getPageCoordinates(page, actFrame, confirmedSelector).catch(() => ({
          x: 0,
          y: 0,
        }));
        await clickByLabel(page, source.caption, coords.x, coords.y);
      }
    }
    debug(`  [ACT] Executed action with selector "${confirmedSelector}"`);
  } catch (err) {
    info(`  [ACT] Selector click failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback to clickByLabel with coordinates if available
    try {
      const coords = await getPageCoordinates(page, actFrame, confirmedSelector);
      await clickByLabel(page, source.caption ?? source.field, coords.x, coords.y);
    } catch {
      info(`  [ACT] Fallback also failed — step will be marked as failed`);
    }
  }

  await page.waitForTimeout(POST_ACTION_WAIT_MS);
  await waitForBCIdle(page);

  // ─── 7. VERIFY ───────────────────────────────────────────────────────
  let verification: VerifyResult;
  let pageCoords: { x: number; y: number };

  try {
    const verifyFrame = await awaitBCFrame(page, BC_IDLE_TIMEOUT_MS);
    pageCoords = await getPageCoordinates(page, verifyFrame, confirmedSelector).catch(() => ({
      x: 0,
      y: 0,
    }));
  } catch {
    pageCoords = { x: 0, y: 0 };
  }

  if (skipVerify) {
    verification = { success: true, observation: 'verification skipped' };
  } else {
    const afterBuf = await captureScreenshot(page, outputDir, `step-${pad}-after.png`);
    verification = await vision.verify(beforeBuf, afterBuf, source, pageCoords);
    info(`  [VERIFY] ${verification.success ? 'SUCCESS' : 'FAILED'} — ${verification.observation}`);
  }

  // ─── 8. LEARN ────────────────────────────────────────────────────────
  if (verification.success) {
    const pName = patternNameFromSource(source);
    try {
      const existingNames = patterns.map((p) => p.name);
      if (existingNames.includes(pName)) {
        incrementSuccess(knowledgeDir, pName);
        debug(`  [LEARN] Incremented pattern "${pName}"`);
      } else {
        const newPattern: KnowledgePattern = {
          name: pName,
          description: `${source.type}: ${targetName}`,
          discovered: new Date().toISOString().split('T')[0],
          successCount: 1,
          lastUsed: new Date().toISOString().split('T')[0],
          pattern: {
            identify: `selector: ${confirmedSelector}`,
            interact: source.type === 'input' ? 'click then fill' : 'click',
            verify: 'before/after screenshot comparison',
          },
        };
        savePattern(knowledgeDir, newPattern);
        patterns.push(newPattern);
        debug(`  [LEARN] Saved new pattern "${pName}"`);
      }
    } catch (err) {
      debug(
        `  [LEARN] Failed to save pattern: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── 9. EMIT ─────────────────────────────────────────────────────────
  // Get bounding box for final coordinates
  let emitCoords = pageCoords;
  try {
    const emitFrame = await awaitBCFrame(page, 5_000);
    emitCoords = await getPageCoordinates(page, emitFrame, confirmedSelector);
  } catch {
    // Keep pageCoords from verify step
  }

  const confidenceNum =
    locateResult.confidence === 'high' ? 0.9 : locateResult.confidence === 'medium' ? 0.6 : 0.3;

  return {
    index: stepIndex,
    source,
    action: source.type === 'input' ? 'click-then-type' : 'click',
    coordinates: emitCoords,
    value: source.value,
    confidence: confidenceNum,
    prep: [],
    verification,
    screenshot: `step-${pad}-before.png`,
  };
}

/**
 * Runs the full investigation pipeline: opens BC, walks each YAML step
 * through the DOM-based 9-step flow, and writes a .script.yml.
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
    throw new Error('ANTHROPIC_API_KEY is required for DOM-based investigation');
  }

  const interpreter = new DomInterpreter(config.anthropicApiKey, config.visionModel);
  const vision = new VisionClient(config.anthropicApiKey, config.visionModel);

  const screenshotDir = resolve(outputDir, 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });

  // Knowledge bank
  const knowledgeDir = resolve(outputDir, 'knowledge', 'patterns');
  mkdirSync(knowledgeDir, { recursive: true });
  const patterns = loadPatterns(knowledgeDir);
  info(`Loaded ${patterns.length} knowledge pattern(s)`);

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
        interpreter,
        vision,
        session.page,
        source,
        i,
        screenshotDir,
        knowledgeDir,
        patterns,
        options.skipVerify ?? false,
      );
      scriptSteps.push(scriptStep);
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
