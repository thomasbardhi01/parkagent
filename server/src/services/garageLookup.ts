/**
 * Garage and lot footprints (FR-49): the outlines in the `garages` table,
 * the geometry over them, and the rule that says which one a point is in.
 *
 * The outlines come from OpenStreetMap (data/fetch_parking_footprints.py →
 * `pnpm -C server load:garages`). Street-side parking is a zone, never a
 * footprint: the builder skips it, the loader refuses it, and nothing here
 * returns a kind outside GARAGE_KINDS.
 *
 * The geometry is the phone's (ios Detection/FootprintIndex.swift):
 * equirectangular meters around the point being asked about, which is
 * exact enough for outlines a few hundred meters across, and means the
 * phone and the server agree about the same outline.
 */

export const GARAGE_KINDS = [
  "multi_storey",
  "underground",
  "surface",
  "rooftop",
  "unknown",
] as const;
export type GarageKind = (typeof GARAGE_KINDS)[number];

export function isGarageKind(kind: unknown): kind is GarageKind {
  return typeof kind === "string" && (GARAGE_KINDS as readonly string[]).includes(kind);
}

/** Kinds a car drives into: GPS fades inside, so the entrance is the evidence. */
const STRUCTURE_KINDS: readonly string[] = ["multi_storey", "underground", "rooftop"];

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GarageFootprint {
  /** "<city>-<slug>-<hash6>". */
  id: string;
  city: string;
  name: string | null;
  operator: string | null;
  /** One of GARAGE_KINDS; a string because it is whatever the row carries. */
  kind: string;
  /** OSM `fee`: true charges, false is free, null nobody tagged it. */
  fee: boolean | null;
  /** OSM `access` ("private", "customers", …); null when untagged. */
  access: string | null;
  capacity: number | null;
  website: string | null;
  /** The outer ring, GeoJSON [lng, lat] pairs, closed. */
  polygon: number[][];
  /** Rings cut out of the outline (a building in the middle of a lot). */
  holes: number[][][];
  /** Entrances, [lng, lat]: mapped ones, else the vertex nearest a road. */
  entrances: number[][];
  source: string;
  sourceVersion: string;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const M_PER_DEG = 111_320;

interface XY {
  x: number;
  y: number;
}

/** Meters east/north of `origin`; null for a pair that isn't coordinates. */
function project(pair: number[] | undefined, origin: LatLng): XY | null {
  const lng = pair?.[0];
  const lat = pair?.[1];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const kx = M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (lng - origin.lng) * kx, y: (lat - origin.lat) * M_PER_DEG };
}

function projectRing(ring: number[][], origin: LatLng): XY[] {
  return ring.flatMap((pair) => {
    const xy = project(pair, origin);
    return xy ? [xy] : [];
  });
}

