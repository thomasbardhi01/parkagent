/**
 * Create the DEDICATED functional-requirements test user and print its api
 * key ONCE. The FR suite (server/fr/, docs/functional-requirements.md)
 * must always run as this user — never as a person's key: it writes
 * parked_events/decisions rows and registers device tokens under whoever
 * the key identifies.
 *
 * Usage (against the database the target API uses — prod for the nightly):
 *   pnpm -C server create:fr-user
 *   pnpm -C server create:fr-user -- --name fr-staging --no-admin
 *
 * Admin is ON by default so the suite can exercise GET /admin/summary and
 * POST /admin/push-test (both read-only-ish; the suite never calls
 * PUT /policy). Pass --no-admin to create a plain user — the admin FR
 * tests then self-skip on the 403.
 *
 * Put the printed key in the repo's Actions secret FR_API_KEY.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config } from "dotenv";

import { createPrisma } from "../db.js";
import { apiKeyPrefix, generateApiKey, hashApiKey } from "../services/apiKeys.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main(): Promise<number> {
  // pnpm forwards a literal "--" (the loader-args pitfall); drop it so
  // flags after it still parse.
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values: flags } = parseArgs({
    args,
    options: {
      name: { type: "string", default: "fr-nightly" },
      "no-admin": { type: "boolean", default: false },
    },
  });
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
    const isAdmin = !flags["no-admin"];
    const apiKey = generateApiKey();
    const user = await prisma.user.create({
      data: {
        name: flags.name!,
        apiKeyHash: hashApiKey(pepper, apiKey),
        apiKeyPrefix: apiKeyPrefix(apiKey),
        isAdmin,
      },
    });
    console.log(`FR user ${user.id} (${user.name})${isAdmin ? " [admin]" : ""}`);
    console.log(`api_key: ${apiKey}   <- shown once, never stored`);
    console.log("Store it as the GitHub Actions secret FR_API_KEY (never in the repo).");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
