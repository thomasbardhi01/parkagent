/**
 * The end of the street session lifecycle (FR-55): the phone coming back
 * to the car ends the session. Where the provider can stop early it is
 * stopped, through POST /session/stop's own path; where it can't (meter
 * time is non-refundable) the session is ended at the return, nothing more
 * is bought, and no stop is attempted. Nothing ends a session whose phone
 * never left, and nobody ends anyone else's.
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import type { Executor, ExecutorResult } from "../src/services/executor.js";
import { DryRunExecutor } from "../src/services/executor.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import {
  API_KEY,
  BOYLSTON_BOS,
  HOURS_MON_SAT,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
  seedProviderAccount,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const OTHER = { "x-api-key": NONADMIN_API_KEY };
const PARKED_AT = new Date(MONDAY_2PM);
const OUTCOMES = ["garage", "nopay", "walk_away"];
const CAR = { lat: 40.7784, lng: -73.9819 };

const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  street: "30th Ave",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

/** The Back Bay block, with its posted number known. */
const BOYLSTON: Candidate = { ...BOYLSTON_BOS, providerZoneNumber: "81234" };
const BOYLSTON_ZONE: ZoneTermsRow = {
  zoneId: BOYLSTON.zoneId,
  city: "bos",
  street: "Boylston St",
  providerZoneNumber: "81234",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 120,
  hoursJson: BOYLSTON.hours,
};

type App = ReturnType<typeof makeTestApp>["app"];

function makeApp(
  options: Parameters<typeof makeTestApp>[0] & { stop?: Executor["stopSession"] } = {},
) {
  const clock = { now: new Date(PARKED_AT) };
  const calls = { start: 0, stop: 0, extend: 0 };
  const dry = new DryRunExecutor(
    () => {},
    () => clock.now,
  );
  const executor: Executor = {
    startSession: (args) => {
      calls.start += 1;
      return dry.startSession(args);
    },
    extendSession: (args) => {
      calls.extend += 1;
      return dry.extendSession(args);
    },
    stopSession: (args) => {
      calls.stop += 1;
      return (options.stop ?? ((a) => dry.stopSession(a)))(args);
    },
  };
  const t = makeTestApp({
    candidates: [STEINWAY_A],
    zones: [STEINWAY_ZONE],
    now: () => clock.now,
    executor,
    ...options,
  });
  const tick = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  return { ...t, clock, calls, tick };
}

function post(app: App, url: string, body: unknown, headers = HEADERS) {
  return app.inject({ method: "POST", url, headers, payload: body as object });
}

function fix(t: { clock: { now: Date } }, distanceM: number, extra: Record<string, unknown> = {}) {
  return {
    lat: CAR.lat + distanceM / 111_320,
    lng: CAR.lng,
    accuracy: 8,
    ts: t.clock.now.toISOString(),
    ...extra,
  };
}

/** Park, walk away, tap Pay: an active session whose phone has left. */
async function paidAndAway(t: ReturnType<typeof makeApp>) {
  const parked = await post(t.app, "/parked", parkedBody({ outcomes: OUTCOMES }));
  const parkedEventId = parked.json()["parkedEventId"] as string;
  t.tick(40);
  await post(t.app, "/location", fix(t, 60));
  t.tick(20);
  await post(t.app, "/location", fix(t, 90));
  const paid = await post(t.app, `/parked/${parkedEventId}/confirm`, {});
  expect(paid.statusCode).toBe(200);
  const session = t.state.sessions.at(-1)!;
  expect(session.status).toBe("active");
  t.tick(60);
  await post(t.app, "/location", fix(t, 250));
  return { parkedEventId, session };
}

/** Back within 30 m of the car, and still there a minute later. */
async function comeBack(t: ReturnType<typeof makeApp>) {
  t.tick(120);
  const arrived = await post(t.app, "/location", fix(t, 14));
  t.tick(61);
  const stayed = await post(t.app, "/location", fix(t, 5));
  return { arrived, stayed };
}

