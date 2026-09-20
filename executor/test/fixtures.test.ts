/**
 * Fixture-driven tests over REAL recorded ParkNYC pages. Files come from
 * `pnpm -C executor record` runs, sanitized by hand and dropped into
 * test/fixtures/pages/ with a name that states the expectation:
 *
 *   <expected>--anything.html
 *
 * where <expected> is one of the error codes (auth_expired, zone_not_found,
 * payment_declined) — asserted against classifyPageText — or `confirmation`,
 * asserted to fully parse via parseConfirmation, or `neutral`, asserted to
 * trip NO error classification (guards against overeager patterns).
 *
 * No fixtures yet → the suite skips. Never hits ParkNYC.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { classifyPageText, visibleTextFromHtml } from "../src/parknyc/classify.js";
import { parseConfirmation } from "../src/parknyc/parse.js";

const pagesDir = fileURLToPath(new URL("./fixtures/pages", import.meta.url));
const files = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith(".html")) : [];

describe.skipIf(files.length === 0)("recorded ParkNYC pages", () => {
  test.each(files)("%s", (file) => {
    const [expected] = file.split("--");
    const text = visibleTextFromHtml(readFileSync(join(pagesDir, file), "utf8"));
    switch (expected) {
      case "auth_expired":
      case "zone_not_found":
      case "payment_declined":
        expect(classifyPageText(text)).toBe(expected);
        break;
      case "confirmation": {
        const parsed = parseConfirmation(text, new Date());
        expect(parsed).not.toBeNull();
        expect(parsed!.amountUsd).toBeGreaterThanOrEqual(0);
        break;
      }
      case "neutral":
        expect(classifyPageText(text)).toBeNull();
        break;
      default:
        throw new Error(
          `fixture ${file} doesn't declare an expectation; name it <expected>--<desc>.html`,
        );
    }
  });
});

test("fixture harness self-check (always runs)", () => {
  // Keeps the file from reporting "no tests" while fixtures are absent.
  expect(files.every((f) => f.endsWith(".html"))).toBe(true);
});
