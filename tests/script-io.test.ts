// tests/script-io.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { computeSpecHash, writeScript, readScript, isScriptValid } from '../src/script-io.js';
import type { ScriptFile } from '../src/script-types.js';

const tmpDir = resolve('./test-tmp-script');

describe('computeSpecHash', () => {
  test('returns consistent hash for same steps', () => {
    const steps = [
      { type: 'action', target: [{ page: 'Test' }], caption: 'OK' },
      { type: 'input', target: [{ page: 'Test', field: 'Name' }], value: 'X' },
    ];
    const hash1 = computeSpecHash(steps);
    const hash2 = computeSpecHash(steps);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  test('returns different hash when steps change', () => {
    const steps1 = [{ type: 'action', caption: 'OK' }];
    const steps2 = [{ type: 'action', caption: 'Cancel' }];
    expect(computeSpecHash(steps1)).not.toBe(computeSpecHash(steps2));
  });
});

describe('writeScript / readScript', () => {
  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const sampleScript: ScriptFile = {
    specHash: 'abc123',
    model: 'claude-sonnet-4-6-20250514',
    investigatedAt: '2026-03-27T14:00:00Z',
    viewportSize: { width: 1920, height: 1080 },
    steps: [
      {
        index: 0,
        source: { type: 'action', caption: 'Post' },
        action: 'click',
        coordinates: { x: 850, y: 120 },
        confidence: 0.92,
        prep: [],
        verification: { success: true, observation: 'Dialog appeared' },
        screenshot: 'step-00-before.png',
      },
    ],
  };

  test('round-trips a script through write and read', () => {
    const path = resolve(tmpDir, 'test.script.yml');
    writeScript(sampleScript, path);
    const loaded = readScript(path);
    expect(loaded.specHash).toBe('abc123');
    expect(loaded.steps).toHaveLength(1);
    expect(loaded.steps[0].coordinates).toEqual({ x: 850, y: 120 });
  });
});

describe('isScriptValid', () => {
  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('returns true when spec hash matches', () => {
    const specPath = resolve(tmpDir, 'spec.yml');
    const scriptPath = resolve(tmpDir, 'spec.script.yml');
    const specContent = 'description: test\nsteps:\n  - type: action\n    caption: OK\n';
    writeFileSync(specPath, specContent);

    const steps = [{ type: 'action', caption: 'OK' }];
    const hash = computeSpecHash(steps);
    const script: ScriptFile = {
      specHash: hash,
      model: 'test',
      investigatedAt: 'now',
      viewportSize: { width: 1920, height: 1080 },
      steps: [],
    };
    writeScript(script, scriptPath);

    expect(isScriptValid(specPath, scriptPath)).toBe(true);
  });

  test('returns false when spec has changed', () => {
    const specPath = resolve(tmpDir, 'spec.yml');
    const scriptPath = resolve(tmpDir, 'spec.script.yml');
    writeFileSync(specPath, 'description: test\nsteps:\n  - type: action\n    caption: Cancel\n');

    const script: ScriptFile = {
      specHash: 'stale-hash',
      model: 'test',
      investigatedAt: 'now',
      viewportSize: { width: 1920, height: 1080 },
      steps: [],
    };
    writeScript(script, scriptPath);

    expect(isScriptValid(specPath, scriptPath)).toBe(false);
  });

  test('returns false when script file does not exist', () => {
    const specPath = resolve(tmpDir, 'spec.yml');
    writeFileSync(specPath, 'description: test\nsteps:\n  - type: action\n    caption: OK\n');
    expect(isScriptValid(specPath, resolve(tmpDir, 'missing.yml'))).toBe(false);
  });
});
