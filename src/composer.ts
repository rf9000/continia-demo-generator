import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { createRequire } from 'module';
import type { StepAudioClip } from './step-audio.js';
import type { StepTimingMetadata } from './player.js';
import { info, debug } from './log.js';

function getFFmpegPath(): string {
  // Use ffmpeg-static (bundled full FFmpeg)
  const require = createRequire(import.meta.url);
  const ffmpegStatic = require('ffmpeg-static') as string;
  if (ffmpegStatic && existsSync(ffmpegStatic)) return ffmpegStatic;

  // Fallback to system FFmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    throw new Error('FFmpeg not found. Run: npm install ffmpeg-static');
  }
}

export interface ComposeResult {
  success: boolean;
  videoPath?: string;
  error?: string;
}

/**
 * Combines a video file with an audio narration track into a final MP4.
 * The narration audio is mixed under the video. If the video is longer
 * than the audio, the remaining video plays in silence. If the audio is
 * longer, the video holds the last frame.
 */
export async function composeVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<ComposeResult> {
  const ffmpeg = getFFmpegPath();
  const absVideo = resolve(videoPath);
  const absAudio = resolve(audioPath);
  const absOutput = resolve(outputPath);

  if (!existsSync(absVideo)) {
    return { success: false, error: `Video not found: ${absVideo}` };
  }
  if (!existsSync(absAudio)) {
    return { success: false, error: `Audio not found: ${absAudio}` };
  }

  mkdirSync(dirname(absOutput), { recursive: true });

  // Compose: take video from input 0, audio from input 1.
  // -shortest: end when the shorter stream ends (if video < audio)
  // If video > audio, the audio just stops and video continues silently.
  const cmd = [
    `"${ffmpeg}"`,
    `-i "${absVideo}"`,
    `-i "${absAudio}"`,
    `-c:v libx264`, // Re-encode video to H.264 for MP4 compatibility
    `-c:a aac`, // Encode audio as AAC
    `-b:a 192k`, // Audio bitrate
    `-map 0:v:0`, // Video from first input
    `-map 1:a:0`, // Audio from second input
    `-y`, // Overwrite output
    `"${absOutput}"`,
  ].join(' ');

  info('Composing final video...');

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 60_000 });
    debug(`Composed video saved: ${absOutput}`);
    return { success: true, videoPath: absOutput };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `FFmpeg failed: ${message}` };
  }
}

export interface StepComposeOptions {
  videoPath: string;
  clips: StepAudioClip[];
  timing: StepTimingMetadata;
  subtitlePath?: string;
  outputPath: string;
  trimLogin?: boolean;
}

/**
 * Composes video with per-step audio clips, optional subtitles, and login trimming.
 * Builds a time-aligned audio track by concatenating silence gaps + clips,
 * then merges with the video via FFmpeg.
 */
