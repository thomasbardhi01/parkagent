/**
 * Tear down FR throwaway accounts a run left behind — the belt to the FR
 * suite's braces. The suite deletes its throwaway (DELETE /me) however its
 * tests end, but it can't when the run dies first or the account's tokens
 * are already dead; this finds those rows and runs the SAME teardown DELETE
 * /me runs (services/accountDeletion.ts). Nothing on the public API can do
 * this: like create-fr-throwaway, it runs only where the target's own
 * DATABASE_URL lives.
 *
 * Only rows create-fr-throwaway minted are ever selected (its marker
 * decision, its exact name, no identity, no api key, not admin — see
 * services/frThrowaways.ts), and a live one only once it is older than
 * --min-age-minutes, so a run in flight is never touched.
 *
 * Usage:
 *   pnpm -C server purge:fr-throwaways                       # dry run: prints the plan
 *   pnpm -C server purge:fr-throwaways -- --apply            # acts on it
 *   pnpm -C server purge:fr-throwaways -- --apply --min-age-minutes 60
 *   fly ssh console -a parkagent-api -C "node dist/scripts/purge-fr-throwaways.js --apply"
 *
 * --include <userId> (repeatable) exempts an id from the age gate — the
 * nightly passes the throwaway it minted minutes earlier.
 *
 * The last stdout line is one JSON summary; every purged account gets a
 * decisions row (the teardown's account_delete, with via).
 */

import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { asAppDb, createPrisma } from "../db.js";
import {
  applyThrowawayPurge,
  planThrowawayPurge,
  type ThrowawayVerdict,
} from "../services/frThrowaways.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const DEFAULT_MIN_AGE_MINUTES = 30;

interface Flags {
  apply: boolean;
  minAgeMinutes: number;
  include: string[];
}

function parseFlags(argv: string[]): Flags | string {
  // pnpm forwards a literal "--" (the loader-args pitfall); drop it.
  const args = argv.filter((a) => a !== "--");
  const flags: Flags = { apply: false, minAgeMinutes: DEFAULT_MIN_AGE_MINUTES, include: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--apply") {
      flags.apply = true;
    } else if (arg === "--min-age-minutes") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) return "--min-age-minutes needs a whole number";
      flags.minAgeMinutes = value;
    } else if (arg === "--include") {
      const id = args[++i];
      if (!id || !/^[a-z0-9]+$/i.test(id)) return "--include needs a user id";
      flags.include.push(id);
    } else {
      return `unknown argument: ${arg}`;
    }
  }
  return flags;
}

function describe(v: ThrowawayVerdict): string {
  const age = v.createdAt ? v.createdAt.toISOString() : "no row";
  const reason = v.reason ? ` (${v.reason})` : "";
  return `${v.action.padEnd(15)} ${v.userId}  created ${age}  refresh tokens ${v.refreshTokens}${reason}`;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (typeof flags === "string") {
    console.error(flags);
    return 2;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env, or run inside the app machine).");
    return 1;
  }

  const prisma = createPrisma(databaseUrl);
  try {
    const db = asAppDb(prisma);
    const now = new Date();
    const plan = await planThrowawayPurge(db, {
      now,
      minAgeMinutes: flags.minAgeMinutes,
      include: flags.include,
    });
    for (const verdict of plan) console.log(describe(verdict));
    const count = (action: ThrowawayVerdict["action"]) =>
      plan.filter((v) => v.action === action).length;

    let deleted = 0;
    let sessionsCleared = 0;
    if (flags.apply) {
      const result = await applyThrowawayPurge(
        { db, now: () => new Date() },
        plan,
        "purge-fr-throwaways",
      );
      deleted = result.deleted.length;
      sessionsCleared = result.sessionsCleared.length;
    } else if (count("delete") + count("clear_sessions") > 0) {
      console.error("Dry run — nothing changed. Re-run with --apply to act on the plan above.");
    }
    console.log(
      JSON.stringify({
        purge: {
          applied: flags.apply,
          minAgeMinutes: flags.minAgeMinutes,
          found: plan.length,
          toDelete: count("delete"),
          toClearSessions: count("clear_sessions"),
          deleted,
          sessionsCleared,
          clean: count("clean"),
          tooFresh: count("too_fresh"),
          needsManual: count("needs_manual"),
          notAThrowaway: count("not_a_throwaway"),
        },
      }),
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
