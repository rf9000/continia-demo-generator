#!/usr/bin/env node

import { Command } from 'commander';
import { resolve, parse as parsePath } from 'path';
import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from './config.js';
import { recordDemo } from './recorder.js';
import { generateNarration } from './narrator.js';
import { composeVideo } from './composer.js';

const program = new Command();

program
  .name('generate-demo')
  .description('Generate demo videos from BC Page Scripting YAML specs')
  .version('0.2.0');

program
  .argument('<spec>', 'Path to the BC Page Scripting YAML spec file')
  .option('--bc-url <url>', 'Business Central web client URL')
  .option('--bc-auth <type>', 'Authentication type: Windows, AAD, or UserPassword')
  .option('--output <dir>', 'Output directory for generated videos', './output')
  .option('--no-headed', 'Run in headless mode (no visible browser)')
  .option('--narrate', 'Generate TTS narration and compose with video')
  .option('--voice <voice>', 'OpenAI TTS voice: alloy, echo, fable, onyx, nova, shimmer', 'nova')
  .option('--skip-record', 'Skip recording, only generate narration and compose (requires existing video)')
  .action(async (spec: string, options: {
    bcUrl?: string;
    bcAuth?: string;
    output?: string;
    headed?: boolean;
    narrate?: boolean;
    voice?: string;
    skipRecord?: boolean;
  }) => {
    const specPath = resolve(spec);

    if (!existsSync(specPath)) {
      console.error(`Error: Spec file not found: ${specPath}`);
      process.exit(1);
    }

    if (!specPath.endsWith('.yml') && !specPath.endsWith('.yaml')) {
      console.error('Error: Spec file must be a YAML file (.yml or .yaml)');
      process.exit(1);
    }

    const config = loadConfig({
      bcStartAddress: options.bcUrl,
      bcAuth: options.bcAuth as 'Windows' | 'AAD' | 'UserPassword' | undefined,
      outputDir: options.output,
      headed: options.headed,
    });

    const specName = parsePath(specPath).name;
    const outputDir = resolve(config.outputDir);
    const videoPath = resolve(outputDir, `${specName}.webm`);
    const audioPath = resolve(outputDir, `${specName}.mp3`);
    const finalPath = resolve(outputDir, `${specName}.mp4`);

    console.log('=== Continia Demo Generator ===\n');

    // Step 1: Record video (unless --skip-record)
    if (!options.skipRecord) {
      const result = await recordDemo(specPath, config);
      if (result.success) {
        console.log(`\nVideo recorded: ${result.videoPath}`);
      } else {
        console.error(`\nFailed to record: ${result.error}`);
        process.exit(1);
      }
    } else {
      if (!existsSync(videoPath)) {
        console.error(`Error: --skip-record but no video found at ${videoPath}`);
        process.exit(1);
      }
      console.log(`Using existing video: ${videoPath}`);
    }

    // Step 2: Generate narration and compose (if --narrate)
    if (options.narrate) {
      const specContent = readFileSync(specPath, 'utf-8');
      const recording = parseYaml(specContent);
      const narrationText = recording?.demo?.narration;

      if (!narrationText) {
        console.error('\nNo narration text found in spec (demo.narration is empty)');
        process.exit(1);
      }

      console.log('\n--- Narration ---\n');

      const voice = (options.voice ?? 'nova') as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
      const narResult = await generateNarration(narrationText.trim(), audioPath, { voice });
      if (!narResult.success) {
        console.error(`\nFailed to generate narration: ${narResult.error}`);
        process.exit(1);
      }

      console.log('\n--- Composing ---\n');

      const compResult = await composeVideo(videoPath, audioPath, finalPath);
      if (compResult.success) {
        console.log(`\nDemo with narration: ${compResult.videoPath}`);
      } else {
        console.error(`\nFailed to compose: ${compResult.error}`);
        process.exit(1);
      }
    }

    console.log('\nDone!');
  });

program.parse();
