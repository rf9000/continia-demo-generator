import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { recordDemo } from '../src/recorder.js';

const tmpDir = resolve('./test-tmp');

describe('recordDemo input validation', () => {
  test('returns error for nonexistent spec file', async () => {
    const result = await recordDemo('/nonexistent/file.yml', {
      bcStartAddress: 'http://localhost/bc/',
      bcAuth: 'Windows',
      outputDir: './output',
      headed: false,
      visionModel: 'claude-sonnet-4-6-20250514',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});

describe('recordDemo execution', () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test(
    'returns error when script file is missing in record mode',
    { timeout: 10_000 },
    async () => {
      const specFile = join(tmpDir, 'test-spec.yml');
      writeFileSync(
        specFile,
        'description: test\nsteps:\n  - type: action\n    target:\n      - page: Test\n    caption: OK',
      );

      const result = await recordDemo(
        specFile,
        {
          bcStartAddress: 'http://localhost:19222/bc/',
          bcAuth: 'Windows',
          outputDir: join(tmpDir, 'output'),
          headed: false,
          visionModel: 'claude-sonnet-4-6-20250514',
        },
        { mode: 'record' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No script found');
    },
  );
});
