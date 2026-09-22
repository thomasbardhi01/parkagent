/**
 * The 2026-09-22 regression, pinned: after zone submit the Review Signage
 * popup is injected LATE and fades in (opacity 0 → 1 under an animating
 * .ui-popup-screen overlay). isVisible({ timeout }) does not wait, so the
 * old handler raced the popup, skipped it, and the flow clicked into the
 * hidden duration page underneath ("Element is not visible" on
 * #pickerNext; fixture passport-start-2026-09-22T15-09-13-438Z).
 *
 * These tests drive handleSignageModal against the sanitized popup markup
 * with a scripted jQM-style fade-in and assert the handler (a) finds the
 * late popup at all and (b) clicks only once the container is fully shown
 * — ui-popup-active, computed opacity 1, nothing animating. Same harness
 * conventions as signageModal.dom.test.ts (setContent, no network; skips
 * where chromium can't launch).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Browser } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { handleSignageModal } from "../src/passport/signage.js";
import { selectors } from "../src/passport/selectors.js";

const harness = readFileSync(
  fileURLToPath(new URL("./fixtures/pages/passport/signage-modal-fade.html", import.meta.url)),
  "utf8",
);

interface ClickState {
  opacity: string;
  animationsRunning: boolean;
  active: boolean;
}

let browser: Browser | null = null;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
});
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(process.env["SKIP_BROWSER_TESTS"] === "1")(
  "signage fade-in handling (live DOM)",
  () => {
    test("waits out a late injection + fade before clicking Continue", async () => {
      if (!browser) {
        console.warn(
          "skipping: chromium could not launch (run `pnpm -C executor exec playwright install chromium`)",
        );
        return;
      }
      const page = await browser.newPage();
      await page.setContent(harness);
      // Popup appears 700ms after "submit" and fades for 600ms — both well
      // past a non-waiting check, both well inside the handler's budgets.
      await page.evaluate(() => {
        (globalThis as unknown as { __openPopup(d: number, f: number): void }).__openPopup(
          700,
          600,
        );
      });

      const handled = await handleSignageModal(page, {
        click: (locator) => locator.click({ timeout: 5_000 }),
      });

      expect(handled).toBe(true);
      const state = (await page.evaluate(
        () => (globalThis as unknown as { __clickState: unknown }).__clickState,
      )) as ClickState | null;
      expect(state).not.toBeNull();
      // The click landed only once the popup was FULLY shown.
      expect(state!.active).toBe(true);
      expect(state!.opacity).toBe("1");
      expect(state!.animationsRunning).toBe(false);
      // And the modal is gone afterwards.
      expect(await selectors.zone.signageModal(page).isVisible()).toBe(false);
      await page.close();
    }, 15_000);

    test("falls back to dispatchEvent when the click doesn't close the modal", async () => {
      if (!browser) return;
      const page = await browser.newPage();
      await page.setContent(harness);
      await page.evaluate(() => {
        const g = globalThis as unknown as {
          __openPopup(d: number, f: number): void;
          __requireClicks: number;
        };
        g.__requireClicks = 2; // first click is eaten, like an intercepting overlay
        g.__openPopup(100, 200);
      });

      const handled = await handleSignageModal(page, {
        click: (locator) => locator.click({ timeout: 5_000 }),
      });

      expect(handled).toBe(true);
      const clicks = await page.evaluate(
        () => (globalThis as unknown as { __clicks: number }).__clicks,
      );
      expect(clicks).toBe(2); // the dispatched event fired the handler again
      expect(await selectors.zone.signageModal(page).isVisible()).toBe(false);
      await page.close();
    }, 15_000);

    test("returns false quickly when the interstitial never appears", async () => {
      if (!browser) return;
      const page = await browser.newPage();
      // No popup — the zone info panel is already up, so the appear-wait
      // resolves on the next screen instead of burning its full timeout.
      await page.setContent(
        '<div id="zoneInfoPage"><button id="zi_selectZone">Select Zone</button></div>',
      );

      const startedAt = Date.now();
      const handled = await handleSignageModal(page, {
        click: (locator) => locator.click({ timeout: 5_000 }),
        appearTimeoutMs: 5_000,
      });

      expect(handled).toBe(false);
      // Resolved on the visible next screen, not the 5s appear timeout.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await page.close();
    });
  },
);
