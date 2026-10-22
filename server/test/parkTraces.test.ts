/**
 * Park traces (K): every /location fix a park reads is kept, the ones it
 * refuses too, with why; GET /admin/parks/:id/trace serves a park's whole
 * story; trace:export makes it a fixture with nothing that names the
 * driver, which replays to what the park did; and the fixes go after 30
 * days.
 */

import { afterEach, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { makeConversationRetention } from "../src/jobs/conversationRetentionTick.js";
import { buildParkTrace, traceToFixture } from "../src/services/parkTrace.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  MOTT_A,
  MOTT_B,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
  setFakeRowClock,
} from "./helpers.js";
import { replayFixture } from "./traces/replay.js";

const HEADERS = { "x-api-key": API_KEY };
const PARKED_AT = new Date(MONDAY_2PM);
const CAR = { lat: 40.7784, lng: -73.9819 };
const OUTCOMES = ["garage", "nopay", "walk_away"];
const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  street: "30th Ave",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

afterEach(() => setFakeRowClock(() => new Date(MONDAY_2PM)));

function makeApp() {
  const clock = { now: new Date(PARKED_AT) };
  const t = makeTestApp({ candidates: [STEINWAY_A], zones: [STEINWAY_ZONE], now: () => clock.now });
  // Decisions are stamped when they're made, as Postgres stamps them.
  setFakeRowClock(() => clock.now);
  const tick = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  const post = (url: string, body: object = {}, headers: Record<string, string> = HEADERS) =>
    t.app.inject({ method: "POST", url, headers, payload: body });
  const fix = (distanceM: number, extra: Record<string, unknown> = {}) => ({
    lat: CAR.lat + distanceM / 111_320,
    lng: CAR.lng,
    accuracy: 8,
    ts: clock.now.toISOString(),
    ...extra,
  });
  return { ...t, clock, tick, post, fix };
}

async function park(t: ReturnType<typeof makeApp>) {
  const res = await t.post("/parked", parkedBody({ outcomes: OUTCOMES }));
  return res.json() as { parkedEventId: string };
}

/** Park, walk away, tap Pay, and walk on: one paid park. */
async function paidPark(t: ReturnType<typeof makeApp>) {
  const { parkedEventId } = await park(t);
  t.tick(5);
  await t.post("/location", t.fix(4));
  t.tick(40);
  await t.post("/location", t.fix(60));
  t.tick(20);
  await t.post("/location", t.fix(90));
  t.tick(10);
  expect((await t.post(`/parked/${parkedEventId}/confirm`)).json()).toMatchObject({
    status: "started",
  });
  t.tick(30);
  await t.post("/location", t.fix(200));
  return parkedEventId;
}

test("every fix a park reads is kept, from the seat to after the tap, with what the phone sensed", async () => {
  const t = makeApp();
  await paidPark(t);
  t.tick(20);
  await t.post(
    "/location",
    t.fix(230, {
      speedMps: 1.3,
      motionActivity: "walking",
      motionConfidence: "high",
      btHint: "car_audio_disconnected",
    }),
  );
  const parkId = t.state.pendingParks[0]!.id;
  // Four before and after the tap, and the walk with its sensing.
  expect(t.state.parkFixes).toHaveLength(5);
  expect(t.state.parkFixes.every((f) => f.pendingParkId === parkId && f.rejected === null)).toBe(
    true,
  );
  expect(t.state.parkFixes.at(-1)).toMatchObject({
    speedMps: 1.3,
    motionActivity: "walking",
    motionConfidence: "high",
    btHint: "car_audio_disconnected",
    event: null,
  });
});

test("a fix the park refuses is kept too, with why", async () => {
  const t = makeApp();
  await park(t);
  const at = (secondsFromNow: number) =>
    new Date(t.clock.now.getTime() + secondsFromNow * 1000).toISOString();
  t.tick(400);
  // Measured before the car stopped (its outbox), measured six minutes
  // ago, and from a phone whose clock is six minutes ahead.
  await t.post("/location", t.fix(60, { measuredAt: at(-401) }));
  await t.post("/location", t.fix(60, { measuredAt: at(-360) }));
  await t.post("/location", t.fix(60, { ts: at(360) }));
  // Mid-start, nothing is read for the park.
  t.state.pendingParks[0]!.status = "starting";
  await t.post("/location", t.fix(80));
  expect(t.state.parkFixes.map((f) => f.rejected)).toEqual([
    "before_park",
    "stale_measurement",
    "clock_skew",
    "park_starting",
  ]);
  expect(t.state.pendingParks[0]).toMatchObject({ farAt: null, leftCarAt: null });
});

test("a phone's sensing that isn't in the vocabulary is refused, not kept", async () => {
  const t = makeApp();
  await park(t);
  const bad = await t.post("/location", t.fix(10, { motionActivity: "teleporting" }));
  expect(bad.statusCode).toBe(400);
  expect(t.state.parkFixes).toEqual([]);
});

