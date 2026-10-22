/**
 * The receipt bound (D0 Q3, "Before DRY_RUN=false"): a provider receipt
 * within $0.25 of the price, at or below what the driver was shown, is what
 * a started session records. Above what was shown it is trimmed to it, and
 * further off it records the price; either way the session is flagged for
 * review (`receipt_mismatch`), the caps count what the receipt said beyond
 * the recorded amount, and the worker stops extending it.
 *
 * The route half uses the Boylston St Back Bay block ($3.75/hr): a 15-min
 * start prices at $0.94 meter + $0.35 ParkBoston fee = $1.29.
 */

import { describe, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import type { ExecutorResult } from "../src/services/executor.js";
import { moneyGate, spentToday } from "../src/services/moneyGate.js";
import { principalFor } from "../src/services/principal.js";
import { boundReceipt } from "../src/services/receiptBound.js";
import { API_KEY, MONDAY_2PM, makeTestApp, seedProviderAccount, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);

const PRICE = { meterUsd: 0.94, feeUsd: 0.35, totalUsd: 1.29 };
type Receipt = typeof PRICE;

const priced = (needsReview: boolean, excessUsd: number | null = null) => ({
  ...PRICE,
  needsReview,
  excessUsd,
});

describe("boundReceipt", () => {
  test("no receipt: the price, nothing to review or count", () => {
    expect(boundReceipt(PRICE, undefined, undefined)).toEqual(priced(false));
  });

  test("a receipt under the price, within $0.25 (to the cent): the receipt", () => {
    const receipt = { meterUsd: 0.69, feeUsd: 0.35, totalUsd: 1.04 };
    expect(boundReceipt(PRICE, receipt, undefined)).toEqual({
      ...receipt,
      needsReview: false,
      excessUsd: null,
    });
  });

  test("a cent past $0.25 either way: the price, flagged; over, the rest is counted", () => {
    const under = { meterUsd: 0.68, feeUsd: 0.35, totalUsd: 1.03 };
    const over = { meterUsd: 1.2, feeUsd: 0.35, totalUsd: 1.55 };
    expect(boundReceipt(PRICE, under, undefined)).toEqual(priced(true));
    expect(boundReceipt(PRICE, over, 5)).toEqual(priced(true, 0.26));
  });

  test("within $0.25 but above what was shown: trimmed to it, flagged, the trim counted", () => {
    const receipt = { meterUsd: 1.1, feeUsd: 0.35, totalUsd: 1.45 };
    // Shown $1.35 (the tap's amount): never recorded above it.
    expect(boundReceipt(PRICE, receipt, 1.35)).toEqual({
      meterUsd: 1,
      feeUsd: 0.35,
      totalUsd: 1.35,
      needsReview: true,
      excessUsd: 0.1,
    });
    // Nothing shown but the price: the price is the ceiling.
    expect(boundReceipt(PRICE, receipt, undefined)).toEqual(priced(true, 0.16));
    // Shown more than the receipt: the receipt, nothing to review.
    expect(boundReceipt(PRICE, receipt, 2)).toEqual({
      ...receipt,
      needsReview: false,
      excessUsd: null,
    });
  });

  test("a fee above what was shown can't be trimmed into: the price, flagged, the rest counted", () => {
    const receipt = { meterUsd: 0, feeUsd: 1.4, totalUsd: 1.4 };
    const out = boundReceipt(PRICE, receipt, undefined);
    expect(out).toEqual(priced(true, 0.11));
    expect(out.meterUsd).toBeGreaterThanOrEqual(0);
  });

  test("a receipt that doesn't add up: the price, flagged", () => {
    for (const receipt of [
      { meterUsd: 0.75, feeUsd: 0.35, totalUsd: Number.NaN },
      { meterUsd: Number.POSITIVE_INFINITY, feeUsd: 0.35, totalUsd: 1.1 },
      { meterUsd: -0.1, feeUsd: 0.35, totalUsd: 0.25 },
      // A negative fee summing to the price: only the sign check catches it.
      { meterUsd: 1.39, feeUsd: -0.1, totalUsd: 1.29 },
      // meter + fee isn't the total.
      { meterUsd: 0.75, feeUsd: 0.35, totalUsd: 1.2 },
      { meterUsd: "0.75", feeUsd: 0.35, totalUsd: 1.1 } as unknown as Receipt,
    ]) {
      expect(boundReceipt(PRICE, receipt, undefined), JSON.stringify(receipt)).toEqual(
        priced(true),
      );
    }
  });

  test("a huge receipt is counted at the column's ceiling, which every cap refuses past", () => {
    const receipt = { meterUsd: 1e12, feeUsd: 0.35, totalUsd: 1e12 + 0.35 };
    expect(boundReceipt(PRICE, receipt, undefined)).toEqual(priced(true, 99_999_999.99));
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

/** A real (not dry) app whose provider answers every start with
 * `receipt`, and every extension with none. */
function makeApp(
  receipt: Receipt | null,
  caps: { daily?: number; session?: number } = {},
): ReturnType<typeof makeTestApp> {
  const paid = (withReceipt: boolean): ExecutorResult => ({
    ok: true,
    providerSessionId: "p-1",
    expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    amountUsd: receipt?.totalUsd ?? PRICE.totalUsd,
    ...(receipt && withReceipt ? { receipt } : {}),
  });
  const t = makeTestApp({
    zones: [BOYLSTON_ZONE],
    now: () => NOW,
    seedLinkedProvider: false,
    envDryRun: false,
    policy: {
      dry_run: false,
      ...(caps.daily !== undefined ? { daily_cap_usd: caps.daily } : {}),
      ...(caps.session !== undefined ? { session_cap_usd: caps.session } : {}),
    },
    executor: {
      startSession: async () => paid(true),
      extendSession: async () => paid(false),
      stopSession: async () => paid(false),
    },
  });
  seedProviderAccount(t.state, { provider: "passport" });
  return t;
}

async function start(t: ReturnType<typeof makeTestApp>, parkedEventId: string) {
  t.state.parkedEvents.push({
    id: parkedEventId,
    userId: "u1",
    lat: 42.35,
    lng: -71.08,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  return t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: { parkedEventId, zoneId: BOYLSTON_ZONE.zoneId, minutes: 15 },
  });
}

/** One start with `receipt`, and what it left behind. */
async function startWith(receipt: Receipt | null) {
  const t = makeApp(receipt);
  const res = await start(t, "pe1");
  expect(res.statusCode).toBe(200);
  const session = t.state.sessions.at(-1)!;
  const decision = t.state.decisions.find((d) => d.kind === "session_start")!;
  const summary = await t.app.inject({ method: "GET", url: "/admin/summary", headers: HEADERS });
  return { t, res, session, decision, bos: summary.json().cities.bos };
}

describe("POST /session/start records under the bound", () => {
  for (const [name, receipt, excessUsd] of [
    ["over", { meterUsd: 1.34, feeUsd: 0.35, totalUsd: 1.69 }, 0.4],
    ["under", { meterUsd: 0.5, feeUsd: 0.35, totalUsd: 0.85 }, null],
  ] as const) {
    test(`a receipt $0.40 ${name} the price records the price, receipt_mismatch, needs review`, async () => {
      const { t, res, session, decision, bos } = await startWith(receipt);
      // The reply and the session record the price, and say to check it.
      expect(res.json()).toMatchObject({ amountUsd: 1.29, needsReview: true });
      expect(Number(session.amountUsd)).toBe(0.94);
      expect(Number(session.feeUsd)).toBe(0.35);
      expect(session.status).toBe("active");
      expect(session.needsReview).toBe(true);
      // Over: the caps count the receipt; under: the price stands.
      expect(session.receiptExcessUsd ?? null).toBe(excessUsd);
      expect(await spentToday(t.deps.db, "u1", NOW)).toBeCloseTo(1.29 + (excessUsd ?? 0), 2);
      // The decision's inputs carry the receipt and what it was judged
      // against; its outcome, what was recorded.
      expect(decision.rule).toBe("receipt_mismatch");
      expect(decision.inputs).toMatchObject({
        providerReceipt: receipt,
        receiptBound: { shownTotalUsd: 1.29, boundUsd: 0.25 },
      });
      expect(decision.outcome).toMatchObject({
        allowed: true,
        ok: true,
        recordedTotalUsd: 1.29,
        needsReview: true,
      });
      expect(decision.outcome["providerReceipt"]).toBeUndefined();
      // Paid, so not a decline; counted for a person to look at.
      expect(bos.sessionsNeedReview).toBe(1);
      expect(bos.declines).toEqual({});
    });
  }

  test("no receipt records the price, start_ok, nothing to review", async () => {
    const { res, session, decision, bos } = await startWith(null);
    expect(res.json()).toMatchObject({ amountUsd: 1.29, needsReview: false });
    expect(Number(session.amountUsd)).toBe(0.94);
    expect(session.needsReview).toBe(false);
    expect(session.receiptExcessUsd).toBeNull();
    expect(decision.rule).toBe("start_ok");
    expect(decision.inputs["providerReceipt"]).toBeUndefined();
    expect(bos.sessionsNeedReview).toBe(0);
  });

  test("a receipt within $0.25, under what was shown, is what the session records", async () => {
    const receipt = { meterUsd: 0.75, feeUsd: 0.35, totalUsd: 1.1 };
    const { res, session, decision } = await startWith(receipt);
    expect(res.json()).toMatchObject({ amountUsd: 1.1, needsReview: false });
    expect(Number(session.amountUsd)).toBe(0.75);
    expect(session.needsReview).toBe(false);
    expect(session.receiptExcessUsd).toBeNull();
    expect(decision.rule).toBe("start_ok");
    expect(decision.inputs).toMatchObject({ providerReceipt: receipt });
    expect(decision.outcome).toMatchObject({ recordedTotalUsd: 1.1 });
  });

  test("a receipt within $0.25 but above the price shown: recorded at it, flagged, the rest counted", async () => {
    // A start from the app shows the price: $1.29. The card paid $1.45.
    const receipt = { meterUsd: 1.1, feeUsd: 0.35, totalUsd: 1.45 };
    const { t, res, session, decision } = await startWith(receipt);
    expect(res.json()).toMatchObject({ amountUsd: 1.29, needsReview: true });
    expect(Number(session.amountUsd)).toBe(0.94);
    expect(Number(session.feeUsd)).toBe(0.35);
    expect(session.needsReview).toBe(true);
    expect(Number(session.receiptExcessUsd)).toBe(0.16);
    expect(await spentToday(t.deps.db, "u1", NOW)).toBeCloseTo(1.45, 2);
    expect(decision.rule).toBe("receipt_mismatch");
    expect(decision.outcome).toMatchObject({ recordedTotalUsd: 1.29, receiptExcessUsd: 0.16 });
  });
});

describe("the caps count what the receipt said, not only what was recorded", () => {
  const CHARGED = { meterUsd: 3.94, feeUsd: 0.35, totalUsd: 4.29 };

  test("$4.29 charged on a $1.29 price: a second start can't pass a $5 daily cap", async () => {
    const t = makeApp(CHARGED, { daily: 5 });
    expect((await start(t, "pe1")).statusCode).toBe(200);
    expect(await spentToday(t.deps.db, "u1", NOW)).toBeCloseTo(4.29, 2);
    t.state.sessions.at(-1)!.status = "stopped";
    // $4.29 + $1.29 is over $5, though only $1.29 + $1.29 was recorded.
    const second = await start(t, "pe2");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "policy_violation", rule: "daily_cap_exceeded" });
  });

  test("the driver's extend of that session can't pass a $5 per-stop cap", async () => {
    const t = makeApp(CHARGED, { session: 5 });
    const started = await start(t, "pe1");
    expect(started.statusCode).toBe(200);
    const extended = await t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: HEADERS,
      payload: { sessionId: started.json().sessionId, minutes: 15 },
    });
    // $4.29 + $1.29 is over $5.
    expect(extended.statusCode).toBe(409);
    expect(extended.json()).toMatchObject({ rule: "session_cap_exceeded" });
  });

  test("a session with no excess extends as before", async () => {
    const t = makeApp({ meterUsd: 0.75, feeUsd: 0.35, totalUsd: 1.1 }, { session: 5 });
    const started = await start(t, "pe1");
    const extended = await t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: HEADERS,
      payload: { sessionId: started.json().sessionId, minutes: 15 },
    });
    expect(extended.statusCode).toBe(200);
  });
});

