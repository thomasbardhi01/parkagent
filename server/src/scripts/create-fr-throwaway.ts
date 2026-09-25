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
 * test:fr`. The suite deletes the user (DELETE /me) however its tests
 * end, and burns the refresh family on purpose, so every run needs a fresh
 * one. The user has no api key, no email, no vehicles, is named
 * "fr-throwaway <iso time>", and gets a marker decision — so a run that
 * dies before the delete leaves a row `pnpm -C server purge:fr-throwaways`
 * finds and tears down (the nightly runs it after every suite).
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { asAppDb, createPrisma } from "../db.js";
import { issueSession } from "../services/authService.js";
import { FR_THROWAWAY_MARKER, frThrowawayName } from "../services/frThrowaways.js";

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
      data: { name: frThrowawayName(now) },
    });
    const deviceId = `fr-throwaway-${randomUUID()}`;
    const session = await issueSession(
      { db: asAppDb(prisma), jwtSecret, now: () => new Date() },
      user,
      deviceId,
    );
    // The marker the purge selects on (purge-fr-throwaways.ts) — together
    // with the name above, it is what makes a row a throwaway.
    await prisma.decision.create({
      data: {
        ...FR_THROWAWAY_MARKER,
        inputs: { via: "create-fr-throwaway" },
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
