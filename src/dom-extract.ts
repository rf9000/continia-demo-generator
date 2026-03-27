import type { Frame } from 'playwright';
import { debug } from './log.js';

/** Attributes to keep during HTML cleaning. */
const KEEP_ATTRS = [
  'role', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-checked',
  'aria-disabled', 'aria-haspopup', 'controlname', 'title', 'type', 'value',
  'placeholder', 'name',
];

/** Tags to strip entirely (including contents). */
const STRIP_TAGS = ['script', 'style', 'svg', 'noscript', 'link', 'meta'];

/** Max text content length per element. */
const MAX_TEXT_LENGTH = 50;

export interface LayerInfo {
  description: string;
  isActive: boolean;
}

export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

/**
 * Extracts cleaned, semantically meaningful HTML from the BC iframe.
 * Detects overlays, strips noise, keeps interactive attributes.
 * This runs entirely in the browser via frame.evaluate().
 */
export async function extractPageHtml(frame: Frame): Promise<{
  html: string;
  layers: LayerInfo[];
  scroll: ScrollState;
}> {
  const result = await frame.evaluate(() => {
    const KEEP = [
      'role', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-checked',
      'aria-disabled', 'aria-haspopup', 'controlname', 'title', 'type', 'value',
      'placeholder', 'name',
    ];
    const STRIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'LINK', 'META']);
    const MAX_TEXT = 50;

    // Detect overlay layers
    const layers: Array<{ description: string; isActive: boolean }> = [];
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [class*="ms-nav-popup"], [class*="modal-dialog"]',
    );
    let activeLayer: Element | null = null;
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const d = dialogs[i] as HTMLElement;
      if (d.offsetWidth > 0 && d.offsetHeight > 0) {
        if (!activeLayer) {
          activeLayer = d;
          layers.push({
            description: d.getAttribute('aria-label') || d.textContent?.slice(0, 40) || 'dialog',
            isActive: true,
          });
        } else {
          layers.push({
            description: d.getAttribute('aria-label') || d.textContent?.slice(0, 40) || 'dialog',
            isActive: false,
          });
        }
      }
    }

    // Determine the root element to extract from
    const root = activeLayer ?? document.body;

    // Recursive HTML cleaning
    function cleanNode(node: Node, depth: number): string {
      if (depth > 30) return ''; // prevent infinite nesting

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (!text) return '';
        return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '...' : text;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node as HTMLElement;
      const tag = el.tagName;

      // Strip tags
      if (STRIP.has(tag)) return '';

      // Skip hidden elements
      if (el.style.display === 'none' || el.style.visibility === 'hidden') return '';
      if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.querySelector('input, select, textarea')) return '';

      // Collect kept attributes
      const attrs: string[] = [];
      for (const attr of KEEP) {
        const val = el.getAttribute(attr);
        if (val != null && val !== '') {
          attrs.push(`${attr}="${val}"`);
        }
      }

      // Add first meaningful class (skip BC's generated hash classes)
      const className = el.className?.toString() || '';
      const classes = className.split(/\s+/).filter(
        (c) => c.length > 3 && c.length < 40 && !c.includes('--') && !/^[a-z]{5,}$/.test(c),
      );
      if (classes.length > 0) {
        attrs.push(`class="${classes[0]}"`);
      }

      // Get children HTML
      const childrenHtml = Array.from(el.childNodes)
        .map((child) => cleanNode(child, depth + 1))
        .filter(Boolean)
        .join('\n');

      // Collapse empty wrapper divs
      const isWrapper =
        tag === 'DIV' &&
        attrs.length === 0 &&
        el.childElementCount === 1 &&
        !el.textContent?.trim();
      if (isWrapper) return childrenHtml;

      // Skip purely decorative elements with no content or attributes
      if (attrs.length === 0 && !childrenHtml && !el.textContent?.trim()) return '';

      const tagLower = tag.toLowerCase();
      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

      if (!childrenHtml && !el.textContent?.trim()) {
        return `<${tagLower}${attrStr}/>`;
      }

      const textContent = !childrenHtml ? el.textContent?.trim().slice(0, MAX_TEXT) || '' : '';
      const inner = childrenHtml || textContent;

      return `<${tagLower}${attrStr}>${inner}</${tagLower}>`;
    }

    const html = cleanNode(root, 0);

    // Scroll state of the main scrollable container
    const scrollContainer = root.querySelector('[style*="overflow"]') ?? root;
    const sc = scrollContainer as HTMLElement;
    const scroll = {
      scrollTop: sc.scrollTop,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      scrollLeft: sc.scrollLeft,
      scrollWidth: sc.scrollWidth,
      clientWidth: sc.clientWidth,
      canScrollDown: sc.scrollTop + sc.clientHeight < sc.scrollHeight - 10,
      canScrollUp: sc.scrollTop > 10,
      canScrollLeft: sc.scrollLeft > 10,
      canScrollRight: sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 10,
    };

    // Add layer annotations
    let annotatedHtml = html;
    if (layers.length > 0) {
      const bgLayers = layers
        .filter((l) => !l.isActive)
        .map((l) => `<!-- BACKGROUND LAYER: ${l.description} -->`)
        .join('\n');
      const activeDesc = layers.find((l) => l.isActive)?.description || 'active';
      annotatedHtml = `${bgLayers}\n<!-- ACTIVE LAYER: ${activeDesc} -->\n${html}`;
    }

    // Add scroll annotation
    annotatedHtml += `\n<!-- scroll: vertical ${sc.scrollTop}/${sc.scrollHeight}px, horizontal ${sc.scrollLeft}/${sc.scrollWidth}px -->`;

    return { html: annotatedHtml, layers, scroll };
  });

  debug(`DOM extract: ${result.html.length} chars, ${result.layers.length} layers`);
  return result;
}

