/**
 * The receipt bound (D0 Q3, "Before DRY_RUN=false"): a provider receipt
 * within $0.25 of the price is what a started session records, never above
 * what the driver was shown; one further off, or one that doesn't add up,
 * records the price, writes `receipt_mismatch`, and flags the session.
 *
 * The route half uses the Boylston St Back Bay block ($3.75/hr): a 15-min
 * start prices at $0.94 meter + $0.35 ParkBoston fee = $1.29.
 */

import { describe, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import type { ExecutorResult } from "../src/services/executor.js";
import { boundReceipt } from "../src/services/receiptBound.js";
import { API_KEY, MONDAY_2PM, makeTestApp, seedProviderAccount } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);

const PRICE = { meterUsd: 0.94, feeUsd: 0.35, totalUsd: 1.29 };

describe("boundReceipt", () => {
  test("no receipt: the price", () => {
    expect(boundReceipt(PRICE, undefined, undefined)).toEqual({ ...PRICE, mismatch: false });
  });

  test("a receipt under the price, within $0.25 (to the cent): the receipt", () => {
    const receipt = { meterUsd: 0.69, feeUsd: 0.35, totalUsd: 1.04 };
    expect(boundReceipt(PRICE, receipt, undefined)).toEqual({ ...receipt, mismatch: false });
  });

  test("a cent past $0.25 either way: the price, flagged", () => {
    const under = { meterUsd: 0.68, feeUsd: 0.35, totalUsd: 1.03 };
    const over = { meterUsd: 1.2, feeUsd: 0.35, totalUsd: 1.55 };
    expect(boundReceipt(PRICE, under, undefined)).toEqual({ ...PRICE, mismatch: true });
    expect(boundReceipt(PRICE, over, 5)).toEqual({ ...PRICE, mismatch: true });
  });

  test("within $0.25 but above what was shown: trimmed to the shown amount, the meter takes it", () => {
    const receipt = { meterUsd: 1.1, feeUsd: 0.35, totalUsd: 1.45 };
    // Shown $1.35 (the tap's amount): never above it.
    expect(boundReceipt(PRICE, receipt, 1.35)).toEqual({
      meterUsd: 1,
      feeUsd: 0.35,
      totalUsd: 1.35,
      mismatch: false,
    });
    // Nothing shown but the price: the price is the ceiling.
    expect(boundReceipt(PRICE, receipt, undefined)).toEqual({ ...PRICE, mismatch: false });
    // Shown more than the receipt: the receipt.
    expect(boundReceipt(PRICE, receipt, 2)).toEqual({ ...receipt, mismatch: false });
  });

  test("a receipt that doesn't add up: the price, flagged", () => {
    for (const receipt of [
      { meterUsd: 0.75, feeUsd: 0.35, totalUsd: Number.NaN },
      { meterUsd: Number.POSITIVE_INFINITY, feeUsd: 0.35, totalUsd: 1.1 },
      { meterUsd: -0.1, feeUsd: 0.35, totalUsd: 0.25 },
      // meter + fee isn't the total.
      { meterUsd: 0.75, feeUsd: 0.35, totalUsd: 1.2 },
      { meterUsd: "0.75", feeUsd: 0.35, totalUsd: 1.1 } as unknown as typeof PRICE,
    ]) {
      expect(boundReceipt(PRICE, receipt, undefined)).toEqual({ ...PRICE, mismatch: true });
    }
  });
});

const BOYLSTON_ZONE: ZoneTermsRow = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  street: "BOYLSTON ST",
  providerZoneNumber: "81234",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 120,
  hoursJson: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }],
};

