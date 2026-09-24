/**
 * FR-3 / FR-4 / FR-8 / FR-20 — Boston zone resolution with and without a
 * ParkBoston number, the driver-report flow, and free periods around the
 * 8 pm end of enforcement, against the live API in dry run.
 *
 * The with-number test is self-healing: if the target database doesn't
 * yet carry zone 456 on the acceptance block (a fresh load), the suite
 * reports the number the way a driver would — it is the real posted
 * number, verified live on 2026-09-23 (docs/acceptance-report.md Part B)
 * — and asserts the next park resolves it.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  BOS_UNNUMBERED,
  BOS_ZONE_456,
  easternWeekday,
  frFetch,
  gate,
  mostRecentEasternAt,
  parkedBody,
} from "./client.js";

const AFTERNOON = mostRecentEasternAt(14, 0);
const SUNDAY = easternWeekday(AFTERNOON) === "Sun";
// The boundary fixture can land on a different calendar day than the
// afternoon one (runs between 14:00 and 19:30 ET), so it gets its own
// Sunday check.
const BOUNDARY = mostRecentEasternAt(19, 30);
const BOUNDARY_SUNDAY = easternWeekday(BOUNDARY) === "Sun";

beforeAll(async () => {
  await gate();
});

async function parkAt456(): Promise<Record<string, unknown>> {
  const res = await frFetch("POST", "/parked", parkedBody(BOS_ZONE_456, { ts: AFTERNOON }));
  expect(res.status).toBe(200);
  const candidates = res.body["candidates"] as Record<string, unknown>[];
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates[0]!["city"]).toBe("bos");
  return res.body;
}

describe("FR-3 / FR-20 Boston resolution with a provider number", () => {
  it("FR-20 FR-3 a driver report fills the zone number and later parks resolve it", async () => {
    let body = await parkAt456();
    let nearest = (body["candidates"] as Record<string, unknown>[])[0]!;

    if ((nearest["providerZoneNumber"] as string) === "") {
      // Unreported here: exercise the report flow with the true posted
      // number, then park again — every later park must be automatic.
      const report = await frFetch(
        "POST",
        `/zones/${encodeURIComponent(nearest["zoneId"] as string)}/provider-number`,
        { number: BOS_ZONE_456.postedNumber, source: "user" },
      );
      expect(report.status).toBe(200);
      expect(report.body["ok"]).toBe(true);
      // What is ON the zone now (import/verified precedence may differ
      // from our input) — clients must use this, not what they typed.
      expect(report.body["number"]).toMatch(/^\d{3,10}$/);
      expect(["report", "import", "verified"]).toContain(report.body["appliedSource"]);
      expect(typeof report.body["decisionId"]).toBe("string");

      body = await parkAt456();
      nearest = (body["candidates"] as Record<string, unknown>[])[0]!;
      expect(nearest["providerZoneNumber"]).toBe(report.body["number"]);
    }

    expect(nearest["providerZoneNumber"]).toMatch(/^\d{3,10}$/);
    expect(body["needsZoneNumber"]).toBe(false);
    const provider = body["provider"] as Record<string, unknown>;
    expect(provider["id"]).toBe("passport");
    expect(provider["city"]).toBe("bos");
    // Boston prices a flat hourly ladder: both rate fields equal.
    expect(nearest["rateFirstHourUsd"]).toBe(nearest["rateAdditionalHourUsd"]);
    // Quote arithmetic holds whatever the terms source (dataset or
    // provider-observed): total = meter + fee, and a free stay has no fee.
    const quote = body["quote"] as Record<string, unknown>;
    const meter = quote["meterUsd"] as number;
    const fee = quote["feeUsd"] as number;
    expect(Math.abs((quote["totalUsd"] as number) - (meter + fee))).toBeLessThanOrEqual(0.005);
    if (meter === 0) expect(fee).toBe(0);
    if (!SUNDAY) expect(meter).toBeGreaterThan(0);
  });
});

describe("FR-4 Boston resolution without a provider number", () => {
  it("FR-4 an unreported block is never auto-paid: needsZoneNumber rides the response and pay downgrades to confirm", async (ctx) => {
    const res = await frFetch("POST", "/parked", parkedBody(BOS_UNNUMBERED, { ts: AFTERNOON }));
    expect(res.status).toBe(200);
    const candidates = res.body["candidates"] as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);
    const nearest = candidates[0]!;
    expect(nearest["city"]).toBe("bos");
    if ((nearest["providerZoneNumber"] as string) !== "") {
      // Someone (or the Passport import) has numbered this block since the
      // fixture was chosen; the without-number path needs a new block.
      ctx.skip();
      return;
    }
    if (SUNDAY) {
      // Free period: nothing to pay, so "ignore" stands and no number is
      // demanded (needsZoneNumber is only raised for payable outcomes).
      expect(res.body["action"]).toBe("ignore");
      return;
    }
    expect(res.body["needsZoneNumber"]).toBe(true);
    expect(res.body["action"]).toBe("confirm");
    // A cheap agreeing block would have auto-paid — the missing number is
    // what downgrades it (unless a stronger confirm rule fired first).
    expect(["needs_zone_number", "candidates_disagree"]).toContain(res.body["rule"]);
  });
});

describe("FR-8 free periods and the 8 pm boundary", () => {
  it("FR-8 a park after 8 pm on Boylston is a free period: ignore, $0, no fee", async () => {
    const evening = mostRecentEasternAt(21, 15);
    const res = await frFetch("POST", "/parked", parkedBody(BOS_ZONE_456, { ts: evening }));
    expect(res.status).toBe(200);
    expect(res.body["action"]).toBe("ignore");
    expect(res.body["rule"]).toBe("free_period");
    const quote = res.body["quote"] as Record<string, unknown>;
    expect(quote["totalUsd"]).toBe(0);
    expect(quote["feeUsd"]).toBe(0);
  });

  it.skipIf(BOUNDARY_SUNDAY)(
    "FR-8 a stay straddling 8 pm is charged only for the enforced minutes",
    async () => {
      const res = await frFetch("POST", "/parked", parkedBody(BOS_ZONE_456, { ts: BOUNDARY }));
      expect(res.status).toBe(200);
      const quote = res.body["quote"] as Record<string, unknown>;
      const stay = quote["stayMinutes"] as number;
      const charged = quote["chargedMinutes"] as number;
      // Enforcement ends 20:00 — at most the first 30 minutes can charge.
      expect(charged).toBeGreaterThan(0);
      expect(charged).toBeLessThanOrEqual(30);
      expect(charged).toBeLessThan(stay);
    },
  );
});
