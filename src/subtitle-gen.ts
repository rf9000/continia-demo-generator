import { writeFileSync } from 'fs';
import { resolve } from 'path';
import type { StepAudioClip } from './step-audio.js';
import type { StepTimingMetadata } from './script-types.js';
import { info } from './log.js';

const FADE_IN_MS = 300;
const FADE_OUT_MS = 400;
const MAX_WORDS_PER_CHUNK = 12;

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
    const stepTiming = timing.steps.find((s) => s.stepIndex === clip.stepIndex);
    if (!stepTiming) continue;

    const startMs = Math.max(0, stepTiming.startMs - timing.trimStartMs);
    const chunks = splitIntoChunks(clip.text, MAX_WORDS_PER_CHUNK);
    const totalWords = clip.text.split(/\s+/).length;

    // Distribute chunks across the clip duration proportional to word count
    let offsetMs = 0;
    for (const chunk of chunks) {
      const chunkWords = chunk.split(/\s+/).length;
      const chunkDurationMs = Math.round((chunkWords / totalWords) * clip.durationMs);
      const chunkStartMs = startMs + offsetMs;
      const chunkEndMs = chunkStartMs + chunkDurationMs;

      // ASS entry with fade effect
      const wrapped = wrapText(chunk.replace(/\n/g, '\\N'), 70).replace(/\n/g, '\\N');
      assLines.push(
        `Dialogue: 0,${formatAssTime(chunkStartMs)},${formatAssTime(chunkEndMs)},Default,,0,0,0,,{\\fad(${FADE_IN_MS},${FADE_OUT_MS})}${wrapped}`,
      );

      // SRT entry (plain, no effects)
      srtLines.push(String(srtIndex));
      srtLines.push(`${formatSrtTime(chunkStartMs)} --> ${formatSrtTime(chunkEndMs)}`);
      srtLines.push(wrapText(chunk, 60));
      srtLines.push('');
      srtIndex++;

      offsetMs += chunkDurationMs;
    }
  }

  writeFileSync(assPath, assLines.join('\n'), 'utf-8');
  writeFileSync(srtPath, srtLines.join('\n'), 'utf-8');
  info(`Subtitles: ${srtIndex - 1} entries (ASS with fade effects)`);
  return assPath;
}

// ASS time format: H:MM:SS.cc (centiseconds)
export function formatAssTime(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

// SRT time format: HH:MM:SS,mmm
export function formatSrtTime(ms: number): string {
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

/**
 * Splits text into chunks of roughly maxWords words each, breaking at
 * sentence boundaries when possible so subtitles read naturally.
 */
function splitIntoChunks(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [text.trim()];

  // Split into sentences first, then merge small sentences / split large ones
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const sentenceWords = sentence.trim().split(/\s+/);

    // If adding this sentence stays within limit, accumulate
    if (currentWordCount + sentenceWords.length <= maxWords) {
      current.push(sentence.trim());
      currentWordCount += sentenceWords.length;
      continue;
    }

    // Flush current accumulator if non-empty
    if (current.length > 0) {
      chunks.push(current.join(' '));
      current = [];
      currentWordCount = 0;
    }

    // If this sentence itself exceeds maxWords, split it by word count
    if (sentenceWords.length > maxWords) {
      for (let i = 0; i < sentenceWords.length; i += maxWords) {
        chunks.push(sentenceWords.slice(i, i + maxWords).join(' '));
      }
    } else {
      current.push(sentence.trim());
      currentWordCount = sentenceWords.length;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join(' '));
  }

  return chunks;
}

export function wrapText(text: string, maxLineLength: number): string {
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
