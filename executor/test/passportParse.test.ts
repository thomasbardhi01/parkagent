/**
 * Passport screens, the pure parts: recognizing the Enter Zone screen (the
 * app's only zone entry — recorded 2026-09-21, no map exists), reading the
 * zone info panel out of fixture HTML, and the street-match rule. Fixture
 * pages live in test/fixtures/pages/passport/; zone-entry.html is a
 * sanitized slice of the real recording. Never hits the provider.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  normalizeStreet,
  parseZoneEntryHtml,
  parseZoneInfoHtml,
  parseZoneNumberText,
  streetsMatch,
  parseNearbyZones,
} from "../src/passport/parse.js";

const pagesDir = fileURLToPath(new URL("./fixtures/pages/passport", import.meta.url));

describe("the recorded Enter Zone screen (zone-entry.html)", () => {
  const html = readFileSync(join(pagesDir, "zone-entry.html"), "utf8");

  test("carries exactly the ids the client drives (#zoneNumber, #zoneNext)", () => {
    const screen = parseZoneEntryHtml(html);
    expect(screen).not.toBeNull();
    expect(screen!.hasZoneNumberInput).toBe(true);
    expect(screen!.hasContinueButton).toBe(true);
    expect(screen!.label).toContain("Enter the zone number posted");
  });

  test("is not mistaken for the zone info panel", () => {
    expect(parseZoneInfoHtml(html)).toBeNull();
  });
});

test("parseZoneEntryHtml answers null on unrelated pages", () => {
  expect(parseZoneEntryHtml("<div id='zi_zoneName'>Boylston St</div>")).toBeNull();
  expect(parseZoneEntryHtml("<html><body>Sign In</body></html>")).toBeNull();
});

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
  // Disagreement is cross-check evidence for the decision trail.
  expect(streetsMatch("NEWBURY ST", "Boylston Street")).toBe(false);
  expect(streetsMatch("BOYLSTON ST", "")).toBe(false);
  expect(streetsMatch("", "Boylston Street")).toBe(false);
});

describe("parseNearbyZones (Find Parking map feed)", () => {
  const body = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/passport/nearby-zones--boylston-back-bay.json", import.meta.url)),
      "utf8",
    ),
  );

  test("extracts every zone's number and block name, skipping malformed rows", () => {
    const zones = parseNearbyZones(body);
    expect(zones).toHaveLength(4); // the null-number row is dropped
    expect(zones[0]).toMatchObject({
      number: "12",
      name: "West Exeter between Newbury and Boylston",
    });
    expect(zones.find((z) => z.number === "456")?.name).toBe(
      "North Boylston between Dartmouth and Clarendon",
    );
    // Every returned row carries a usable number and name.
    expect(zones.every((z) => z.number.length > 0 && z.name.length > 0)).toBe(true);
    // Coordinates parse to numbers (coarse, but present).
    expect(zones[0]!.latitude).toBeCloseTo(42.349998, 5);
  });

  test("returns [] for an error body or a no-data envelope", () => {
    expect(parseNearbyZones({ status: 404, reason: "No zones in this radius.", data: null })).toEqual(
      [],
    );
    expect(parseNearbyZones(null)).toEqual([]);
    expect(parseNearbyZones({})).toEqual([]);
  });
});
