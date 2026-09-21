/**
 * PERSONAL-USE PROTOTYPE — see index.ts header.
 *
 * One warm Chromium process shared by executor calls: launching the browser
 * is the slow part (~1s+), a fresh context per call is cheap and keeps one
 * user's cookies fully isolated from the next. If the process died (crash,
 * OOM), the next call relaunches it. login/record keep their own dedicated
 * browsers — they are interactive and headed.
 */

import type { Browser } from "playwright";
import { chromium } from "playwright";

/** The bit of Playwright warmBrowser needs — injectable so the recovery
 * logic is unit-testable without ever launching a real Chromium. */
export interface BrowserLauncher {
  launch(options: { headless: boolean }): Promise<Browser>;
}

let launcher: BrowserLauncher = chromium;
let current: Promise<Browser> | null = null;

/** Tests only: swap the launcher and reset the singleton. */
export function setBrowserLauncherForTests(fake: BrowserLauncher): void {
  launcher = fake;
  current = null;
}

export function warmBrowser(headless = true): Promise<Browser> {
  const attempt = current;
  if (!attempt) {
    current = launcher.launch({ headless });
    return current;
  }
  const relaunch = (): Promise<Browser> => {
    if (current === attempt) current = launcher.launch({ headless });
    return current!;
  };
  return attempt.then((browser) => (browser.isConnected() ? browser : relaunch()), relaunch);
}

/** Tests and graceful shutdown only. */
export async function closeWarmBrowser(): Promise<void> {
  const attempt = current;
  current = null;
  if (attempt) {
    await attempt.then(
      (browser) => browser.close().catch(() => {}),
      () => {},
    );
  }
}
