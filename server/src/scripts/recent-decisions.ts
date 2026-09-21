/**
 * Print the last 20 decisions — the table the dry-run week lives in.
 *
 * Usage:
 *   pnpm -C server decisions:recent [-- --user <name-or-id>] [--city nyc|bos] [--limit 50]
 *
 * --user matches the users row by id or (case-insensitive) name; --city
 * keeps decisions attributable to that city (via the quoted zone, the
 * session's stored city, or the first candidate).
 *
 * Reads DATABASE_URL from the repo-root .env (dev/Neon). To read prod,
 * export DATABASE_URL pointed at the fly proxy first (see server/README.md);
 * an exported variable wins over .env.
 */

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { createPrisma } from "../db.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

interface DecisionOutcome {
  action?: string;
  quote?: {
    zoneId?: string;
    stayMinutes?: number;
    totalUsd?: number;
  } | null;
  candidates?: { city?: string }[];
  /** Shadow mode's parallel test authorization (see services/shadow.ts). */
  shadow?: {
    fired?: boolean;
    authorizationId?: string;
    approved?: boolean;
    reason?: string;
  };
}

/** "shadow:approved iauth_…" / "shadow:declined …" / "shadow:missed(no_card)". */
function shadowSummary(shadow: NonNullable<DecisionOutcome["shadow"]>): string {
  if (!shadow.fired) return `shadow:missed(${shadow.reason ?? "?"})`;
  const verdict = shadow.approved ? "approved" : "declined";
  return `shadow:${verdict} ${shadow.authorizationId ?? ""}`.trim();
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      user: { type: "string" },
      city: { type: "string" },
      limit: { type: "string", default: "20" },
    },
  });
  const limit = Math.max(1, Number(flags.limit) || 20);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }
  const prisma = createPrisma(databaseUrl);
  try {
    let userId: string | undefined;
    if (flags.user) {
      const users = await prisma.user.findMany({ select: { id: true, name: true } });
      const match = users.find(
        (u: { id: string; name: string }) =>
          u.id === flags.user || u.name.toLowerCase() === flags.user!.toLowerCase(),
      );
      if (!match) {
        console.error(`No user matches "${flags.user}" (by id or name).`);
        return 1;
      }
      userId = match.id;
    }

    const rows = await prisma.decision.findMany({
      ...(userId ? { where: { userId } } : {}),
      orderBy: { createdAt: "desc" },
      // City is attributed client-side; over-fetch so a filtered view
      // still shows `limit` rows when possible.
      take: flags.city ? limit * 10 : limit,
    });

    // Which city a decision belongs to: the quoted zone's prefix, the
    // session's stored city, or the first candidate's city.
    const sessionIds = [
      ...new Set(rows.map((r) => r.sessionId).filter((id): id is string => id !== null)),
    ];
    const sessions =
      flags.city && sessionIds.length > 0
        ? await prisma.session.findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, city: true },
          })
        : [];
    const sessionCity = new Map(
      sessions.map((s: { id: string; city: string }) => [s.id, s.city]),
    );
    const cityOf = (row: (typeof rows)[number]): string | null => {
      if (row.sessionId && sessionCity.has(row.sessionId)) {
        return sessionCity.get(row.sessionId) ?? null;
      }
      const outcome = row.outcome as DecisionOutcome;
      const zoneId = outcome.quote?.zoneId;
      if (zoneId) return zoneId.split("-")[0] ?? null;
      return outcome.candidates?.[0]?.city ?? null;
    };

    const filtered = (
      flags.city ? rows.filter((row) => cityOf(row) === flags.city) : rows
    ).slice(0, limit);
    if (filtered.length === 0) {
      console.log("No decisions match.");
      return 0;
    }
    for (const row of filtered) {
      const outcome = row.outcome as DecisionOutcome;
      const action = outcome.action ?? "-";
      const zone = outcome.quote?.zoneId ?? "-";
      const total =
        outcome.quote?.totalUsd !== undefined ? `$${outcome.quote.totalUsd.toFixed(2)}` : "-";
      const stay =
        outcome.quote?.stayMinutes !== undefined ? `${outcome.quote.stayMinutes}min` : "";
      console.log(
        [
          row.createdAt.toISOString(),
          row.rule.padEnd(22),
          action.padEnd(12),
          zone.padEnd(12),
          `${total} ${stay}`.trim(),
          ...(outcome.shadow ? [shadowSummary(outcome.shadow)] : []),
        ].join("  "),
      );
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
