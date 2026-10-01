/**
 * FR-49 — garage and lot footprints, against the live API: a point inside
 * a known Boston garage is answered with that garage and `containsPoint`,
 * a point in the harbor is inside nothing, and an unknown id is a 404.
 *
 * Garages are loaded by hand per city (`pnpm -C server load:garages`), so
 * between a merge and that load the target has none: the tests that need
 * the data skip themselves then, like FR-4 does for a renumbered block.
 * This file is also where FR-50 and FR-52's live cases go.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  BOS_GARAGE,
  BOS_HARBOR,
  gate,
  ownUser,
  sessionFetch,
  userFetch,
  type FrResponse,
} from "./client.js";

/** This file's own throwaway user (client.ts `ownUser`). */
const me = ownUser(import.meta.url);

/** The widest window the route allows. */
const MAX_RADIUS_M = 1500;

type Garage = Record<string, unknown>;

function near(at: { lat: number; lng: number }, extra = ""): Promise<FrResponse> {
  return userFetch(me, "GET", `/garages/near?lat=${at.lat}&lng=${at.lng}${extra}`);
}

/** Whether the target has this city's garages at all: downtown has dozens
 * within 1.5 km once they're loaded, and none before. */
let loaded = false;

beforeAll(async () => {
  await gate();
  const res = await near(BOS_GARAGE, `&radius=${MAX_RADIUS_M}&limit=50`);
  expect(res.status).toBe(200);
  loaded = (res.body["garages"] as Garage[]).length > 0;
});

describe("FR-49 garage and lot footprints", () => {
  it("FR-49 a point inside a known garage is answered with it, contained, with its outline and entrances", async (ctx) => {
    if (!loaded) {
      ctx.skip();
      return;
    }
    const res = await near(BOS_GARAGE);
    expect(res.status).toBe(200);
    expect(res.body["radiusM"]).toBe(250);
    expect(res.body["limit"]).toBe(10);
    expect(res.body["attribution"]).toMatch(/OpenStreetMap/);
    const garages = res.body["garages"] as Garage[];
    expect(garages.length).toBeGreaterThan(0);
    expect(garages.length).toBeLessThanOrEqual(10);

    // Nearest first, and the garage the point is in comes first of all.
    const distances = garages.map((g) => g["distanceM"] as number);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    const inside = garages.filter((g) => g["containsPoint"] === true);
    expect(inside.length).toBeGreaterThan(0);
    const garage = inside.find((g) => BOS_GARAGE.name.test(String(g["name"])));
    expect(garage, `no contained garage named ${String(BOS_GARAGE.name)}`).toBeDefined();
    expect(garage!["city"]).toBe("bos");
    expect(garage!["distanceM"]).toBe(0);
    expect(["multi_storey", "underground", "rooftop"]).toContain(garage!["kind"]);
    expect(garage!["id"]).toMatch(/^bos-[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6,12}$/);

    // The outline is a closed ring of [lng, lat] pairs around the point.
    const polygon = garage!["polygon"] as number[][];
    expect(polygon.length).toBeGreaterThanOrEqual(4);
    expect(polygon[0]).toEqual(polygon[polygon.length - 1]);
    const lngs = polygon.map((p) => p[0]!);
    const lats = polygon.map((p) => p[1]!);
    expect(Math.min(...lngs)).toBeLessThan(BOS_GARAGE.lng);
    expect(Math.max(...lngs)).toBeGreaterThan(BOS_GARAGE.lng);
    expect(Math.min(...lats)).toBeLessThan(BOS_GARAGE.lat);
    expect(Math.max(...lats)).toBeGreaterThan(BOS_GARAGE.lat);
    // An entrance is on or beside the garage, so within a block of a
    // point inside it.
    const entrances = garage!["entrances"] as number[][];
    if (entrances.length > 0) {
      expect(garage!["nearestEntranceM"]).toBeGreaterThanOrEqual(0);
      expect(garage!["nearestEntranceM"]).toBeLessThan(300);
    } else {
      expect(garage!["nearestEntranceM"]).toBeNull();
    }

    // The same garage by id, without the three fields measured from a point.
    const one = await userFetch(me, "GET", `/garages/${encodeURIComponent(String(garage!["id"]))}`);
    expect(one.status).toBe(200);
    const byId = one.body["garage"] as Garage;
    expect(byId["id"]).toBe(garage!["id"]);
    expect(byId["name"]).toBe(garage!["name"]);
    expect(byId["polygon"]).toEqual(polygon);
    expect(byId).not.toHaveProperty("containsPoint");
  });

  it("FR-49 a point in the harbor is inside nothing, and street-side parking is never a footprint", async (ctx) => {
    if (!loaded) {
      ctx.skip();
      return;
    }
    const water = await near(BOS_HARBOR, "&radius=400&limit=50");
    expect(water.status).toBe(200);
    for (const g of water.body["garages"] as Garage[]) {
      expect(g["containsPoint"], String(g["id"])).toBe(false);
      expect(g["distanceM"] as number, String(g["id"])).toBeGreaterThan(0);
    }

    // Everything the widest window returns downtown is one of the five kinds.
    const wide = await near(BOS_GARAGE, `&radius=${MAX_RADIUS_M}&limit=500`);
    expect(wide.status).toBe(200);
    const kinds = new Set((wide.body["garages"] as Garage[]).map((g) => g["kind"]));
    for (const kind of kinds) {
      expect(["multi_storey", "underground", "surface", "rooftop", "unknown"]).toContain(kind);
    }
    // More than the default ten are there to be asked for.
    expect((wide.body["garages"] as Garage[]).length).toBeGreaterThan(10);
    const ten = await near(BOS_GARAGE, `&radius=${MAX_RADIUS_M}`);
    expect((ten.body["garages"] as Garage[]).length).toBe(10);
    expect(ten.body["truncated"]).toBe(true);
  });

  it("FR-49 an unknown garage id is a 404, and the window is capped", async () => {
    const missing = await userFetch(me, "GET", "/garages/bos-fr-no-such-garage-000000");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "garage_not_found" });
    const tooWide = await near(BOS_GARAGE, `&radius=${MAX_RADIUS_M + 1}`);
    expect(tooWide.status).toBe(400);
    expect((await near({ lat: 99, lng: 0 })).status).toBe(400);
  });

  it("FR-49 garages are private like every other read", async () => {
    const list = await sessionFetch(
      "GET",
      `/garages/near?lat=${BOS_GARAGE.lat}&lng=${BOS_GARAGE.lng}`,
    );
    expect(list.status).toBe(401);
    const one = await sessionFetch("GET", "/garages/bos-fr-no-such-garage-000000");
    expect(one.status).toBe(401);
  });
});
