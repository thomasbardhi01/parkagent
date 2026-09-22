/**
 * Load imported ParkBoston zone numbers (data/out/parkboston_zone_numbers.json,
 * built by data/import_parkboston_zones.py from the Passport Find Parking
 * feed) into zone_number_imports, and apply them to the zones table.
 *
 * Usage:
 *   pnpm -C server load:zone-numbers
 *   pnpm -C server load:zone-numbers -- --file data/out/parkboston_zone_numbers.json
 *
 * Semantics:
 *   - zone_number_imports mirrors the file (stale rows deleted) — like
 *     zone_number_reports it has no FK to zones, so imports survive
 *     load:zones reloads and are rehydrated by that loader.
 *   - Precedence on the zones table: a VERIFIED user report (two users
 *     agree — the zone row's provider_zone_number_verified) is never
 *     overwritten; an import beats an empty number AND a single
 *     unverified report.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { config } from "dotenv";
import pg from "pg";

// Secrets live in the repo-root .env (see .env.example), not in server/.
const repoRoot = new URL("../../..", import.meta.url).pathname;
config({ path: resolve(repoRoot, ".env") });

interface ImportMatch {
  zone_id: string;
  number: string;
  confidence: number;
  method: string; // "rule" | "llm"
  name: string; // the provider's block name
}

interface ImportFile {
  built_at?: string;
  matches: ImportMatch[];
}

// 5 parameters per row; well under the protocol limit at 400 rows.
const CHUNK_SIZE = 400;

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      file: {
        type: "string",
        default: resolve(repoRoot, "data/out/parkboston_zone_numbers.json"),
      },
    },
  });

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }

  // Same resolution rule as load:zones: relative --file means repo-root.
  const fromRoot = resolve(repoRoot, flags.file);
  const filePath = existsSync(fromRoot) ? fromRoot : resolve(flags.file);
  console.log(`Reading ${filePath} ...`);
  const file = JSON.parse(readFileSync(filePath, "utf-8")) as ImportFile;
  // Real ParkBoston numbers run 1-5 digits (the 2026-09-22 sweep has zone
  // "1"); keep the ceiling loose and the floor honest.
  const matches = (file.matches ?? []).filter(
    (m) => m.zone_id && /^\d{1,10}$/.test(m.number ?? ""),
  );
  if (matches.length === 0) {
    console.error("No usable matches in the file; nothing loaded.");
    return 1;
  }
  const dropped = (file.matches?.length ?? 0) - matches.length;
  if (dropped > 0) console.log(`  dropped ${dropped} rows with missing/malformed numbers`);
  console.log(`${matches.length} imported zone numbers (built_at ${file.built_at ?? "?"})`);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");

    for (let start = 0; start < matches.length; start += CHUNK_SIZE) {
      const chunk = matches.slice(start, start + CHUNK_SIZE);
      const params: unknown[] = [];
      for (const m of chunk) {
        params.push(m.zone_id, m.number, m.confidence, m.method, m.name);
      }
      const rows = chunk
        .map((_, i) => {
          const p = (o: number) => `$${i * 5 + o}`;
          return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, now())`;
        })
        .join(", ");
      await client.query(
        `INSERT INTO zone_number_imports (zone_id, number, confidence, method, source_name, imported_at)
         VALUES ${rows}
         ON CONFLICT (zone_id) DO UPDATE SET
           number = EXCLUDED.number,
           confidence = EXCLUDED.confidence,
           method = EXCLUDED.method,
           source_name = EXCLUDED.source_name,
           imported_at = now()`,
        params,
      );
    }

    // The table mirrors the file: an import run that no longer claims a
    // zone withdraws its earlier claim.
    const stale = await client.query(
      "DELETE FROM zone_number_imports WHERE zone_id <> ALL($1::text[])",
      [matches.map((m) => m.zone_id)],
    );
    if ((stale.rowCount ?? 0) > 0) {
      console.log(`  deleted ${stale.rowCount} stale import rows`);
    }

    // Apply to zones with precedence: never touch a verified number; an
    // import overwrites empties and single unverified reports alike.
    const applied = await client.query(
      `UPDATE zones z
       SET provider_zone_number = i.number
       FROM zone_number_imports i
       WHERE z.zone_id = i.zone_id
         AND NOT z.provider_zone_number_verified
         AND z.provider_zone_number IS DISTINCT FROM i.number`,
    );
    const skippedVerified = await client.query(
      `SELECT COUNT(*)::int AS n FROM zones z
       JOIN zone_number_imports i ON i.zone_id = z.zone_id
       WHERE z.provider_zone_number_verified AND z.provider_zone_number <> i.number`,
    );
    const missing = await client.query(
      `SELECT COUNT(*)::int AS n FROM zone_number_imports i
       WHERE NOT EXISTS (SELECT 1 FROM zones z WHERE z.zone_id = i.zone_id)`,
    );

    await client.query("COMMIT");
    console.log(
      `Applied ${applied.rowCount} zone numbers ` +
        `(${skippedVerified.rows[0].n} kept their verified user-reported number, ` +
        `${missing.rows[0].n} import rows have no zone row loaded).`,
    );
    return 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

process.exitCode = await main();
