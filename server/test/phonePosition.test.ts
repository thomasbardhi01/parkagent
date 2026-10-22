/**
 * Where the phone is, for a running session (delete-list 1): the
 * lifecycle's `phonePosition`, which the extension worker and the gate
 * under the extension lock read. End to end over the shared walk route
 * (ios/Fixtures/drive-park-walk.gpx): a driver who walked away and sits
 * still is still away (the heartbeat re-sends the last measurement with
 * ts now), a session paid away from the car is told, and a fix pulling out
 * beside the car buys nothing. Then the rule itself, case by case, with
 * what still differs from the worker's old distance reading.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import type { PendingParkRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import { phonePosition } from "../src/services/pendingSession.js";
import type { FakeDbState } from "./helpers.js";
import { API_KEY, HOURS_MON_SAT, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`);
const gpx = readFileSync(
  fileURLToPath(new URL("../../ios/Fixtures/drive-park-walk.gpx", import.meta.url)),
  "utf8",
);
const ROUTE = [...gpx.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)">.*?<type>(\w+)<\/type>/g)].map(
  (m) => ({ lat: Number(m[1]), lng: Number(m[2]), phase: m[3]! }),
);
const CAR = ROUTE.find((p) => p.phase === "park")!;
const WALK = ROUTE.filter((p) => p.phase === "walk_away").filter(
  (_, i, all) => i % 5 === 0 || i === all.length - 1,
);

const lastTick = (state: FakeDbState) =>
  state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;

function app(start: string, rates = { first: 2.0, additional: 3.0 }) {
  const clock = { now: T(start) };
  const t = makeTestApp({ now: () => clock.now });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const session = seedSession(t.state, {
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
    rateFirstHour: rates.first,
    rateAdditionalHour: rates.additional,
    maxStayMinutes: 240,
    hoursJson: HOURS_MON_SAT,
    parknycConfirmation: "dry-seed",
  });
  const report = async (
    at: { lat: number; lng: number },
    extra: { measuredAt?: Date; accuracy?: number; speedMps?: number } = {},
  ) => {
    const res = await t.app.inject({
      method: "POST",
      url: "/location",
      headers: HEADERS,
      payload: {
        lat: at.lat,
        lng: at.lng,
        accuracy: extra.accuracy ?? 5,
        ts: clock.now.toISOString(),
        measuredAt: (extra.measuredAt ?? clock.now).toISOString(),
        ...(extra.speedMps !== undefined ? { speedMps: extra.speedMps } : {}),
      },
    });
    expect(res.statusCode).toBe(200);
  };
  const walkAway = async () => {
    for (const p of WALK) {
      clock.now = new Date(clock.now.getTime() + 15_000);
      await report(p);
    }
  };
  return { t, clock, extender, session, report, walkAway };
}

test.each([
  ["re-sends its last measurement (the heartbeat)", false],
  ["measures afresh each minute", true],
] as const)(
  "walked away and sat in a café, the phone %s: still away, and the worker extends",
  async (_label, fresh) => {
    const { t, clock, extender, session, report, walkAway } = app("13:05");
    await walkAway();
    const sat = WALK.at(-1)!;
    const measuredAt = clock.now;
    // CoreLocation's 10 m distance filter delivers nothing; the app's
    // heartbeat re-sends the last fix every minute until 14:20.
    while (clock.now.getTime() < T("14:20").getTime()) {
      clock.now = new Date(clock.now.getTime() + 60_000);
      await report(sat, fresh ? {} : { measuredAt });
    }
    expect(t.state.pendingParks[0]).toMatchObject({ backAt: null });
    expect(t.state.pendingParks[0]!.leftCarAt).not.toBeNull();
    clock.now = T("14:20");
    await extender.tick();
    expect(lastTick(t.state)).toMatchObject({ rule: "extend", inputs: { position: "away" } });
    expect(session.extendCount).toBe(1);
  },
);

test("paid away from the car, no walk-away seen, the phone 400 m off: nothing bought, and the driver is told once", async () => {
  const { t, clock, extender, session, report } = app("14:05");
  const far = { lat: CAR.lat + 400 / 111_320, lng: CAR.lng };
  const measuredAt = clock.now;
  while (clock.now.getTime() < T("14:20").getTime()) {
    await report(far, { accuracy: 8, measuredAt });
    clock.now = new Date(clock.now.getTime() + 60_000);
  }
  clock.now = T("14:20");
  await extender.tick();
  expect(lastTick(t.state)).toMatchObject({
    rule: "hold_position_unknown",
    inputs: { position: "unknown" },
  });
  expect(session.extendCount).toBe(0);
  expect(t.pushes.map((p) => p.push.extra)).toEqual([{ reason: "position_unknown" }]);
});

test("walked away, then a fix 15 m from the car at 6 m/s (back in, pulling out): at the car, nothing bought", async () => {
  const { t, clock, extender, session, report, walkAway } = app("13:05", {
    first: 0.5,
    additional: 0.5,
  });
  await walkAway();
  clock.now = new Date(T("14:20").getTime() - 20_000);
  await report({ lat: CAR.lat + 15 / 111_320, lng: CAR.lng }, { speedMps: 6 });
  clock.now = T("14:20");
  await extender.tick();
  expect(lastTick(t.state)).toMatchObject({ rule: "hold_at_car", inputs: { position: "at_car" } });
  expect(session.extendCount).toBe(0);
});

// ---------------------------------------------------------------- the rule

const AT = T("14:20");
const PARKED = T("13:00");

function park(over: Partial<PendingParkRow> = {}): PendingParkRow {
  return {
    id: "pp1",
    userId: "u1",
    parkedEventId: null,
    status: "started",
    candidates: null,
    quote: null,
    prompt: null,
    shownDryRun: null,
    zoneId: "z",
    carLat: CAR.lat,
    carLng: CAR.lng,
    parkedAt: PARKED,
    leftCarAt: null,
    farAt: null,
    farDistanceM: null,
    nearSince: null,
    atCarSince: null,
    backAt: null,
    driveAt: null,
    driveDistanceM: null,
    driveSpeedMps: null,
    promptedAt: null,
    confirmedAt: null,
    startingAt: null,
    sessionId: "s1",
    carMovedAt: null,
    closedAt: null,
    createdAt: PARKED,
    ...over,
  } as PendingParkRow;
}

const LEFT = { leftCarAt: T("13:02") };
/** A fix `northM` from the car, sent `ageMin` minutes ago. */
const fix = (northM: number, ageMin: number, accuracyM = 10) => ({
  lat: CAR.lat + northM / 111_320,
  lng: CAR.lng,
  accuracyM,
  ts: new Date(AT.getTime() - ageMin * 60_000),
  // Measured long ago: the report time decides "still reporting".
  measuredAt: new Date(AT.getTime() - (ageMin + 30) * 60_000),
});

