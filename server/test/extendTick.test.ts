/**
 * Extension worker scenarios. One session at 30th Ave & Steinway ($2/$3,
 * 120 min max stay), started 13:00, meter ending 14:30, evaluated at 14:20
 * (10 min left — inside the 12-minute decision window; elapsed 80 min).
 * With no dwell history the model predicts P80 ≈ 113 min, so the desired
 * extension is 33 min, clamped to 30 by the 120-minute max stay.
 */

import { expect, test } from "vitest";

import type { SessionRow } from "../src/db.js";
import { dwellStatsFrom, makeExtender, pReturnInTime } from "../src/jobs/extendTick.js";
import { headingFromDistances } from "../src/services/pendingSession.js";
import type { FakeDbState } from "./helpers.js";
import { HOURS_MON_SAT, makeTestApp, seedAwayPark, seedSession } from "./helpers.js";

const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`); // a Monday
const NOW = T("14:20");
const CAR = { lat: 40.7702, lng: -73.9077 };

function activeSession(state: FakeDbState, overrides: Partial<SessionRow> = {}): SessionRow {
  return seedSession(state, {
    status: "active",
    dryRun: true,
    zoneId: "nyc-417371",
    providerZoneNumber: "417371",
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
  seedAwayPark(state, session);
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
  seedAwayPark(state, session);
  addFixes(state, session.id, [800, 400, 200]); // toward; walk ETA ≈ 3.3 min < 10

  await extender.tick();

  const decision = lastTick(state);
  expect(decision.rule).toBe("hold_return_likely");
  expect(decision.inputs).toMatchObject({ heading: "toward", pReturn: 0.98 });
  expect(session.extendCount).toBe(0);
  expect(pushes).toHaveLength(0);
});

test("auto-extend meeting a provider free period holds and says parking is free", async () => {
  const { state, extender, pushes } = makeTickApp({
    executor: {
      startSession: async () => ({
        ok: false as const,
        code: "unknown" as const,
        message: "unused",
      }),
      extendSession: async () => ({
        ok: false as const,
        code: "free_period" as const,
        message: "No Meter Parking. Please Check Signage.",
      }),
      stopSession: async () => ({
        ok: false as const,
        code: "unknown" as const,
        message: "unused",
      }),
    },
  });
  const session = activeSession(state);
  seedAwayPark(state, session);
  addFixes(state, session.id, [100, 300, 600]); // away → the worker WOULD extend

  await extender.tick();

  const decision = lastTick(state);
  // A hold, not extend_failed: the provider says the meter is free now.
  expect(decision.rule).toBe("free_period");
  expect(decision.outcome).toMatchObject({ action: "hold", code: "free_period" });
  expect(session.extendCount).toBe(0);
  expect(state.sessionEvents.some((e) => e.kind === "failed")).toBe(false);
  expect(pushes.some((p) => p.push.type === "payment_failed")).toBe(false);
  expect(pushes.map((p) => p.push.type)).toContain("free_period");
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
  seedAwayPark(state, session);
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  expect(lastTick(state).rule).toBe("hold_daily_cap");
  expect(session.extendCount).toBe(0);
  expect(pushes.map((p) => p.push.type)).toEqual(["session_expiring"]);
  expect(pushes[0]!.push.extra).toMatchObject({ reason: "budget" });
});

test("an amount the gate can't judge (a garbled spend row): hold, never extend", async () => {
  const { state, extender, pushes } = makeTickApp({
    policy: { dry_run: false },
    envDryRun: false,
  });
  // Today's sum is NaN, and NaN passes every `>` cap: the gate refuses
  // it as amount_invalid, and the ladder holds on any refusal.
  seedSession(state, { status: "stopped", dryRun: false, amountUsd: Number.NaN });
  const session = activeSession(state, { dryRun: false });
  seedAwayPark(state, session);
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  expect(lastTick(state).rule).toBe("hold_gate_refused");
  expect(session.extendCount).toBe(0);
  expect(pushes.map((p) => p.push.type)).toEqual(["session_expiring"]);
  expect(pushes[0]!.push.extra).toMatchObject({ reason: "no_auto_extend" });
});

test("dry run: the daily budget counts what dry runs recorded today, and holds as a real run would", async () => {
  const { state, extender, pushes } = makeTickApp();
  // $60 a day: $59.95 of it on this session and an earlier one, all dry run.
  seedSession(state, { status: "stopped", dryRun: true, amountUsd: 56, feeUsd: 0.3 });
  const session = activeSession(state);
  seedAwayPark(state, session);
  addFixes(state, session.id, [100, 300, 600]);

  await extender.tick();

  expect(lastTick(state).rule).toBe("hold_daily_cap");
  expect(lastTick(state).inputs).toMatchObject({ dryRun: true });
  expect(lastTick(state).inputs["spentTodayUsd"]).toBeCloseTo(59.95);
  expect(session.extendCount).toBe(0);
  expect(pushes.at(-1)!.push.extra).toMatchObject({ reason: "budget" });
});

test("a fresh contrary decision is held for five minutes", async () => {
  const { state, extender } = makeTickApp();
  const session = activeSession(state, {
    lastExtenderRule: "hold_return_likely",
    lastExtenderRuleAt: T("14:18"),
  });
  seedAwayPark(state, session);
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
  seedAwayPark(state, session);
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

test("drain waits for the pass in progress (shutdown doesn't cut an extension off)", async () => {
  const { extender, deps } = makeTickApp();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const findMany = deps.db.session.findMany.bind(deps.db.session);
  deps.db.session.findMany = (async (args: Parameters<typeof findMany>[0]) => {
    await held;
    return findMany(args);
  }) as typeof deps.db.session.findMany;

  const pass = extender.tick();
  let drained = false;
  const drain = extender.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(drained).toBe(false);
  release();
  await Promise.all([pass, drain]);
  expect(drained).toBe(true);
});

// --- only while the phone is away from the car (FR-55) ---

/** The lifecycle's record for a session: whether the phone left, or came back. */
async function seedPark(
  t: ReturnType<typeof makeTickApp>,
  session: SessionRow,
  overrides: { status?: string; leftCarAt?: Date | null; backAt?: Date | null } = {},
) {
  return t.deps.db.pendingPark.create({
    data: {
      userId: session.userId,
      status: "started",
      sessionId: session.id,
      carLat: CAR.lat,
      carLng: CAR.lng,
      parkedAt: T("13:00"),
      ...overrides,
    },
  });
}

test("never buys time with the phone at the car, however cheap the extension", async () => {
  // A $0.50/h block: 30 minutes cost less than the at-the-car ticket risk,
  // so the cost rule alone would have bought them. The lifecycle never saw
  // the phone leave (`leftCarAt` null): it is at the car (FR-55).
  const t = makeTickApp();
  const session = activeSession(t.state, { rateFirstHour: 0.5, rateAdditionalHour: 0.5 });
  await seedPark(t, session);
  addFixes(t.state, session.id, [200, 80, 12]);

  await t.extender.tick();

  const decision = lastTick(t.state);
  expect(decision.rule).toBe("hold_at_car");
  expect(decision.inputs).toMatchObject({ position: "at_car", distanceM: 12 });
  expect(session.extendCount).toBe(0);
  expect(t.state.sessionEvents).toEqual([]);
  expect(t.pushes).toEqual([]);
});

test("back within reach of the car after leaving: at the car, nothing bought, however cheap the extension", async () => {
  // A usable fix that counts, 9 m from the car, is at the car whatever the
  // walk rules hold (`back_at` here): the same answer the worker gave by
  // its own distance before.
  const t = makeTickApp();
  const session = activeSession(t.state, { rateFirstHour: 0.5, rateAdditionalHour: 0.5 });
  await seedPark(t, session, { leftCarAt: T("13:02"), backAt: T("14:19") });
  addFixes(t.state, session.id, [300, 90, 9]);

  await t.extender.tick();

  expect(lastTick(t.state)).toMatchObject({
    rule: "hold_at_car",
    inputs: { position: "at_car", distanceM: 9 },
  });
  expect(session.extendCount).toBe(0);
});

test("the worker reads the newest fix, not the oldest of the three", async () => {
  // Newest at 12 m (at the car) after two far ones: held. Read from the
  // oldest (600 m) it would extend.
  const t = makeTickApp();
  const session = activeSession(t.state, { rateFirstHour: 0.5, rateAdditionalHour: 0.5 });
  await seedPark(t, session, { leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [600, 300, 12]);

  await t.extender.tick();

  expect(lastTick(t.state)).toMatchObject({ rule: "hold_at_car", inputs: { position: "at_car" } });
  expect(session.extendCount).toBe(0);
});

test("far from a car its lifecycle never saw the phone leave: nothing is bought, and the driver is told", async () => {
  // A session paid away from the car (POST /session/start) gets a park
  // from its first fix with no walk-away on it. Never seen leaving, and not
  // shown at the car: unknown, so the meter isn't left to lapse unsaid.
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session);
  addFixes(t.state, session.id, [100, 300, 600]);

  await t.extender.tick();

  expect(lastTick(t.state).inputs).toMatchObject({ position: "unknown", fixCount: 3 });
  expect(lastTick(t.state).rule).toBe("hold_position_unknown");
  expect(session.extendCount).toBe(0);
  expect(t.pushes.map((p) => p.push.extra)).toEqual([{ reason: "position_unknown" }]);
});

test("no sign of where the phone is: nothing is bought, and the driver is told once", async () => {
  const t = makeTickApp();
  const session = activeSession(t.state);

  await t.extender.tick();
  await t.extender.tick();

  const decision = lastTick(t.state);
  expect(decision.rule).toBe("hold_position_unknown");
  expect(decision.inputs).toMatchObject({ position: "unknown", fixCount: 0 });
  expect(session.extendCount).toBe(0);
  expect(t.pushes).toHaveLength(1);
  expect(t.pushes[0]!.push).toMatchObject({
    type: "session_expiring",
    extra: { reason: "position_unknown" },
  });
  expect(t.pushes[0]!.push.body).toContain("won't add time");
});

test("a phone that left the car but has said nothing for fifteen minutes: nothing is bought", async () => {
  // It may be back in the car, or driving off: having left once is not
  // where it is now.
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session, { leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [100, 300, 600]);
  for (const f of t.state.locationFixes) f.ts = new Date(f.ts.getTime() - 15 * 60_000);

  await t.extender.tick();

  const decision = lastTick(t.state);
  expect(decision.inputs).toMatchObject({ position: "unknown", fixCount: 0, staleFixCount: 3 });
  expect(decision.rule).toBe("hold_position_unknown");
  expect(session.extendCount).toBe(0);
  expect(t.state.sessionEvents).toEqual([]);
});

test("…and without a lifecycle record, even fresh fixes far from the car say nothing", async () => {
  // An older build or a direct start the walk rules never saw: "away" is
  // the lifecycle's alone, so a session with no park row is unknown, and
  // nothing is bought (the worker's own distance fallback is gone).
  const t = makeTickApp();
  const session = activeSession(t.state);
  addFixes(t.state, session.id, [100, 300, 600]);

  await t.extender.tick();

  expect(lastTick(t.state).inputs).toMatchObject({ position: "unknown", fixCount: 3 });
  expect(lastTick(t.state).rule).toBe("hold_position_unknown");
  expect(session.extendCount).toBe(0);
});

test("a phone that left and whose newest fix is six minutes old: unknown, nothing bought, and the driver is told", async () => {
  // Freshness is the lifecycle's clock (fixCountsFor): a fix measured more
  // than five minutes ago says where the phone was. Once it was ten
  // minutes on the reported ts.
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session, { leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [100, 300, 600]);
  for (const f of t.state.locationFixes) {
    f.ts = new Date(f.ts.getTime() - 5 * 60_000);
    f.measuredAt = f.ts;
  }

  await t.extender.tick();

  expect(lastTick(t.state)).toMatchObject({
    rule: "hold_position_unknown",
    inputs: { position: "unknown", fixCount: 0, staleFixCount: 3 },
  });
  expect(session.extendCount).toBe(0);
  expect(t.pushes.map((p) => p.push.extra)).toEqual([{ reason: "position_unknown" }]);
});

test("a heartbeat re-sending a measurement eight minutes old still says the phone is reporting: extended", async () => {
  // Sitting still, the phone gets no new measurement and re-sends its last
  // one each minute with ts now: "still reporting" is the report time.
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session, { leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [100, 300, 600]);
  for (const f of t.state.locationFixes) f.measuredAt = new Date(f.ts.getTime() - 8 * 60_000);

  await t.extender.tick();

  expect(lastTick(t.state)).toMatchObject({
    rule: "extend",
    inputs: { position: "away", fixCount: 3 },
  });
  expect(session.extendCount).toBe(1);
});

test("a phone that left the car and is still reporting away: extended, never past the max stay", async () => {
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session, { leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [100, 300, 600]);

  await t.extender.tick();

  const decision = lastTick(t.state);
  expect(decision.inputs).toMatchObject({ position: "away", fixCount: 3 });
  expect(decision.rule).toBe("extend");
  expect(session.extendCount).toBe(1);
  expect(session.purchasedMinutes).toBe(120);
});

test("the belt: a park holding its session with a newer park elsewhere since, however it got there, buys nothing (#246)", async () => {
  // Moved to started without the newer-park check (a transition the
  // lifecycle missed): the worker reads the newest park itself first.
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session, { leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [100, 300, 600]);
  t.state.parkedEvents.push({
    id: "pe-newer",
    userId: session.userId,
    lat: CAR.lat + 0.01,
    lng: CAR.lng,
    accuracyM: 10,
    ts: T("13:30"),
    signals: [],
  });

  await t.extender.tick();

  expect(lastTick(t.state)).toMatchObject({
    rule: "hold_car_moved",
    inputs: { position: "moved" },
  });
  expect(session.extendCount).toBe(0);
  expect(t.state.decisions.filter((d) => d.kind === "session_car_moved")).toEqual([
    expect.objectContaining({
      sessionId: session.id,
      inputs: expect.objectContaining({ seenAt: "extension_worker" }),
    }),
  ]);
});

test("after the phone came back, nothing more is bought", async () => {
  const t = makeTickApp();
  const session = activeSession(t.state);
  await seedPark(t, session, { status: "ended", leftCarAt: T("13:02") });
  addFixes(t.state, session.id, [100, 300, 600]); // far again, and would want to extend

  await t.extender.tick();

  expect(lastTick(t.state).rule).toBe("hold_returned");
  expect(session.extendCount).toBe(0);
  expect(t.pushes).toEqual([]);
});

test("fifteen minutes before the max stay runs out: move your car, with the time", async () => {
  const t = makeTickApp({ now: () => T("14:45") });
  const session = activeSession(t.state, {
    purchasedMinutes: 120,
    chargedMinutes: 120,
    expiresAt: T("15:00"),
  });
  addFixes(t.state, session.id, [100, 300, 600]);

  await t.extender.tick();

  expect(lastTick(t.state).rule).toBe("warn_max_stay");
  expect(session.extendCount).toBe(0);
  expect(t.pushes).toHaveLength(1);
  expect(t.pushes[0]!.push).toMatchObject({
    type: "session_expiring",
    title: "Move your car — max stay at 3:00 PM",
    extra: { reason: "max_stay" },
  });
});

test("sixteen minutes before the max stay runs out: not yet", async () => {
  const t = makeTickApp({ now: () => T("14:44") });
  const session = activeSession(t.state, {
    purchasedMinutes: 120,
    chargedMinutes: 120,
    expiresAt: T("15:00"),
  });
  addFixes(t.state, session.id, [100, 300, 600]);

  await t.extender.tick();

  expect(lastTick(t.state).rule).toBe("hold_not_near_expiry");
  expect(t.pushes).toEqual([]);
});

test("a later park put the car somewhere else: nothing is bought here, and the driver is told once", async () => {
  const t = makeTickApp();
  const session = activeSession(t.state);
  const park = await seedPark(t, session, { leftCarAt: T("13:02") });
  await t.deps.db.pendingPark.update({ where: { id: park.id }, data: { carMovedAt: T("13:40") } });
  addFixes(t.state, session.id, [100, 300, 600]); // far, and would want to extend

  await t.extender.tick();
  await t.extender.tick();

  const decision = lastTick(t.state);
  expect(decision.rule).toBe("hold_car_moved");
  expect(decision.inputs).toMatchObject({ position: "moved" });
  expect(session.extendCount).toBe(0);
  expect(t.pushes).toHaveLength(1);
  expect(t.pushes[0]!.push.extra).toMatchObject({ reason: "car_moved" });
});
