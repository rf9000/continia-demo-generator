import { resolve, parse } from 'path';
import { existsSync } from 'fs';
import { DemoConfig } from './config.js';
import { playDemo, type PlayResult, type PlayOptions, type StepTimingMetadata } from './player.js';

export interface RecordResult {
  success: boolean;
  videoPath?: string;
  timing?: StepTimingMetadata;
  error?: string;
}

export async function recordDemo(specPath: string, config: DemoConfig, options?: PlayOptions): Promise<RecordResult> {
  const absoluteSpecPath = resolve(specPath);
  const specName = parse(absoluteSpecPath).name;

  if (!existsSync(absoluteSpecPath)) {
    return { success: false, error: `Spec file not found: ${absoluteSpecPath}` };
  }

  console.log(`Recording demo: ${specName}`);
  console.log(`BC URL: ${config.bcStartAddress}`);
  console.log(`Spec: ${absoluteSpecPath}`);

  const result: PlayResult = await playDemo(absoluteSpecPath, config, options);

  if (result.success) {
    return { success: true, videoPath: result.videoPath, timing: result.timing };
  } else {
    return { success: false, error: result.error };
  }
}
