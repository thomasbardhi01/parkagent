/**
 * The phone's side of auto-extend, end to end on the server: the iOS test
 * route (ios/Fixtures/drive-park-walk.gpx, the same one the detector's UI
 * and unit tests use) walked through POST /location at the reporter's
 * cadence, then one extension-worker tick. The worker must see the walk
 * away as "away" (and extend near expiry), and the walk back as "toward"
 * or at the car (and hold).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { haversineM, makeExtender } from "../src/jobs/extendTick.js";
import type { FakeDbState } from "./helpers.js";
import { API_KEY, HOURS_MON_SAT, STEINWAY_A, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`); // a Monday
const NOW = T("14:20");

interface RoutePoint {
  lat: number;
  lng: number;
  phase: string;
}

function loadRoute(): RoutePoint[] {
  const gpx = readFileSync(
    fileURLToPath(new URL("../../ios/Fixtures/drive-park-walk.gpx", import.meta.url)),
    "utf8",
  );
  const points = [...gpx.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)">.*?<type>(\w+)<\/type>/g)];
  return points.map((m) => ({ lat: Number(m[1]), lng: Number(m[2]), phase: m[3]! }));
}

const ROUTE = loadRoute();
const CAR = ROUTE.find((p) => p.phase === "park")!;

function activeSession(state: FakeDbState) {
  return seedSession(state, {
    status: "active",
    dryRun: true,
    zoneId: "nyc-417371",
    providerZoneNumber: "417371",
    startedAt: T("13:00"),
    expiresAt: T("14:30"), // 10 min left at NOW: inside the decision window
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
  });
}

/** Posts one fix per 15 s (the reporter's fastest cadence while moving),
 * the last one at NOW, exactly as the phone would. */
async function walk(app: ReturnType<typeof makeTestApp>["app"], points: RoutePoint[]) {
  const every = points.filter((_, i) => i % 5 === 0 || i === points.length - 1);
  for (const [i, point] of every.entries()) {
    const ts = new Date(NOW.getTime() - (every.length - 1 - i) * 15_000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/location",
      headers: HEADERS,
      payload: { lat: point.lat, lng: point.lng, accuracy: 5, ts },
    });
    expect(res.statusCode).toBe(200);
  }
}

function lastTick(state: FakeDbState) {
  return state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
}

test("the route's walk away reaches the worker as 'away' and extends near expiry", async () => {
  const t = makeTestApp({ now: () => NOW });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const session = activeSession(t.state);

  await walk(
    t.app,
    ROUTE.filter((p) => p.phase === "walk_away"),
  );
  await extender.tick();

  const decision = lastTick(t.state);
  const inputs = decision.inputs as { heading: string; distanceM: number };
  expect(inputs.heading).toBe("away");
  expect(inputs.distanceM).toBeGreaterThan(280);
  expect(decision.rule).toBe("extend");
  expect(session.extendCount).toBe(1);
});

test("the route's walk back reaches the worker as heading to the car, and it holds", async () => {
  const t = makeTestApp({ now: () => NOW });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const session = activeSession(t.state);

  await walk(
    t.app,
    ROUTE.filter((p) => p.phase === "walk_back"),
  );
  await extender.tick();

  const decision = lastTick(t.state);
  const inputs = decision.inputs as { heading: string; distanceM: number };
  expect(inputs.heading).toBe("toward");
  expect(inputs.distanceM).toBeLessThan(30);
  expect(decision.rule).toBe("hold_return_likely");
  expect(session.extendCount).toBe(0);
});

test("the route's spot is the car the walk is measured from", () => {
  const far = ROUTE.find((p) => p.phase === "far")!;
  expect(Math.round(haversineM(CAR.lat, CAR.lng, far.lat, far.lng))).toBeGreaterThanOrEqual(295);
});

test("a park waiting on the same route is asked about once, as the walk leaves the car", async () => {
  const t = makeTestApp({
    now: () => NOW,
    candidates: [STEINWAY_A],
    zones: [
      {
        zoneId: "nyc-417371",
        providerZoneNumber: "417371",
        rateFirstHour: 2.0,
        rateAdditionalHour: 3.0,
        maxStayMinutes: 120,
        hoursJson: HOURS_MON_SAT,
      },
    ],
  });
  const parked = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: {
      lat: CAR.lat,
      lng: CAR.lng,
      accuracy: 8,
      ts: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      signals: ["motion_stop"],
      outcomes: ["garage", "nopay", "walk_away"],
    },
  });
  expect(parked.json()).toMatchObject({ action: "pay", awaitsWalkAway: true });

  // The driver sits through the route's parked minute, then walks.
  const stay = ROUTE.filter((p) => p.phase === "park");
  await walk(t.app, stay);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "at_car", leftCarAt: null });
  expect(t.state.decisions.some((d) => d.kind === "street_prompt")).toBe(false);

  await walk(
    t.app,
    ROUTE.filter((p) => p.phase === "walk_away"),
  );
  expect(t.state.pendingParks[0]!.status).toBe("prompted");
  const asked = t.state.decisions.filter((d) => d.kind === "street_prompt");
  expect(asked).toHaveLength(1);
  // Asked while still within the block, not at the far end of the walk.
  const fix = asked[0]!.inputs["fix"] as { distanceM: number };
  expect(fix.distanceM).toBeGreaterThan(30);
  expect(fix.distanceM).toBeLessThan(150);
  expect(t.state.sessions).toEqual([]);
  expect(t.pushes).toEqual([]);
});
