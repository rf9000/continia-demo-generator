import OpenAI from 'openai';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';

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
  },
): Promise<NarrationResult> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY not set in environment' };
  }

  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });

  const openai = new OpenAI({ apiKey });

  try {
    console.log(
      `Generating narration (${text.length} chars, voice: ${options?.voice ?? 'nova'})...`,
    );

    const expandedText = expandAbbreviations(text);

    const response = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: options?.voice ?? 'nova',
      input: expandedText,
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

/**
 * Probes an audio file's duration in milliseconds using FFmpeg.
 */
export async function getAudioDuration(audioPath: string): Promise<number> {
  const ffmpeg = getFFmpegPath();
  const absPath = resolve(audioPath);

  // FFmpeg prints duration to stderr even when it "fails" (no output specified).
  // We intentionally omit an output to just probe the input.
  try {
    execSync(`"${ffmpeg}" -i "${absPath}" 2>&1`, { encoding: 'utf-8', stdio: 'pipe' });
    return 0; // Won't reach here — FFmpeg always exits non-zero without output
  } catch (error: unknown) {
    const output =
      (error as { stdout?: string }).stdout ?? (error as { stderr?: string }).stderr ?? '';
    return parseDuration(output);
  }
}

// Common BC abbreviations → spoken form for TTS
const BC_ABBREVIATIONS: [RegExp, string][] = [
  [/\bNo\./g, 'Number'],
  [/\bAcc\./g, 'Account'],
  [/\bRecon\./g, 'Reconciliation'],
  [/\bStmt\./g, 'Statement'],
  [/\bAmt\./g, 'Amount'],
  [/\bBal\./g, 'Balance'],
  [/\bQty\./g, 'Quantity'],
  [/\bDesc\./g, 'Description'],
  [/\bDoc\./g, 'Document'],
  [/\bPmt\./g, 'Payment'],
  [/\bJnl\./g, 'Journal'],
  [/\bGen\./g, 'General'],
  [/\bCust\./g, 'Customer'],
  [/\bVend\./g, 'Vendor'],
  [/\bInv\./g, 'Invoice'],
  [/\bDim\./g, 'Dimension'],
  [/\bCurr\./g, 'Currency'],
  [/\bExt\./g, 'External'],
  [/\bId\b/g, 'I.D.'],
];

function expandAbbreviations(text: string): string {
  let result = text;
  for (const [pattern, replacement] of BC_ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function parseDuration(output: string): number {
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) throw new Error('Could not parse audio duration from FFmpeg output');
  const [, hours, minutes, seconds, centiseconds] = match;
  return (
    parseInt(hours, 10) * 3600_000 +
    parseInt(minutes, 10) * 60_000 +
    parseInt(seconds, 10) * 1000 +
    parseInt(centiseconds.padEnd(3, '0').slice(0, 3), 10)
  );
}

function getFFmpegPath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}
