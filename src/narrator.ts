import OpenAI from 'openai';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export interface NarrationResult {
  success: boolean;
  audioPath?: string;
  error?: string;
}

/**
 * Generates TTS audio from narration text using OpenAI's TTS API.
 * Returns the path to the generated audio file.
 */
export async function generateNarration(
  text: string,
  outputPath: string,
  options?: {
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
    speed?: number;
  }
): Promise<NarrationResult> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY not set in environment' };
  }

  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });

  const openai = new OpenAI({ apiKey });

  try {
    console.log(`Generating narration (${text.length} chars, voice: ${options?.voice ?? 'nova'})...`);

    const response = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: options?.voice ?? 'nova',
      input: text,
      speed: options?.speed ?? 1.0,
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(absolutePath, buffer);
    console.log(`Narration saved: ${absolutePath} (${(buffer.length / 1024).toFixed(0)} KB)`);

    return { success: true, audioPath: absolutePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `TTS generation failed: ${message}` };
  }
}
