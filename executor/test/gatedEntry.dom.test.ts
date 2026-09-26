/**
 * The 2026-09-26 finding, pinned: ParkBoston draws its gated entry (Sign
 * In / Guest) ~0.4 s after DOM-ready, and the old instant check
 * (`isVisible({ timeout })` never waits) missed it — a signed-out session
 * read as signed in and ran on to a ui_changed timeout (live: 22 s, then
 * retries) instead of auth_expired (live after the fix: 1.5 s).
 *
 * The harness draws each screen late, as the app does. Same conventions
 * as signageFade.dom.test.ts (setContent, no network; skips where
 * chromium can't launch).
 */

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { atGatedEntry } from "../src/passport/gatedEntry.js";
import { selectors } from "../src/passport/selectors.js";

let browser: Browser | null = null;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
});
afterAll(async () => {
  await browser?.close();
});

/** A page that shows `html` after `delayMs`, like the SPA's late render. */
async function lateScreen(html: string, delayMs: number, base = ""): Promise<Page> {
  const page = await browser!.newPage();
  await page.setContent(`<body>${base}<div id="app"></div></body>`);
  await page.evaluate(
    ([markup, delay]) => {
      setTimeout(() => {
        document.getElementById("app")!.innerHTML = markup as string;
      }, delay as number);
    },
    [html, delayMs],
  );
  return page;
}

const SIGN_IN =
  '<button id="registerBtn">Sign In</button><button id="guestContinueBtn">Guest</button>';
const ENTER_ZONE = '<input id="zoneNumber" type="tel" placeholder="Zone Number">';

describe.skipIf(process.env["SKIP_BROWSER_TESTS"] === "1")(
  "Passport gated entry (live DOM)",
  () => {
    test("a sign-in screen drawn late is seen: signed out", async () => {
      if (!browser) {
        console.warn(
          "skipping: chromium could not launch (run `pnpm -C executor exec playwright install chromium`)",
        );
        return;
      }
      const page = await lateScreen(SIGN_IN, 400);
      // What the old check saw at this moment: nothing.
      expect(await selectors.gatedEntry.marker(page).first().isVisible()).toBe(false);

      expect(await atGatedEntry(page, selectors.account.signedInMarker(page), 5_000)).toBe(true);
      await page.close();
    });

    test("the screen's own witness drawn late answers signed in, without waiting out the cap", async () => {
      if (!browser) return;
      const page = await lateScreen(ENTER_ZONE, 300);
      const startedAt = Date.now();
      expect(await atGatedEntry(page, selectors.account.signedInMarker(page), 5_000)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await page.close();
    });

    test("a hidden copy of the sign-in buttons (another jQM page) is not a sign-in screen", async () => {
      if (!browser) return;
      const page = await lateScreen(ENTER_ZONE, 300, `<div style="display:none">${SIGN_IN}</div>`);
      const startedAt = Date.now();
      expect(await atGatedEntry(page, selectors.account.signedInMarker(page), 5_000)).toBe(false);
      // Resolved on the visible witness, not stuck on the hidden first match.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await page.close();
    });

    test("neither screen within the cap: not gated, and the caller's own wait reports it", async () => {
      if (!browser) return;
      const page = await lateScreen("<p>Something else</p>", 100);
      const startedAt = Date.now();
      expect(await atGatedEntry(page, selectors.account.signedInMarker(page), 600)).toBe(false);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
      await page.close();
    });
  },
);
