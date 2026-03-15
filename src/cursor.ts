import type { Page, Frame, Locator } from 'playwright';

const CURSOR_MOVE_DURATION_MS = 600;
const CLICK_EFFECT_DURATION_MS = 400;

/**
 * Injects a visual cursor overlay into the page. The cursor is rendered
 * above everything (including iframes) so it's always visible in the video.
 */
export async function injectCursor(page: Page): Promise<void> {
  await page.evaluate(({ moveDuration, clickDuration }: { moveDuration: number; clickDuration: number }) => {
    if (document.getElementById('demo-cursor')) return;

    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = `
      <div id="demo-cursor-dot"></div>
      <div id="demo-cursor-ring"></div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor {
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: 0;
        z-index: 2147483647;
        pointer-events: none;
        transition: transform ${moveDuration}ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #demo-cursor-dot {
        position: absolute;
        width: 16px;
        height: 16px;
        margin-left: -8px;
        margin-top: -8px;
        border-radius: 50%;
        background: rgba(255, 80, 80, 0.85);
        box-shadow: 0 0 6px rgba(255, 80, 80, 0.4);
      }
      #demo-cursor-ring {
        position: absolute;
        width: 32px;
        height: 32px;
        margin-left: -16px;
        margin-top: -16px;
        border-radius: 50%;
        border: 2px solid rgba(255, 80, 80, 0.5);
        opacity: 0;
        transform: scale(0.5);
      }
      #demo-cursor-ring.clicking {
        animation: demo-cursor-click ${clickDuration}ms ease-out forwards;
      }
      @keyframes demo-cursor-click {
        0% { opacity: 1; transform: scale(0.5); }
        100% { opacity: 0; transform: scale(2); }
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(cursor);
  }, { moveDuration: CURSOR_MOVE_DURATION_MS, clickDuration: CLICK_EFFECT_DURATION_MS });
}

/**
 * Moves the cursor to a target element and performs a click with visual feedback.
 * The cursor smoothly animates to the target, then shows a ripple effect.
 */
export async function cursorClickLocator(page: Page, locator: Locator): Promise<void> {
  const box = await locator.first().boundingBox();
  if (!box) {
    await locator.first().click();
    return;
  }

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await animateCursorAndClick(page, x, y);
  await locator.first().click();
}

/**
 * Moves the cursor to specific coordinates (relative to the page viewport)
 * and shows the click animation. Used for clicks inside iframes where we
 * need to translate frame-relative coords to page-level coords.
 */
export async function cursorClickAt(page: Page, frame: Frame, frameRelativeX: number, frameRelativeY: number): Promise<void> {
  // Find the iframe element's position in the main page to offset coordinates
  const iframeOffset = await page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    if (!iframe) return { x: 0, y: 0 };
    const rect = iframe.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });

  const pageX = iframeOffset.x + frameRelativeX;
  const pageY = iframeOffset.y + frameRelativeY;

  await animateCursorAndClick(page, pageX, pageY);
}

/**
 * Resolves the bounding box of an element found via evaluate() inside a frame,
 * then animates the cursor and clicks it.
 */
export async function cursorClickElement(page: Page, frame: Frame, selector: string): Promise<void> {
  const box = await frame.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = (el as HTMLElement).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);

  if (box) {
    await cursorClickAt(page, frame, box.x + box.width / 2, box.y + box.height / 2);
  }
}

/**
 * Animates the cursor to page-level coordinates and shows the click effect.
 * Use this when you already have page-level coords (e.g. from boundingBox).
 */
export async function animateCursorTo(page: Page, x: number, y: number): Promise<void> {
  return animateCursorAndClick(page, x, y);
}

async function animateCursorAndClick(page: Page, x: number, y: number): Promise<void> {
  // Move cursor to target position
  await page.evaluate(({ x, y }: { x: number; y: number }) => {
    const cursor = document.getElementById('demo-cursor');
    if (!cursor) return;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }, { x, y });

  // Wait for the move animation to complete
  await page.waitForTimeout(CURSOR_MOVE_DURATION_MS + 50);

  // Trigger click ripple effect
  await page.evaluate(() => {
    const ring = document.getElementById('demo-cursor-ring');
    if (!ring) return;
    ring.classList.remove('clicking');
    void ring.offsetWidth; // force reflow
    ring.classList.add('clicking');
  });

  // Wait for click animation
  await page.waitForTimeout(CLICK_EFFECT_DURATION_MS);
}