/**
 * Cleans raw HTML string (for testing without a browser).
 * Simplified version of the in-browser extraction.
 */
export function cleanHtml(rawHtml: string): string {
  // Strip tags
  let html = rawHtml;
  for (const tag of STRIP_TAGS) {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    html = html.replace(regex, '');
    html = html.replace(new RegExp(`<${tag}[^>]*/>`, 'gi'), '');
  }

  // Strip hidden elements
  html = html.replace(/<[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Strip attributes not in KEEP_ATTRS list (keep the element, remove the attr)
  html = html.replace(/\s+(?!role|aria-|controlname|title|type|value|placeholder|name)[a-z][\w-]*="[^"]*"/gi, '');

  // Collapse empty wrapper divs: <div><div><span>X</span></div></div> → <span>X</span>
  let prev = '';
  while (prev !== html) {
    prev = html;
    html = html.replace(/<div>\s*(<(?:div|span|section|input|button|nav|header)[^>]*>[\s\S]*?<\/(?:div|span|section|input|button|nav|header)>)\s*<\/div>/gi, '$1');
  }

  // Truncate long text
  html = html.replace(/>([^<]{51,})</g, (_, text: string) => '>' + text.slice(0, MAX_TEXT_LENGTH) + '...<');

  return html.trim();
}

/** Detects overlay layers from HTML string (for testing). */
export function detectLayers(html: string): LayerInfo[] {
  const layers: LayerInfo[] = [];
  const dialogRegex = /role="dialog"[^>]*>([^<]*)/g;
  let match;
  let first = true;
  while ((match = dialogRegex.exec(html)) !== null) {
    layers.push({
      description: match[1].trim().slice(0, 40) || 'dialog',
      isActive: first,
    });
    first = false;
  }
  return layers;
}

/** Extracts scroll state from annotated HTML (for testing). */
export function extractScrollState(html: string): ScrollState {
  const yMatch = html.match(/scroll-y="(\d+)\/(\d+)"/);
  const xMatch = html.match(/scroll-x="(\d+)\/(\d+)"/);
  const scrollTop = yMatch ? parseInt(yMatch[1]) : 0;
  const scrollHeight = yMatch ? parseInt(yMatch[2]) : 0;
  const scrollLeft = xMatch ? parseInt(xMatch[1]) : 0;
  const scrollWidth = xMatch ? parseInt(xMatch[2]) : 0;

  // Use a conservative assumed viewport for the test helper (actual values come from the browser)
  const clientHeight = 600;
  const clientWidth = 1200;

  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollLeft,
    scrollWidth,
    clientWidth,
    canScrollDown: scrollTop + clientHeight < scrollHeight,
    canScrollUp: scrollTop > 0,
    canScrollLeft: scrollLeft > 0,
    canScrollRight: scrollLeft + clientWidth < scrollWidth,
  };
}
