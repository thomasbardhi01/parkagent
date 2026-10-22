/**
 * Write one park's trace as an anonymized fixture (services/parkTrace.ts):
 * coordinates in metres from the car, times in seconds from the park, the
 * wall-clock start as a weekday and a New York time, and no user id.
 *
 * Usage:
 *   pnpm -C server trace:export <parkId> [--name red-light] [--out server/test/traces/red-light.json]
 *
 * <parkId> is the pending_parks id or the park's parkedEventId. Without
 * --out the fixture goes to stdout. Add `expected` (what the replay must
 * end with) by hand, from `pnpm -C server trace:replay <fixture>`; see
 * docs/park-traces.md.
 *
 * Reads DATABASE_URL from the repo-root .env (dev/Neon). To read prod,
 * export DATABASE_URL pointed at the fly proxy first (see server/README.md);
 * an exported variable wins over .env.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { asAppDb, createPrisma } from "../db.js";
import { buildParkTrace, traceToFixture } from "../services/parkTrace.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main(): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    options: { name: { type: "string" }, out: { type: "string" } },
    allowPositionals: true,
  });
  const parkId = positionals[0];
  if (!parkId) {
    console.error("usage: pnpm -C server trace:export <parkId> [--name <name>] [--out <file>]");
    return 2;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env, or export it)");
    return 2;
  }
  const prisma = createPrisma(databaseUrl);
  try {
    const trace = await buildParkTrace(asAppDb(prisma), parkId);
    if (!trace) {
      console.error(`no park ${parkId}`);
      return 1;
    }
    const fixture = traceToFixture(trace, flags.name ?? "unnamed-park");
    const json = `${JSON.stringify(fixture, null, 2)}\n`;
    if (flags.out) {
      writeFileSync(flags.out, json);
      console.error(
        `wrote ${flags.out}: ${fixture.fixes.length} fixes, ${fixture.taps.length} taps`,
      );
    } else {
      process.stdout.write(json);
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
