/**
 * FR-49 — GET /garages/near and GET /garages/:id: the garage and lot
 * outlines around a point, each with whether the point is inside it, how
 * far its outline is, and how far its nearest entrance is. Read-only, and
 * private like every other read route.
 */

import { expect, test } from "vitest";

import { at, garage, pair, square } from "./garageFixtures.js";
import { API_KEY, MONDAY_2PM, NONADMIN_API_KEY, TEST_JWT_SECRET, makeTestApp } from "./helpers.js";
import { GARAGE_NEAR_MAX_LIMIT, GARAGE_NEAR_MAX_RADIUS_M } from "../src/routes/garages.js";
import { signAccessToken } from "../src/services/authTokens.js";

const HEADERS = { "x-api-key": API_KEY };

/** A named deck the point is inside, with two entrances. */
const DECK = garage({
  id: "bos-fixture-deck-0a1b2c",
  name: "Fixture Deck",
  operator: "Fixture Parking Co",
  kind: "multi_storey",
  fee: true,
  access: "customers",
  capacity: 420,
  website: "https://example.com/deck",
  polygon: square(0, 0, 30),
  entrances: [pair(30, 0), pair(-30, 10)],
});
/** An unnamed lot 100 m east of the deck's center. */
const LOT = garage({
  id: "bos-surface-3d4e5f",
  kind: "surface",
  polygon: square(130, 0, 30),
  entrances: [pair(100, -5)],
});
/** Far outside the default radius. */
const FAR = garage({ id: "bos-far-6a7b8c", kind: "underground", polygon: square(900, 0, 30) });

const HERE = at(10, 0);
const here = `lat=${HERE.lat}&lng=${HERE.lng}`;

function near(app: ReturnType<typeof makeTestApp>["app"], query: string) {
  return app.inject({ method: "GET", url: `/garages/near?${query}`, headers: HEADERS });
}

test("near: garages around the point, nearest first, each with containment and its distances", async () => {
  const { app } = makeTestApp({ garages: [FAR, LOT, DECK] });
  const res = await near(app, here);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.radiusM).toBe(250);
  expect(body.limit).toBe(10);
  expect(body.truncated).toBe(false);
  expect(body.garages.map((g: { id: string }) => g.id)).toEqual([DECK.id, LOT.id]);

  const [deck, lot] = body.garages;
  expect(deck).toMatchObject({
    id: "bos-fixture-deck-0a1b2c",
    city: "bos",
    name: "Fixture Deck",
    operator: "Fixture Parking Co",
    kind: "multi_storey",
    fee: true,
    access: "customers",
    capacity: 420,
    website: "https://example.com/deck",
    // Inside the outline: zero meters to it, 20 m to the east entrance.
    containsPoint: true,
    distanceM: 0,
    nearestEntranceM: 20,
    source: "osm",
    sourceVersion: "2026-09-30T12:00:00Z",
  });
  // What the phone's footprint cache decodes: the outer ring and the
  // entrances, as [lng, lat] pairs.
  expect(deck.polygon).toEqual(DECK.polygon);
  expect(deck.entrances).toEqual(DECK.entrances);
  expect(lot).toMatchObject({
    id: "bos-surface-3d4e5f",
    name: null,
    kind: "surface",
    fee: null,
    containsPoint: false,
    // The lot's west side is 100 m east of the origin; the point is 10 m east.
    distanceM: 90,
  });
  expect(lot.nearestEntranceM).toBeCloseTo(Math.hypot(90, 5), 0);
});

test("near: exactly the documented fields, nothing else from the row", async () => {
  const { app } = makeTestApp({ garages: [DECK] });
  const body = (await near(app, here)).json();
  expect(Object.keys(body).sort()).toEqual(
    ["attribution", "garages", "limit", "radiusM", "truncated"].sort(),
  );
  expect(Object.keys(body.garages[0]).sort()).toEqual(
    [
      "access",
      "capacity",
      "city",
      "containsPoint",
      "distanceM",
      "entrances",
      "fee",
      "id",
      "kind",
      "name",
      "nearestEntranceM",
      "operator",
      "polygon",
      "source",
      "sourceVersion",
      "website",
    ].sort(),
  );
  // The outlines are OpenStreetMap's, and the license wants that said.
  expect(body.attribution).toMatch(/OpenStreetMap/);
});

test("near: a hole in an outline rides along, and only then", async () => {
  const ring = garage({
    id: "bos-ring-9d8e7f",
    kind: "surface",
    polygon: square(0, 0, 50),
    holes: [square(0, 0, 20)],
  });
  const { app } = makeTestApp({ garages: [ring] });
  const origin = at(0, 0);
  const body = (await near(app, `lat=${origin.lat}&lng=${origin.lng}`)).json();
  expect(body.garages[0].holes).toEqual(ring.holes);
  // Standing in the hole is outside the lot, 20 m from its inner edge.
  expect(body.garages[0]).toMatchObject({ containsPoint: false, distanceM: 20 });
});

