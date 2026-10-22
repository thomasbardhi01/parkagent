/**
 * The assistant's model spend: what a call is estimated to cost, and what
 * one person has spent today, which the daily cap
 * (ASSISTANT_DAILY_SPEND_CAP_USD) compares against. A leaf: the loop and
 * the explain capability both read it, and it imports neither.
 */

import type { AppDb } from "../../db.js";
import { nycStartOfDay } from "../hours.js";

/** Anthropic list prices per million tokens (checked 2026-09-24), most
 * specific first: a generation can reprice a family (Sonnet 5 is $2/$10,
 * Sonnet 4.x $3/$15). Unknown models estimate at the priciest tier so the
 * cap errs toward refusing. */
const MODEL_PRICES_PER_MTOK: { match: RegExp; inputUsd: number; outputUsd: number }[] = [
  { match: /haiku-5-5/, inputUsd: 0.1, outputUsd: 0.5 },
  { match: /haiku/, inputUsd: 1, outputUsd: 5 },
  { match: /sonnet-5/, inputUsd: 2, outputUsd: 10 },
  { match: /sonnet/, inputUsd: 3, outputUsd: 15 },
  { match: /opus-5-5/, inputUsd: 4, outputUsd: 20 },
  { match: /opus/, inputUsd: 5, outputUsd: 25 },
  { match: /fable|mythos/, inputUsd: 10, outputUsd: 50 },
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES_PER_MTOK.find((p) => p.match.test(model)) ?? {
    inputUsd: 10,
    outputUsd: 50,
  };
  const usd = (inputTokens * price.inputUsd + outputTokens * price.outputUsd) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/** Today's (ET) estimated assistant model spend for one user, from the
 * assistant_turn decision rows — what the daily cap compares against. */
export async function assistantSpendTodayUsd(db: AppDb, userId: string, at: Date): Promise<number> {
  const rows = await db.decision.findMany({
    // Midnight ET, the same day boundary the parking caps use.
    where: { userId, kind: "assistant_turn", createdAt: { gte: nycStartOfDay(at) } },
  });
  return rows
    .filter((r) => r.kind === "assistant_turn" && r.userId === userId)
    .reduce((sum, r) => {
      const outcome = r.outcome as { estimatedCostUsd?: number } | null;
      return sum + (typeof outcome?.estimatedCostUsd === "number" ? outcome.estimatedCostUsd : 0);
    }, 0);
}
