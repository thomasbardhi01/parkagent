/**
 * Upsert a garage footprint file (data/out/<city>_garages.geojson, built by
 * data/fetch_parking_footprints.py) into the garages table.
 *
 * Usage:
 *   pnpm -C server load:garages                  # every data/out/*_garages.geojson
 *   pnpm -C server load:garages --file data/out/bos_garages.geojson
 *   pnpm -C server load:garages --file … --allow-shrink
 *
 * Semantics: the table mirrors the load, per city and per source. Every
 * feature is upserted; rows of the file's city and source whose id the
 * file no longer carries are deleted. Another city's rows, and rows from
 * another source, are never touched, so run it once per city.
 *
 * The file is checked whole before anything is written
 * (services/garage/footprintFile.ts): a problem refuses the load. So does
 * a file with under half the rows the city already has, unless
 * --allow-shrink says the drop is real.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { config } from "dotenv";
import pg from "pg";

import type { FootprintFile } from "../services/garage/footprintFile.js";
import { loadFootprintFile, readFootprintFile } from "../services/garage/footprintFile.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
const repoRoot = new URL("../../..", import.meta.url).pathname;
config({ path: resolve(repoRoot, ".env") });

/** Every built garage file, in name order, when no --file is given. */
function builtFiles(): string[] {
  const outDir = resolve(repoRoot, "data/out");
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.endsWith("_garages.geojson"))
    .sort()
    .map((name) => resolve(outDir, name));
}

async function loadFile(
  client: pg.Client,
  file: FootprintFile,
  allowShrink: boolean,
): Promise<number> {
  const { city, source, sourceVersion, rows } = file;
  const result = await loadFootprintFile(client, file, {
    allowShrink,
    log: (line) => console.log(line),
  });
  if (!result.ok) {
    console.error(`Refused: ${result.refusal}`);
    return 1;
  }

  const byKind = new Map<string, number>();
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  const kinds = [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  console.log(
    `Loaded ${rows.length} ${city} garages from ${source} (source_version ${sourceVersion}): ${kinds}.`,
  );
  return 0;
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      file: { type: "string" },
      "allow-shrink": { type: "boolean", default: false },
    },
  });

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }

  // A relative --file resolves against the REPO ROOT, like load:zones —
  // `pnpm -C server` runs with cwd server/.
  let paths: string[];
  if (flags.file) {
    const fromRoot = resolve(repoRoot, flags.file);
    paths = [existsSync(fromRoot) ? fromRoot : resolve(flags.file)];
  } else {
    paths = builtFiles();
    if (paths.length === 0) {
      console.error(
        "No data/out/*_garages.geojson to load; build one with " +
          "`uv run data/fetch_parking_footprints.py`, or pass --file.",
      );
      return 1;
    }
  }

  // Read and check every file before the first write.
  const files: FootprintFile[] = [];
  for (const path of paths) {
    console.log(`Reading ${path} ...`);
    const result = readFootprintFile(JSON.parse(readFileSync(path, "utf-8")));
    if (!result.ok) {
      console.error(`Refused ${path}:`);
      for (const problem of result.problems) console.error(`  ${problem}`);
      return 1;
    }
    files.push(result.file);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const code = await loadFile(client, file, flags["allow-shrink"]);
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    await client.end();
  }
}

process.exitCode = await main();
