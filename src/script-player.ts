// src/script-player.ts
import type { Page } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { launchBCSession, closeBCSession, awaitBCFrame } from './browser.js';
import { readScript } from './script-io.js';
import { injectCursor, animateCursorTo } from './cursor.js';
import type { PrepAction } from './script-types.js';
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
      } catch {
        /* non-critical */
      }

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
