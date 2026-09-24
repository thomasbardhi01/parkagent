/**
 * Mint a THROWAWAY user holding one real refresh session, for the FR-32
 * live tests (server/fr/60-accounts.fr.test.ts). Refresh rotation, reuse
 * detection, and DELETE /me can't be proven against a deployed API without
 * a session, and a session otherwise needs a real Apple or email sign-in.
 *
 * This is deliberately NOT an API route. It needs the deployment's own
 * DATABASE_URL and AUTH_JWT_SECRET, so it only runs where those already
 * live — inside the app machine (`fly ssh console`) or on a laptop pointed
 * at a dev database. Nothing on the public surface can mint a session
 * without a verified identity.
 *
 * Usage:
 *   pnpm -C server create:fr-throwaway            # dev DB from repo .env
 *   fly ssh console -a parkagent-api -C "node dist/scripts/create-fr-throwaway.js"
 *
 * Prints ONE line of JSON — {userId, deviceId, refreshToken, accessToken}
 * — on stdout; export it as FR_THROWAWAY_SESSION for `pnpm -C server
 * test:fr`. The suite deletes the user (DELETE /me) and burns the refresh
 * family on purpose, so every run needs a fresh one. The user has no api
 * key, no email, no vehicles, and is named "fr-throwaway <iso time>", so a
 * run that dies before the delete leaves a findable, credential-less row
 * whose refresh token expires on its own in 60 days.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { asAppDb, createPrisma } from "../db.js";
import { issueSession } from "../services/authService.js";

// quiet: stdout is the one JSON line a caller parses.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

async function main(): Promise<number> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env, or run inside the app machine).");
    return 1;
  }
  const jwtSecret = process.env["AUTH_JWT_SECRET"];
  if (!jwtSecret || jwtSecret.length < 32) {
    console.error(
      "AUTH_JWT_SECRET is not set — it must be the TARGET API's secret, or its tokens won't verify.",
    );
    return 1;
  }

  const prisma = createPrisma(databaseUrl);
  try {
    const now = new Date();
    const user = await prisma.user.create({
      data: { name: `fr-throwaway ${now.toISOString()}` },
    });
    const deviceId = `fr-throwaway-${randomUUID()}`;
    const session = await issueSession(
      { db: asAppDb(prisma), jwtSecret, now: () => new Date() },
      user,
      deviceId,
    );
    await prisma.decision.create({
      data: {
        kind: "auth_identity",
        inputs: { via: "create-fr-throwaway" },
        rule: "fr_throwaway_minted",
        outcome: { ok: true },
        userId: user.id,
      },
    });
    console.error(`FR throwaway ${user.id} minted; the FR-32 suite deletes it.`);
    console.log(
      JSON.stringify({
        userId: user.id,
        deviceId,
        refreshToken: session.refreshToken,
        accessToken: session.accessToken,
      }),
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
