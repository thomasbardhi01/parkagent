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
  isAddPaymentScreen,
  recentZonesState,
  isSignageModal,
  activePageSettled,
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


describe("Add Payment Details screen (card-less account)", () => {
  const dir = fileURLToPath(new URL("./fixtures/pages/passport", import.meta.url));
  const addPayment = readFileSync(join(dir, "add-payment-details.html"), "utf8");

  test("isAddPaymentScreen recognizes the #updateCard form from the recording", () => {
    expect(isAddPaymentScreen(addPayment)).toBe(true);
  });

  test("it does not fire on the other Passport screens", () => {
    for (const other of ["zone-entry.html", "zone-info--81234--boylston-st.html"]) {
      expect(isAddPaymentScreen(readFileSync(join(dir, other), "utf8"))).toBe(false);
    }
    expect(isAddPaymentScreen("<html><body>anything else</body></html>")).toBe(false);
    // Header without the form (e.g. a confirmation echoing the words) is not it.
    expect(
      isAddPaymentScreen('<h1 id="updateCardWindowHeader">Add Payment Details</h1>'),
    ).toBe(false);
  });

  test("the same form backs setupCard: the fixture carries every selector id the flow fills", () => {
    // Selectors in passport/selectors.ts payment.* target these ids; the
    // recording is where they came from, so both flows share one form.
    for (const id of ["cardNumber", "selectMonth", "selectYear", "cvv", "billingZipcode", "cardName", "saveCard"]) {
      expect(addPayment).toContain(`id="${id}"`);
    }
  });

  test("the fixture is sanitized — none of the reported card values survive", () => {
    for (const secret of ["5143772191773606", "02184", "067", "thomas_bardhi_venmo_card"]) {
      expect(addPayment).not.toContain(secret);
    }
  });
});

describe("Enter Zone recent-zones panel (2026-09-21 Continue-timeout regression)", () => {
  const dir = fileURLToPath(new URL("./fixtures/pages/passport", import.meta.url));
  const read = (name: string) => readFileSync(join(dir, name), "utf8");

  test("recentZonesState sees the visible panel + chip that overlays Continue", () => {
    const state = recentZonesState(read("zone-entry--recent-zones-visible.html"));
    expect(state.present).toBe(true);
    expect(state.visible).toBe(true);
    expect(state.chips).toContain("456");
  });

  test("the baseline capture's panel is hidden (display:none) — Continue was clear", () => {
    const state = recentZonesState(read("zone-entry--recent-zones-hidden.html"));
    expect(state.present).toBe(true);
    expect(state.visible).toBe(false);
    expect(state.chips).toEqual([]);
  });

  test("no #recentZones at all reads as not-present, not a crash", () => {
    expect(recentZonesState("<html><body>Enter Zone</body></html>")).toEqual({
      present: false,
      visible: false,
      chips: [],
    });
  });
});

describe("Review Signage interstitial (optional, after Enter Zone)", () => {
  const dir = fileURLToPath(new URL("./fixtures/pages/passport", import.meta.url));
  const read = (name: string) => readFileSync(join(dir, name), "utf8");

  test("isSignageModal fires on the popup (signage text + Continue/Cancel)", () => {
    expect(isSignageModal(read("signage-modal.html"))).toBe(true);
  });

  test("it does NOT fire on the inline zoneWarningMessage label alone", () => {
    // The Length-of-Stay page carries the same 'signage/restrictions'
    // words in a plain <p> with no popup and no Continue/Cancel — the
    // structural requirement keeps that from being a false positive.
    const inlineOnly =
      '<div data-role="page"><p id="zoneWarningMessage">By continuing you agree you are ' +
      "abiding to all zone signage on restrictions and rules.</p></div>";
    expect(isSignageModal(inlineOnly)).toBe(false);
  });

  test("it does not fire on the other Passport screens", () => {
    for (const other of ["zone-entry--recent-zones-visible.html", "add-payment-details.html"]) {
      expect(isSignageModal(read(other))).toBe(false);
    }
    expect(isSignageModal("<html><body>nothing here</body></html>")).toBe(false);
  });
})

describe("duration picker + jQM transition settle", () => {
  const dir = fileURLToPath(new URL("./fixtures/pages/passport", import.meta.url));
  const read = (name: string) => readFileSync(join(dir, name), "utf8");

  test("the duration-picker fixture carries the real stepper + continue ids", () => {
    const html = read("duration-picker.html");
    for (const id of ["dayPlus", "hourPlus", "hourTimeText", "minPlus", "minTimeText", "pickerNext"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("activePageSettled is true for a settled page, false mid-transition", () => {
    expect(activePageSettled(read("page-settled.html"))).toBe(true);
    expect(activePageSettled(read("page-transitioning.html"))).toBe(false);
  });

  test("activePageSettled needs an active page and tolerates none", () => {
    expect(activePageSettled('<div class="ui-page" id="x"></div>')).toBe(false); // no active
    expect(activePageSettled("<html><body>no jqm here</body></html>")).toBe(false);
    // a settled active page with unrelated classes stays true
    expect(
      activePageSettled('<div class="ui-page ui-page-theme-a ui-page-active ui-corner-all"></div>'),
    ).toBe(true);
  });
})
