/**
 * Upsert data/out/zones.geojson into the zones table and record the run in
 * zone_loads.
 *
 * Lives in server/ rather than data/ so the loader and the Prisma schema it
 * targets change together in one package: data/ stays a pure fetch/build
 * pipeline with no database driver, and the pg dependency added here is the
 * same one Phase 3's Prisma adapter (@prisma/adapter-pg) runs on.
 *
 * Usage:
 *   pnpm -C server load:zones             # passenger zones only (default)
 *   pnpm -C server load:zones -- --all    # include commercial/charter-bus
 *   pnpm -C server load:zones -- --file path/to/zones.geojson
 *
 * Semantics: the table mirrors the load. Every selected feature is upserted
 * with the file's data_version, then rows still carrying any other version are
 * deleted — so re-running with a narrower selection (e.g. dropping --all)
 * intentionally removes the rows the selection no longer covers.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { config } from "dotenv";
import pg from "pg";

// Secrets live in the repo-root .env (see .env.example), not in server/.
const repoRoot = new URL("../../..", import.meta.url).pathname;
config({ path: resolve(repoRoot, ".env") });

interface ZoneProperties {
  zone_id: string;
  /** "nyc" | "bos"; the NYC builder predates the field, so it may be absent. */
  city?: string;
  /** NYC files use provider_zone_number; the Boston builder emits the generic
   * zone_number ("" when ParkBoston's number isn't in the source data). */
  provider_zone_number?: string;
  zone_number?: string;
  /** Boston builder emits the block's street; NYC files predate the field. */
  street?: string;
  vehicle_type: string;
  passenger: boolean;
  rate_first_hour: number;
  rate_additional_hour: number;
  max_stay_minutes: number | null;
  hours_json: unknown[];
  centerline: { type: string; coordinates: unknown };
}

interface ZoneFeature {
  type: "Feature";
  properties: ZoneProperties;
  geometry: { type: string; coordinates: unknown };
}

interface ZonesCollection {
  type: "FeatureCollection";
  metadata: {
    built_at: string;
    sources: Record<string, string>;
  };
  features: ZoneFeature[];
}

// 13 parameters per row; 400 rows = 5200 parameters, well under the
// Postgres protocol limit of 65535 and few enough round-trips over WAN.
const CHUNK_SIZE = 400;

const UPSERT_COLUMNS = `(zone_id, city, street, provider_zone_number, vehicle_type, passenger,
   rate_first_hour, rate_additional_hour, max_stay_minutes, hours_json,
   geom, centerline, data_version)`;

