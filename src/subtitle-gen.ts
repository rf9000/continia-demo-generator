import { writeFileSync } from 'fs';
import { resolve } from 'path';
import type { StepAudioClip } from './step-audio.js';
import type { StepTimingMetadata } from './player.js';

const FADE_IN_MS = 300;
const FADE_OUT_MS = 400;

/**
 * Generates an ASS subtitle file with fade-in/fade-out effects.
 * ASS format gives us smooth transitions that look like real movie subtitles.
 * Also generates a plain SRT sidecar for accessibility.
 */
export function generateSubtitles(
  clips: StepAudioClip[],
  timing: StepTimingMetadata,
  outputPath: string,
): string {
  const absPath = resolve(outputPath);
  const srtPath = absPath.replace(/\.ass$/, '.srt').replace(/\.srt$/, '.srt');
  const assPath = absPath.replace(/\.srt$/, '.ass');

  const assLines: string[] = [
    '[Script Info]',
    'Title: Demo Narration',
    'ScriptType: v4.00+',
    'PlayResX: 1440',
    'PlayResY: 900',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,50,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const srtLines: string[] = [];
  let srtIndex = 1;

  for (const clip of clips) {
    const stepTiming = timing.steps.find(s => s.stepIndex === clip.stepIndex);
    if (!stepTiming) continue;

    const startMs = Math.max(0, stepTiming.startMs - timing.trimStartMs);
    const endMs = startMs + clip.durationMs;

    // ASS entry with fade effect
    const text = clip.text.replace(/\n/g, '\\N');
    const wrapped = wrapText(text, 70).replace(/\n/g, '\\N');
    assLines.push(
      `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Default,,0,0,0,,{\\fad(${FADE_IN_MS},${FADE_OUT_MS})}${wrapped}`
    );

    // SRT entry (plain, no effects)
    srtLines.push(String(srtIndex));
    srtLines.push(`${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}`);
    srtLines.push(wrapText(clip.text, 60));
    srtLines.push('');
    srtIndex++;
  }

  writeFileSync(assPath, assLines.join('\n'), 'utf-8');
  writeFileSync(srtPath, srtLines.join('\n'), 'utf-8');
  console.log(`Subtitles saved: ${assPath} (${srtIndex - 1} entries, with fade effects)`);
  return assPath;
}

// ASS time format: H:MM:SS.cc (centiseconds)
function formatAssTime(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

// SRT time format: HH:MM:SS,mmm
function formatSrtTime(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad3(millis)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function wrapText(text: string, maxLineLength: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxLineLength && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.join('\n');
}
