// tests/vision.test.ts
import { describe, test, expect } from 'vitest';
import {
  buildLocatePrompt,
  buildVerifyPrompt,
  buildInputPrompt,
  parseLocateResponse,
  parseVerifyResponse,
} from '../src/vision.js';

describe('buildLocatePrompt', () => {
  test('builds prompt for action step with caption', () => {
    const prompt = buildLocatePrompt({ type: 'action', caption: 'Post' });
    expect(prompt).toContain('Post');
    expect(prompt).toContain('button');
  });

  test('builds prompt for action step with row', () => {
    const prompt = buildLocatePrompt({ type: 'action', row: 'PMT JNL' });
    expect(prompt).toContain('PMT JNL');
    expect(prompt).toContain('row');
  });

  test('builds prompt for assistEdit step', () => {
    const prompt = buildLocatePrompt({ type: 'action', caption: 'Batch Name', assistEdit: true });
    expect(prompt).toContain('Batch Name');
    expect(prompt).toContain('assist');
  });
});

describe('buildInputPrompt', () => {
  test('builds prompt for input step', () => {
    const prompt = buildInputPrompt({ type: 'input', field: 'Bank Name', value: 'Danske Bank' });
    expect(prompt).toContain('Bank Name');
    expect(prompt).toContain('input');
  });
});

describe('parseLocateResponse', () => {
  test('parses valid JSON response', () => {
    const json = {
      element: 'Post button',
      coordinates: { x: 850, y: 120 },
      confidence: 0.92,
      prep: [],
      observation: 'Found the Post button in the action bar',
    };
    const result = parseLocateResponse(JSON.stringify(json));
    expect(result.coordinates).toEqual({ x: 850, y: 120 });
    expect(result.confidence).toBe(0.92);
  });

  test('parses response with prep actions', () => {
    const json = {
      element: 'Bank Name field',
      coordinates: { x: 600, y: 340 },
      confidence: 0.88,
      prep: [{ action: 'scroll', direction: 'down', px: 200, reason: 'field below fold' }],
      observation: 'Field is in General FastTab',
    };
    const result = parseLocateResponse(JSON.stringify(json));
    expect(result.prep).toHaveLength(1);
    expect(result.prep[0].action).toBe('scroll');
  });

  test('extracts JSON from markdown code block', () => {
    const response =
      'Here is the result:\n```json\n{"element":"OK","coordinates":{"x":100,"y":200},"confidence":0.9,"prep":[],"observation":"found"}\n```';
    const result = parseLocateResponse(response);
    expect(result.coordinates).toEqual({ x: 100, y: 200 });
  });

  test('throws on unparseable response', () => {
    expect(() => parseLocateResponse('I cannot find anything')).toThrow();
  });
});

describe('parseVerifyResponse', () => {
  test('parses successful verification', () => {
    const json = { success: true, observation: 'Dialog appeared' };
    const result = parseVerifyResponse(JSON.stringify(json));
    expect(result.success).toBe(true);
  });

  test('parses failed verification', () => {
    const json = { success: false, observation: 'Nothing changed on the page' };
    const result = parseVerifyResponse(JSON.stringify(json));
    expect(result.success).toBe(false);
    expect(result.observation).toContain('Nothing changed');
  });
});

describe('buildVerifyPrompt', () => {
  test('includes step description', () => {
    const prompt = buildVerifyPrompt({ type: 'action', caption: 'Post' }, { x: 850, y: 120 });
    expect(prompt).toContain('Post');
    expect(prompt).toContain('850');
  });
});