test("near: up to 10 by default, and it says when there were more", async () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    garage({
      id: `bos-row-${String(i).padStart(6, "0")}`,
      kind: "surface",
      polygon: square(i * 15, 0, 5),
    }),
  );
  const { app } = makeTestApp({ garages: many });
  const origin = at(0, 0);
  const where = `lat=${origin.lat}&lng=${origin.lng}`;

  const capped = (await near(app, where)).json();
  expect(capped.garages).toHaveLength(10);
  expect(capped.truncated).toBe(true);
  // The ten nearest, not any ten.
  expect(capped.garages.map((g: { id: string }) => g.id)).toEqual(
    many.slice(0, 10).map((g) => g.id),
  );

  // The phone's cell cache asks for more than ten.
  const all = (await near(app, `${where}&limit=50`)).json();
  expect(all.limit).toBe(50);
  expect(all.garages).toHaveLength(14);
  expect(all.truncated).toBe(false);

  const exact = (await near(app, `${where}&limit=14`)).json();
  expect(exact.garages).toHaveLength(14);
  expect(exact.truncated).toBe(false);
});

test("near: the radius defaults to 250 m and is capped; the limit is capped", async () => {
  const { app } = makeTestApp({ garages: [DECK, LOT, FAR] });
  // 900 m away is outside 250 m and inside 1000 m.
  expect((await near(app, here)).json().garages).toHaveLength(2);
  const wide = (await near(app, `${here}&radius=1000`)).json();
  expect(wide.radiusM).toBe(1000);
  expect(wide.garages.map((g: { id: string }) => g.id)).toEqual([DECK.id, LOT.id, FAR.id]);
  // A 2 km cell's corner-to-center distance must fit under the cap.
  expect(GARAGE_NEAR_MAX_RADIUS_M).toBeGreaterThanOrEqual(1416);
  expect((await near(app, `${here}&radius=${GARAGE_NEAR_MAX_RADIUS_M}`)).statusCode).toBe(200);
  expect((await near(app, `${here}&radius=${GARAGE_NEAR_MAX_RADIUS_M + 1}`)).statusCode).toBe(400);
  expect((await near(app, `${here}&radius=0`)).statusCode).toBe(400);
  expect((await near(app, `${here}&limit=${GARAGE_NEAR_MAX_LIMIT}`)).statusCode).toBe(200);
  expect((await near(app, `${here}&limit=${GARAGE_NEAR_MAX_LIMIT + 1}`)).statusCode).toBe(400);
  expect((await near(app, `${here}&limit=0`)).statusCode).toBe(400);
  expect((await near(app, `${here}&limit=2.5`)).statusCode).toBe(400);
});

test("near: bad or missing coordinates are rejected", async () => {
  const { app } = makeTestApp({ garages: [DECK] });
  expect((await near(app, "lng=-71.07")).statusCode).toBe(400);
  expect((await near(app, "lat=99&lng=-71.07")).statusCode).toBe(400);
  expect((await near(app, "lat=nope&lng=-71.07")).statusCode).toBe(400);
});

test("near: street-side parking is never returned, even if a row carries it", async () => {
  const curb = garage({ id: "bos-curb-aaaaaa", kind: "street_side", polygon: square(0, 0, 30) });
  const { app } = makeTestApp({ garages: [curb, LOT] });
  const body = (await near(app, here)).json();
  expect(body.garages.map((g: { id: string }) => g.id)).toEqual([LOT.id]);
  const byId = await app.inject({ method: "GET", url: `/garages/${curb.id}`, headers: HEADERS });
  expect(byId.statusCode).toBe(404);
});

test("near and by-id need a credential like every other private route", async () => {
  const { app } = makeTestApp({ garages: [DECK] });
  expect((await app.inject({ method: "GET", url: `/garages/near?${here}` })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: `/garages/${DECK.id}` })).statusCode).toBe(401);
});

test("the app's Bearer access token reaches both", async () => {
  const { app, state } = makeTestApp({ garages: [DECK], now: () => new Date(MONDAY_2PM) });
  const user = state.users.find((u) => u.id === "u1")!;
  const { token } = signAccessToken(TEST_JWT_SECRET, user, new Date(MONDAY_2PM));
  const headers = { authorization: `Bearer ${token}` };
  const list = await app.inject({ method: "GET", url: `/garages/near?${here}`, headers });
  expect(list.statusCode).toBe(200);
  expect(list.json().garages.map((g: { id: string }) => g.id)).toEqual([DECK.id]);
  const one = await app.inject({ method: "GET", url: `/garages/${DECK.id}`, headers });
  expect(one.statusCode).toBe(200);
});

