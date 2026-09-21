/**
 * The one assertion that needs a real layout engine: against the sanitized
 * "Review Signage" fixture, the scoped selector must resolve to EXACTLY
 * one VISIBLE Continue — not the zero-size .submit/#saveProfile duplicates
 * or the other active popup. Uses Playwright setContent (no network, no
 * provider); self-skips where chromium can't launch (executor tests are
 * local-only and not in CI).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Browser } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { selectors } from "../src/passport/selectors.js";

const html = readFileSync(
  fileURLToPath(new URL("./fixtures/pages/passport/signage-modal.html", import.meta.url)),
  "utf8",
);

let browser: Browser | null = null;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
});
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(process.env["SKIP_BROWSER_TESTS"] === "1")("signage Continue selector (live DOM)", () => {
  test("resolves to exactly one visible Continue in the open signage popup", async () => {
    if (!browser) {
      // Chromium not installable in this environment — skip loudly.
      console.warn("skipping: chromium could not launch (run `pnpm -C executor exec playwright install chromium`)");
      return;
    }
    const page = await browser.newPage();
    await page.setContent(html);

    // The signage popup is matched among two active popups by its text.
    expect(await selectors.zone.signageModal(page).count()).toBe(1);

    const cont = selectors.zone.signageContinue(page);
    expect(await cont.count()).toBe(1); // exactly one — not the 0-size dups
    expect(await cont.isVisible()).toBe(true);
    // And it's the real rendered button, not a zero-size duplicate.
    const box = await cont.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    await page.close();
  });
});
