/**
 * Boston pricing: flat $x/hr rate, the ParkBoston fee and ticket cost from
 * policy.city_overrides, and enforcement-hour edges (free Sunday; the
 * Saturday 8 PM boundary). Rates per boston.gov — see data/README.md.
 */

import { expect, test } from "vitest";

import { cityPolicy, DEFAULT_PARKING_FEE_USD, policySchema } from "../src/services/policy.js";
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
  // Each city carries its own pay-by-app fee; nothing city-specific lives
  // at the top level any more.
  expect(cityPolicy(DEFAULT_POLICY, "bos")).toEqual({ parkingFeeUsd: 0.35, ticketCostUsd: 40 });
  expect(cityPolicy(DEFAULT_POLICY, "nyc")).toEqual({ parkingFeeUsd: 0.15, ticketCostUsd: 65 });
  // NYC's shipped fee equals DEFAULT_PARKING_FEE_USD, so the line above
  // can't tell "read the override" from "fell through to the default".
  // A fee only the override carries can.
  const repriced = {
    ...DEFAULT_POLICY,
    city_overrides: { ...DEFAULT_POLICY.city_overrides, nyc: { parking_fee_usd: 0.27 } },
  };
  expect(cityPolicy(repriced, "nyc").parkingFeeUsd).toBe(0.27);
  // No overrides at all → the top-level ticket cost and the default fee.
  const bare = { ...DEFAULT_POLICY };
  delete (bare as Record<string, unknown>)["city_overrides"];
  expect(cityPolicy(bare, "bos")).toEqual({
    parkingFeeUsd: DEFAULT_PARKING_FEE_USD,
    ticketCostUsd: 65,
  });
  // Unknown/absent city → the same defaults (pre-city rows).
  expect(cityPolicy(DEFAULT_POLICY, undefined)).toEqual({
    parkingFeeUsd: DEFAULT_PARKING_FEE_USD,
    ticketCostUsd: 65,
  });
});

test("a pre-migration document still resolves through the deprecated fee", () => {
  // policy.json files written before the fee moved under city_overrides keep
  // working: the top-level key is accepted and used as the fallback. The
  // legacy value is deliberately NOT the default (0.15), or this would pass
  // with the fallback deleted.
  const legacy = {
    ...DEFAULT_POLICY,
    parknyc_fee_usd: 0.2,
    city_overrides: { bos: { parking_fee_usd: 0.35, ticket_cost_usd: 40 } },
  };
  expect(DEFAULT_PARKING_FEE_USD).not.toBe(0.2);
  expect(policySchema.safeParse(legacy).success).toBe(true);
  expect(cityPolicy(legacy, "nyc")).toEqual({ parkingFeeUsd: 0.2, ticketCostUsd: 65 });
  // A city's own override still wins over the legacy top-level key.
  expect(cityPolicy(legacy, "bos")).toEqual({ parkingFeeUsd: 0.35, ticketCostUsd: 40 });
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
