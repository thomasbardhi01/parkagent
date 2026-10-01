/**
 * Reading a garage footprint file (data/out/<city>_garages.geojson, built
 * by data/fetch_parking_footprints.py) into rows for the `garages` table.
 *
 * The loader (scripts/load-garages.ts) is the last check before the
 * database, so the file is validated whole and refused whole: one city per
 * file, ids of the documented shape and unique, known kinds only
 * (street-side parking is a zone, never a garage), closed polygons of real
 * coordinates, and a website only when it is http(s) — the app may open it.
 */

import { isGarageKind } from "../garageLookup.js";

export interface GarageFileRow {
  id: string;
  city: string;
  name: string | null;
  operator: string | null;
  kind: string;
  fee: boolean | null;
  access: string | null;
  capacity: number | null;
  website: string | null;
  /** GeoJSON Polygon, as text for ST_GeomFromGeoJSON. */
  geomJson: string;
  /** GeoJSON MultiPoint (possibly empty), as text. */
  entrancesJson: string;
}

export interface FootprintFile {
  city: string;
  /** Where the outlines come from ("osm"). */
  source: string;
  /** The source's own version: for OSM, the snapshot time the data was read at. */
  sourceVersion: string;
  rows: GarageFileRow[];
}

export type FootprintFileResult =
  { ok: true; file: FootprintFile } | { ok: false; problems: string[] };

const CITY = /^[a-z]{2,8}$/;
const MAX_ID_LENGTH = 100;
const MAX_TEXT_LENGTH = 200;
const MAX_WEBSITE_LENGTH = 500;
const MAX_CAPACITY = 100_000;
const MAX_ENTRANCES = 64;
/** How many problems a refusal lists before it stops and counts. */
const MAX_PROBLEMS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [lng, lat] = value as unknown[];
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

function isClosedRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4) return false;
  if (!value.every(isPosition)) return false;
  const first = value[0] as number[];
  const last = value[value.length - 1] as number[];
  return first[0] === last[0] && first[1] === last[1];
}

function isPolygon(value: unknown): boolean {
  if (!isRecord(value) || value["type"] !== "Polygon") return false;
  const rings = value["coordinates"];
  return Array.isArray(rings) && rings.length >= 1 && rings.every(isClosedRing);
}

function isMultiPoint(value: unknown): boolean {
  if (!isRecord(value) || value["type"] !== "MultiPoint") return false;
  const points = value["coordinates"];
  return Array.isArray(points) && points.length <= MAX_ENTRANCES && points.every(isPosition);
}

function isHttpUrl(value: string): boolean {
  if (value.length > MAX_WEBSITE_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
}

/** null, or a non-empty string no longer than the cap. */
function isOptionalText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH)
  );
}

function featureProblems(
  feature: unknown,
  city: string,
  idPattern: RegExp,
): { row?: GarageFileRow; why: string[] } {
  if (!isRecord(feature) || !isRecord(feature["properties"])) {
    return { why: ["not a feature with properties"] };
  }
  const p = feature["properties"];
  const why: string[] = [];

  const id = p["garage_id"];
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH || !idPattern.test(id)) {
    why.push(`garage_id is not "${city}-<slug>-<hash6>"`);
  }
  if (p["city"] !== city) why.push(`city is not the file's city (${city})`);
  if (!isGarageKind(p["kind"])) {
    why.push(`kind ${JSON.stringify(p["kind"] ?? null)} is not a garage kind`);
  }
  for (const field of ["name", "operator", "access"] as const) {
    if (!isOptionalText(p[field] ?? null)) {
      why.push(`${field} is not text of 1 to ${MAX_TEXT_LENGTH} characters, or null`);
    }
  }
  const fee = p["fee"] ?? null;
  if (fee !== null && typeof fee !== "boolean") why.push("fee is not true, false, or null");
  const capacity = p["capacity"] ?? null;
  if (
    capacity !== null &&
    (typeof capacity !== "number" ||
      !Number.isInteger(capacity) ||
      capacity < 0 ||
      capacity > MAX_CAPACITY)
  ) {
    why.push("capacity is not a whole number of spaces, or null");
  }
  const website = p["website"] ?? null;
  if (website !== null && (typeof website !== "string" || !isHttpUrl(website))) {
    why.push("website is not an http(s) URL, or null");
  }
  if (!isPolygon(feature["geometry"])) why.push("geometry is not a closed Polygon");
  if (!isMultiPoint(p["entrances"])) why.push("entrances is not a MultiPoint");

  if (why.length > 0) return { why };
  return {
    why,
    row: {
      id: id as string,
      city,
      name: (p["name"] ?? null) as string | null,
      operator: (p["operator"] ?? null) as string | null,
      kind: p["kind"] as string,
      fee: fee as boolean | null,
      access: (p["access"] ?? null) as string | null,
      capacity: capacity as number | null,
      website: website as string | null,
      geomJson: JSON.stringify(feature["geometry"]),
      entrancesJson: JSON.stringify(p["entrances"]),
    },
  };
}