test.each([
  // [case, park, newest fix, position]: the same as the old reading
  ["left, still reporting far", park(LEFT), fix(400, 1), "away"],
  ["left, still reporting within 30 m", park(LEFT), fix(20, 1), "at_car"],
  ["left and back, now 20 m", park({ ...LEFT, backAt: T("14:15") }), fix(20, 1), "at_car"],
  ["left and back, now 100 m", park({ ...LEFT, backAt: T("14:15") }), fix(100, 1), "back"],
  ["never left, within 30 m", park(), fix(10, 1), "at_car"],
  ["never left, far", park(), fix(400, 1), "unknown"],
  ["never left, no fix", park(), null, "unknown"],
  ["ended", park({ ...LEFT, status: "ended" }), fix(400, 1), "returned"],
  ["car moved", park({ ...LEFT, carMovedAt: T("14:10") }), fix(400, 1), "moved"],
  ["left, newest too blurry to read", park(LEFT), fix(400, 1, 80), "unknown"],
  ["left, within 30 m but too blurry to read", park(LEFT), fix(20, 1, 80), "unknown"],
  // …and what differs from it, on purpose (each holds, and pushes
  // position_unknown once near expiry)
  ["no park row (a session the walk rules never saw)", null, fix(400, 1), "unknown"],
  [
    "a park that isn't started (start_failed)",
    park({ ...LEFT, status: "start_failed" }),
    fix(400, 1),
    "unknown",
  ],
  ["left, newest sent six minutes ago (was ten)", park(LEFT), fix(400, 6), "unknown"],
  ["left, newest from a clock six minutes ahead", park(LEFT), fix(400, -6), "unknown"],
  [
    "left, newest sent before the park",
    park({ ...LEFT, parkedAt: T("14:19") }),
    fix(400, 2),
    "unknown",
  ],
] as const)("%s: %s", (_label, p, newest, expected) => {
  expect(phonePosition(p, newest, AT)).toBe(expected);
});
