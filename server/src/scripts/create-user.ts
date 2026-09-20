/**
 * Create a user (and optionally a vehicle) and print the api_key once.
 *
 * Usage:
 *   pnpm -C server create:user -- --name Thomas
 *   pnpm -C server create:user -- --name Thomas --plate ABC1234 --state NY
 *
 * The key is shown only here; it is stored in users.api_key and sent by the
 * app as the x-api-key header.
 */

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config } from "dotenv";

import { createPrisma } from "../db.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      name: { type: "string" },
      plate: { type: "string" },
      state: { type: "string", default: "NY" },
    },
  });
  if (!flags.name) {
    console.error(
      "Usage: pnpm -C server create:user -- --name <name> [--plate <plate> --state <state>]",
    );
    return 1;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }

  const prisma = createPrisma(databaseUrl);
  try {
    const apiKey = randomBytes(24).toString("base64url");
    const user = await prisma.user.create({
      data: { name: flags.name, apiKey },
    });
    console.log(`user ${user.id} (${user.name})`);
    console.log(`api_key: ${apiKey}`);
    if (flags.plate) {
      const vehicle = await prisma.vehicle.create({
        data: { userId: user.id, plate: flags.plate, state: flags.state },
      });
      console.log(`vehicle ${vehicle.id} (${vehicle.plate} ${vehicle.state})`);
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