/** The parsed GeoJSON as rows, or every reason (up to a few) it was refused. */
export function readFootprintFile(collection: unknown): FootprintFileResult {
  if (!isRecord(collection) || !isRecord(collection["metadata"])) {
    return { ok: false, problems: ["the file has no metadata; rebuild it with the data script"] };
  }
  const metadata = collection["metadata"];
  const problems: string[] = [];
  const city = metadata["city"];
  if (typeof city !== "string" || !CITY.test(city)) {
    problems.push("metadata.city is not a city key");
  }
  const source = metadata["source"];
  if (typeof source !== "string" || source === "") {
    problems.push("metadata.source is missing");
  }
  const sourceVersion = metadata["source_version"];
  if (typeof sourceVersion !== "string" || sourceVersion === "") {
    problems.push("metadata.source_version is missing");
  }
  const features = collection["features"];
  if (!Array.isArray(features) || features.length === 0) {
    problems.push("the file has no features");
  }
  if (problems.length > 0) return { ok: false, problems };

  // "<city>-<slug>-<hash6>"; the hash runs longer where six collided.
  const idPattern = new RegExp(`^${city as string}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6,12}$`);
  const rows: GarageFileRow[] = [];
  const seen = new Set<string>();
  let hidden = 0;
  const report = (problem: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
    else hidden += 1;
  };
  (features as unknown[]).forEach((feature, index) => {
    const { row, why } = featureProblems(feature, city as string, idPattern);
    for (const reason of why) report(`feature ${index}: ${reason}`);
    if (!row) return;
    if (seen.has(row.id)) {
      report(`feature ${index}: duplicate garage_id ${row.id}`);
      return;
    }
    seen.add(row.id);
    rows.push(row);
  });
  if (problems.length > 0) {
    if (hidden > 0) problems.push(`… and ${hidden} more`);
    return { ok: false, problems };
  }
  return {
    ok: true,
    file: {
      city: city as string,
      source: source as string,
      sourceVersion: sourceVersion as string,
      rows,
    },
  };
}

/** A load may not drop a city below this share of the rows it has. */
const MIN_KEPT_SHARE = 0.5;

/**
 * Why a load that mirrors the file would be refused, or null. The table
 * mirrors each load, so a file cut short (a failed fetch, a wrong
 * bounding box) would delete most of a city's garages; under half is
 * refused unless the operator says so.
 */