test("back at the car for a minute: the session is stopped, once, through the stop path", async () => {
  const t = makeApp();
  const { parkedEventId, session } = await paidAndAway(t);

  const { arrived, stayed } = await comeBack(t);
  // Walking up is not yet a return.
  expect(arrived.json()["ended"]).toBeUndefined();
  expect(stayed.statusCode).toBe(200);
  expect(stayed.json()).toMatchObject({
    sessionId: session.id,
    ended: { reason: "returned", why: "near_for_60s", stopped: true },
  });
  // Only a drive-off says what it was read from.
  expect(stayed.json()["ended"]).not.toHaveProperty("readBy");

  expect(t.calls.stop).toBe(1);
  expect(session.status).toBe("stopped");
  expect(session.stoppedAt?.getTime()).toBe(t.clock.now.getTime());
  expect(t.state.pendingParks[0]!.status).toBe("ended");
  expect(t.state.decisions.filter((d) => d.kind === "session_stop").at(-1)!.rule).toBe("stop_ok");
  const ended = t.state.decisions.filter((d) => d.kind === "session_end_return");
  expect(ended).toHaveLength(1);
  expect(ended[0]).toMatchObject({
    rule: "stopped_at_return",
    sessionId: session.id,
    parkedEventId,
  });
  expect(ended[0]!.inputs).toMatchObject({ why: "near_for_60s", dryRun: true });
  expect((ended[0]!.inputs["fix"] as { distanceM: number }).distanceM).toBeLessThan(30);

  // The phone's next (and retried) reports find nothing to end.
  t.tick(15);
  const after = await post(t.app, "/location", fix(t, 5));
  expect(after.statusCode).toBe(409);
  expect(t.calls.stop).toBe(1);
  expect(t.state.decisions.filter((d) => d.kind === "session_end_return")).toHaveLength(1);
});

test("two reports of the same return at once end it once", async () => {
  const t = makeApp();
  await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", fix(t, 14));
  t.tick(61);
  const body = fix(t, 5);
  await Promise.all([post(t.app, "/location", body), post(t.app, "/location", body)]);
  expect(t.calls.stop).toBe(1);
  expect(t.state.decisions.filter((d) => d.kind === "session_end_return")).toHaveLength(1);
});

test("where the provider can't stop early: ended_at_return, no stop attempted, nothing more bought", async () => {
  const t = makeApp({
    candidates: [BOYLSTON],
    zones: [BOYLSTON_ZONE],
    seedLinkedProvider: false,
  });
  seedProviderAccount(t.state, { provider: "passport" });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);
  expect(session.city).toBe("bos");

  const { stayed } = await comeBack(t);
  expect(stayed.json()).toMatchObject({ ended: { reason: "returned", stopped: false } });
  expect(t.calls.stop).toBe(0);
  expect(session.status).toBe("stopped");
  expect(t.state.sessionEvents.at(-1)).toMatchObject({
    sessionId: session.id,
    kind: "ended_at_return",
  });
  expect(t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)).toMatchObject({
    rule: "ended_at_return",
    sessionId: session.id,
  });
  // The provider was never asked to stop, so there is no stop decision.
  expect(t.state.decisions.some((d) => d.kind === "session_stop")).toBe(false);

  // The meter runs out with the driver gone again: nothing is extended.
  t.clock.now = new Date(session.expiresAt!.getTime() - 5 * 60_000);
  await extender.tick();
  expect(t.calls.extend).toBe(0);
  expect(session.extendCount).toBe(0);
});

test("the app's returned_to_car ends it at the car, and never from somewhere else", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);

  // In a bus, a quarter of a kilometre from the car.
  t.tick(60);
  const bus = await post(t.app, "/location", fix(t, 250, { event: "returned_to_car" }));
  expect(bus.json()["ended"]).toBeUndefined();
  expect(session.status).toBe("active");
  // Too blurry to say where: not a return either.
  const blurry = await post(
    t.app,
    "/location",
    fix(t, 20, { accuracy: 300, event: "returned_to_car" }),
  );
  expect(blurry.json()["ended"]).toBeUndefined();
  expect(t.calls.stop).toBe(0);

  // The car's audio reconnects with the phone beside it.
  t.tick(600);
  const back = await post(t.app, "/location", fix(t, 9, { event: "returned_to_car" }));
  expect(back.json()).toMatchObject({ ended: { reason: "returned", stopped: true } });
  expect(session.status).toBe("stopped");
  expect(
    t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)!.inputs,
  ).toMatchObject({
    why: "returned_event",
  });
});

test("a session whose phone never went far isn't ended by standing near the car", async () => {
  const t = makeApp();
  const parked = await post(t.app, "/parked", parkedBody({ outcomes: OUTCOMES }));
  const parkedEventId = parked.json()["parkedEventId"] as string;
  // On foot into the shop the car is parked in front of.
  t.tick(40);
  await post(t.app, "/location", fix(t, 18, { event: "left_car" }));
  await post(t.app, `/parked/${parkedEventId}/confirm`, {});
  const session = t.state.sessions.at(-1)!;
  expect(session.status).toBe("active");

  for (let i = 0; i < 6; i += 1) {
    t.tick(60);
    const res = await post(t.app, "/location", fix(t, 15 + i));
    expect(res.json()["ended"]).toBeUndefined();
  }
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
});

