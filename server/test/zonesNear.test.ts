/**
 * GET /zones/near — the map's curb layer. What matters here: the radius cap
 * (this is a PostGIS read per pan), the paid-now vs free-now flag the map
 * colors by, today's posted windows for the tapped-zone card, and the
 * GeoJSON parsing that turns a centerline into drawable coordinates.
 */

import { expect, test } from "vitest";

import { API_KEY, MONDAY_2PM, MONDAY_8PM, makeTestApp } from "./helpers.js";
import type { NearbyZone } from "../src/services/zoneLookup.js";
import { parseMultiLineString } from "../src/services/zoneLookup.js";

const HEADERS = { "x-api-key": API_KEY };

const HOURS_MON_SAT_8_8 = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];

const BOYLSTON: NearbyZone = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  providerZoneNumber: "81234",
  street: "BOYLSTON ST",
  rateFirstHourUsd: 3.75,
  rateAdditionalHourUsd: 3.75,
  maxStayMinutes: 120,
  hours: HOURS_MON_SAT_8_8,
  distanceM: 12.34,
  containsPoint: true,
  centerline: [
    [
      [-71.0812, 42.3502],
      [-71.0805, 42.3504],
    ],
  ],
};

/** Nothing posted — always enforced, and the card says all day. */
const UNPOSTED: NearbyZone = {
  ...BOYLSTON,
  zoneId: "bos-unposted",
  street: null,
  hours: [],
  distanceM: 88,
  centerline: [
    [
      [-71.0822, 42.3512],
      [-71.0815, 42.3514],
    ],
  ],
};

function get(app: ReturnType<typeof makeTestApp>["app"], query: string) {
  return app.inject({ method: "GET", url: `/zones/near?${query}`, headers: HEADERS });
}

test("returns drawable curb lines with terms, colored by enforcement now", async () => {
  const { app } = makeTestApp({
    nearbyZones: [BOYLSTON, UNPOSTED],
    now: () => new Date(MONDAY_2PM),
  });
  const res = await get(app, "lat=42.3503&lng=-71.081&radius=300");
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.radiusM).toBe(300);
  expect(body.truncated).toBe(false);
  expect(body.zones).toHaveLength(2);
  expect(body.zones[0]).toMatchObject({
    zoneId: "bos-boylston-st-e-d-819305",
    city: "bos",
    providerZoneNumber: "81234",
    street: "BOYLSTON ST",
    rateFirstHourUsd: 3.75,
    maxStayMinutes: 120,
    // Monday 2 PM is inside Mon-Sat 8-8: paying now.
    enforcedNow: true,
    todayHours: [{ start: "08:00", end: "20:00" }],
    distanceM: 12.3, // rounded to 0.1 m
  });
  expect(body.zones[0].centerline).toEqual(BOYLSTON.centerline);
  // Nothing posted reads as enforced all day, matching the quote path.
  expect(body.zones[1]).toMatchObject({
    enforcedNow: true,
    todayHours: [{ start: "00:00", end: "24:00" }],
    street: null,
  });
});

test("after the posted end, the same zone is free now", async () => {
  const { app } = makeTestApp({
    nearbyZones: [BOYLSTON],
    now: () => new Date(MONDAY_8PM),
  });
  const body = (await get(app, "lat=42.3503&lng=-71.081")).json();
  expect(body.zones[0].enforcedNow).toBe(false);
  // The windows still show — the card says when it starts charging again.
  expect(body.zones[0].todayHours).toEqual([{ start: "08:00", end: "20:00" }]);
});

test("radius defaults, and is capped at 400 m", async () => {
  const { app } = makeTestApp({ nearbyZones: [] });
  expect((await get(app, "lat=42.35&lng=-71.08")).json().radiusM).toBe(250);
  expect((await get(app, "lat=42.35&lng=-71.08&radius=400")).json().radiusM).toBe(400);

  const tooBig = await get(app, "lat=42.35&lng=-71.08&radius=5000");
  expect(tooBig.statusCode).toBe(400);
});

test("bad or missing coordinates are rejected", async () => {
  const { app } = makeTestApp({ nearbyZones: [] });
  expect((await get(app, "lng=-71.08")).statusCode).toBe(400);
  expect((await get(app, "lat=99&lng=-71.08")).statusCode).toBe(400);
  expect((await get(app, "lat=nope&lng=-71.08")).statusCode).toBe(400);
});

test("the endpoint needs an api key like every other private route", async () => {
  const { app } = makeTestApp({ nearbyZones: [BOYLSTON] });
  const res = await app.inject({ method: "GET", url: "/zones/near?lat=42.35&lng=-71.08" });
  expect(res.statusCode).toBe(401);
});

test("501 when the deployment has no geometry fetcher wired", async () => {
  const { app, deps } = makeTestApp({ nearbyZones: [BOYLSTON] });
  delete (deps as { findNearbyZones?: unknown }).findNearbyZones;
  const res = await get(app, "lat=42.35&lng=-71.08");
  expect(res.statusCode).toBe(501);
  expect(res.json()).toMatchObject({ error: "zone_geometry_unavailable" });
});

test("parseMultiLineString normalizes what PostGIS hands back", () => {
  // ST_Simplify can collapse a MultiLineString to a LineString; both shapes
  // must reach the app as [[[lng, lat], …], …].
  expect(
    parseMultiLineString('{"type":"LineString","coordinates":[[-71.08,42.35],[-71.07,42.36]]}'),
  ).toEqual([
    [
      [-71.08, 42.35],
      [-71.07, 42.36],
    ],
  ]);
  expect(
    parseMultiLineString('{"type":"MultiLineString","coordinates":[[[-71.08,42.35]]]}'),
  ).toEqual([[[-71.08, 42.35]]]);
  // A null/garbage geometry must not throw — the zone is simply not drawn.
  expect(parseMultiLineString(null)).toEqual([]);
  expect(parseMultiLineString("not json")).toEqual([]);
  expect(parseMultiLineString('{"type":"Point","coordinates":[-71.08,42.35]}')).toEqual([]);
});