describe("a flagged session gets no automatic time", () => {
  test("the gate refuses an auto extend of it; the driver's own still runs", async () => {
    const t = makeApp(null);
    const flagged = seedSession(t.state, {
      status: "active",
      dryRun: false,
      zoneId: BOYLSTON_ZONE.zoneId,
      city: "bos",
      amountUsd: 0.94,
      feeUsd: 0.35,
      needsReview: true,
    });
    const intent = (source: "auto" | "manual") => ({
      kind: "extend" as const,
      session: flagged,
      minutes: 15,
      price: { ...PRICE, chargedMinutes: 15 },
      source,
    });
    const auto = await moneyGate(t.deps, principalFor("u1"), intent("auto"), NOW);
    expect(auto).toMatchObject({ ok: false, rule: "receipt_needs_review" });
    const manual = await moneyGate(t.deps, principalFor("u1"), intent("manual"), NOW);
    expect(manual).toMatchObject({ ok: true });
  });

  test("the worker holds it as hold_needs_review where it would otherwise extend", async () => {
    // bostonSession.test.ts's extension case: 10 min left, the phone a
    // kilometre off, so the ticket risk buys time. Flagged, it holds.
    for (const needsReview of [false, true]) {
      const t = makeApp(null);
      const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
      const session = seedSession(t.state, {
        status: "active",
        dryRun: true,
        userId: "u1",
        zoneId: BOYLSTON_ZONE.zoneId,
        city: "bos",
        startedAt: new Date(NOW.getTime() - 80 * 60_000),
        expiresAt: new Date(NOW.getTime() + 10 * 60_000),
        createdAt: new Date(NOW.getTime() - 80 * 60_000),
        amountUsd: 5.63,
        feeUsd: 0.35,
        purchasedMinutes: 90,
        chargedMinutes: 90,
        rateFirstHour: 3.75,
        rateAdditionalHour: 3.75,
        maxStayMinutes: 120,
        hoursJson: BOYLSTON_ZONE.hoursJson,
        parknycConfirmation: "dry-seed",
        needsReview,
      });
      await t.deps.db.pendingPark.create({
        data: {
          userId: "u1",
          status: "started",
          sessionId: session.id,
          carLat: 42.3495,
          carLng: -71.0798,
          parkedAt: session.createdAt,
          leftCarAt: new Date(NOW.getTime() - 79 * 60_000),
        },
      });
      t.state.locationFixes.push({
        id: "f-far",
        sessionId: session.id,
        userId: "u1",
        lat: 42.3495 + 1000 / 111_320,
        lng: -71.0798,
        accuracyM: 10,
        ts: new Date(NOW.getTime() - 60_000),
      });
      await extender.tick();
      const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
      expect(tick.rule, `needsReview ${needsReview}`).toBe(
        needsReview ? "hold_needs_review" : "extend",
      );
      expect(t.state.sessions.find((s) => s.id === session.id)!.extendCount).toBe(
        needsReview ? 0 : 1,
      );
    }
  });
});