test("a session started outside the lifecycle isn't ended at the car it never left", async () => {
  const t = makeApp();
  // An older build: no walk_away, and it starts the session itself.
  const parked = await post(t.app, "/parked", parkedBody({ outcomes: ["garage", "nopay"] }));
  const started = await post(t.app, "/session/start", {
    parkedEventId: parked.json()["parkedEventId"],
    zoneId: "nyc-417371",
  });
  expect(started.statusCode).toBe(200);
  const session = t.state.sessions.at(-1)!;

  // Sitting in the car for five minutes after paying.
  for (let i = 0; i < 5; i += 1) {
    t.tick(60);
    const res = await post(t.app, "/location", fix(t, 4));
    expect(res.statusCode).toBe(200);
    expect(res.json()["ended"]).toBeUndefined();
  }
  expect(session.status).toBe("active");

  // Then away and back: the same rule ends it.
  t.tick(30);
  await post(t.app, "/location", fix(t, 80));
  t.tick(20);
  await post(t.app, "/location", fix(t, 140));
  const { stayed } = await comeBack(t);
  expect(stayed.json()).toMatchObject({ ended: { reason: "returned", stopped: true } });
  expect(session.status).toBe("stopped");
  expect(t.calls.stop).toBe(1);
});

test("a second session for a park whose first was stopped takes over its lifecycle, on the ledger", async () => {
  const t = makeApp();
  const { parkedEventId, session: first } = await paidAndAway(t);
  const stopped = await post(t.app, "/session/stop", { sessionId: first.id });
  expect(stopped.statusCode).toBe(200);
  // The driver pays the same park again (its session started, so the
  // start path itself is what decides).
  const again = await post(t.app, "/session/start", { parkedEventId, zoneId: "nyc-417371" });
  expect(again.statusCode).toBe(200);
  const second = t.state.sessions.at(-1)!;
  expect(second.id).not.toBe(first.id);

  t.tick(30);
  await post(t.app, "/location", fix(t, 260));
  expect(t.state.pendingParks).toHaveLength(1);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", sessionId: second.id });
  const linked = t.state.decisions.filter((d) => d.kind === "park_lifecycle");
  expect(linked).toEqual([
    expect.objectContaining({
      rule: "linked_to_session",
      sessionId: second.id,
      parkedEventId,
      inputs: expect.objectContaining({ previousStatus: "started", previousSessionId: first.id }),
      outcome: { status: "started", sessionId: second.id },
    }),
  ]);
  // Linked once: the next fix finds it by its session.
  t.tick(30);
  await post(t.app, "/location", fix(t, 280));
  expect(t.state.decisions.filter((d) => d.kind === "park_lifecycle")).toHaveLength(1);
});

test("nobody ends anyone else's session", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);

  // Another user stands at my car for two minutes.
  t.tick(30);
  const first = await post(t.app, "/location", fix(t, 3), OTHER);
  expect(first.statusCode).toBe(409);
  t.tick(90);
  await post(t.app, "/location", fix(t, 3, { event: "returned_to_car" }), OTHER);
  // …and can't stop it by id either.
  const stop = await post(t.app, "/session/stop", { sessionId: session.id }, OTHER);
  expect(stop.statusCode).toBe(404);

  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  expect(t.state.decisions.some((d) => d.kind === "session_end_return")).toBe(false);
});

test("a stop the provider refuses leaves the session running, and it is never extended after the return", async () => {
  const failed: ExecutorResult = { ok: false, code: "network", message: "timed out" };
  const t = makeApp({ stop: async () => failed });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);

  const { stayed } = await comeBack(t);
  expect(stayed.json()).toMatchObject({
    ended: { reason: "returned", stopped: false, error: "executor_failed" },
  });
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(1);
  expect(t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)).toMatchObject({
    rule: "stop_failed",
  });

  // Later reports don't hammer the provider with more stops.
  t.tick(30);
  await post(t.app, "/location", fix(t, 5));
  expect(t.calls.stop).toBe(1);

  // Near expiry, with the phone far away again: the park is over, no extension.
  t.clock.now = new Date(session.expiresAt!.getTime() - 8 * 60_000);
  await post(t.app, "/location", fix(t, 400));
  await extender.tick();
  expect(t.calls.extend).toBe(0);
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe(
    "hold_returned",
  );
});

// ------------------------------------------------------------ driving off, and what isn't a return

