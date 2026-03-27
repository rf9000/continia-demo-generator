// src/investigator.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, parse as parsePath } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Page } from 'playwright';
import { VisionClient } from './vision.js';
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

    // LOCATE
    const locateResult = await vision.locate(beforeBuf, source);
    lastLocate = locateResult;
    info(
      `  → ${locateResult.element} at (${locateResult.coordinates.x}, ${locateResult.coordinates.y}) [confidence: ${locateResult.confidence}]`,
    );

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
      const afterPrepBuf = await captureScreenshot(page, outputDir, `step-${pad}-after-prep.png`);
      const reLocate = await vision.locate(afterPrepBuf, source);
      lastLocate = reLocate;
      info(
        `  → Re-located: (${reLocate.coordinates.x}, ${reLocate.coordinates.y}) [confidence: ${reLocate.confidence}]`,
      );
    }

    // ACT
    const coords = lastLocate.coordinates;
    if (source.type === 'input' && source.value) {
      await page.mouse.click(coords.x, coords.y);
      await page.waitForTimeout(300);
      await page.mouse.click(coords.x, coords.y, { clickCount: 3 });
      await page.waitForTimeout(100);
      await page.keyboard.type(source.value, { delay: 50 });
      await page.keyboard.press('Tab');
    } else if (source.assistEdit) {
      // Click field to focus, wait for assist button, then find and click it
      await page.mouse.click(coords.x, coords.y);
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
    } else {
      await page.mouse.click(coords.x, coords.y);
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
