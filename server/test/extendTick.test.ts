/**
 * Extension worker scenarios. One session at 30th Ave & Steinway ($2/$3,
 * 120 min max stay), started 13:00, meter ending 14:30, evaluated at 14:20
 * (10 min left — inside the 12-minute decision window; elapsed 80 min).
 * With no dwell history the model predicts P80 ≈ 113 min, so the desired
 * extension is 33 min, clamped to 30 by the 120-minute max stay.
 */

import { expect, test } from "vitest";

import type { SessionRow } from "../src/db.js";
import {
  dwellStatsFrom,
  headingFromDistances,
  makeExtender,
  pReturnInTime,
} from "../src/jobs/extendTick.js";
import type { FakeDbState } from "./helpers.js";
import { HOURS_MON_SAT, makeTestApp, seedSession } from "./helpers.js";

const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`); // a Monday
const NOW = T("14:20");
const CAR = { lat: 40.7702, lng: -73.9077 };

function activeSession(state: FakeDbState, overrides: Partial<SessionRow> = {}): SessionRow {
  return seedSession(state, {
    status: "active",
    dryRun: true,
    zoneId: "nyc-417371",
    parknycZoneNumber: "417371",
    startedAt: T("13:00"),
    expiresAt: T("14:30"),
    createdAt: T("13:00"),
    amountUsd: 3.5,
    feeUsd: 0.15,
    purchasedMinutes: 90,
    chargedMinutes: 90,
    carLat: CAR.lat,
    carLng: CAR.lng,
    rateFirstHour: 2.0,
    rateAdditionalHour: 3.0,
    maxStayMinutes: 120,
    hoursJson: HOURS_MON_SAT,
    parknycConfirmation: "dry-seed",
    ...overrides,
  });
}

/** Phone fixes at the given straight-line distances (m) north of the car. */
function addFixes(state: FakeDbState, sessionId: string, distancesM: number[]): void {
  distancesM.forEach((distM, i) => {
    state.locationFixes.push({
      id: `f${state.locationFixes.length + 1}`,
      sessionId,
      userId: "u1",
      lat: CAR.lat + distM / 111_320,
      lng: CAR.lng,
      accuracyM: 10,
      ts: new Date(NOW.getTime() - (distancesM.length - i) * 60_000),
    });
  });
}

function makeTickApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp({ now: () => NOW, ...options });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  return { ...t, extender };
}

function lastTick(state: FakeDbState) {
  return state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
}

test("driver far away and heading away: extend to the max-stay clamp", async () => {
  const { state, extender, pushes } = makeTickApp();
  const session = activeSession(state);
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  const decision = lastTick(state);
  expect(decision.rule).toBe("extend");
  expect(decision.inputs).toMatchObject({ heading: "away", pReturn: 0.15, desiredMinutes: 30 });
  expect(decision.outcome).toMatchObject({ action: "extend", minutes: 30 });
  // 30 min past the first hour = $1.50 + $0.15 fee; meter now ends 15:00.
  expect(session.expiresAt!.getTime()).toBe(T("15:00").getTime());
  expect(session).toMatchObject({ purchasedMinutes: 120, extendCount: 1 });
  expect(Number(session.amountUsd)).toBe(5.0);
  expect(state.sessionEvents.at(-1)).toMatchObject({
    kind: "extended",
    details: { source: "auto" },
  });
  expect(pushes.map((p) => p.push.type)).toEqual(["session_extended"]);
  expect(session.lastExtenderRule).toBe("extend");
});

test("driver walking back with time to spare: hold, no push", async () => {
  const { state, extender, pushes } = makeTickApp();
  const session = activeSession(state);
  addFixes(state, session.id, [800, 400, 200]); // toward; walk ETA ≈ 3.3 min < 10

  await extender.tick();

  const decision = lastTick(state);
  expect(decision.rule).toBe("hold_return_likely");
  expect(decision.inputs).toMatchObject({ heading: "toward", pReturn: 0.98 });
  expect(session.extendCount).toBe(0);
  expect(pushes).toHaveLength(0);
});

test("at the zone max stay: warn to move the car, once", async () => {
  const { state, extender, pushes } = makeTickApp();
  const session = activeSession(state, { purchasedMinutes: 120, chargedMinutes: 120 });
  addFixes(state, session.id, [100, 300, 600]); // would want to extend

  await extender.tick();
  await extender.tick(); // same rule again — no second push

  expect(lastTick(state).rule).toBe("warn_max_stay");
  expect(session.extendCount).toBe(0);
  expect(pushes.map((p) => p.push.type)).toEqual(["session_expiring"]);
  expect(pushes[0]!.push.extra).toMatchObject({ reason: "max_stay" });
});

test("daily budget exhausted: hold and warn with reason budget", async () => {
  const { state, extender, pushes } = makeTickApp({
    policy: { dry_run: false },
    envDryRun: false,
  });
  seedSession(state, { status: "stopped", dryRun: false, amountUsd: 58, feeUsd: 0.3 });
  const session = activeSession(state, { dryRun: false });
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  expect(lastTick(state).rule).toBe("hold_daily_cap");
  expect(session.extendCount).toBe(0);
  expect(pushes.map((p) => p.push.type)).toEqual(["session_expiring"]);
  expect(pushes[0]!.push.extra).toMatchObject({ reason: "budget" });
});

test("a fresh contrary decision is held for five minutes", async () => {
  const { state, extender } = makeTickApp();
  const session = activeSession(state, {
    lastExtenderRule: "hold_return_likely",
    lastExtenderRuleAt: T("14:18"),
  });
  addFixes(state, session.id, [100, 300, 600]); // now says extend

  await extender.tick();

  const decision = lastTick(state);
  expect(decision.rule).toBe("hysteresis_hold");
  expect(decision.inputs).toMatchObject({ desiredRule: "extend", heldRule: "hold_return_likely" });
  expect(session.extendCount).toBe(0);
  expect(session.lastExtenderRule).toBe("hold_return_likely"); // anchor unchanged
});

test("the same contrary decision goes through once the window passes", async () => {
  const { state, extender } = makeTickApp();
  const session = activeSession(state, {
    lastExtenderRule: "hold_return_likely",
    lastExtenderRuleAt: T("14:10"),
  });
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  expect(lastTick(state).rule).toBe("extend");
  expect(session.extendCount).toBe(1);
});

test("well before expiry the worker only observes", async () => {
  const { state, extender, pushes } = makeTickApp();
  const session = activeSession(state, { expiresAt: T("15:00") }); // 40 min left
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  expect(lastTick(state).rule).toBe("hold_not_near_expiry");
  expect(session.extendCount).toBe(0);
  expect(pushes).toHaveLength(0);
});

test("a session past its expiry is marked expired", async () => {
  const { state, extender } = makeTickApp();
  const session = activeSession(state, { expiresAt: T("14:10") });

  await extender.tick();

  expect(session.status).toBe("expired");
  expect(state.sessionEvents.at(-1)).toMatchObject({ kind: "expired" });
  expect(lastTick(state).rule).toBe("expired");
});

// --- unit checks on the model pieces ---

test("heading classification", () => {
  expect(headingFromDistances([])).toBe("unknown");
  expect(headingFromDistances([500])).toBe("unknown");
  expect(headingFromDistances([500, 495, 505])).toBe("still");
  expect(headingFromDistances([500, 300, 100])).toBe("toward");
  expect(headingFromDistances([100, 300, 500])).toBe("away");
});

test("dwell stats fall back to the default stay, then learn from history", () => {
  expect(dwellStatsFrom([], 90)).toEqual({ p50Minutes: 90, p80Minutes: 113, sampleCount: 0 });
  expect(dwellStatsFrom([60, 120], 90).p50Minutes).toBe(90);
  const learned = dwellStatsFrom([30, 60, 90, 120, 150], 90);
  expect(learned).toMatchObject({ p50Minutes: 90, p80Minutes: 126, sampleCount: 5 });
});

test("pReturnInTime buckets", () => {
  const base = { walkEtaMin: 5, remainingMin: 10, elapsedMin: 80, dwellP50Min: 90 };
  expect(pReturnInTime({ ...base, heading: "toward" })).toBe(0.98);
  expect(pReturnInTime({ ...base, heading: "toward", walkEtaMin: 20 })).toBeCloseTo(0.4);
  expect(pReturnInTime({ ...base, heading: "away" })).toBe(0.15);
  expect(pReturnInTime({ ...base, heading: "still" })).toBe(0.6); // dwell ends within remaining
  expect(pReturnInTime({ ...base, heading: "still", dwellP50Min: 180 })).toBe(0.25);
});