test("back at the car and driving off inside a minute, at the phone's own speed, stops the session: ended_drove_off", async () => {
  const t = makeApp();
  const { parkedEventId, session } = await paidAndAway(t);

  // In the seat, and gone 25 s later: no minute at the car, and no
  // automotive report reached the server.
  t.tick(120);
  await post(t.app, "/location", fix(t, 8, { speedMps: 0.3 }));
  t.tick(25);
  const pulling = await post(t.app, "/location", fix(t, 90, { speedMps: 8 }));
  expect(pulling.json()["ended"]).toBeUndefined();
  t.tick(8);
  const gone = await post(t.app, "/location", fix(t, 170, { speedMps: 11 }));
  expect(gone.json()).toMatchObject({
    sessionId: session.id,
    ended: { reason: "returned", why: "drove_off", readBy: "speed", stopped: true },
  });
  expect(t.calls.stop).toBe(1);
  expect(session.status).toBe("stopped");
  expect(t.state.pendingParks[0]!.status).toBe("ended");
  const ended = t.state.decisions.filter((d) => d.kind === "session_end_return");
  expect(ended).toHaveLength(1);
  expect(ended[0]).toMatchObject({
    rule: "ended_drove_off",
    sessionId: session.id,
    parkedEventId,
    outcome: expect.objectContaining({ stopped: true }),
  });
  expect(ended[0]!.inputs).toMatchObject({
    why: "drove_off",
    readBy: "speed",
    fix: expect.objectContaining({ speedMps: 11 }),
  });
});

/** Like the build in the field today: says when it measured, gives no speed. */
const measured = (
  t: { clock: { now: Date } },
  distanceM: number,
  extra: Record<string, unknown> = {},
) => fix(t, distanceM, { measuredAt: t.clock.now.toISOString(), ...extra });

test("a drive-off read from pace alone never asks the provider to stop: ended where it stands, the paid time runs out", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", measured(t, 6));
  t.tick(15);
  await post(t.app, "/location", measured(t, 120));
  // 160 m in 12 s: a car, or one GPS jump.
  t.tick(12);
  const gone = await post(t.app, "/location", measured(t, 280));
  // The app words this one as a guess: "ParkAgent thinks your car moved".
  expect(gone.json()).toMatchObject({
    ended: { reason: "returned", why: "drove_off", readBy: "pace", stopped: false },
  });
  // The provider could stop this one early, and is not asked to.
  expect(t.calls.stop).toBe(0);
  expect(session.status).toBe("stopped");
  expect(t.state.sessionEvents.at(-1)).toMatchObject({
    kind: "ended_at_return",
    details: { why: "drove_off", readBy: "pace", providerAsked: false },
  });
  expect(t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)).toMatchObject({
    rule: "ended_drove_off",
    inputs: expect.objectContaining({ readBy: "pace" }),
    outcome: {
      stopped: false,
      paidUntil: session.expiresAt!.toISOString(),
      providerAsked: false,
    },
  });
});

test("walking past the car to the subway and coming up far away is no drive-off: the gap is not one leg", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", measured(t, 20));
  t.tick(18);
  await post(t.app, "/location", measured(t, 50));
  // Eight minutes underground, then 3 km away: "6 m/s" across the gap.
  t.tick(8 * 60);
  const emerge = await post(t.app, "/location", measured(t, 3_000));
  expect(emerge.json()["ended"]).toBeUndefined();
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  expect(t.state.decisions.some((d) => d.kind === "session_end_return")).toBe(false);
});

test("back at the car for a bag and off again at the phone's own walking speed: a bus after it is no drive-off", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", fix(t, 8, { speedMps: 0.4 }));
  t.tick(20);
  await post(t.app, "/location", fix(t, 60, { speedMps: 1.3 }));
  t.tick(300);
  await post(t.app, "/location", fix(t, 600, { speedMps: 9 }));
  t.tick(12);
  const bus = await post(t.app, "/location", fix(t, 720, { speedMps: 10 }));
  expect(bus.json()["ended"]).toBeUndefined();
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", backAt: null });
});

test("…without the phone's speed a walking pace proves nothing (traffic crawls too): a bus after it reads as a drive-off, and nothing is asked of the provider", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", measured(t, 8));
  t.tick(20);
  await post(t.app, "/location", measured(t, 60));
  t.tick(20);
  await post(t.app, "/location", measured(t, 85));
  t.tick(300);
  await post(t.app, "/location", measured(t, 600));
  t.tick(12);
  const bus = await post(t.app, "/location", measured(t, 720));
  expect(bus.json()).toMatchObject({ ended: { reason: "returned", stopped: false } });
  expect(t.calls.stop).toBe(0);
  expect(session.status).toBe("stopped");
});

test("back in the seat with no new measurement, then out in stop-and-go traffic: the worker buys no more time", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);
  t.tick(120);
  const seat = measured(t, 6);
  await post(t.app, "/location", seat);
  // The 10 m distance filter: a phone sitting still measures nothing new,
  // and the heartbeat re-sends the one it has.
  for (let i = 0; i < 3; i += 1) {
    t.tick(60);
    await post(t.app, "/location", { ...seat, ts: t.clock.now.toISOString() });
  }
  // Pulls out at a crawl: 40 m, 65 m, 140 m, 30 s apart.
  for (const metres of [40, 65, 140]) {
    t.tick(30);
    await post(t.app, "/location", measured(t, metres));
  }
  expect(session.status).toBe("active");
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();

  // Near the end of what was paid, 2.5 km away with the car.
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", measured(t, 2_500));
  await extender.tick();
  expect(t.calls.extend).toBe(0);
  // The ledger says why a fresh, sharp fix 2.5 km off isn't "away", and
  // the driver is told the same.
  const row = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
  expect(row.rule).toBe("hold_back_at_car");
  expect(row.inputs).toMatchObject({
    position: "back",
    backAt: t.state.pendingParks[0]!.backAt!.toISOString(),
    leftCarAt: expect.any(String),
  });
  expect(t.pushes.at(-1)!.push).toMatchObject({
    type: "session_expiring",
    extra: { reason: "back_at_car" },
  });
  expect(t.pushes.at(-1)!.push.body).toContain("back at the car");
});

