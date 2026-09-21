import { expect, test } from "vitest";

import { quoteZone } from "../src/services/quote.js";
import { BROADWAY_A, DEFAULT_POLICY, MONDAY_2PM, MONDAY_8PM, STEINWAY_A } from "./helpers.js";

test("90-minute stay walks the ladder: first hour + prorated second", () => {
  // Steinway $2.00/$3.00: 60 min at $2 + 30 min at $3/h = $3.50 + fee.
  const quote = quoteZone(STEINWAY_A, DEFAULT_POLICY, new Date(MONDAY_2PM));
  expect(quote).toEqual({
    zoneId: "nyc-417371",
    providerZoneNumber: "417371",
    stayMinutes: 90,
    chargedMinutes: 90,
    meterUsd: 3.5,
    feeUsd: 0.15,
    totalUsd: 3.65,
  });
});

test("fractional cents round half-up once", () => {
  // Broadway $5.00/$8.25: 5 + 8.25/2 = 9.125 → 9.13.
  const quote = quoteZone(BROADWAY_A, DEFAULT_POLICY, new Date(MONDAY_2PM));
  expect(quote.meterUsd).toBe(9.13);
  expect(quote.totalUsd).toBe(9.28);
});

test("stay clamps to the zone's max stay", () => {
  const quote = quoteZone(
    { ...STEINWAY_A, maxStayMinutes: 60 },
    DEFAULT_POLICY,
    new Date(MONDAY_2PM),
  );
  expect(quote.stayMinutes).toBe(60);
  expect(quote.meterUsd).toBe(2.0);
});

test("no max stay posted falls back to the default stay", () => {
  const quote = quoteZone(
    { ...STEINWAY_A, maxStayMinutes: null },
    DEFAULT_POLICY,
    new Date(MONDAY_2PM),
  );
  expect(quote.stayMinutes).toBe(90);
});

test("minutes after enforcement ends are free: park 18:30, meters stop 19:00", () => {
  const quote = quoteZone(STEINWAY_A, DEFAULT_POLICY, new Date("2026-01-05T18:30:00-05:00"));
  expect(quote.stayMinutes).toBe(90);
  expect(quote.chargedMinutes).toBe(30);
  expect(quote.meterUsd).toBe(1.0); // 30 min at $2/h
  expect(quote.totalUsd).toBe(1.15);
});

test("a wholly free window quotes $0 with no fee", () => {
  const quote = quoteZone(STEINWAY_A, DEFAULT_POLICY, new Date(MONDAY_8PM));
  expect(quote.chargedMinutes).toBe(0);
  expect(quote.meterUsd).toBe(0);
  expect(quote.feeUsd).toBe(0);
  expect(quote.totalUsd).toBe(0);
});

test("Sunday is free under Mon-Sat hours", () => {
  const quote = quoteZone(STEINWAY_A, DEFAULT_POLICY, new Date("2026-01-04T14:00:00-05:00"));
  expect(quote.totalUsd).toBe(0);
});

test("respect_enforcement_hours: false charges the whole stay", () => {
  const quote = quoteZone(
    STEINWAY_A,
    { ...DEFAULT_POLICY, respect_enforcement_hours: false },
    new Date(MONDAY_8PM),
  );
  expect(quote.chargedMinutes).toBe(90);
  expect(quote.totalUsd).toBe(3.65);
});

test("empty hours (nothing posted) charge as always enforced", () => {
  const quote = quoteZone({ ...STEINWAY_A, hours: [] }, DEFAULT_POLICY, new Date(MONDAY_8PM));
  expect(quote.chargedMinutes).toBe(90);
});