test("GET /admin/parks/:id/trace: the park's whole story, for an admin only", async () => {
  const t = makeApp();
  const parkedEventId = await paidPark(t);
  const parkId = t.state.pendingParks[0]!.id;
  const get = (id: string, headers = HEADERS) =>
    t.app.inject({ method: "GET", url: `/admin/parks/${id}/trace`, headers });

  expect((await get(parkId, { "x-api-key": NONADMIN_API_KEY })).statusCode).toBe(403);
  expect((await get("no-such-park")).statusCode).toBe(404);
  const res = await get(parkId);
  expect(res.statusCode).toBe(200);
  const trace = res.json();
  expect(trace.park).toMatchObject({ id: parkId, status: "started" });
  expect(trace.parkedEvent).toMatchObject({ id: parkedEventId });
  expect(trace.fixes).toHaveLength(4);
  expect(trace.decisions.map((d: { kind: string }) => d.kind)).toEqual(
    expect.arrayContaining([
      "parked_quote",
      "street_pending",
      "street_prompt",
      "street_confirmed",
      "session_start_walkaway",
    ]),
  );
  expect(trace.session).toMatchObject({ status: "active", parkedEventId });
  expect(trace.sessionEvents.map((e: { kind: string }) => e.kind)).toContain("started");
  expect(trace.timeline.map((s: { status: string }) => s.status)).toEqual([
    "at_car",
    "prompted",
    "confirmed",
    "starting",
    "started",
  ]);
  // …and by the parkedEventId the phone knows it by.
  expect((await get(parkedEventId)).json().park.id).toBe(parkId);
});

test("an exported trace names nobody, and replays to what the park did", async () => {
  const t = makeApp();
  await paidPark(t);
  const trace = (await buildParkTrace(t.deps.db, t.state.pendingParks[0]!.id))!;
  const fixture = traceToFixture(trace, "exported");
  const json = JSON.stringify(fixture);
  expect(json).not.toContain("u1");
  expect(json).not.toContain(String(CAR.lat));
  expect(json).not.toContain("2026-01-05");
  expect(fixture.parkedAt).toEqual({ weekday: "Mon", time: "14:00" });
  // Metres from the car (haversine, to the decimetre).
  expect(fixture.fixes.map((f) => Math.round(f.northM))).toEqual([4, 60, 90, 200]);
  expect(fixture.fixes.every((f) => f.eastM === 0)).toBe(true);
  expect(fixture.fixes.map((f) => f.receivedS)).toEqual([5, 45, 65, 105]);
  expect(fixture.taps).toEqual([
    expect.objectContaining({
      atS: 75,
      kind: "confirm",
      zoneId: "nyc-417371",
      shownTotalUsd: 3.65,
    }),
  ]);

  const { outcome } = await replayFixture(fixture);
  expect(outcome).toEqual({
    statuses: ["at_car", "prompted", "started"],
    park: "started",
    session: "active",
    starts: 1,
  });
});

test("a park bound to an agent's plan exports its zone from the row's outcome, and replays to it", async () => {
  const zoneOf = (c: typeof MOTT_A): ZoneTermsRow => ({
    zoneId: c.zoneId,
    providerZoneNumber: c.providerZoneNumber,
    rateFirstHour: c.rateFirstHourUsd,
    rateAdditionalHour: c.rateAdditionalHourUsd,
    maxStayMinutes: c.maxStayMinutes,
    hoursJson: c.hours,
  });
  const t = makeTestApp({
    candidates: [MOTT_A, MOTT_B],
    zones: [zoneOf(MOTT_A), zoneOf(MOTT_B)],
    now: () => PARKED_AT,
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody({ outcomes: OUTCOMES }),
  });
  const { parkedEventId } = res.json() as { parkedEventId: string };
  // What E3's binding writes: the zone is in the outcome, not the inputs.
  t.state.decisions.push({
    kind: "street_confirmed",
    rule: "agent_plan_bound",
    inputs: { mode: "agent_plan", shown: { totalUsd: 5 } },
    outcome: { status: "confirmed", startsAt: "walk_away", zoneId: MOTT_B.zoneId },
    parkedEventId,
    createdAt: PARKED_AT,
  });
  const fixture = traceToFixture(
    (await buildParkTrace(t.deps.db, t.state.pendingParks[0]!.id))!,
    "agent-bound",
  );
  expect(fixture.taps).toEqual([
    { atS: 0, kind: "confirm", zoneId: MOTT_B.zoneId, shownTotalUsd: 5 },
  ]);
  // With two sides, a confirm without its zone would be asked which side.
  const { outcome } = await replayFixture(fixture);
  expect(outcome).toMatchObject({ statuses: ["at_car", "confirmed"], park: "confirmed" });
});

test("park fixes are kept 30 days: the retention sweep deletes older ones, on the ledger", async () => {
  const t = makeApp();
  await park(t);
  t.tick(30);
  await t.post("/location", t.fix(10));
  t.tick(31 * 24 * 60 * 60);
  // A newer park's fix, today.
  await t.post("/parked", parkedBody({ outcomes: OUTCOMES, ts: t.clock.now.toISOString() }));
  await t.post("/location", t.fix(12));
  expect(t.state.parkFixes).toHaveLength(2);

  const retention = makeConversationRetention({
    db: t.deps.db,
    retentionDays: 90,
    log: { info() {}, warn() {} },
    now: () => t.clock.now,
  });
  await retention.tick();
  expect(t.state.parkFixes).toHaveLength(1);
  expect(t.state.parkFixes[0]!.receivedAt).toEqual(t.clock.now);
  expect(t.state.decisions.at(-1)).toMatchObject({
    actor: "job",
    kind: "park_trace",
    rule: "retention_purge",
    outcome: { deleted: 1 },
  });
});