test("a walk past the car before the tap: the tap waits for the walk-away, and the session it then starts still extends", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const parked = await post(t.app, "/parked", parkedBody({ outcomes: OUTCOMES }));
  const parkedEventId = parked.json()["parkedEventId"] as string;
  t.tick(40);
  await post(t.app, "/location", measured(t, 60));
  t.tick(20);
  await post(t.app, "/location", measured(t, 90));
  // Asked, not yet answered: back past the car, then off again on foot,
  // with no speed to say so.
  t.tick(20);
  await post(t.app, "/location", measured(t, 10));
  t.tick(20);
  await post(t.app, "/location", measured(t, 60));
  t.tick(20);
  await post(t.app, "/location", measured(t, 100));
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  // The phone was at the car since it left: the tap is kept, not paid.
  const tap = await post(t.app, `/parked/${parkedEventId}/confirm`, {});
  expect(tap.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
  expect(t.calls.start).toBe(0);
  // The app's on-foot report starts it, with nothing of the walk-by kept.
  t.tick(20);
  const left = await post(t.app, "/location", measured(t, 110, { event: "left_car" }));
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  const session = t.state.sessions.at(-1)!;
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", backAt: null, driveAt: null });

  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", measured(t, 400));
  await extender.tick();
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe("extend");
  expect(t.calls.extend).toBe(1);
  expect(t.pushes.some((p) => p.push.extra?.["reason"] === "back_at_car")).toBe(false);
});

test("two blurry fixes near the car a minute apart are no return: the session isn't stopped", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(120);
  // 28 m and 27 m off, each with 60 m of error: a driver in a café down
  // the block as much as one at the car.
  await post(t.app, "/location", { ...measured(t, 28), accuracy: 60 });
  t.tick(61);
  const second = await post(t.app, "/location", { ...measured(t, 27), accuracy: 60 });
  expect(second.json()["ended"]).toBeUndefined();
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  // Sharp fixes there a minute apart still are.
  t.tick(5);
  await post(t.app, "/location", measured(t, 6));
  t.tick(61);
  const back = await post(t.app, "/location", measured(t, 5));
  expect(back.json()).toMatchObject({ ended: { why: "near_for_60s", stopped: true } });
});

test("one blurry fix near the car holds, and stops nothing: the worker buys no more on a guess, and says why", async () => {
  // Holding errs toward not buying. A blurry fix within 30 m may be the
  // driver back at the car (urban returns are often this blurry); it may
  // be GPS. Not buying costs a push and a manual extend; buying may pay
  // for an empty spot. It never stops the session.
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", measured(t, 300));
  t.tick(20);
  await post(t.app, "/location", { ...measured(t, 28), accuracy: 60 });
  for (const metres of [300, 310]) {
    t.tick(20);
    await post(t.app, "/location", measured(t, metres));
  }
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", measured(t, 305));
  await extender.tick();
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe(
    "hold_back_at_car",
  );
  expect(t.calls.extend).toBe(0);
});

test("back in the car on blurry fixes, then a drive-off by pace: the session ends, and nothing is bought for the empty spot", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(600);
  // An urban canyon: four minutes within 30 m of the car, every fix 45 m
  // blurry. No return (too blurry to stop on) but the phone may be back.
  for (const metres of [10, 12, 9, 11]) {
    await post(t.app, "/location", { ...measured(t, metres), accuracy: 45 });
    t.tick(60);
  }
  expect(session.status).toBe("active");
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  // Pulls out: 160 m in 12 s.
  await post(t.app, "/location", { ...measured(t, 120), accuracy: 45 });
  t.tick(12);
  const gone = await post(t.app, "/location", { ...measured(t, 280), accuracy: 45 });
  expect(gone.json()).toMatchObject({
    ended: { why: "drove_off", readBy: "pace", stopped: false },
  });
  expect(t.calls.stop).toBe(0);
  expect(
    t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)!.inputs,
  ).toMatchObject({
    driveFrom: { distanceM: expect.closeTo(120, 0), measuredAt: expect.any(String) },
  });
  // Ended at the return, not stopped at the provider: nothing more can be
  // bought for it, and the lifecycle is over.
  expect(session.status).toBe("stopped");
  expect(t.state.sessionEvents.at(-1)).toMatchObject({ kind: "ended_at_return" });
  expect(t.state.pendingParks[0]!.status).toBe("ended");
});

