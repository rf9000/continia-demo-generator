#!/usr/bin/env node

import { Command } from 'commander';
import { resolve, parse as parsePath } from 'path';
import { existsSync, readFileSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from './config.js';
import { recordDemo } from './recorder.js';
import { generateNarration } from './narrator.js';
import { composeVideo, composeWithStepAudio } from './composer.js';
import { generateStepAudio } from './step-audio.js';
import { generateSubtitles } from './subtitle-gen.js';
import { getVoiceForLocale, type VoiceConfig } from './locale-voices.js';
import { setVerbose, header, info } from './log.js';
import { isScriptValid } from './script-io.js';
import { resetEnvironment, extractEnvId } from './env-reset.js';
import type { ScriptPlayResult } from './script-player.js';

const program = new Command();

program
  .name('generate-demo')
  .description('Generate demo videos from BC Page Scripting YAML specs')
  .version('0.5.0');

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
  .option('--investigate-only', 'Run investigation only — write script and exit')
  .option('--no-investigate', 'Skip investigation — use existing script')
  .option(
    '--vision-model <model>',
    'Vision model for investigation (default: claude-sonnet-4-6-20250514)',
  )
  .option('--no-verify', 'Skip verification step during investigation')
  .option('-v, --verbose', 'Show detailed debug output')
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
        investigateOnly?: boolean;
        investigate?: boolean;
        visionModel?: string;
        verify?: boolean;
        verbose?: boolean;
      },
    ) => {
      setVerbose(options.verbose ?? false);
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
        visionModel: options.visionModel,
      });

      const specName = parsePath(specPath).name;
      const outputDir = resolve(config.outputDir, specName);
      config.outputDir = outputDir;

      let videoPath = resolve(outputDir, `${specName}.webm`);
      const finalPath = resolve(outputDir, `${specName}.mp4`);
      const srtPath = resolve(outputDir, `${specName}.srt`);
      const scriptPath = resolve(outputDir, `${specName}.script.yml`);

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

      console.log('Continia Demo Generator');
      info(`Spec: ${specName}`);

      const skipInvestigate = options.investigate === false;
      const investigateOnly = options.investigateOnly === true;
      const skipVerify = options.verify === false;

      if (skipInvestigate && investigateOnly) {
        console.error('Error: --no-investigate and --investigate-only are mutually exclusive');
        process.exit(1);
      }

      // Determine mode
      let mode: 'investigate' | 'record' | 'full';
      if (investigateOnly) {
        mode = 'investigate';
      } else if (skipInvestigate || options.skipRecord) {
        mode = 'record';
      } else {
        if (existsSync(scriptPath) && isScriptValid(specPath, scriptPath)) {
          info('Script cache is valid — skipping investigation');
          mode = 'record';
        } else {
          mode = 'full';
        }
      }

      // Determine pipeline: per-step narration or single narration
      const useStepNarration =
        options.narrate && stepNarration && Object.keys(stepNarration).length > 0;
      const useSingleNarration = options.narrate && !useStepNarration && narrationText;

      let timing: ScriptPlayResult['timing'] | undefined;

      // ── Phase A: Generate per-step audio (before recording) ──
      let stepAudioPlan: Awaited<ReturnType<typeof generateStepAudio>> | undefined;
      if (useStepNarration && !options.skipRecord) {
        header('Narration');
        stepAudioPlan = await generateStepAudio(stepNarration!, specName, outputDir, voiceConfig);
      }

      // ── Phase B: Investigation + Recording ──
      if (!options.skipRecord) {
        if (mode === 'full' || mode === 'investigate') {
          header('Investigation');
        }

        // For full mode: investigate first, then reset env, then record
        if (mode === 'full') {
          // Investigation
          const investResult = await recordDemo(specPath, config, {
            mode: 'investigate',
            skipVerify,
          });

          if (!investResult.success) {
            console.error(`\nInvestigation failed: ${investResult.error}`);
            info('Cannot proceed without investigation results.');
            process.exit(1);
          }

          // Environment reset
          header('Environment Reset');
          const envId = extractEnvId(config.bcStartAddress);
          if (envId) {
            try {
              const resetResult = await resetEnvironment(envId, config.bcStartAddress);
              config.bcStartAddress = resetResult.bcStartAddress;
              info(`New environment: ${resetResult.envId}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`\nEnvironment reset failed: ${msg}`);
              info('Proceeding with recording on current environment...');
            }
          } else {
            info('Cannot determine envId from URL — skipping environment reset');
          }

          // Recording
          header('Recording');
          const recordResult = await recordDemo(specPath, config, {
            stepDelays: stepAudioPlan?.stepDelays,
            mode: 'record',
          });

          if (recordResult.success) {
            timing = recordResult.timing;
            if (recordResult.videoPath) videoPath = recordResult.videoPath;
          } else {
            console.error(`\nFailed to record: ${recordResult.error}`);
            process.exit(1);
          }
        } else if (mode === 'investigate') {
          // Investigate only
          const result = await recordDemo(specPath, config, {
            mode: 'investigate',
            skipVerify,
          });

          if (result.success) {
            info(`Script written to: ${result.scriptPath}`);
            console.log('\nDone! (investigate-only)');
          } else {
            console.error(`\nInvestigation failed: ${result.error}`);
            process.exit(1);
          }
          process.exit(0);
        } else {
          // Record only (mode === 'record')
          header('Recording');
          const result = await recordDemo(specPath, config, {
            stepDelays: stepAudioPlan?.stepDelays,
            mode: 'record',
          });

          if (result.success) {
            timing = result.timing;
            if (result.videoPath) videoPath = result.videoPath;
          } else {
            console.error(`\nFailed to record: ${result.error}`);
            process.exit(1);
          }
        }
      } else {
        // --skip-record: use existing video
        if (!existsSync(videoPath)) {
          console.error(`Error: --skip-record but no video found at ${videoPath}`);
          process.exit(1);
        }
        info(`Using existing video: ${videoPath}`);

        if (useStepNarration && !stepAudioPlan) {
          header('Narration');
          stepAudioPlan = await generateStepAudio(stepNarration!, specName, outputDir, voiceConfig);
        }
      }

      // ── Phase C: Compose with narration ──
      if (useStepNarration && stepAudioPlan && timing) {
        header('Composing');

        let subtitlePath: string | undefined;
        if (options.subs !== false) {
          subtitlePath = generateSubtitles(
            stepAudioPlan.clips,
            timing as Parameters<typeof generateSubtitles>[1],
            srtPath,
          );
        }

        const compResult = await composeWithStepAudio({
          videoPath,
          clips: stepAudioPlan.clips,
          timing: timing as Parameters<typeof composeWithStepAudio>[0]['timing'],
          subtitlePath,
          outputPath: finalPath,
          trimLogin: options.trim !== false,
        });

        if (compResult.success) {
          info(`Saved: ${parsePath(compResult.videoPath!).base}`);
        } else {
          console.error(`\nFailed to compose: ${compResult.error}`);
          process.exit(1);
        }
      } else if (useSingleNarration) {
        header('Narration (single track)');
        const audioPath = resolve(outputDir, `${specName}.mp3`);
        const narResult = await generateNarration(narrationText!.trim(), audioPath, {
          voice: voiceConfig.voice,
          speed: voiceConfig.speed,
        });
        if (!narResult.success) {
          console.error(`\nFailed to generate narration: ${narResult.error}`);
          process.exit(1);
        }

        header('Composing');
        const compResult = await composeVideo(videoPath, audioPath, finalPath);
        if (compResult.success) {
          info(`Saved: ${parsePath(compResult.videoPath!).base}`);
        } else {
          console.error(`\nFailed to compose: ${compResult.error}`);
          process.exit(1);
        }
      }

      // ── Cleanup intermediate files ──
      if (existsSync(finalPath)) {
        const keep = new Set([finalPath, scriptPath]);
        for (const file of readdirSync(outputDir)) {
          const fullPath = resolve(outputDir, file);
          if (keep.has(fullPath)) continue;
          if (file === 'narration' || file === 'screenshots') {
            rmSync(fullPath, { recursive: true, force: true });
          } else if (
            file.endsWith('.webm') ||
            file.endsWith('.ass') ||
            file.endsWith('.srt') ||
            file.endsWith('.mp3') ||
            file.endsWith('.timing.json')
          ) {
            unlinkSync(fullPath);
          }
        }
        info('Cleaned up intermediate files');
      }

      console.log('\nDone!');
    },
  );

program.parse();
