import { resolve, parse } from 'path';
import { existsSync } from 'fs';
import { DemoConfig } from './config.js';
import { playDemo, type PlayResult } from './player.js';

export interface RecordResult {
  success: boolean;
  videoPath?: string;
  error?: string;
}

/**
 * Records a demo video using our custom Playwright-based player.
 * Handles BC authentication, direct page navigation via start.pageId,
 * and adds delays between steps so the video is watchable.
 */
export async function recordDemo(specPath: string, config: DemoConfig): Promise<RecordResult> {
  const absoluteSpecPath = resolve(specPath);
  const specName = parse(absoluteSpecPath).name;

  if (!existsSync(absoluteSpecPath)) {
    return { success: false, error: `Spec file not found: ${absoluteSpecPath}` };
  }

  console.log(`Recording demo: ${specName}`);
  console.log(`BC URL: ${config.bcStartAddress}`);
  console.log(`Spec: ${absoluteSpecPath}`);

  const result: PlayResult = await playDemo(absoluteSpecPath, config);

  if (result.success) {
    return { success: true, videoPath: result.videoPath };
  } else {
    return { success: false, error: result.error };
  }
}