test("near is rate-limited per user", async () => {
  const { app } = makeTestApp({ garages: [DECK] });
  for (let i = 0; i < 60; i += 1) {
    expect((await near(app, here)).statusCode).toBe(200);
  }
  const blocked = await near(app, here);
  expect(blocked.statusCode).toBe(429);
  expect(blocked.json()).toEqual({ error: "rate_limited" });
  // Another user is unaffected.
  const other = await app.inject({
    method: "GET",
    url: `/garages/near?${here}`,
    headers: { "x-api-key": NONADMIN_API_KEY },
  });
  expect(other.statusCode).toBe(200);
});

test("by id: the garage, with its outline and entrances", async () => {
  const { app } = makeTestApp({ garages: [DECK, LOT] });
  const res = await app.inject({ method: "GET", url: `/garages/${DECK.id}`, headers: HEADERS });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.garage).toMatchObject({
    id: DECK.id,
    city: "bos",
    name: "Fixture Deck",
    kind: "multi_storey",
    fee: true,
    capacity: 420,
    polygon: DECK.polygon,
    entrances: DECK.entrances,
    source: "osm",
  });
  // No point was given, so nothing is measured from one.
  expect(body.garage).not.toHaveProperty("containsPoint");
  expect(body.garage).not.toHaveProperty("distanceM");
  expect(body.attribution).toMatch(/OpenStreetMap/);
});

test("by id: 404 for an id nobody loaded, and for one that couldn't be an id", async () => {
  const { app } = makeTestApp({ garages: [DECK] });
  for (const id of ["bos-nope-000000", "BOS-Fixture-Deck-0A1B2C", "a%20b", "bos_deck"]) {
    const res = await app.inject({ method: "GET", url: `/garages/${id}`, headers: HEADERS });
    expect(res.statusCode, id).toBe(404);
    expect(res.json(), id).toEqual({ error: "garage_not_found" });
  }
});

test("by id never swallows /garages/near", async () => {
  // A garage whose id is the word the other route is named.
  const { app } = makeTestApp({ garages: [garage({ id: "near" })] });
  const res = await near(app, here);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toHaveProperty("garages");
  expect((await near(app, "")).statusCode).toBe(400);
});

test("501 when the deployment has no footprint store wired", async () => {
  const { app, deps } = makeTestApp({ garages: [DECK] });
  delete (deps as { garageFootprints?: unknown }).garageFootprints;
  const list = await near(app, here);
  expect(list.statusCode).toBe(501);
  expect(list.json()).toEqual({ error: "garage_footprints_unavailable" });
  const one = await app.inject({ method: "GET", url: `/garages/${DECK.id}`, headers: HEADERS });
  expect(one.statusCode).toBe(501);
});

test("reading garages writes nothing: no decision, no push", async () => {
  const { app, state, pushes } = makeTestApp({ garages: [DECK] });
  await near(app, here);
  await app.inject({ method: "GET", url: `/garages/${DECK.id}`, headers: HEADERS });
  expect(state.decisions).toHaveLength(0);
  expect(pushes).toHaveLength(0);
});

test("near: the answer is ordered by its own distances, whatever order the store hands back", async () => {
  const { app, deps } = makeTestApp({ garages: [DECK, LOT] });
  deps.garageFootprints = {
    near: async () => ({ garages: [FAR, LOT, DECK], truncated: false }),
    byId: async () => null,
  };
  const body = (await near(app, `${here}&radius=1000`)).json();
  expect(body.garages.map((g: { id: string }) => g.id)).toEqual([DECK.id, LOT.id, FAR.id]);
  const distances = body.garages.map((g: { distanceM: number }) => g.distanceM);
  expect(distances).toEqual([...distances].sort((a: number, b: number) => a - b));
});

test("by id: an id that couldn't be one never reaches the database", async () => {
  const { app, deps } = makeTestApp({ garages: [DECK] });
  const asked: string[] = [];
  deps.garageFootprints = {
    near: async () => ({ garages: [], truncated: false }),
    byId: async (id) => {
      asked.push(id);
      return null;
    },
  };
  for (const id of ["a%20b", "bos_deck", "BOS-DECK", "bos-deck-", "-bos"]) {
    const res = await app.inject({ method: "GET", url: `/garages/${id}`, headers: HEADERS });
    expect(res.statusCode, id).toBe(404);
    expect(res.json(), id).toEqual({ error: "garage_not_found" });
  }
  // The router refuses a path parameter over 100 characters by itself.
  const long = await app.inject({
    method: "GET",
    url: `/garages/bos-${"a".repeat(120)}`,
    headers: HEADERS,
  });
  expect(long.statusCode).toBe(414);
  expect(asked).toEqual([]);
  await app.inject({ method: "GET", url: "/garages/bos-deck-0a1b2c", headers: HEADERS });
  expect(asked).toEqual(["bos-deck-0a1b2c"]);
});
