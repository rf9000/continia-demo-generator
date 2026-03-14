import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';

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
    `-c:v libx264`,     // Re-encode video to H.264 for MP4 compatibility
    `-c:a aac`,         // Encode audio as AAC
    `-b:a 192k`,        // Audio bitrate
    `-map 0:v:0`,       // Video from first input
    `-map 1:a:0`,       // Audio from second input
    `-y`,               // Overwrite output
    `"${absOutput}"`,
  ].join(' ');

  console.log(`Composing video + narration → ${absOutput}`);

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 60_000 });
    console.log(`Composed video saved: ${absOutput}`);
    return { success: true, videoPath: absOutput };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `FFmpeg failed: ${message}` };
  }
}
