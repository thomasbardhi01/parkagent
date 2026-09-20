/**
 * Map-based zone resolution, the pure parts: reading the Passport zone info
 * panel out of fixture HTML and the street-match rule that guards against
 * paying the wrong block (zone_mismatch). Fixture pages live in
 * test/fixtures/pages/passport/ — hand-built from the app's shipped view
 * template today, to be replaced by sanitized recordings (see the fixture's
 * own header). Never hits the provider.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  normalizeStreet,
  parseZoneInfoHtml,
  parseZoneNumberText,
  streetsMatch,
} from "../src/passport/parse.js";

const pagesDir = fileURLToPath(new URL("./fixtures/pages/passport", import.meta.url));

describe("zone info fixtures (zone-info--<number>--<street-slug>.html)", () => {
  const files = readdirSync(pagesDir).filter((f) => f.startsWith("zone-info--"));
  test.each(files)("%s", (file) => {
    const [, expectedNumber, slug] = file.replace(/\.html$/, "").split("--");
    const panel = parseZoneInfoHtml(readFileSync(join(pagesDir, file), "utf8"));
    expect(panel).not.toBeNull();
    expect(panel!.zoneNumber).toBe(expectedNumber);
    // The slug is the normalized street with dashes: "boylston-st".
    expect(normalizeStreet(panel!.street)).toContain(slug!.replaceAll("-", " ").toUpperCase());
  });

  test("at least one zone-info fixture exists", () => {
    expect(files.length).toBeGreaterThan(0);
  });
});

test("parseZoneNumberText reads the labeled number", () => {
  expect(parseZoneNumberText("Zone Number: 81234")).toBe("81234");
  expect(parseZoneNumberText("Zone # 402")).toBe("402");
  expect(parseZoneNumberText("Rates and hours")).toBeNull();
  // Never mistakes a rate or a year for a zone number label.
  expect(parseZoneNumberText("Total $3.75")).toBeNull();
});

test("parseZoneInfoHtml returns null when the panel is incomplete", () => {
  expect(parseZoneInfoHtml("<div id='zi_zoneno'>Zone Number: 81234</div>")).toBeNull();
  expect(parseZoneInfoHtml("<div id='zi_zoneName'>Boylston St</div>")).toBeNull();
  expect(
    parseZoneInfoHtml(
      "<div id='zi_zoneName'>Boylston St</div><div id='zi_zoneno'>Rates vary</div>",
    ),
  ).toBeNull();
});

test("normalizeStreet canonicalizes suffixes and drops parentheticals", () => {
  expect(normalizeStreet("Boylston Street (North Side)")).toBe("BOYLSTON ST");
  expect(normalizeStreet("COMMONWEALTH AV")).toBe("COMMONWEALTH AV");
  expect(normalizeStreet("Commonwealth Avenue")).toBe("COMMONWEALTH AV");
  expect(normalizeStreet("D St.")).toBe("D ST");
});

test("streetsMatch: our abbreviated data vs the provider's spelled-out names", () => {
  expect(streetsMatch("BOYLSTON ST", "Boylston Street (Copley Square)")).toBe(true);
  expect(streetsMatch("COMMONWEALTH AV", "Commonwealth Avenue")).toBe(true);
  expect(streetsMatch("D ST", "D Street")).toBe(true);
  // Disagreement → the caller refuses with zone_mismatch.
  expect(streetsMatch("NEWBURY ST", "Boylston Street")).toBe(false);
  expect(streetsMatch("BOYLSTON ST", "")).toBe(false);
  expect(streetsMatch("", "Boylston Street")).toBe(false);
});
