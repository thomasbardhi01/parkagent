/**
 * Print the last 20 decisions — the table the dry-run week lives in.
 *
 * Usage:
 *   pnpm -C server decisions:recent
 *
 * Reads DATABASE_URL from the repo-root .env (dev/Neon). To read prod,
 * export DATABASE_URL pointed at the fly proxy first (see server/README.md);
 * an exported variable wins over .env.
 */

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
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }
  const prisma = createPrisma(databaseUrl);
  try {
    const rows = await prisma.decision.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    if (rows.length === 0) {
      console.log("No decisions yet.");
      return 0;
    }
    for (const row of rows) {
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
