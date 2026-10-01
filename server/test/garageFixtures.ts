/**
 * Garage and lot outlines for the footprint tests, laid out in meters
 * around one origin so a test can say "an entrance 60 m east" and mean it.
 */

import type { GarageFootprint, LatLng } from "../src/services/garageLookup.js";

/** Back Bay, where the meters-per-degree figures below hold. */
export const ORIGIN: LatLng = { lat: 42.35, lng: -71.07 };

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** The point `eastM` east and `northM` north of the origin. */
export function at(eastM: number, northM: number): LatLng {
  return { lat: ORIGIN.lat + northM / M_PER_DEG_LAT, lng: ORIGIN.lng + eastM / M_PER_DEG_LNG };
}

/** The same point as a GeoJSON [lng, lat] pair. */
export function pair(eastM: number, northM: number): number[] {
  const p = at(eastM, northM);
  return [p.lng, p.lat];
}

/** A closed square ring, `halfM` from its center to each side. */
export function square(centerEastM: number, centerNorthM: number, halfM: number): number[][] {
  return [
    pair(centerEastM - halfM, centerNorthM - halfM),
    pair(centerEastM + halfM, centerNorthM - halfM),
    pair(centerEastM + halfM, centerNorthM + halfM),
    pair(centerEastM - halfM, centerNorthM + halfM),
    pair(centerEastM - halfM, centerNorthM - halfM),
  ];
}

export function garage(overrides: Partial<GarageFootprint> & { id: string }): GarageFootprint {
  return {
    city: "bos",
    name: null,
    operator: null,
    kind: "multi_storey",
    fee: null,
    access: null,
    capacity: null,
    website: null,
    polygon: square(0, 0, 30),
    holes: [],
    entrances: [],
    source: "osm",
    sourceVersion: "2026-09-30T12:00:00Z",
    ...overrides,
  };
}