/** A real (not dry) start whose provider answers with `receipt`. */
async function startWith(receipt: { meterUsd: number; feeUsd: number; totalUsd: number } | null) {
  const expiresAt = new Date(NOW.getTime() + 15 * 60_000);
  const paid: ExecutorResult = {
    ok: true,
    providerSessionId: "p-1",
    expiresAt,
    amountUsd: receipt?.totalUsd ?? PRICE.totalUsd,
    ...(receipt ? { receipt } : {}),
  };
  const t = makeTestApp({
    zones: [BOYLSTON_ZONE],
    now: () => NOW,
    seedLinkedProvider: false,
    envDryRun: false,
    policy: { dry_run: false },
    executor: {
      startSession: async () => paid,
      extendSession: async () => paid,
      stopSession: async () => paid,
    },
  });
  seedProviderAccount(t.state, { provider: "passport" });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 42.35,
    lng: -71.08,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: { parkedEventId: "pe1", zoneId: BOYLSTON_ZONE.zoneId, minutes: 15 },
  });
  expect(res.statusCode).toBe(200);
  const session = t.state.sessions.at(-1)!;
  const decision = t.state.decisions.find((d) => d.kind === "session_start")!;
  const summary = await t.app.inject({ method: "GET", url: "/admin/summary", headers: HEADERS });
  return { t, res, session, decision, bos: summary.json().cities.bos };
}

describe("POST /session/start records under the bound", () => {
  for (const [name, receipt] of [
    ["over", { meterUsd: 1.34, feeUsd: 0.35, totalUsd: 1.69 }],
    ["under", { meterUsd: 0.5, feeUsd: 0.35, totalUsd: 0.85 }],
  ] as const) {
    test(`a receipt $0.40 ${name} the price records the price, receipt_mismatch, needs review`, async () => {
      const { res, session, decision, bos } = await startWith(receipt);
      // The reply, the session and the daily cap's spend are the price.
      expect(res.json().amountUsd).toBe(1.29);
      expect(Number(session.amountUsd)).toBe(0.94);
      expect(Number(session.feeUsd)).toBe(0.35);
      expect(session.status).toBe("active");
      expect(session.needsReview).toBe(true);
      // The decision says so, and keeps the receipt for the audit.
      expect(decision.rule).toBe("receipt_mismatch");
      expect(decision.outcome).toMatchObject({
        allowed: true,
        ok: true,
        providerReceipt: receipt,
        recordedTotalUsd: 1.29,
        needsReview: true,
      });
      // Paid, so not a decline; counted for a person to look at.
      expect(bos.sessionsNeedReview).toBe(1);
      expect(bos.declines).toEqual({});
    });
  }

  test("no receipt records the price, start_ok, nothing to review", async () => {
    const { res, session, decision, bos } = await startWith(null);
    expect(res.json().amountUsd).toBe(1.29);
    expect(Number(session.amountUsd)).toBe(0.94);
    expect(session.needsReview).toBeUndefined();
    expect(decision.rule).toBe("start_ok");
    expect(decision.outcome["providerReceipt"]).toBeUndefined();
    expect(bos.sessionsNeedReview).toBe(0);
  });

  test("a receipt within $0.25 is what the session records", async () => {
    const receipt = { meterUsd: 0.75, feeUsd: 0.35, totalUsd: 1.1 };
    const { res, session, decision } = await startWith(receipt);
    expect(res.json().amountUsd).toBe(1.1);
    expect(Number(session.amountUsd)).toBe(0.75);
    expect(session.needsReview).toBeUndefined();
    expect(decision.rule).toBe("start_ok");
    expect(decision.outcome).toMatchObject({ providerReceipt: receipt, recordedTotalUsd: 1.1 });
  });

  test("a receipt within $0.25 but above the price shown is never recorded above it", async () => {
    // A start from the app shows the price: $1.29.
    const receipt = { meterUsd: 1.1, feeUsd: 0.35, totalUsd: 1.45 };
    const { res, session, decision } = await startWith(receipt);
    expect(res.json().amountUsd).toBe(1.29);
    expect(Number(session.amountUsd)).toBe(0.94);
    expect(Number(session.feeUsd)).toBe(0.35);
    expect(decision.rule).toBe("start_ok");
    expect(decision.outcome).toMatchObject({ providerReceipt: receipt, recordedTotalUsd: 1.29 });
  });
});