test("the app's on-foot report on a fix at driving speed doesn't clear the phone being back at the car", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", fix(t, 6, { speedMps: 0.2 }));
  t.tick(20);
  await post(t.app, "/location", fix(t, 150, { speedMps: 9, event: "left_car" }));
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  // …so the next fix at speed still finishes the drive-off.
  t.tick(8);
  const gone = await post(t.app, "/location", fix(t, 230, { speedMps: 10 }));
  expect(gone.json()).toMatchObject({ ended: { why: "drove_off", readBy: "speed" } });
  expect(session.status).toBe("stopped");
});

test("a speed of nothing is a phone standing still, not one on foot: a car at a light 150 m off keeps the hold", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", fix(t, 6, { speedMps: 0 }));
  // Pulled out and stopped at a light: clear of the car, speed 0.
  t.tick(30);
  await post(t.app, "/location", fix(t, 150, { speedMps: 0 }));
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", fix(t, 2_500, { speedMps: 0 }));
  await extender.tick();
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe(
    "hold_back_at_car",
  );
  expect(t.calls.extend).toBe(0);
});

test("…and the phone's own walking speed away from the car is what lets the worker extend again", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);
  t.tick(120);
  await post(t.app, "/location", fix(t, 6, { speedMps: 0.2 }));
  t.tick(30);
  await post(t.app, "/location", fix(t, 60, { speedMps: 1.3 }));
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", fix(t, 2_500, { speedMps: 1.2 }));
  await extender.tick();
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe("extend");
  expect(t.calls.extend).toBe(1);
});

test("between the two fixes of a drive-off, the extension worker doesn't read driving as away", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session } = await paidAndAway(t);
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", fix(t, 8, { speedMps: 0.2 }));
  t.tick(20);
  await post(t.app, "/location", fix(t, 150, { speedMps: 9 }));
  await extender.tick();
  expect(t.calls.extend).toBe(0);
  const row = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
  expect(row.rule).toBe("hold_back_at_car");
  expect(row.inputs).toMatchObject({ position: "back", driveAt: expect.any(String) });
});

test("one measurement beside the car, re-sent by the heartbeat for a minute, is not a return", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  // Walking past the car: one fix within 30 m, then the phone goes quiet
  // and re-sends it with a fresh report time.
  t.tick(120);
  const measuredAt = t.clock.now.toISOString();
  const past = fix(t, 10, { measuredAt });
  await post(t.app, "/location", past);
  for (let i = 0; i < 4; i += 1) {
    t.tick(20);
    const again = await post(t.app, "/location", { ...past, ts: t.clock.now.toISOString() });
    expect(again.json()["ended"]).toBeUndefined();
  }
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);

  // A second measurement there, a minute after the first, is a return.
  t.tick(1);
  const stayed = await post(t.app, "/location", fix(t, 6));
  expect(stayed.json()).toMatchObject({ ended: { reason: "returned", stopped: true } });
  expect(t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)).toMatchObject({
    rule: "stopped_at_return",
    inputs: expect.objectContaining({ why: "near_for_60s" }),
  });
});

// ------------------------------------------------------------ the car moved without a return being seen

/** A second park, a kilometre north of the first. */
const ELSEWHERE = { lat: CAR.lat + 0.01, lng: CAR.lng };

function fixAt(t: { clock: { now: Date } }, metresNorthOfElsewhere: number) {
  return { ...fix(t, 0), lat: ELSEWHERE.lat + metresNorthOfElsewhere / 111_320 };
}

