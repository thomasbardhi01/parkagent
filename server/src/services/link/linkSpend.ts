/**
 * Link's share of the daily cap. The cap is "whatever pays": street
 * sessions are counted from their own rows, and garages paid with Link are
 * counted from their spend requests — a request becomes a spendable
 * one-time card the moment the user approves it, so an approval is spend
 * whether or not the card has been used yet.
 */

import type { AppDb } from "../../db.js";

/** Approved in Link (or already charged): committed spend. */
export const LINK_COMMITTED_STATUSES: readonly string[] = ["approved", "succeeded"];

/** Made but not yet approved: spend if the user approves in Link's window. */
export const LINK_PENDING_STATUSES: readonly string[] = [
  "created",
  "pending_approval",
  "requires_action",
];

const round2 = (usd: number) => Math.round(usd * 100) / 100;

/** The total of a user's spend requests made since `since` whose status is
 * one of `statuses`. */
export async function linkSpentSince(
  db: AppDb,
  userId: string,
  since: Date,
  statuses: readonly string[],
): Promise<number> {
  const rows = await db.linkSpendRequest.findMany({ where: { userId } });
  return round2(
    rows
      .filter((r) => r.createdAt >= since && statuses.includes(r.status))
      .reduce((sum, r) => sum + Number(r.amountUsd), 0),
  );
}
