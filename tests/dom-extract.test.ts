import { describe, test, expect } from 'vitest';
import { cleanHtml, detectLayers, extractScrollState } from '../src/dom-extract.js';

describe('cleanHtml', () => {
  test('strips script and style tags', () => {
    const html = '<div><script>alert(1)</script><style>.x{}</style><span>Hello</span></div>';
    const result = cleanHtml(html);
    expect(result).not.toContain('script');
    expect(result).not.toContain('style');
    expect(result).toContain('Hello');
  });

  test('keeps aria attributes and role', () => {
    const html = '<button role="menuitem" aria-label="New">+ New</button>';
    const result = cleanHtml(html);
    expect(result).toContain('role="menuitem"');
    expect(result).toContain('aria-label="New"');
    expect(result).toContain('New');
  });

  test('keeps controlname attribute', () => {
    const html = '<div controlname="Bank Name"><input value="Test"/></div>';
    const result = cleanHtml(html);
    expect(result).toContain('controlname="Bank Name"');
    expect(result).toContain('value="Test"');
  });

  test('keeps aria-expanded state', () => {
    const html = '<section aria-expanded="false" aria-label="Posting"></section>';
    const result = cleanHtml(html);
    expect(result).toContain('aria-expanded="false"');
    expect(result).toContain('aria-label="Posting"');
  });

  test('collapses empty wrapper divs', () => {
    const html = '<div><div><div><span>Content</span></div></div></div>';
    const result = cleanHtml(html);
    // Should not have 3 nested divs — just the content
    const divCount = (result.match(/<div/g) || []).length;
    expect(divCount).toBeLessThan(3);
  });

  test('strips hidden elements', () => {
    const html = '<div style="display:none">Hidden</div><div>Visible</div>';
    const result = cleanHtml(html);
    expect(result).not.toContain('Hidden');
    expect(result).toContain('Visible');
  });

  test('truncates long text content', () => {
    const longText = 'A'.repeat(200);
    const html = `<span>${longText}</span>`;
    const result = cleanHtml(html);
    expect(result.length).toBeLessThan(html.length);
  });
});

describe('detectLayers', () => {
  test('detects dialog overlay', () => {
    const html = '<div><div role="dialog" style="z-index:1000">Dialog content</div><div>Background</div></div>';
    const layers = detectLayers(html);
    expect(layers.length).toBeGreaterThanOrEqual(1);
    expect(layers[0].isActive).toBe(true);
  });
});

describe('extractScrollState', () => {
  test('parses scroll attributes from cleaned HTML', () => {
    const html = '<section scroll-y="100/800" scroll-x="0/1920">content</section>';
    const state = extractScrollState(html);
    expect(state.canScrollDown).toBe(true);
  });
});
