import { resolve, join } from 'path';
import { mkdirSync } from 'fs';
import { generateNarration, getAudioDuration } from './narrator.js';
import type { VoiceConfig } from './locale-voices.js';
import { info } from './log.js';

export interface StepAudioClip {
  stepIndex: number;
  audioPath: string;
  durationMs: number;
  text: string;
}

export interface StepAudioPlan {
  clips: StepAudioClip[];
  stepDelays: Map<number, number>;
}

const AUDIO_BUFFER_MS = 500;
const MIN_STEP_DELAY_MS = 1500;
const MAX_CONCURRENT = 3;

/**
 * Generates per-step TTS audio clips from stepNarration entries.
 * Returns a plan with clips and a stepDelays map that the player uses
 * to adapt its delays to fit each narration clip.
 */
export async function generateStepAudio(
  stepNarration: Record<string, string>,
  specName: string,
  outputDir: string,
  voice: VoiceConfig,
): Promise<StepAudioPlan> {
  const narrationDir = resolve(outputDir, 'narration');
  mkdirSync(narrationDir, { recursive: true });

  const entries = Object.entries(stepNarration)
    .map(([key, text]) => ({ stepIndex: parseInt(key, 10), text: text.trim() }))
    .filter((e) => !isNaN(e.stepIndex) && e.text.length > 0)
    .sort((a, b) => a.stepIndex - b.stepIndex);

  info(`Generating ${entries.length} clips (voice: ${voice.voice})...`);

  // Generate clips with concurrency limit
  const clips: StepAudioClip[] = [];
  for (let i = 0; i < entries.length; i += MAX_CONCURRENT) {
    const batch = entries.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const audioPath = join(narrationDir, `${specName}-step-${entry.stepIndex}.mp3`);
        const result = await generateNarration(entry.text, audioPath, {
          voice: voice.voice,
          speed: voice.speed,
        });

        if (!result.success || !result.audioPath) {
          throw new Error(`Failed to generate audio for step ${entry.stepIndex}: ${result.error}`);
        }

        const durationMs = await getAudioDuration(result.audioPath);

        return {
          stepIndex: entry.stepIndex,
          audioPath: result.audioPath,
          durationMs,
          text: entry.text,
        };
      }),
    );
    clips.push(...results);
  }

  // Build stepDelays map: each narrated step gets audio duration + buffer,
  // non-narrated steps keep the default delay
  const stepDelays = new Map<number, number>();
  for (const clip of clips) {
    const delay = Math.max(clip.durationMs + AUDIO_BUFFER_MS, MIN_STEP_DELAY_MS);
    stepDelays.set(clip.stepIndex, delay);
    info(
      `Step ${clip.stepIndex}: ${(clip.durationMs / 1000).toFixed(1)}s audio -> ${(delay / 1000).toFixed(1)}s delay`,
    );
  }

  return { clips, stepDelays };
}
