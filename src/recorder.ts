// src/recorder.ts
import { resolve, parse } from 'path';
import { existsSync } from 'fs';
import { DemoConfig } from './config.js';
import { investigate } from './investigator.js';
import { playScript, type ScriptPlayResult } from './script-player.js';
import { isScriptValid } from './script-io.js';
import { info } from './log.js';

export interface RecordResult {
  success: boolean;
  videoPath?: string;
  timing?: ScriptPlayResult['timing'];
  scriptPath?: string;
  error?: string;
}

/**
 * Orchestrates the full demo recording pipeline:
 * 1. Investigate (if needed) — vision-based discovery
 * 2. Record — mechanical replay of coordinate script
 */
export async function recordDemo(
  specPath: string,
  config: DemoConfig,
  options?: {
    stepDelays?: Map<number, number>;
    mode?: 'investigate' | 'record' | 'full';
    skipVerify?: boolean;
  },
): Promise<RecordResult> {
  const absoluteSpecPath = resolve(specPath);
  const specName = parse(absoluteSpecPath).name;
  const outputDir = resolve(config.outputDir);
  const scriptPath = resolve(outputDir, `${specName}.script.yml`);
  const mode = options?.mode ?? 'full';

  if (!existsSync(absoluteSpecPath)) {
    return { success: false, error: `Spec file not found: ${absoluteSpecPath}` };
  }

  info(`Demo: ${specName}`);
  info(`BC: ${config.bcStartAddress}`);

  try {
    // Investigation phase
    if (mode === 'investigate' || mode === 'full') {
      const needsInvestigation =
        mode === 'investigate' ||
        !existsSync(scriptPath) ||
        !isScriptValid(absoluteSpecPath, scriptPath);

      if (needsInvestigation) {
        info('Starting vision-based investigation...');
        const result = await investigate(absoluteSpecPath, config, outputDir, {
          skipVerify: options?.skipVerify,
        });

        if (mode === 'investigate') {
          return { success: true, scriptPath: result.scriptPath };
        }
      } else {
        info('Script cache is valid — skipping investigation');
      }
    }

    // Recording phase
    if (mode === 'record' || mode === 'full') {
      if (!existsSync(scriptPath)) {
        return {
          success: false,
          error: `No script found at ${scriptPath}. Run investigation first.`,
        };
      }

      info('Starting coordinate-based recording...');
      const result = await playScript(scriptPath, absoluteSpecPath, config, {
        stepDelays: options?.stepDelays,
      });

      return {
        success: result.success,
        videoPath: result.videoPath,
        timing: result.timing,
        scriptPath,
        error: result.error,
      };
    }

    return { success: true, scriptPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
