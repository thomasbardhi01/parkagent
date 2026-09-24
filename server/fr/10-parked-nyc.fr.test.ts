/**
 * FR-1 / FR-2 / FR-6 / FR-7 / FR-9 / FR-12 — detection handoff, NYC zone
 * resolution, unknown zones, quote self-consistency, timestamp clamping,
 * and the auto-pay rate ceiling, against the live API in dry run.
 *
 * Enforced-hours tests price at the most recent 14:00 Eastern already in
 * the past (inside the 24h ts window at any run hour). When that lands on
 * a Sunday, the same call must price as a free period instead — both
 * branches are asserted.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  easternDaysAgoAt,
  easternHourWithin,
  easternWeekday,
  frFetch,
  gate,
  ladderMeterUsd,
  mostRecentEasternAt,
  NOWHERE,
  NYC_AUTOPAY,
  NYC_PRICEY,
  parkedBody,
} from "./client.js";

const AFTERNOON = mostRecentEasternAt(14, 0);
const SUNDAY = easternWeekday(AFTERNOON) === "Sun";

let policy: Record<string, unknown>;

beforeAll(async () => {
  policy = (await gate())["policy"] as Record<string, unknown>;
});

describe("FR-1 park event → /parked", () => {
  it("FR-1 a detected park writes a parked event and an audited decision, and answers a plan", async () => {
    const res = await frFetch("POST", "/parked", parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }));
    expect(res.status).toBe(200);
    expect(typeof res.body["parkedEventId"]).toBe("string");
    expect(typeof res.body["decisionId"]).toBe("string");
    expect(res.body["dryRun"]).toBe(true);
    expect(["pay", "confirm", "ignore", "unknown_zone"]).toContain(res.body["action"]);
  });
});

describe("FR-2 NYC zone resolution", () => {
  it("FR-2 FR-7 a park at 30th Ave & Steinway resolves the ParkNYC zone and prices the ladder", async () => {
    const res = await frFetch("POST", "/parked", parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }));
    expect(res.status).toBe(200);
    const candidates = res.body["candidates"] as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);
    const nearest = candidates[0]!;
    expect(nearest["city"]).toBe("nyc");
    expect(nearest["providerZoneNumber"]).toMatch(/^\d{3,10}$/);
    const provider = res.body["provider"] as Record<string, unknown>;
    expect(provider["id"]).toBe("parknyc");
    expect(res.body["needsZoneNumber"]).toBe(false);

    const quote = res.body["quote"] as Record<string, unknown>;
    expect(quote).toBeTruthy();
    if (SUNDAY) {
      // No enforcement on Sunday: the whole stay is free.
      expect(res.body["action"]).toBe("ignore");
      expect(res.body["rule"]).toBe("free_period");
      expect(quote["totalUsd"]).toBe(0);
      return;
    }
    // $2.00/$3.00 sits under the rate ceiling and every cap → auto-pay.
    expect(res.body["action"]).toBe("pay");
    expect(res.body["rule"]).toBe("auto_pay_ok");
    // FR-7: the quote is the documented ladder over the charged minutes,
    // and total = meter + fee exactly.
    const charged = quote["chargedMinutes"] as number;
    const meter = quote["meterUsd"] as number;
    const fee = quote["feeUsd"] as number;
    const total = quote["totalUsd"] as number;
    expect(charged).toBeGreaterThan(0);
    const recomputed = ladderMeterUsd(
      charged,
      nearest["rateFirstHourUsd"] as number,
      nearest["rateAdditionalHourUsd"] as number,
    );
    expect(Math.abs(meter - recomputed)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(total - (meter + fee))).toBeLessThanOrEqual(0.005);
    expect(fee).toBeGreaterThan(0); // NYC per-city fee applies when the meter charges
  });

  it("FR-2 GET /city places the same point in NYC with the ParkNYC provider", async () => {
    const res = await frFetch("GET", `/city?lat=${NYC_AUTOPAY.lat}&lng=${NYC_AUTOPAY.lng}`);
    expect(res.status).toBe(200);
    expect(res.body["city"]).toBe("nyc");
    const provider = res.body["provider"] as Record<string, unknown>;
    expect(provider["id"]).toBe("parknyc");
    expect(Array.isArray(provider["cookieDomains"])).toBe(true);
  });
});

describe("FR-6 unknown zone", () => {
  it("FR-6 a park nowhere near a meter answers unknown_zone with no quote and no candidates", async () => {
    const res = await frFetch("POST", "/parked", parkedBody(NOWHERE));
    expect(res.status).toBe(200);
    expect(res.body["action"]).toBe("unknown_zone");
    expect(res.body["rule"]).toBe("unknown_zone");
    expect(res.body["quote"]).toBeNull();
    expect(res.body["candidates"]).toEqual([]);
    expect(res.body["provider"]).toBeNull();
  });

  it('FR-6 GET /city off the coast answers all-null ("we\'re not there yet")', async () => {
    const res = await frFetch("GET", `/city?lat=${NOWHERE.lat}&lng=${NOWHERE.lng}`);
    expect(res.status).toBe(200);
    expect(res.body["city"]).toBeNull();
    expect(res.body["cityDisplayName"]).toBeNull();
    expect(res.body["provider"]).toBeNull();
  });
});

describe("FR-12 auto-pay rate ceiling", () => {
  it("FR-12 a zone whose ladder tops auto_pay_max_rate_per_hour is never auto-paid", async () => {
    const res = await frFetch("POST", "/parked", parkedBody(NYC_PRICEY, { ts: AFTERNOON }));
    expect(res.status).toBe(200);
    const candidates = res.body["candidates"] as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);
    const nearest = candidates[0]!;
    const ladderMax = Math.max(
      nearest["rateFirstHourUsd"] as number,
      nearest["rateAdditionalHourUsd"] as number,
    );
    expect(ladderMax).toBeGreaterThan(policy["auto_pay_max_rate_per_hour"] as number);
    if (SUNDAY) {
      expect(res.body["action"]).toBe("ignore");
      return;
    }
    expect(res.body["action"]).not.toBe("pay");
    // Nearest-candidate disagreement outranks the ceiling in the rule
    // table; either way the FR holds — no silent payment above the ceiling.
    expect(["rate_above_ceiling", "candidates_disagree"]).toContain(res.body["rule"]);
  });
});

describe("FR-9 timestamp clamping", () => {
  // Only conclusive while the server's current Eastern time is OUTSIDE
  // enforcement hours (the nightly window): a clamped ts must then price
  // as a free period where the stale ts would have priced midday money.
  it.skipIf(easternHourWithin(8, 20))(
    "FR-9 a ts three days stale is clamped to server time before pricing",
    async () => {
      const stale = easternDaysAgoAt(3, 14, 0);
      const res = await frFetch("POST", "/parked", parkedBody(NYC_AUTOPAY, { ts: stale }));
      expect(res.status).toBe(200);
      expect(res.body["action"]).toBe("ignore");
      expect(res.body["rule"]).toBe("free_period");
      expect((res.body["quote"] as Record<string, unknown>)["totalUsd"]).toBe(0);
    },
  );
});
