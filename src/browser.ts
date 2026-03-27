import { chromium, type Page, type Frame, type BrowserContext, type Browser } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { DemoConfig } from './config.js';
import { info, debug } from './log.js';

const NAV_TIMEOUT_MS = 120_000;

export interface BCSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  frame: Frame;
  authenticatedUrl: string;
}

/**
 * Waits for BC's execution context to be idle in both the main page
 * and the iframe, then returns the BC iframe. Matches bc-replay's
 * awaitFrame() logic exactly.
 */
export async function awaitBCFrame(page: Page, timeout = NAV_TIMEOUT_MS): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const isIdle = await page.evaluate(() => {
      const ns = window as unknown as Record<string, unknown>;
      const namespace = (ns['BC'] ?? ns['DN']) as
        | { ExecutionContext?: { Instance?: { IsIdle?: () => boolean } } }
        | undefined;
      return namespace?.ExecutionContext?.Instance?.IsIdle?.() ?? false;
    });

    if (isIdle) {
      const frames = page.frames();
      if (frames.length > 1) {
        const frameIdle = await frames[1]
          .evaluate(() => {
            const DN = (window as unknown as Record<string, unknown>)['DN'] as
              | { ExecutionContext?: { Instance?: { IsIdle?: () => boolean } } }
              | undefined;
            return DN?.ExecutionContext?.Instance?.IsIdle?.() ?? false;
          })
          .catch(() => false);
        if (frameIdle) return frames[1];
      }
    }

    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for BC to become idle');
}

/**
 * Launches a browser, authenticates with BC, transfers cookies,
 * and returns a ready-to-use session with the BC frame loaded.
 */
export async function launchBCSession(
  config: DemoConfig,
  options: {
    headless?: boolean;
    recordVideoDir?: string;
    pageId?: number;
    profile?: string;
    editMode?: boolean;
  } = {},
): Promise<BCSession> {
  const bcUrl = new URL(config.bcStartAddress);
  if (options.profile) {
    bcUrl.searchParams.set('profile', options.profile);
  }
  if (options.pageId) {
    bcUrl.searchParams.set('page', String(options.pageId));
  }

  const headless = options.headless ?? !config.headed;
  const browser = await chromium.launch({ headless });

  // Phase A: Authenticate in a non-recording context
  debug(`Navigating to: ${bcUrl.toString()}`);
  const authContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const authPage = await authContext.newPage();
  await authPage.goto(bcUrl.toString());

  if (config.bcAuth === 'UserPassword' && config.bcUsernameKey && config.bcPasswordKey) {
    const username = process.env[config.bcUsernameKey];
    const password = process.env[config.bcPasswordKey] ?? '';
    if (username) {
      info(`Auth: ${username} (UserPassword)`);
      await authPage.fill('input[name=UserName]', username);
      await authPage.fill('input[name=Password]', password);
      await Promise.all([
        authPage.click('button[type=submit]', { timeout: NAV_TIMEOUT_MS }),
        authPage.waitForNavigation({ timeout: NAV_TIMEOUT_MS }),
      ]);
    }
  }

  info('Waiting for BC to load...');
  await authPage.waitForTimeout(200);
  await awaitBCFrame(authPage);
  debug('BC is ready — transferring session');

  const cookies = await authContext.cookies();
  const authenticatedUrl = authPage.url();
  await authContext.close();

  // Phase B: Create the real context (with or without video)
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1920, height: 1080 },
  };
  if (options.recordVideoDir) {
    mkdirSync(resolve(options.recordVideoDir), { recursive: true });
    contextOptions.recordVideo = {
      dir: resolve(options.recordVideoDir),
      size: { width: 1920, height: 1080 },
    };
  }
  const context = await browser.newContext(contextOptions);
  await context.addCookies(cookies);
  const page = await context.newPage();

  await page.goto(authenticatedUrl);
  await page.waitForTimeout(200);
  const frame = await awaitBCFrame(page);

  // Optional: switch to edit mode
  if (options.editMode) {
    debug('Switching to edit mode...');
    for (const label of ['Edit', 'Edit List']) {
      const btn = frame.getByRole('menuitem', { name: label, exact: true });
      if ((await btn.count()) > 0) {
        await btn.first().click();
        info(`Clicked "${label}" to enter edit mode`);
        await awaitBCFrame(page, 10_000).catch(() => {});
        await page.waitForTimeout(300);
        break;
      }
    }
  }

  return { browser, context, page, frame, authenticatedUrl };
}

/** Closes the browser session and returns the video path if recording was active. */
export async function closeBCSession(session: BCSession): Promise<string | undefined> {
  let videoPath: string | undefined;
  try {
    const video = session.page.video();
    await session.page.close();
    videoPath = (await video?.path()) ?? undefined;
  } catch {
    /* ignore */
  }
  await session.context.close();
  await session.browser.close();
  return videoPath;
}
