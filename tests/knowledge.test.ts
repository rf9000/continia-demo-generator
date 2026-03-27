import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readdirSync } from 'fs';
import { resolve } from 'path';
import {
  loadPatterns,
  savePattern,
  incrementSuccess,
  deprecatePattern,
  type KnowledgePattern,
} from '../src/knowledge.js';

const tmpDir = resolve('./test-tmp-knowledge');
const patternsDir = resolve(tmpDir, 'patterns');

describe('knowledge bank', () => {
  beforeEach(() => {
    mkdirSync(patternsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loadPatterns returns empty array for empty directory', () => {
    const patterns = loadPatterns(patternsDir);
    expect(patterns).toEqual([]);
  });

  test('savePattern writes a YAML file and loadPatterns reads it back', () => {
    const pattern: KnowledgePattern = {
      name: 'bc-fasttab-expand',
      description: 'How to expand a collapsed FastTab',
      discovered: '2026-03-27',
      successCount: 1,
      lastUsed: '2026-03-27',
      pattern: {
        identify: 'section with aria-expanded="false"',
        interact: 'click the section header',
        verify: 'aria-expanded changes to "true"',
      },
    };

    savePattern(patternsDir, pattern);

    const files = readdirSync(patternsDir).filter((f) => f.endsWith('.yml'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('bc-fasttab-expand.yml');

    const loaded = loadPatterns(patternsDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('bc-fasttab-expand');
    expect(loaded[0].successCount).toBe(1);
  });

  test('incrementSuccess updates count and lastUsed', () => {
    const pattern: KnowledgePattern = {
      name: 'test-pattern',
      description: 'test',
      discovered: '2026-03-20',
      successCount: 5,
      lastUsed: '2026-03-20',
      pattern: { identify: 'x', interact: 'y', verify: 'z' },
    };
    savePattern(patternsDir, pattern);

    incrementSuccess(patternsDir, 'test-pattern');

    const loaded = loadPatterns(patternsDir);
    expect(loaded[0].successCount).toBe(6);
    expect(loaded[0].lastUsed).not.toBe('2026-03-20');
  });

  test('deprecatePattern sets deprecated flag', () => {
    const pattern: KnowledgePattern = {
      name: 'old-pattern',
      description: 'outdated',
      discovered: '2026-03-10',
      successCount: 3,
      lastUsed: '2026-03-15',
      pattern: { identify: 'a', interact: 'b', verify: 'c' },
    };
    savePattern(patternsDir, pattern);

    deprecatePattern(patternsDir, 'old-pattern', 'replaced by new approach');

    const loaded = loadPatterns(patternsDir, { includeDeprecated: true });
    expect(loaded[0].deprecated).toBe(true);
    expect(loaded[0].deprecatedReason).toBe('replaced by new approach');
  });

  test('loadPatterns excludes deprecated patterns by default', () => {
    savePattern(patternsDir, {
      name: 'active',
      description: 'works',
      discovered: '2026-03-27',
      successCount: 1,
      lastUsed: '2026-03-27',
      pattern: { identify: 'x', interact: 'y', verify: 'z' },
    });
    savePattern(patternsDir, {
      name: 'old',
      description: 'broken',
      discovered: '2026-03-10',
      successCount: 1,
      lastUsed: '2026-03-10',
      deprecated: true,
      deprecatedReason: 'no longer works',
      pattern: { identify: 'a', interact: 'b', verify: 'c' },
    });

    const active = loadPatterns(patternsDir);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('active');

    const all = loadPatterns(patternsDir, { includeDeprecated: true });
    expect(all).toHaveLength(2);
  });
});
