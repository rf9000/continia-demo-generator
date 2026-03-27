// tests/dom-interpreter.test.ts
import { describe, test, expect } from 'vitest';
import {
  buildSurveyPrompt,
  buildLocatePrompt,
  buildConfirmPrompt,
  parseSurveyResponse,
  parseLocateResponse,
  parseConfirmResponse,
} from '../src/dom-interpreter.js';

describe('buildSurveyPrompt', () => {
  test('includes HTML in the prompt', () => {
    const html = '<section aria-label="General"><input controlname="Name"/></section>';
    const prompt = buildSurveyPrompt(html, []);
    expect(prompt).toContain('General');
    expect(prompt).toContain('Name');
  });

  test('includes knowledge patterns when provided', () => {
    const prompt = buildSurveyPrompt('<div>page</div>', [
      {
        name: 'bc-fasttab',
        description: 'FastTab pattern',
        discovered: '2026-03-27',
        successCount: 5,
        lastUsed: '2026-03-27',
        pattern: { identify: 'aria-expanded', interact: 'click', verify: 'expanded' },
      },
    ]);
    expect(prompt).toContain('bc-fasttab');
    expect(prompt).toContain('aria-expanded');
  });
});

describe('buildLocatePrompt', () => {
  test('includes field name and HTML', () => {
    const html =
      '<section aria-label="Posting"><div controlname="Currency Code"><input/></div></section>';
    const prompt = buildLocatePrompt(
      html,
      { type: 'input', field: 'Currency Code', value: 'EUR' },
      [],
    );
    expect(prompt).toContain('Currency Code');
    expect(prompt).toContain('Posting');
  });

  test('includes action caption for action steps', () => {
    const html = '<button role="menuitem" aria-label="Post">Post</button>';
    const prompt = buildLocatePrompt(html, { type: 'action', caption: 'Post' }, []);
    expect(prompt).toContain('Post');
    expect(prompt).toContain('selector');
  });
});

describe('buildConfirmPrompt', () => {
  test('includes previous locate result', () => {
    const html = '<div controlname="Currency Code"><input value="EUR"/></div>';
    const prompt = buildConfirmPrompt(html, 'Currency Code', '[controlname="Currency Code"] input');
    expect(prompt).toContain('Currency Code');
    expect(prompt).toContain('controlname');
  });
});

describe('parseSurveyResponse', () => {
  test('parses valid survey JSON', () => {
    const json = JSON.stringify({
      pageType: 'card',
      pageTitle: 'Bank Account Card',
      isOverlay: false,
      sections: [
        { name: 'General', expanded: true, fields: ['No.', 'Name'] },
        { name: 'Posting', expanded: false, fields: [] },
      ],
      actionBar: ['Edit', 'New'],
      scroll: { canScrollDown: true, canScrollRight: false },
    });
    const result = parseSurveyResponse(json);
    expect(result.pageType).toBe('card');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].fields).toContain('No.');
  });
});

describe('parseLocateResponse', () => {
  test('parses locate result with steps', () => {
    const json = JSON.stringify({
      found: true,
      section: 'Posting',
      sectionExpanded: false,
      stepsToReach: [{ action: 'expandSection', selector: '[aria-label="Posting"]' }],
      interactSelector: '[controlname="Currency Code"] input',
      confidence: 'high',
      reasoning: 'Field is in collapsed Posting FastTab.',
    });
    const result = parseLocateResponse(json);
    expect(result.found).toBe(true);
    expect(result.interactSelector).toContain('Currency Code');
    expect(result.stepsToReach).toHaveLength(1);
  });
});

describe('parseConfirmResponse', () => {
  test('parses confirmed result', () => {
    const json = JSON.stringify({
      confirmed: true,
      selector: '[controlname="Currency Code"] input',
      visible: true,
      reasoning: 'Posting FastTab is now expanded.',
    });
    const result = parseConfirmResponse(json);
    expect(result.confirmed).toBe(true);
    expect(result.selector).toContain('Currency Code');
  });
});
