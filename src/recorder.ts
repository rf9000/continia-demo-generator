import { resolve, parse } from 'path';
import { existsSync } from 'fs';
import { DemoConfig } from './config.js';
import { playDemo, type PlayResult, type PlayOptions, type StepTimingMetadata } from './player.js';
import { info, debug } from './log.js';
import type { StepDiscovery } from './types.js';

export interface RecordResult {
  success: boolean;
  videoPath?: string;
  timing?: StepTimingMetadata;
  discoveries?: StepDiscovery[];
  error?: string;
}

export async function recordDemo(
  specPath: string,
  config: DemoConfig,
  options?: PlayOptions,
): Promise<RecordResult> {
  const absoluteSpecPath = resolve(specPath);
  const specName = parse(absoluteSpecPath).name;

  if (!existsSync(absoluteSpecPath)) {
    return { success: false, error: `Spec file not found: ${absoluteSpecPath}` };
  }

  info(`Demo: ${specName}`);
  info(`BC: ${config.bcStartAddress}`);
  debug(`Spec: ${absoluteSpecPath}`);

  try {
    const result: PlayResult = await playDemo(absoluteSpecPath, config, options);

    if (result.success) {
      return {
        success: true,
        videoPath: result.videoPath,
        timing: result.timing,
        discoveries: result.discoveries,
      };
    } else {
      return { success: false, error: result.error, discoveries: result.discoveries };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
