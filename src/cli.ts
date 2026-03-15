#!/usr/bin/env node

import { Command } from 'commander';
import { resolve, parse as parsePath } from 'path';
import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from './config.js';
import { recordDemo } from './recorder.js';
import { generateNarration } from './narrator.js';
import { composeVideo, composeWithStepAudio } from './composer.js';
import { generateStepAudio } from './step-audio.js';
import { generateSubtitles } from './subtitle-gen.js';
import { getVoiceForLocale, type VoiceConfig } from './locale-voices.js';
import type { StepTimingMetadata } from './player.js';

const program = new Command();

program
  .name('generate-demo')
  .description('Generate demo videos from BC Page Scripting YAML specs')
  .version('0.3.0');

program
  .argument('<spec>', 'Path to the BC Page Scripting YAML spec file')
  .option('--bc-url <url>', 'Business Central web client URL')
  .option('--bc-auth <type>', 'Authentication type: Windows, AAD, or UserPassword')
  .option('--output <dir>', 'Output directory for generated videos', './output')
  .option('--no-headed', 'Run in headless mode (no visible browser)')
  .option('--narrate', 'Generate TTS narration and compose with video')
  .option('--voice <voice>', 'OpenAI TTS voice (overrides locale default)')
  .option('--skip-record', 'Skip recording, only generate narration and compose')
  .option('--no-subs', 'Skip subtitle generation and burn-in')
  .option('--no-trim', 'Keep login/auth in the video (debugging)')
  .action(
    async (
      spec: string,
      options: {
        bcUrl?: string;
        bcAuth?: string;
        output?: string;
        headed?: boolean;
        narrate?: boolean;
        voice?: string;
        skipRecord?: boolean;
        subs?: boolean;
        trim?: boolean;
      },
    ) => {
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
      const finalPath = resolve(outputDir, `${specName}.mp4`);
      const srtPath = resolve(outputDir, `${specName}.srt`);
      const timingJsonPath = resolve(outputDir, `${specName}.timing.json`);

      // Parse spec for metadata
      const specContent = readFileSync(specPath, 'utf-8');
      const recording = parseYaml(specContent);
      const demo = recording?.demo as Record<string, unknown> | undefined;
      const stepNarration = demo?.stepNarration as Record<string, string> | undefined;
      const narrationText = demo?.narration as string | undefined;
      const locale = demo?.locale as string | undefined;

      // Resolve voice config
      let voiceConfig: VoiceConfig;
      if (options.voice) {
        voiceConfig = { voice: options.voice as VoiceConfig['voice'], speed: 1.0 };
      } else {
        voiceConfig = getVoiceForLocale(locale);
      }

      console.log('=== Continia Demo Generator ===\n');

      // Determine pipeline: per-step narration (preferred) or single narration (fallback)
      const useStepNarration =
        options.narrate && stepNarration && Object.keys(stepNarration).length > 0;
      const useSingleNarration = options.narrate && !useStepNarration && narrationText;

      let timing: StepTimingMetadata | undefined;

      // --- Phase A: Generate per-step audio (before recording, to get delays) ---
      let stepAudioPlan: Awaited<ReturnType<typeof generateStepAudio>> | undefined;

      if (useStepNarration && !options.skipRecord) {
        console.log('--- Step Narration ---\n');
        stepAudioPlan = await generateStepAudio(stepNarration!, specName, outputDir, voiceConfig);
        console.log(`\nGenerated ${stepAudioPlan.clips.length} audio clips\n`);
      }

      // --- Phase B: Record video ---
      if (!options.skipRecord) {
        console.log('--- Recording ---\n');
        const result = await recordDemo(specPath, config, {
          stepDelays: stepAudioPlan?.stepDelays,
        });
        if (result.success) {
          console.log(`\nVideo recorded: ${result.videoPath}`);
          timing = result.timing;
        } else {
          console.error(`\nFailed to record: ${result.error}`);
          process.exit(1);
        }
      } else {
        // Load existing video and timing
        if (!existsSync(videoPath)) {
          console.error(`Error: --skip-record but no video found at ${videoPath}`);
          process.exit(1);
        }
        console.log(`Using existing video: ${videoPath}`);

        if (existsSync(timingJsonPath)) {
          timing = JSON.parse(readFileSync(timingJsonPath, 'utf-8')) as StepTimingMetadata;
          console.log(`Loaded timing from: ${timingJsonPath}`);
        }

        // Generate step audio if needed (may not have been generated before)
        if (useStepNarration && !stepAudioPlan) {
          console.log('\n--- Step Narration ---\n');
          stepAudioPlan = await generateStepAudio(stepNarration!, specName, outputDir, voiceConfig);
        }
      }

      // --- Phase C: Compose with narration ---
      if (useStepNarration && stepAudioPlan && timing) {
        // Per-step narration pipeline
        console.log('\n--- Composing (per-step narration) ---\n');

        // Generate subtitles
        let subtitlePath: string | undefined;
        if (options.subs !== false) {
          subtitlePath = generateSubtitles(stepAudioPlan.clips, timing, srtPath);
        }

        const compResult = await composeWithStepAudio({
          videoPath,
          clips: stepAudioPlan.clips,
          timing,
          subtitlePath,
          outputPath: finalPath,
          trimLogin: options.trim !== false,
        });

        if (compResult.success) {
          console.log(`\nFinal video: ${compResult.videoPath}`);
        } else {
          console.error(`\nFailed to compose: ${compResult.error}`);
          process.exit(1);
        }
      } else if (useSingleNarration) {
        // Fallback: single narration (no step sync)
        console.log('\n--- Narration (single track) ---\n');
        const audioPath = resolve(outputDir, `${specName}.mp3`);
        const narResult = await generateNarration(narrationText!.trim(), audioPath, {
          voice: voiceConfig.voice,
          speed: voiceConfig.speed,
        });
        if (!narResult.success) {
          console.error(`\nFailed to generate narration: ${narResult.error}`);
          process.exit(1);
        }

        console.log('\n--- Composing ---\n');
        const compResult = await composeVideo(videoPath, audioPath, finalPath);
        if (compResult.success) {
          console.log(`\nFinal video: ${compResult.videoPath}`);
        } else {
          console.error(`\nFailed to compose: ${compResult.error}`);
          process.exit(1);
        }
      }

      console.log('\nDone!');
    },
  );

program.parse();