/** Ray cast from the origin (the point itself) along +x. */
function ringContainsOrigin(ring: XY[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Meters from the origin to the ring's nearest side. */
function ringDistanceToOrigin(ring: XY[]): number {
  if (ring.length < 2) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

function ringAreaM2(ring: XY[]): number {
  if (ring.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

export interface FootprintMeasure {
  /** The point is inside the outline (and not in one of its holes). */
  containsPoint: boolean;
  /** Meters to the outline; 0 inside. */
  distanceM: number;
  /** Meters to the outline's nearest side, inside or out: how deep a
   * contained point is. A fix nearer the edge than its own accuracy may be
   * the street beside the garage. */
  edgeDistanceM: number;
  /** Meters to the nearest entrance; null when none is known. */
  nearestEntranceM: number | null;
}

/** Where `point` is relative to one garage's outline and entrances. */
export function describeFootprint(point: LatLng, garage: GarageFootprint): FootprintMeasure {
  const outer = projectRing(garage.polygon, point);
  const holes = garage.holes.map((ring) => projectRing(ring, point));
  const containsPoint =
    ringContainsOrigin(outer) && !holes.some((ring) => ringContainsOrigin(ring));
  const edgeDistanceM = Math.min(
    ringDistanceToOrigin(outer),
    ...holes.map((ring) => ringDistanceToOrigin(ring)),
  );
  let nearestEntranceM: number | null = null;
  for (const entrance of garage.entrances) {
    const xy = project(entrance, point);
    if (!xy) continue;
    const d = Math.hypot(xy.x, xy.y);
    if (nearestEntranceM === null || d < nearestEntranceM) nearestEntranceM = d;
  }
  return {
    containsPoint,
    distanceM: containsPoint ? 0 : edgeDistanceM,
    edgeDistanceM,
    nearestEntranceM,
  };
}

function outlineAreaM2(garage: GarageFootprint): number {
  const first = garage.polygon[0];
  const lng = first?.[0];
  const lat = first?.[1];
  if (typeof lng !== "number" || typeof lat !== "number") return 0;
  return ringAreaM2(projectRing(garage.polygon, { lat, lng }));
}

// ---------------------------------------------------------------------------
// classifyByFootprint
// ---------------------------------------------------------------------------

/** An entry fix this close to a structure's entrance drove into it. */
export const MIN_ENTRANCE_REACH_M = 40;
/** However bad the fix, a garage further than this is not "the" garage. */
export const MAX_ENTRANCE_REACH_M = 100;

/** max(40 m, the fix's accuracy), capped; an unreadable accuracy is 40 m. */
export function entranceReachM(accuracyM: number): number {
  if (!Number.isFinite(accuracyM)) return MIN_ENTRANCE_REACH_M;
  return Math.min(MAX_ENTRANCE_REACH_M, Math.max(MIN_ENTRANCE_REACH_M, accuracyM));
}

export interface FootprintMatch {
  /** The matched garage's kind; null when nothing matched. */
  kind: GarageKind | null;
  garageId: string | null;
  /** True when the point is inside the matched outline; false for an
   * entrance match and for no match. */
  containsPoint: boolean;
  /** Meters from the point to the matched garage's nearest entrance, to
   * 0.1 m; null when nothing matched or it has no entrance. */
  nearestEntranceM: number | null;
}

const NO_MATCH: FootprintMatch = {
  kind: null,
  garageId: null,
  containsPoint: false,
  nearestEntranceM: null,
};

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Code-unit order: the same on every machine, whatever its locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which garage or lot a point is in. Pure: the same point, accuracy, and
 * garages always give the same answer.
 *
 * 1. Containment wins: the outline the point is inside (of nested
 *    outlines, the smallest).
 * 2. Else the nearest entrance within max(40 m, accuracyM), capped at
 *    MAX_ENTRANCE_REACH_M — structures only. A car is in a surface lot
 *    when it is inside its outline; being near a lot's entrance is where a
 *    street park beside the lot is.
 *
 * Ties go to the smaller id. A garage whose kind isn't one of GARAGE_KINDS
 * is never returned.
 */
export function classifyByFootprint(
  point: LatLng,
  accuracyM: number,
  garages: readonly GarageFootprint[],
): FootprintMatch {
  const known = garages.filter((garage): garage is GarageFootprint & { kind: GarageKind } =>
    isGarageKind(garage.kind),
  );
  const measured = known.map((garage) => ({ garage, at: describeFootprint(point, garage) }));

  const containing = measured
    .filter((m) => m.at.containsPoint)
    .map((m) => ({ ...m, areaM2: outlineAreaM2(m.garage) }))
    .sort((a, b) => a.areaM2 - b.areaM2 || compareIds(a.garage.id, b.garage.id));
  const inside = containing[0];
  if (inside) {
    return {
      kind: inside.garage.kind,
      garageId: inside.garage.id,
      containsPoint: true,
      nearestEntranceM:
        inside.at.nearestEntranceM === null ? null : roundTenth(inside.at.nearestEntranceM),
    };
  }

  const reach = entranceReachM(accuracyM);
  const entered = measured
    .flatMap((m) =>
      STRUCTURE_KINDS.includes(m.garage.kind) &&
      m.at.nearestEntranceM !== null &&
      m.at.nearestEntranceM <= reach
        ? [{ garage: m.garage, entranceM: m.at.nearestEntranceM }]
        : [],
    )
    .sort((a, b) => a.entranceM - b.entranceM || compareIds(a.garage.id, b.garage.id));
  const nearest = entered[0];
  if (nearest) {
    return {
      kind: nearest.garage.kind,
      garageId: nearest.garage.id,
      containsPoint: false,
      nearestEntranceM: roundTenth(nearest.entranceM),
    };
  }
  return { ...NO_MATCH };
}

// ---------------------------------------------------------------------------
// The garages table
// ---------------------------------------------------------------------------

export interface GarageNearQuery extends LatLng {
  radiusM: number;
  /** At most this many garages, nearest first. */
  limit: number;
}

export interface NearbyGarages {
  garages: GarageFootprint[];
  /** More garages matched than `limit`. Decided on the raw rows, before
   * any that can't be drawn are dropped. */
  truncated: boolean;
}

export interface GarageStore {
  /** Garages whose outline comes within `radiusM` of the point, nearest first. */
  near(query: GarageNearQuery): Promise<NearbyGarages>;
  byId(id: string): Promise<GarageFootprint | null>;
}

interface RawQuerier {
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface GarageRow {
  id: string;
  city: string;
  name: string | null;
  operator: string | null;
  kind: string;
  fee: boolean | null;
  access: string | null;
  capacity: number | null;
  website: string | null;
  source: string;
  source_version: string;
  geom_json: string | null;
  entrances_json: string | null;
}

function parseGeometry(json: string | null): { type?: unknown; coordinates?: unknown } | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as { type?: unknown }) : null;
  } catch {
    return null;
  }
}

/** A row as a footprint; null when its outline can't be read. */
function footprintFromRow(row: GarageRow): GarageFootprint | null {
  const geom = parseGeometry(row.geom_json);
  if (geom?.type !== "Polygon" || !Array.isArray(geom.coordinates)) return null;
  const rings = geom.coordinates as number[][][];
  const outer = rings[0];
  if (!Array.isArray(outer) || outer.length < 4) return null;
  const points = parseGeometry(row.entrances_json);
  const entrances =
    points?.type === "MultiPoint" && Array.isArray(points.coordinates)
      ? (points.coordinates as number[][])
      : [];
  return {
    id: row.id,
    city: row.city,
    name: row.name,
    operator: row.operator,
    kind: row.kind,
    fee: row.fee,
    access: row.access,
    capacity: row.capacity,
    website: row.website,
    polygon: outer,
    holes: rings.slice(1),
    entrances,
    source: row.source,
    sourceVersion: row.source_version,
  };
}

/**
 * PostGIS-backed store. Same two-step filter as the zone lookup: the
 * geometry ST_DWithin is a cheap prefilter that can use the GiST index
 * (degrees, padded past the lng-degree shortfall at these latitudes), the
 * geography ST_DWithin is the exact meters test. Coordinates are written
 * to 7 places (about a centimeter), which keeps a cell of outlines small.
 */
export function makeGarageStore(db: RawQuerier): GarageStore {
  return {
    async near({ lat, lng, radiusM, limit }) {
      const radiusDeg = (radiusM / 111_320) * 1.6;
      const rows = await db.$queryRaw<GarageRow[]>`
        SELECT
          g.id, g.city, g.name, g.operator, g.kind, g.fee, g.access, g.capacity,
          g.website, g.source, g.source_version,
          ST_AsGeoJSON(g.geom, 7)      AS geom_json,
          ST_AsGeoJSON(g.entrances, 7) AS entrances_json
        FROM garages g,
             (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS g) pt
        WHERE ST_DWithin(g.geom, pt.g, ${radiusDeg})
          AND ST_DWithin(g.geom::geography, pt.g::geography, ${radiusM})
        ORDER BY ST_Distance(g.geom::geography, pt.g::geography), g.id
        LIMIT ${limit + 1}`;
      const truncated = rows.length > limit;
      const garages = rows.slice(0, limit).flatMap((row) => {
        const footprint = footprintFromRow(row);
        return footprint ? [footprint] : [];
      });
      return { garages, truncated };
    },
    async byId(id) {
      const rows = await db.$queryRaw<GarageRow[]>`
        SELECT
          g.id, g.city, g.name, g.operator, g.kind, g.fee, g.access, g.capacity,
          g.website, g.source, g.source_version,
          ST_AsGeoJSON(g.geom, 7)      AS geom_json,
          ST_AsGeoJSON(g.entrances, 7) AS entrances_json
        FROM garages g
        WHERE g.id = ${id}
        LIMIT 1`;
      const row = rows[0];
      return row ? footprintFromRow(row) : null;
    },
  };
}
