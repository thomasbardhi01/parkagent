/**
 * Job 2 — ParkBoston quote-vs-receipt reconciliation.
 *
 * Ground truth: two real zone-456 transactions on the account (parking
 * history), both plate 2TZY87:
 *   831908580  9/23/26  12 minutes  $0.75 meter + $0.35 conv = $1.10
 *   831291617  9/21/26  12 minutes  $0.75 meter + $0.35 conv = $1.10
 *
 * The rate is $3.75/hr and the receipts are per-minute exact
 * (12 min × $3.75/hr = $0.75) with a FLAT $0.35 convenience fee — our
 * priceStay formula already models both. The only delta is the DURATION:
 * a 15-minute request was billed as 12 minutes, because ParkBoston sells
 * parking in a per-zone duration increment (zone 456's picker increment is
 * 12 minutes, read off the live #minTimeText). That increment is
 * operator-configured per zone and is NOT in Analyze Boston's open data, so
 * it can't be inferred for other zones from these two same-zone receipts —
 * it must be collected per zone in the field test. When it IS known,
 * priceStay's `billingIncrementMinutes` snaps the quote to it so the quote
 * matches the receipt to the cent (below).
 */

import { describe, expect, test } from "vitest";

import { priceStay, snapToIncrement } from "../src/services/quote.js";
import type { RatedTerms } from "../src/services/quote.js";
import { DEFAULT_POLICY, MONDAY_2PM } from "./helpers.js";

// Zone 456: Back Bay flat $3.75/hr, enforced Mon-Sat 8-8 (2 PM is inside).
const BOYLSTON: RatedTerms = {
  city: "bos",
  rateFirstHourUsd: 3.75,
  rateAdditionalHourUsd: 3.75,
  hours: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }],
};
const AT = new Date(MONDAY_2PM);

describe("the observed billing rule: per-minute meter + flat fee", () => {
  test("12 charged minutes price to the receipt exactly ($0.75 + $0.35 = $1.10)", () => {
    const price = priceStay(BOYLSTON, DEFAULT_POLICY, AT, 12);
    expect(price.meterUsd).toBe(0.75); // 12/60 × $3.75
    expect(price.feeUsd).toBe(0.35); // flat, city_overrides.bos
    expect(price.totalUsd).toBe(1.1);
  });

  test("the convenience fee is flat $0.35 regardless of duration", () => {
    for (const minutes of [12, 24, 60, 120]) {
      const price = priceStay(BOYLSTON, DEFAULT_POLICY, AT, minutes);
      expect(price.feeUsd).toBe(0.35);
    }
  });

  test("without the increment, a 15-minute request over-quotes ($0.94, the observed delta)", () => {
    // This is the acceptance-run mismatch: we quoted 15 min but the meter
    // granted 12. Documented, not a formula bug.
    const price = priceStay(BOYLSTON, DEFAULT_POLICY, AT, 15);
    expect(price.meterUsd).toBe(0.94); // 15/60 × $3.75 = 0.9375 → 0.94
    expect(price.totalUsd).toBe(1.29);
  });
});

describe("snapping the quote to the zone's billing increment", () => {
  test("snapToIncrement rounds to whole increments with a floor of one", () => {
    expect(snapToIncrement(15, 12)).toBe(12); // nearest: |15-12|<|15-24|
    expect(snapToIncrement(20, 12)).toBe(24); // nearest up
    expect(snapToIncrement(5, 12)).toBe(12); // floor: at least one increment
    expect(snapToIncrement(90, 12)).toBe(96); // 7.5 → 8 increments
    expect(snapToIncrement(15, undefined)).toBe(15); // no increment → unchanged
    expect(snapToIncrement(15, 0)).toBe(15);
  });

  // Reproduce EACH observed transaction to the cent, given zone 456's
  // 12-minute increment: a 15-minute request snaps to 12 min → the receipt.
  test.each([
    ["831908580", 15],
    ["831291617", 15],
  ])("transaction %s: a 15-min request snaps to the 12-min receipt", (_txn, requested) => {
    const price = priceStay(
      { ...BOYLSTON, billingIncrementMinutes: 12 },
      DEFAULT_POLICY,
      AT,
      requested,
    );
    expect(price.stayMinutes).toBe(12);
    expect(price.meterUsd).toBe(0.75);
    expect(price.feeUsd).toBe(0.35);
    expect(price.totalUsd).toBe(1.1);
  });

  test("a 90-minute default stay in zone 456 snaps to 96 min (8 increments)", () => {
    const price = priceStay({ ...BOYLSTON, billingIncrementMinutes: 12 }, DEFAULT_POLICY, AT, 90);
    expect(price.stayMinutes).toBe(96);
    expect(price.meterUsd).toBe(6.0); // 96/60 × $3.75
    expect(price.totalUsd).toBe(6.35);
  });
});