export async function composeWithStepAudio(options: StepComposeOptions): Promise<ComposeResult> {
  const ffmpeg = getFFmpegPath();
  const { videoPath, clips, timing, subtitlePath, outputPath, trimLogin = true } = options;
  const absVideo = resolve(videoPath);
  const absOutput = resolve(outputPath);

  if (!existsSync(absVideo)) {
    return { success: false, error: `Video not found: ${absVideo}` };
  }

  mkdirSync(dirname(absOutput), { recursive: true });

  // Create temp directory for intermediate files
  const tmpDir = resolve(dirname(absOutput), `.tmp-compose-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Step 1: Build the concatenated audio track
    const trimMs = trimLogin ? timing.trimStartMs : 0;
    const combinedAudioPath = join(tmpDir, 'combined.mp3');

    await buildCombinedAudio(ffmpeg, clips, timing, trimMs, tmpDir, combinedAudioPath);

    // Step 2: Compose video + audio + optional subtitles
    // Note: -ss AFTER -i for webm (input seeking on webm is unreliable)
    const cmdParts = [`"${ffmpeg}"`];
    cmdParts.push(`-i "${absVideo}"`);
    cmdParts.push(`-i "${combinedAudioPath}"`);

    // Build video filter chain
    const vFilters: string[] = [];
    if (trimLogin && trimMs > 0) {
      // Use setpts to trim from the start instead of -ss (more reliable for webm)
      vFilters.push(`trim=start=${(trimMs / 1000).toFixed(3)},setpts=PTS-STARTPTS`);
    }
    if (subtitlePath && existsSync(resolve(subtitlePath))) {
      const absSubPath = resolve(subtitlePath).replace(/\\/g, '/').replace(/:/g, '\\:');
      // Use ASS filter — styles and fade effects are embedded in the .ass file
      vFilters.push(`ass='${absSubPath}'`);
    }
    if (vFilters.length > 0) {
      cmdParts.push(`-vf "${vFilters.join(',')}"`);
    }

    // Note: do NOT trim the audio — buildCombinedAudio already places clips
    // at trim-adjusted positions (stepStartMs - trimMs), so the audio track
    // is already aligned to the trimmed video timeline.

    cmdParts.push('-c:v libx264');
    cmdParts.push('-c:a aac');
    cmdParts.push('-b:a 192k');
    cmdParts.push('-map 0:v:0');
    cmdParts.push('-map 1:a:0');
    // Don't use -shortest: let the video play fully even if audio is shorter
    cmdParts.push('-y');
    cmdParts.push(`"${absOutput}"`);

    const cmd = cmdParts.join(' ');
    debug(`FFmpeg cmd: ${cmd}`);
    info('Composing final video...');

    try {
      execSync(cmd, { stdio: 'pipe', timeout: 120_000 });
    } catch (e: unknown) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
      console.error('FFmpeg stderr:', stderr.slice(-500));
      throw e;
    }
    debug(`Composed video saved: ${absOutput}`);

    return { success: true, videoPath: absOutput };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Composition failed: ${message}` };
  } finally {
    // Clean up temp files
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Builds a single audio file by concatenating silence gaps and step clips
 * in the correct order, time-aligned to the trimmed video timeline.
 */
async function buildCombinedAudio(
  ffmpeg: string,
  clips: StepAudioClip[],
  timing: StepTimingMetadata,
  trimMs: number,
  tmpDir: string,
  outputPath: string,
): Promise<void> {
  const sortedClips = [...clips].sort((a, b) => a.stepIndex - b.stepIndex);
  const concatEntries: string[] = [];
  let currentTimeMs = 0;

  for (const clip of sortedClips) {
    const stepTiming = timing.steps.find((s) => s.stepIndex === clip.stepIndex);
    if (!stepTiming) continue;

    // When this clip should start in the trimmed timeline
    const clipStartMs = Math.max(0, stepTiming.startMs - trimMs);

    // Generate silence to fill the gap before this clip
    const silenceDurationMs = clipStartMs - currentTimeMs;
    if (silenceDurationMs > 50) {
      // Skip trivial gaps
      const silencePath = join(tmpDir, `silence-${clip.stepIndex}.mp3`);
      const silenceSec = (silenceDurationMs / 1000).toFixed(3);
      // Match TTS sample rate (24000 Hz mono) so concat timing stays in sync
      execSync(
        `"${ffmpeg}" -f lavfi -i anullsrc=r=24000:cl=mono -t ${silenceSec} -c:a libmp3lame -q:a 9 "${silencePath}"`,
        { stdio: 'pipe', timeout: 10_000 },
      );
      concatEntries.push(`file '${silencePath.replace(/\\/g, '/')}'`);
    }

    // Add the audio clip
    concatEntries.push(`file '${resolve(clip.audioPath).replace(/\\/g, '/')}'`);
    currentTimeMs = clipStartMs + clip.durationMs;
  }

  if (concatEntries.length === 0) {
    // No clips — generate a short silence as placeholder
    execSync(
      `"${ffmpeg}" -f lavfi -i anullsrc=r=24000:cl=mono -t 1 -c:a libmp3lame -q:a 9 "${outputPath}"`,
      { stdio: 'pipe', timeout: 10_000 },
    );
    return;
  }

  // Write concat list and concatenate
  const concatListPath = join(tmpDir, 'concat-list.txt');
  writeFileSync(concatListPath, concatEntries.join('\n'), 'utf-8');

  execSync(`"${ffmpeg}" -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  });

  info(`Audio: ${concatEntries.length} segments`);
}