function rowPlaceholders(rowIndex: number): string {
  const p = (offset: number) => `$${rowIndex * 13 + offset}`;
  // ST_Multi lifts the occasional plain Polygon/LineString into the column's
  // Multi* type; SRID is pinned rather than trusting GeoJSON defaults.
  return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)},
    ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(${p(11)})), 4326),
    ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(${p(12)})), 4326), ${p(13)})`;
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      all: { type: "boolean", default: false },
      file: {
        type: "string",
        default: resolve(repoRoot, "data/out/zones.geojson"),
      },
    },
  });

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }

  console.log(`Reading ${flags.file} ...`);
  const collection = JSON.parse(readFileSync(flags.file, "utf-8")) as ZonesCollection;
  const dataVersion = collection.metadata?.built_at;
  if (!dataVersion) {
    console.error("zones.geojson has no metadata.built_at; rebuild it with data/build_zones.py.");
    return 1;
  }

  const selected = flags.all
    ? collection.features
    : collection.features.filter((f) => f.properties.passenger);
  // Loads are per-city: the stale-row mirror below must never let a Boston
  // load wipe the NYC rows (or vice versa), so a file spanning cities is
  // refused rather than half-mirrored.
  const cities = [...new Set(selected.map((f) => f.properties.city ?? "nyc"))];
  if (cities.length !== 1) {
    console.error(`zones file spans cities (${cities.join(", ")}); load them separately.`);
    return 1;
  }
  const city = cities[0]!;
  console.log(
    `${collection.features.length} features, loading ${selected.length}` +
      (flags.all ? " (all vehicle types)" : " (passenger only)"),
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");

    for (let start = 0; start < selected.length; start += CHUNK_SIZE) {
      const chunk = selected.slice(start, start + CHUNK_SIZE);
      const params: unknown[] = [];
      for (const feature of chunk) {
        const p = feature.properties;
        params.push(
          p.zone_id,
          city,
          p.street ?? null,
          p.provider_zone_number ?? p.zone_number ?? "",
          p.vehicle_type,
          p.passenger,
          p.rate_first_hour,
          p.rate_additional_hour,
          p.max_stay_minutes,
          JSON.stringify(p.hours_json),
          JSON.stringify(feature.geometry),
          JSON.stringify(p.centerline),
          dataVersion,
        );
      }
      await client.query(
        `INSERT INTO zones ${UPSERT_COLUMNS}
         VALUES ${chunk.map((_, i) => rowPlaceholders(i)).join(", ")}
         ON CONFLICT (zone_id) DO UPDATE SET
           city = EXCLUDED.city,
           street = EXCLUDED.street,
           -- Never let a source file without numbers (Boston) wipe a
           -- user-reported one; verified is deliberately untouched.
           provider_zone_number = CASE
             WHEN EXCLUDED.provider_zone_number = '' THEN zones.provider_zone_number
             ELSE EXCLUDED.provider_zone_number
           END,
           vehicle_type = EXCLUDED.vehicle_type,
           passenger = EXCLUDED.passenger,
           rate_first_hour = EXCLUDED.rate_first_hour,
           rate_additional_hour = EXCLUDED.rate_additional_hour,
           max_stay_minutes = EXCLUDED.max_stay_minutes,
           hours_json = EXCLUDED.hours_json,
           geom = EXCLUDED.geom,
           centerline = EXCLUDED.centerline,
           data_version = EXCLUDED.data_version,
           loaded_at = now()`,
        params,
      );
      console.log(`  upserted ${Math.min(start + CHUNK_SIZE, selected.length)}/${selected.length}`);
    }

    // Mirror within this city only; the other city's rows are untouched.
    const stale = await client.query("DELETE FROM zones WHERE city = $1 AND data_version <> $2", [
      city,
      dataVersion,
    ]);
    if ((stale.rowCount ?? 0) > 0) {
      console.log(`  deleted ${stale.rowCount} stale ${city} rows (other data_version)`);
    }

    // Rehydrate user-reported numbers onto rows the load re-created empty
    // (reports survive reloads on purpose — no FK to zones).
    const rehydrated = await client.query(
      `UPDATE zones z
       SET provider_zone_number = latest.number,
           provider_zone_number_verified = latest.verified
       FROM (
         SELECT DISTINCT ON (r.zone_id) r.zone_id, r.number,
           (SELECT COUNT(DISTINCT r2.user_id) FROM zone_number_reports r2
             WHERE r2.zone_id = r.zone_id AND r2.number = r.number) >= 2 AS verified
         FROM zone_number_reports r
         ORDER BY r.zone_id, r.created_at DESC
       ) latest
       WHERE z.zone_id = latest.zone_id AND z.provider_zone_number = ''`,
    );
    if ((rehydrated.rowCount ?? 0) > 0) {
      console.log(`  rehydrated ${rehydrated.rowCount} user-reported zone numbers`);
    }

    await client.query(
      `INSERT INTO zone_loads (city, data_version, source_datasets, zone_count, passenger_only)
       VALUES ($1, $2, $3, $4, $5)`,
      [city, dataVersion, JSON.stringify(collection.metadata.sources), selected.length, !flags.all],
    );

    await client.query("COMMIT");
    console.log(`Loaded ${selected.length} ${city} zones (data_version ${dataVersion}).`);
    return 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

process.exitCode = await main();
