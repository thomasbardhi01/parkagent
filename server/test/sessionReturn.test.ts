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
    ended: { reason: "returned", stopped: true },
  });

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
