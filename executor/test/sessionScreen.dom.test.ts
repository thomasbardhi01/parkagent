/**
 * The active-session screen's Extend / Stop detection, against the sanitized
 * post-extend fixture (session-active--stop-disabled.html). Needs a real
 * layout engine for the visibility/count checks, so it uses Playwright
 * setContent (no network, no provider) and self-skips where chromium can't
 * launch (executor tests are local-only, not in CI).
 *
 * VERIFIED live 2026-09-23: ParkBoston zone 456 renders Zone Info / Extend /
 * Discount and NOT Stop — session.js pushes #sessStopBtn only when the
 * operator enables stopParkingOption, and zone 456 (non-refundable) does
 * not. So the extend flow finds #extendBtn, and the stop flow finds no
 * #sessStopBtn and returns stopNotSupported.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Browser } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { selectors } from "../src/passport/selectors.js";

const session = readFileSync(
  fileURLToPath(
    new URL("./fixtures/pages/passport/session-active--stop-disabled.html", import.meta.url),
  ),
  "utf8",
);

let browser: Browser | null = null;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
});
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(process.env["SKIP_BROWSER_TESTS"] === "1")(
  "active-session screen (live DOM)",
  () => {
    test("Extend is present; Stop is absent (zone 456 offers no early stop)", async () => {
      if (!browser) {
        console.warn("skipping: chromium could not launch");
        return;
      }
      const page = await browser.newPage();
      await page.setContent(session);

      // The extend flow's success marker + its button.
      expect(await selectors.session.activeMarker(page).first().isVisible()).toBe(true);
      expect(await selectors.session.extendButton(page).count()).toBeGreaterThan(0);
      expect(await selectors.session.extendButton(page).first().isVisible()).toBe(true);

      // The stop flow keys on #sessStopBtn being ABSENT → stopNotSupported.
      expect(await selectors.session.stopButton(page).count()).toBe(0);

      await page.close();
    });
  },
);