test("a newer park somewhere else: the old session is no longer extended, the new park is asked about, and its tap ends the old one", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const { session: old } = await paidAndAway(t);

  // The driver came back and drove off without the phone showing it, then
  // parked a kilometre away.
  t.tick(30 * 60);
  const parked = await post(
    t.app,
    "/parked",
    parkedBody({ outcomes: OUTCOMES, lat: ELSEWHERE.lat, ts: t.clock.now.toISOString() }),
  );
  expect(parked.json()).toMatchObject({ awaitsWalkAway: true });
  const newParkId = parked.json()["parkedEventId"] as string;
  expect(t.state.decisions.filter((d) => d.kind === "session_car_moved")).toHaveLength(1);
  expect(t.state.decisions.find((d) => d.kind === "session_car_moved")).toMatchObject({
    rule: "newer_park_elsewhere",
    sessionId: old.id,
  });
  // Not stopped on the phone's say-so: the new park could be a car it rode in.
  expect(old.status).toBe("active");
  expect(t.calls.stop).toBe(0);

  // In the seat at the new spot: the session's fix is stored, and the new
  // park waits. Then the phone leaves the new car.
  t.tick(30);
  const seat = await post(t.app, "/location", fixAt(t, 3));
  expect(seat.json()).toMatchObject({
    sessionId: old.id,
    park: { parkedEventId: newParkId, status: "at_car" },
  });
  t.tick(30);
  await post(t.app, "/location", fixAt(t, 60));
  t.tick(20);
  const left = await post(t.app, "/location", fixAt(t, 88));
  expect(left.json()).toMatchObject({ park: { parkedEventId: newParkId, status: "prompted" } });
  expect((left.json()["prompt"] as { kind: string }).kind).toBe("confirm");
  expect(left.json()["ended"]).toBeUndefined();

  // Near the old session's expiry, with the phone far from the old car:
  // nothing is bought for a spot the car has left.
  const at = t.clock.now;
  t.clock.now = new Date(old.expiresAt!.getTime() - 8 * 60_000);
  await extender.tick();
  const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
  expect(tick.rule).toBe("hold_car_moved");
  expect(tick.inputs).toMatchObject({ position: "moved" });
  expect(t.calls.extend).toBe(0);
  expect(t.pushes.at(-1)!.push.extra).toMatchObject({ reason: "car_moved" });
  t.clock.now = at;

  // The tap on the new park is the driver saying where the car is: the
  // old session is stopped, and the new one starts.
  const paid = await post(t.app, `/parked/${newParkId}/confirm`, {});
  expect(paid.statusCode).toBe(200);
  expect(paid.json()).toMatchObject({ status: "started" });
  expect(t.calls.stop).toBe(1);
  expect(old.status).toBe("stopped");
  const ended = t.state.decisions.filter((d) => d.kind === "session_end_return").at(-1)!;
  expect(ended).toMatchObject({ rule: "stopped_at_return", sessionId: old.id });
  expect(ended.inputs).toMatchObject({ reason: "new_park", why: "new_park_paid" });
  expect(t.calls.start).toBe(2);
  expect(t.state.sessions.filter((s) => s.status === "active")).toHaveLength(1);
  expect(t.state.sessions.filter((s) => s.status === "active")[0]!.carLat).toBe(ELSEWHERE.lat);
});

test("a tap elsewhere that its own start would refuse leaves the running session alone", async () => {
  const t = makeApp();
  const { session: old } = await paidAndAway(t);
  t.tick(30 * 60);
  const parked = await post(
    t.app,
    "/parked",
    parkedBody({ outcomes: OUTCOMES, lat: ELSEWHERE.lat, ts: t.clock.now.toISOString() }),
  );
  const newParkId = parked.json()["parkedEventId"] as string;
  t.tick(30);
  await post(t.app, "/location", fixAt(t, 60));
  t.tick(20);
  const left = await post(t.app, "/location", fixAt(t, 88));
  expect(left.json()).toMatchObject({ park: { parkedEventId: newParkId, status: "prompted" } });

  // The driver lowered their per-stop limit since: the new start is over it.
  const at = t.clock.now;
  t.state.userLimits.push({
    userId: "u1",
    sessionCapUsd: 2,
    dailyCapUsd: null,
    defaultStayMinutes: null,
    createdAt: at,
    updatedAt: at,
  });
  const tap = await post(t.app, `/parked/${newParkId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "policy_violation", rule: "session_cap_exceeded" });

  // Nothing new was paid, so nothing old was given up.
  expect(old.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  expect(t.calls.start).toBe(1);
  expect(t.state.decisions.some((d) => d.kind === "session_end_return")).toBe(false);
  expect(t.state.pendingParks.find((p) => p.sessionId === old.id)!.status).toBe("started");
  expect(t.state.pendingParks.find((p) => p.parkedEventId === newParkId)!.status).toBe("prompted");
});

test("a new park at the spot a session already pays is covered: never asked about, never paid twice", async () => {
  const t = makeApp();
  const { session } = await paidAndAway(t);
  // The detector fires again at the same spot while the phone is away.
  t.tick(600);
  const again = await post(
    t.app,
    "/parked",
    parkedBody({ outcomes: OUTCOMES, ts: t.clock.now.toISOString() }),
  );
  const againId = again.json()["parkedEventId"] as string;
  expect(t.state.decisions.some((d) => d.kind === "session_car_moved")).toBe(false);

  t.tick(20);
  await post(t.app, "/location", fix(t, 250));
  t.tick(20);
  const far = await post(t.app, "/location", fix(t, 275));
  expect(far.json()).toMatchObject({
    sessionId: session.id,
    park: { parkedEventId: againId, status: "covered" },
  });
  expect(far.json()["prompt"]).toBeUndefined();
  expect(t.state.decisions.filter((d) => d.kind === "street_prompt").at(-1)).toMatchObject({
    rule: "already_paid",
  });

  const tap = await post(t.app, `/parked/${againId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "park_closed", status: "covered" });
  expect(t.calls.start).toBe(1);
  expect(session.status).toBe("active");
});