export function shrinkProblem(existingRows: number, incomingRows: number): string | null {
  if (existingRows === 0 || incomingRows >= existingRows * MIN_KEPT_SHARE) return null;
  return (
    `the file has ${incomingRows} garages and the table has ${existingRows} for this city and ` +
    "source; loading it would delete most of them. Pass --allow-shrink if that is intended."
  );
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

/** The slice of a pg client the load uses; tests script it. */
export interface LoadClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export type LoadResult =
  { ok: true; upserted: number; deleted: number } | { ok: false; refusal: string };

// 13 parameters per row; 400 rows = 5200 parameters, well under the
// Postgres protocol limit of 65535 and few enough round-trips over WAN.
const CHUNK_SIZE = 400;
const PARAMS_PER_ROW = 13;

const UPSERT_COLUMNS = `(id, city, name, operator, kind, fee, access, capacity, website,
   geom, entrances, source, source_version)`;

function rowPlaceholders(rowIndex: number): string {
  const p = (offset: number) => `$${rowIndex * PARAMS_PER_ROW + offset}`;
  // SRID is pinned rather than trusting GeoJSON defaults. An empty
  // MultiPoint (no known entrance) stays an empty MultiPoint.
  return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)},
    ST_SetSRID(ST_GeomFromGeoJSON(${p(10)}), 4326),
    ST_SetSRID(ST_GeomFromGeoJSON(${p(11)}), 4326), ${p(12)}, ${p(13)})`;
}

function countOf(result: { rows: Record<string, unknown>[] }): number {
  return Number(result.rows[0]?.["count"] ?? 0);
}

/**
 * Mirror one file into the garages table, in one transaction: upsert every
 * row, then delete the rows of the file's city AND source whose id the
 * file no longer carries. Another city's rows, and another source's, are
 * never written or deleted — every statement here is scoped to both.
 *
 * Refused (nothing written) when the file would drop the city below half
 * its rows without `allowShrink`. Throws (rolled back) when an id in the
 * file is already another city's or source's, or an outline isn't valid.
 */
export async function loadFootprintFile(
  client: LoadClient,
  file: FootprintFile,
  options: { allowShrink?: boolean; log?: (line: string) => void } = {},
): Promise<LoadResult> {
  const { city, source, sourceVersion, rows } = file;
  const log = options.log ?? (() => {});
  await client.query("BEGIN");
  try {
    const existing = countOf(
      await client.query("SELECT COUNT(*) AS count FROM garages WHERE city = $1 AND source = $2", [
        city,
        source,
      ]),
    );
    const refusal = options.allowShrink ? null : shrinkProblem(existing, rows.length);
    if (refusal) {
      await client.query("ROLLBACK");
      return { ok: false, refusal };
    }

    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      const chunk = rows.slice(start, start + CHUNK_SIZE);
      const params: unknown[] = [];
      for (const row of chunk) {
        params.push(
          row.id,
          city,
          row.name,
          row.operator,
          row.kind,
          row.fee,
          row.access,
          row.capacity,
          row.website,
          row.geomJson,
          row.entrancesJson,
          source,
          sourceVersion,
        );
      }
      await client.query(
        `INSERT INTO garages ${UPSERT_COLUMNS}
         VALUES ${chunk.map((_, i) => rowPlaceholders(i)).join(", ")}
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           operator = EXCLUDED.operator,
           kind = EXCLUDED.kind,
           fee = EXCLUDED.fee,
           access = EXCLUDED.access,
           capacity = EXCLUDED.capacity,
           website = EXCLUDED.website,
           geom = EXCLUDED.geom,
           entrances = EXCLUDED.entrances,
           source_version = EXCLUDED.source_version,
           updated_at = now()
         -- An id is one city's and one source's: a file can't take over
         -- another's row by reusing its id.
         WHERE garages.city = EXCLUDED.city AND garages.source = EXCLUDED.source`,
        params,
      );
      log(`  upserted ${Math.min(start + CHUNK_SIZE, rows.length)}/${rows.length}`);
    }

    // Every row of the file is now in the table under this city and source;
    // one that isn't was refused by the WHERE above (an id held elsewhere).
    const ids = rows.map((row) => row.id);
    const landed = countOf(
      await client.query(
        "SELECT COUNT(*) AS count FROM garages WHERE city = $1 AND source = $2 AND id = ANY($3::text[])",
        [city, source, ids],
      ),
    );
    if (landed !== rows.length) {
      throw new Error(
        `${rows.length - landed} ids in the file already belong to another city or source; ` +
          "nothing was loaded",
      );
    }

    // Mirror within this city and source only.
    const stale = await client.query(
      "DELETE FROM garages WHERE city = $1 AND source = $2 AND NOT (id = ANY($3::text[]))",
      [city, source, ids],
    );
    const deleted = stale.rowCount ?? 0;
    if (deleted > 0) log(`  deleted ${deleted} ${city} rows the file no longer carries`);

    // The lookups assume valid outlines; the builder repairs them, and
    // this is the proof before the load commits.
    const invalid = countOf(
      await client.query(
        "SELECT COUNT(*) AS count FROM garages WHERE city = $1 AND source = $2 AND NOT ST_IsValid(geom)",
        [city, source],
      ),
    );
    if (invalid > 0) {
      throw new Error(`${invalid} outlines are not valid polygons; nothing was loaded`);
    }

    await client.query("COMMIT");
    return { ok: true, upserted: rows.length, deleted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
