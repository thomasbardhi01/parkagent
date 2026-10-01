/**
 * FR-49 — classifyByFootprint and the geometry under it. The rule: the
 * outline the point is inside wins; otherwise the nearest entrance of a
 * structure within max(40 m, the fix's accuracy). Street-side parking is a
 * zone, never a footprint.
 */

import { describe, expect, test } from "vitest";

import { at, garage, pair, square } from "./garageFixtures.js";
import {
  classifyByFootprint,
  describeFootprint,
  entranceReachM,
  makeGarageStore,
  MAX_ENTRANCE_REACH_M,
} from "../src/services/garageLookup.js";

const NO_MATCH = { kind: null, garageId: null, containsPoint: false, nearestEntranceM: null };

describe("classifyByFootprint", () => {
  test("containment beats proximity: the lot the point is in wins over a garage entrance 10 m away", () => {
    const lot = garage({ id: "bos-lot-aaaaaa", kind: "surface", polygon: square(0, 0, 30) });
    const structure = garage({
      id: "bos-structure-bbbbbb",
      kind: "multi_storey",
      polygon: square(100, 0, 30),
      entrances: [pair(10, 0)],
    });
    // Whichever order they arrive in.
    for (const garages of [
      [lot, structure],
      [structure, lot],
    ]) {
      expect(classifyByFootprint(at(0, 0), 10, garages)).toEqual({
        kind: "surface",
        garageId: "bos-lot-aaaaaa",
        containsPoint: true,
        nearestEntranceM: null,
      });
    }
  });

  test("of nested outlines, the innermost is the place", () => {
    const campus = garage({ id: "bos-campus-aaaaaa", kind: "surface", polygon: square(0, 0, 200) });
    const deck = garage({
      id: "bos-deck-bbbbbb",
      kind: "multi_storey",
      polygon: square(0, 0, 25),
      entrances: [pair(25, 0)],
    });
    const match = classifyByFootprint(at(5, 5), 10, [campus, deck]);
    expect(match).toMatchObject({ kind: "multi_storey", garageId: "bos-deck-bbbbbb" });
    expect(match.containsPoint).toBe(true);
    // The matched garage's own nearest entrance: 20 m east, 5 m south.
    expect(match.nearestEntranceM).toBeCloseTo(Math.hypot(20, 5), 0);
  });

  test("the entrance radius scales with accuracy: 40 m at best, the fix's accuracy when worse", () => {
    const structure = garage({
      id: "bos-structure-bbbbbb",
      kind: "underground",
      polygon: square(200, 0, 30),
      entrances: [pair(60, 0)],
    });
    // 60 m from the entrance with a 10 m fix: outside the 40 m floor.
    expect(classifyByFootprint(at(0, 0), 10, [structure])).toEqual(NO_MATCH);
    // 39 m is in reach; 41 m is not.
    expect(classifyByFootprint(at(21, 0), 10, [structure]).garageId).toBe("bos-structure-bbbbbb");
    expect(classifyByFootprint(at(19, 0), 10, [structure])).toEqual(NO_MATCH);
    // The same 60 m with an 80 m fix: inside.
    const wide = classifyByFootprint(at(0, 0), 80, [structure]);
    expect(wide).toMatchObject({
      kind: "underground",
      garageId: "bos-structure-bbbbbb",
      containsPoint: false,
    });
    expect(wide.nearestEntranceM).toBeCloseTo(60, 0);
  });

  test("the reach stops at the cap: a useless fix can't claim a garage blocks away", () => {
    const structure = garage({
      id: "bos-structure-bbbbbb",
      polygon: square(400, 0, 30),
      entrances: [pair(300, 0)],
    });
    expect(entranceReachM(5_000)).toBe(MAX_ENTRANCE_REACH_M);
    expect(MAX_ENTRANCE_REACH_M).toBeLessThan(300);
    expect(classifyByFootprint(at(0, 0), 5_000, [structure])).toEqual(NO_MATCH);
  });

  test("an unreadable accuracy falls back to the 40 m floor", () => {
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(entranceReachM(bad), String(bad)).toBe(40);
    }
    expect(entranceReachM(0)).toBe(40);
    expect(entranceReachM(65)).toBe(65);
  });

  test("only a structure is entered by its entrance: a lot beside the street is not where a street park is", () => {
    // A street park 10 m from a surface lot's entrance, outside its outline.
    const lot = garage({
      id: "bos-lot-aaaaaa",
      kind: "surface",
      polygon: square(50, 0, 30),
      entrances: [pair(10, 0)],
    });
    const unknown = garage({ ...lot, id: "bos-parking-cccccc", kind: "unknown" });
    expect(classifyByFootprint(at(0, 0), 10, [lot, unknown])).toEqual(NO_MATCH);
    for (const kind of ["multi_storey", "underground", "rooftop"]) {
      const structure = garage({ ...lot, id: "bos-structure-bbbbbb", kind });
      expect(classifyByFootprint(at(0, 0), 10, [lot, structure]), kind).toMatchObject({
        kind,
        garageId: "bos-structure-bbbbbb",
        containsPoint: false,
      });
    }
  });

  test("of two structures in reach, the nearer entrance wins; a tie goes to the smaller id", () => {
    const far = garage({
      id: "bos-far-aaaaaa",
      polygon: square(200, 0, 30),
      entrances: [pair(30, 0)],
    });
    const near = garage({
      id: "bos-near-bbbbbb",
      polygon: square(-200, 0, 30),
      entrances: [pair(-12, 0), pair(-90, 0)],
    });
    const match = classifyByFootprint(at(0, 0), 10, [far, near]);
    expect(match.garageId).toBe("bos-near-bbbbbb");
    expect(match.nearestEntranceM).toBeCloseTo(12, 0);

    const twin = garage({ ...near, id: "bos-near-aaaaaa" });
    expect(classifyByFootprint(at(0, 0), 10, [near, twin]).garageId).toBe("bos-near-aaaaaa");
    expect(classifyByFootprint(at(0, 0), 10, [twin, near]).garageId).toBe("bos-near-aaaaaa");
  });

  test("street_side is never returned, by containment or by entrance", () => {
    for (const kind of ["street_side", "lane", "on_kerb", "something_new"]) {
      const curb = garage({
        id: "bos-curb-dddddd",
        kind,
        polygon: square(0, 0, 30),
        entrances: [pair(5, 0)],
      });
      // Inside its outline and 5 m from its entrance: still nothing.
      expect(classifyByFootprint(at(0, 0), 10, [curb]), kind).toEqual(NO_MATCH);
      // And it doesn't hide the real garage behind it.
      const real = garage({ id: "bos-real-eeeeee", kind: "surface", polygon: square(0, 0, 50) });
      expect(classifyByFootprint(at(0, 0), 10, [curb, real]).garageId).toBe("bos-real-eeeeee");
    }
  });

  test("nothing near, or nothing loaded, is no match", () => {
    expect(classifyByFootprint(at(0, 0), 10, [])).toEqual(NO_MATCH);
    const elsewhere = garage({
      id: "bos-elsewhere-aaaaaa",
      polygon: square(900, 900, 30),
      entrances: [pair(870, 900)],
    });
    expect(classifyByFootprint(at(0, 0), 10, [elsewhere])).toEqual(NO_MATCH);
  });

  test("an outline that isn't one never contains anything", () => {
    const broken = garage({ id: "bos-broken-aaaaaa", polygon: [pair(0, 0), pair(10, 0)] });
    const garbage = garage({
      id: "bos-garbage-bbbbbb",
      polygon: [[Number.NaN, 1], [2], []] as number[][],
    });
    expect(classifyByFootprint(at(0, 0), 10, [broken, garbage])).toEqual(NO_MATCH);
  });
});