test("a park detected while a start is in flight doesn't orphan it: the paid park keeps its session", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const t = makeApp();
  const dryStart = t.deps.executorFor({ userId: "u1", city: "nyc", dryRun: true });
  const slow: Executor = {
    startSession: async (args) => {
      await held;
      return dryStart.startSession(args);
    },
    extendSession: (args) => dryStart.extendSession(args),
    stopSession: (args) => dryStart.stopSession(args),
  };
  t.deps.executorFor = () => slow;

  const parked = await post(t.app, "/parked", parkedBody({ outcomes: OUTCOMES }));
  const id = parked.json()["parkedEventId"] as string;
  t.tick(40);
  await post(t.app, "/location", fix(t, 60));
  t.tick(20);
  await post(t.app, "/location", fix(t, 90));
  const paying = post(t.app, `/parked/${id}/confirm`, {});
  // Let the tap reach the provider, then a stray detection arrives.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(t.state.pendingParks[0]!.status).toBe("starting");
  await post(t.app, "/parked", parkedBody({ outcomes: OUTCOMES, lat: ELSEWHERE.lat }));
  expect(t.state.pendingParks[0]!.status).toBe("starting");
  release();
  const paid = await paying;
  expect(paid.statusCode).toBe(200);
  expect(t.state.pendingParks[0]).toMatchObject({
    status: "started",
    sessionId: t.state.sessions[0]!.id,
  });
});

test("…nor does the next fix: a park mid-start is never superseded by a newer one", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const t = makeApp();
  const dryStart = t.deps.executorFor({ userId: "u1", city: "nyc", dryRun: true });
  t.deps.executorFor = () => ({
    startSession: async (args) => {
      await held;
      return dryStart.startSession(args);
    },
    extendSession: (args) => dryStart.extendSession(args),
    stopSession: (args) => dryStart.stopSession(args),
  });

  const parked = await post(t.app, "/parked", parkedBody({ outcomes: OUTCOMES }));
  const id = parked.json()["parkedEventId"] as string;
  t.tick(40);
  await post(t.app, "/location", fix(t, 60));
  t.tick(20);
  await post(t.app, "/location", fix(t, 90));
  const paying = post(t.app, `/parked/${id}/confirm`, {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(t.state.pendingParks[0]!.status).toBe("starting");

  // A newer park elsewhere, then a fix: the newer one is what waits, and
  // the one being paid for is left to finish.
  const newer = await post(
    t.app,
    "/parked",
    parkedBody({ outcomes: OUTCOMES, lat: ELSEWHERE.lat, ts: t.clock.now.toISOString() }),
  );
  t.tick(20);
  const seat = await post(t.app, "/location", fixAt(t, 3));
  expect(seat.json()).toMatchObject({
    park: { parkedEventId: newer.json()["parkedEventId"], status: "at_car" },
  });
  expect(t.state.pendingParks[0]!.status).toBe("starting");

  release();
  expect((await paying).statusCode).toBe(200);
  expect(t.state.pendingParks[0]).toMatchObject({
    status: "started",
    sessionId: t.state.sessions[0]!.id,
  });
});

test("the phone back at the car while the worker is buying time: the extension is refused, and nothing is bought", async () => {
  // A return that lands in time ends the session; the phone merely back
  // within reach of the car (a tap would wait, a drive-off is armed) is no
  // phone known to be away either.
  for (const back of ["returned", "at_car"] as const) {
    const t = makeApp();
    const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
    const { session } = await paidAndAway(t);
    t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
    await post(t.app, "/location", fix(t, 2_500, { speedMps: 1.2 }));

    // The worker has read the phone as away and priced the extension; the
    // phone's fixes land while it takes the session's extension lock.
    const real = t.deps.db.$transaction;
    let landed = false;
    t.deps.db.$transaction = (async (...args: Parameters<typeof real>) => {
      if (!landed) {
        landed = true;
        await post(t.app, "/location", fix(t, 5));
        if (back === "returned") {
          t.tick(61);
          await post(t.app, "/location", fix(t, 4));
        }
      }
      return real(...args);
    }) as typeof real;
    await extender.tick();

    expect(landed).toBe(true);
    expect({ back, extend: t.calls.extend }).toEqual({ back, extend: 0 });
    expect(session.purchasedMinutes).toBe(90);
    const row = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(row.outcome).toMatchObject({
      ok: false,
      code: back === "returned" ? "extension_in_progress" : "phone_not_away",
    });
  }
});
