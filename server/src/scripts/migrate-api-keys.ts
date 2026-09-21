/**
 * One-time: convert plaintext users.api_key rows to hashed-at-rest form —
 * api_key_hash = SHA-256(pepper:key), api_key_prefix = first 8 chars —
 * and NULL the plaintext. Idempotent: already-migrated rows are skipped.
 *
 *   pnpm -C server migrate:api-keys
 *
 * Needs API_KEY_PEPPER (repo-root .env; prod: run through the fly proxy
 * with DATABASE_URL exported and the SAME pepper the server has as a Fly
 * secret — a mismatched pepper writes hashes no login will ever match).
 * The phones keep their existing keys; nothing changes client-side.
 */

import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { createPrisma } from "../db.js";
import { apiKeyPrefix, hashApiKey } from "../services/apiKeys.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main(): Promise<number> {
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
    const users = await prisma.user.findMany({
      select: { id: true, name: true, apiKey: true, apiKeyHash: true },
    });
    let migrated = 0;
    for (const user of users) {
      if (user.apiKey === null) {
        console.log(`  ${user.id} (${user.name}): already migrated`);
        continue;
      }
      if (user.apiKeyHash !== null) {
        // Hash exists but plaintext lingers (interrupted run) — just wipe.
        await prisma.user.update({ where: { id: user.id }, data: { apiKey: null } });
        console.log(`  ${user.id} (${user.name}): cleared leftover plaintext`);
        continue;
      }
      await prisma.user.update({
        where: { id: user.id },
        data: {
          apiKeyHash: hashApiKey(pepper, user.apiKey),
          apiKeyPrefix: apiKeyPrefix(user.apiKey),
          apiKey: null,
        },
      });
      migrated += 1;
      console.log(`  ${user.id} (${user.name}): hashed, plaintext cleared`);
    }
    console.log(`${migrated} key(s) migrated, ${users.length} user(s) total.`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
