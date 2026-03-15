import { describe, test, expect, vi, beforeEach } from 'vitest';
import { formatAssTime, formatSrtTime, wrapText, generateSubtitles } from '../src/subtitle-gen.js';
import type { StepAudioClip } from '../src/step-audio.js';
import type { StepTimingMetadata } from '../src/player.js';
import * as fs from 'fs';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFileSync: vi.fn() };
});

describe('formatAssTime', () => {
  test('0ms → 0:00:00.00', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00');
  });

  test('1500ms → 0:00:01.50', () => {
    expect(formatAssTime(1500)).toBe('0:00:01.50');
  });

  test('61000ms → 0:01:01.00', () => {
    expect(formatAssTime(61000)).toBe('0:01:01.00');
  });

  test('3661000ms → 1:01:01.00', () => {
    expect(formatAssTime(3661000)).toBe('1:01:01.00');
  });

  test('fractional centiseconds → 550ms = 0:00:00.55', () => {
    expect(formatAssTime(550)).toBe('0:00:00.55');
  });

  test('999ms → 0:00:00.99', () => {
    expect(formatAssTime(999)).toBe('0:00:00.99');
  });
});

describe('formatSrtTime', () => {
  test('0ms → 00:00:00,000', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
  });

  test('1500ms → 00:00:01,500', () => {
    expect(formatSrtTime(1500)).toBe('00:00:01,500');
  });

  test('61000ms → 00:01:01,000', () => {
    expect(formatSrtTime(61000)).toBe('00:01:01,000');
  });

  test('3661000ms → 01:01:01,000', () => {
    expect(formatSrtTime(3661000)).toBe('01:01:01,000');
  });

  test('uses comma separator (not dot)', () => {
    expect(formatSrtTime(1234)).toContain(',');
    expect(formatSrtTime(1234)).not.toMatch(/\.\d{3}$/);
  });

  test('1234ms → 00:00:01,234', () => {
    expect(formatSrtTime(1234)).toBe('00:00:01,234');
  });
});

describe('wrapText', () => {
  test('short text returns unchanged', () => {
    expect(wrapText('Hello world', 70)).toBe('Hello world');
  });

  test('wraps at maxLineLength boundary', () => {
    const result = wrapText('word word word word word', 12);
    const lines = result.split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  test('long word exceeding limit stays on its own line', () => {
    const longWord = 'superlongword';
    const result = wrapText(`hi ${longWord} end`, 5);
    expect(result).toContain(longWord);
  });

  test('empty string returns empty', () => {
    expect(wrapText('', 70)).toBe('');
  });

  test('multi-word wrap produces multiple lines', () => {
    const text = 'The quick brown fox jumps over the lazy dog by the river';
    const result = wrapText(text, 20);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('generateSubtitles', () => {
  const writtenFiles: Record<string, string> = {};
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);

  beforeEach(() => {
    for (const key of Object.keys(writtenFiles)) delete writtenFiles[key];
    mockWriteFileSync.mockImplementation((path: fs.PathOrFileDescriptor, data: unknown) => {
      writtenFiles[String(path)] = String(data);
    });
  });

  test('generates ASS file with correct structure', () => {
    const clips: StepAudioClip[] = [
      { stepIndex: 0, text: 'First step narration', durationMs: 3000, audioPath: '/tmp/0.mp3' },
      { stepIndex: 1, text: 'Second step narration', durationMs: 2500, audioPath: '/tmp/1.mp3' },
    ];

    const timing: StepTimingMetadata = {
      trimStartMs: 0,
      steps: [
        { stepIndex: 0, startMs: 0, endMs: 3000 },
        { stepIndex: 1, startMs: 4000, endMs: 6500 },
      ],
    };

    const result = generateSubtitles(clips, timing, '/tmp/output/demo.ass');

    expect(result).toMatch(/\.ass$/);

    // Check ASS content
    const assContent = Object.entries(writtenFiles).find(([k]) => k.endsWith('.ass'))?.[1];
    expect(assContent).toBeDefined();
    expect(assContent).toContain('[Script Info]');
    expect(assContent).toContain('[V4+ Styles]');
    expect(assContent).toContain('[Events]');
    expect(assContent).toContain('\\fad(300,400)');
    expect(assContent).toContain('First step narration');
    expect(assContent).toContain('Second step narration');

    // Check SRT content
    const srtContent = Object.entries(writtenFiles).find(([k]) => k.endsWith('.srt'))?.[1];
    expect(srtContent).toBeDefined();
    expect(srtContent).toContain('First step narration');
    expect(srtContent).toContain('-->');
  });

  test('skips clips without matching timing entry', () => {
    const clips: StepAudioClip[] = [
      { stepIndex: 99, text: 'Orphan clip', durationMs: 1000, audioPath: '/tmp/99.mp3' },
    ];

    const timing: StepTimingMetadata = {
      trimStartMs: 0,
      steps: [{ stepIndex: 0, startMs: 0, endMs: 1000 }],
    };

    generateSubtitles(clips, timing, '/tmp/output/demo.ass');

    // Should complete without error — orphan clip is silently skipped
    const assContent = Object.entries(writtenFiles).find(([k]) => k.endsWith('.ass'))?.[1];
    expect(assContent).not.toContain('Orphan clip');
  });

  test('accounts for trimStartMs offset', () => {
    const clips: StepAudioClip[] = [
      { stepIndex: 0, text: 'After trim', durationMs: 2000, audioPath: '/tmp/0.mp3' },
    ];

    const timing: StepTimingMetadata = {
      trimStartMs: 5000,
      steps: [{ stepIndex: 0, startMs: 7000, endMs: 9000 }],
    };

    generateSubtitles(clips, timing, '/tmp/output/demo.ass');

    const assContent = Object.entries(writtenFiles).find(([k]) => k.endsWith('.ass'))?.[1];
    // startMs(7000) - trimStartMs(5000) = 2000ms → 0:00:02.00
    expect(assContent).toContain('0:00:02.00');
  });
});