describe("describeFootprint", () => {
  const deck = garage({
    id: "bos-deck-bbbbbb",
    polygon: square(0, 0, 30),
    entrances: [pair(30, 0), pair(-30, 0)],
  });

  test("inside: contained, zero distance, and how deep", () => {
    const inside = describeFootprint(at(10, 0), deck);
    expect(inside.containsPoint).toBe(true);
    expect(inside.distanceM).toBe(0);
    // 20 m from the east side: what "nearer the edge than the fix is good" reads.
    expect(inside.edgeDistanceM).toBeCloseTo(20, 0);
    expect(inside.nearestEntranceM).toBeCloseTo(20, 0);
  });

  test("outside: meters to the outline, not to its center or a corner", () => {
    const outside = describeFootprint(at(75, 0), deck);
    expect(outside.containsPoint).toBe(false);
    expect(outside.distanceM).toBeCloseTo(45, 0);
    expect(outside.edgeDistanceM).toBeCloseTo(45, 0);
    expect(outside.nearestEntranceM).toBeCloseTo(45, 0);
    // Diagonal from a corner.
    expect(describeFootprint(at(60, 70), deck).distanceM).toBeCloseTo(50, 0);
  });

  test("no mapped entrance is null, never zero", () => {
    const bare = garage({ id: "bos-bare-aaaaaa", entrances: [] });
    expect(describeFootprint(at(0, 0), bare).nearestEntranceM).toBeNull();
  });

  test("a hole in the outline is outside it", () => {
    const ring = garage({
      id: "bos-ring-aaaaaa",
      kind: "surface",
      polygon: square(0, 0, 50),
      holes: [square(0, 0, 20)],
    });
    expect(describeFootprint(at(0, 0), ring).containsPoint).toBe(false);
    expect(describeFootprint(at(0, 0), ring).distanceM).toBeCloseTo(20, 0);
    expect(describeFootprint(at(35, 0), ring).containsPoint).toBe(true);
    expect(classifyByFootprint(at(0, 0), 10, [ring]).garageId).toBeNull();
    expect(classifyByFootprint(at(35, 0), 10, [ring]).garageId).toBe("bos-ring-aaaaaa");
  });
});

