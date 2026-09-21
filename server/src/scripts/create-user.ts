/**
 * Create a user (and optionally a vehicle) and print the api key ONCE.
 *
 * Usage:
 *   pnpm -C server create:user -- --name Thomas
 *   pnpm -C server create:user -- --name Thomas --plate ABC1234 --state NY
 *
 * Only SHA-256(pepper:key) and an 8-char identification prefix are stored
 * (users.api_key_hash / api_key_prefix) — the plaintext appears exactly
 * once, on this terminal, and the app sends it as the x-api-key header.
 * Needs API_KEY_PEPPER in the environment (repo-root .env).
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config } from "dotenv";

import { createPrisma } from "../db.js";
import { apiKeyPrefix, generateApiKey, hashApiKey } from "../services/apiKeys.js";

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
  const pepper = process.env["API_KEY_PEPPER"];
  if (!pepper || pepper.length < 16) {
    console.error("API_KEY_PEPPER is not set (repo-root .env; openssl rand -base64 32).");
    return 1;
  }

  const prisma = createPrisma(databaseUrl);
  try {
    const apiKey = generateApiKey();
    const user = await prisma.user.create({
      data: {
        name: flags.name,
        apiKeyHash: hashApiKey(pepper, apiKey),
        apiKeyPrefix: apiKeyPrefix(apiKey),
      },
    });
    console.log(`user ${user.id} (${user.name})`);
    console.log(`api_key: ${apiKey}   <- shown once, never stored; put it in Config.xcconfig`);
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
