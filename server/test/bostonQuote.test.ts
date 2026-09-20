/**
 * Boston pricing: flat $x/hr rate, the ParkBoston fee and ticket cost from
 * policy.city_overrides, and enforcement-hour edges (free Sunday; the
 * Saturday 8 PM boundary). Rates per boston.gov — see data/README.md.
 */

import { expect, test } from "vitest";

import { cityPolicy } from "../src/services/policy.js";
import { priceStay, quoteZone } from "../src/services/quote.js";
import { BOYLSTON_BOS, DEFAULT_POLICY, makeTestApp, parkedBody } from "./helpers.js";

// 2026-01-06 is a Tuesday; 2026-01-10 a Saturday; 2026-01-11 a Sunday.
const TUESDAY_2PM = new Date("2026-01-06T14:00:00-05:00");
const SATURDAY_759PM = new Date("2026-01-10T19:59:00-05:00");
const SATURDAY_801PM = new Date("2026-01-10T20:01:00-05:00");
const SUNDAY_NOON = new Date("2026-01-11T12:00:00-05:00");

const BOS_TERMS = {
  city: "bos",
  rateFirstHourUsd: 3.75,
  rateAdditionalHourUsd: 3.75,
  hours: BOYLSTON_BOS.hours,
};

test("city_overrides resolve fee and ticket cost per city, with fallbacks", () => {
  expect(cityPolicy(DEFAULT_POLICY, "bos")).toEqual({ parkingFeeUsd: 0.35, ticketCostUsd: 40 });
  expect(cityPolicy(DEFAULT_POLICY, "nyc")).toEqual({ parkingFeeUsd: 0.15, ticketCostUsd: 65 });
  // No overrides at all → the top-level (NYC) numbers.
  const bare = { ...DEFAULT_POLICY };
  delete (bare as Record<string, unknown>)["city_overrides"];
  expect(cityPolicy(bare, "bos")).toEqual({ parkingFeeUsd: 0.15, ticketCostUsd: 65 });
  // Unknown/absent city → defaults too (pre-city rows).
  expect(cityPolicy(DEFAULT_POLICY, undefined)).toEqual({ parkingFeeUsd: 0.15, ticketCostUsd: 65 });
});

test("Back Bay weekday quote: flat $3.75/hr, ParkBoston $0.35 fee", () => {
  // 90 min enforced: 60 @ $3.75 + 30 @ $3.75 = $5.625 -> $5.63 meter.
  const quote = quoteZone(BOYLSTON_BOS, DEFAULT_POLICY, TUESDAY_2PM);
  expect(quote).toMatchObject({
    stayMinutes: 90,
    chargedMinutes: 90,
    meterUsd: 5.63,
    feeUsd: 0.35,
    totalUsd: 5.98,
  });
});

test("Sunday is free: zero charged minutes, no fee", () => {
  const quote = quoteZone(BOYLSTON_BOS, DEFAULT_POLICY, SUNDAY_NOON);
  expect(quote).toMatchObject({ chargedMinutes: 0, meterUsd: 0, feeUsd: 0, totalUsd: 0 });
});

test("Saturday 7:59 PM still bills the last enforced minute; 8:01 PM is free", () => {
  const lastMinute = priceStay(BOS_TERMS, DEFAULT_POLICY, SATURDAY_759PM, 30);
  // One enforced minute (19:59-20:00) at $3.75/hr = $0.0625 -> $0.06 + fee.
  expect(lastMinute).toMatchObject({ chargedMinutes: 1, meterUsd: 0.06, feeUsd: 0.35 });
  expect(lastMinute.totalUsd).toBe(0.41);

  const afterHours = priceStay(BOS_TERMS, DEFAULT_POLICY, SATURDAY_801PM, 30);
  expect(afterHours).toMatchObject({ chargedMinutes: 0, meterUsd: 0, feeUsd: 0, totalUsd: 0 });
});

test("/parked candidates carry city and Boston quotes use the bos fee", async () => {
  const { app } = makeTestApp({ candidates: [BOYLSTON_BOS], now: () => TUESDAY_2PM });
  const res = await app.inject({
    method: "POST",
    url: "/parked",
    headers: { "x-api-key": "test-key" },
    payload: parkedBody({ ts: TUESDAY_2PM.toISOString() }),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.candidates[0]).toMatchObject({
    zoneId: "bos-boylston-st-e-d-819305",
    city: "bos",
  });
  expect(body.quote).toMatchObject({ meterUsd: 5.63, feeUsd: 0.35, totalUsd: 5.98 });
});