describe("makeGarageStore", () => {
  const row = (i: number, overrides: Record<string, unknown> = {}) => ({
    id: `bos-garage-${String(i).padStart(6, "0")}`,
    city: "bos",
    name: i === 0 ? "Fixture Garage" : null,
    operator: null,
    kind: "multi_storey",
    fee: i === 0 ? true : null,
    access: null,
    capacity: i === 0 ? 400 : null,
    website: null,
    source: "osm",
    source_version: "2026-09-30T12:00:00Z",
    geom_json: JSON.stringify({ type: "Polygon", coordinates: [square(i * 100, 0, 30)] }),
    entrances_json: JSON.stringify({ type: "MultiPoint", coordinates: [pair(i * 100 + 30, 0)] }),
    ...overrides,
  });

  test("rows become footprints: the outer ring, its holes, and the entrances", async () => {
    const withHole = row(0, {
      geom_json: JSON.stringify({
        type: "Polygon",
        coordinates: [square(0, 0, 30), square(0, 0, 5)],
      }),
    });
    const store = makeGarageStore({ $queryRaw: async <T>() => [withHole] as T });
    const { garages, truncated } = await store.near({ ...at(0, 0), radiusM: 250, limit: 10 });
    expect(truncated).toBe(false);
    expect(garages).toEqual([
      {
        id: "bos-garage-000000",
        city: "bos",
        name: "Fixture Garage",
        operator: null,
        kind: "multi_storey",
        fee: true,
        access: null,
        capacity: 400,
        website: null,
        polygon: square(0, 0, 30),
        holes: [square(0, 0, 5)],
        entrances: [pair(30, 0)],
        source: "osm",
        sourceVersion: "2026-09-30T12:00:00Z",
      },
    ]);
  });

  test("truncation is decided on the raw rows, before an undrawable one is dropped", async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row(i, i === 1 ? { geom_json: "not json" } : {}),
    );
    const store = makeGarageStore({ $queryRaw: async <T>() => rows as T });
    const cut = await store.near({ ...at(0, 0), radiusM: 250, limit: 3 });
    expect(cut.truncated).toBe(true);
    // Three rows fit the limit; one of them has no outline.
    expect(cut.garages.map((g) => g.id)).toEqual(["bos-garage-000000", "bos-garage-000002"]);

    const exact = makeGarageStore({ $queryRaw: async <T>() => rows.slice(0, 3) as T });
    expect((await exact.near({ ...at(0, 0), radiusM: 250, limit: 3 })).truncated).toBe(false);
  });

  test("a row with no entrances, or with a geometry that isn't a polygon, reads safely", async () => {
    const rows = [
      row(0, { entrances_json: JSON.stringify({ type: "MultiPoint", coordinates: [] }) }),
      row(1, { entrances_json: null }),
      row(2, { geom_json: JSON.stringify({ type: "Point", coordinates: pair(0, 0) }) }),
      row(3, { geom_json: null }),
    ];
    const store = makeGarageStore({ $queryRaw: async <T>() => rows as T });
    const { garages } = await store.near({ ...at(0, 0), radiusM: 250, limit: 10 });
    expect(garages.map((g) => [g.id, g.entrances])).toEqual([
      ["bos-garage-000000", []],
      ["bos-garage-000001", []],
    ]);
  });

  test("byId answers the one row, or null", async () => {
    const found = makeGarageStore({ $queryRaw: async <T>() => [row(0)] as T });
    expect((await found.byId("bos-garage-000000"))?.name).toBe("Fixture Garage");
    const missing = makeGarageStore({ $queryRaw: async <T>() => [] as T });
    expect(await missing.byId("bos-nope-000000")).toBeNull();
  });
});
