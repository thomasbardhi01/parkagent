/**
 * Mint THROWAWAY users, each holding one real refresh session, for the live
 * FR suite (server/fr/). Every FR file runs as its own throwaway, so no
 * file reads or leaves state another depends on; the FR-32 tests also need
 * one to prove refresh rotation, reuse detection, and DELETE /me, which a
 * deployed API can't show without a session — and a session otherwise
 * needs a real Apple or email sign-in.
 *
 * This is deliberately NOT an API route. It needs the deployment's own
 * DATABASE_URL and AUTH_JWT_SECRET, so it only runs where those already
 * live — inside the app machine (`fly ssh console`) or on a laptop pointed
 * at a dev database. Nothing on the public surface can mint a session
 * without a verified identity.
 *
 * Usage:
 *   pnpm -C server create:fr-throwaway            # one, dev DB from repo .env
 *   pnpm -C server create:fr-throwaway --pool "$(node server/fr/pool.mjs)"
 *   fly ssh console -a parkagent-api -C "node dist/scripts/create-fr-throwaway.js --pool <labels>"
 *
 * Prints ONE line of JSON on stdout: {userId, deviceId, refreshToken,
 * accessToken} for one, or with `--pool a,b` a map of those by label —
 * export that as FR_THROWAWAY_POOL for `pnpm -C server test:fr`. Each file
 * deletes its users (DELETE /me) however its tests end, so every run needs
 * fresh ones. A user has no api key, no email, no vehicles, is named
 * "fr-throwaway <iso time>", and gets a marker decision — so a run that
 * dies before the delete leaves rows `pnpm -C server purge:fr-throwaways`
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
  const labels = poolLabels(process.argv.slice(2));
  if (typeof labels === "string") {
    console.error(labels);
    return 2;
  }
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
    const mint = async (label: string | null) => {
      const user = await prisma.user.create({
        data: { name: frThrowawayName(new Date()) },
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
          inputs: { via: "create-fr-throwaway", ...(label ? { label } : {}) },
          outcome: { ok: true },
          userId: user.id,
        },
      });
      console.error(`FR throwaway ${user.id}${label ? ` (${label})` : ""} minted.`);
      return {
        userId: user.id,
        deviceId,
        refreshToken: session.refreshToken,
        accessToken: session.accessToken,
      };
    };
    if (!labels) {
      console.log(JSON.stringify(await mint(null)));
      return 0;
    }
    const pool: Record<string, Awaited<ReturnType<typeof mint>>> = {};
    for (const label of labels) pool[label] = await mint(label);
    console.log(JSON.stringify(pool));
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

/** `--pool a,b,c` → the labels; absent → null (one user, the old shape). */
function poolLabels(argv: string[]): string[] | null | string {
  // pnpm forwards a literal "--" (the loader-args pitfall); drop it.
  const args = argv.filter((a) => a !== "--");
  if (args.length === 0) return null;
  if (args[0] !== "--pool" || args.length !== 2) return "usage: create-fr-throwaway [--pool a,b,c]";
  const labels = args[1]!.split(",").filter((l) => l !== "");
  // Labels name FR files; they ride a remote command line, so keep them plain.
  if (labels.length === 0 || labels.some((l) => !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(l))) {
    return "--pool needs comma-separated labels of [a-z0-9.-]";
  }
  if (new Set(labels).size !== labels.length) return "--pool labels must be distinct";
  return labels;
}

process.exitCode = await main();
