/**
 * "Does this user have a session awaiting payment right now?" — the
 * question the issuing webhook asks before approving an authorization.
 * True when the user has a pending or active session that started (or,
 * while still pending, was created) within the last 10 minutes — the
 * window in which the executor's ParkNYC charge should arrive.
 */

import type { AppDb } from "../db.js";

export type PendingSessionCheck = (userId: string, at: Date) => Promise<boolean>;

export const PENDING_SESSION_WINDOW_MINUTES = 10;

export function makePendingSessionCheck(db: AppDb): PendingSessionCheck {
  return async (userId, at) => {
    const cutoff = new Date(at.getTime() - PENDING_SESSION_WINDOW_MINUTES * 60_000);
    const rows = await db.session.findMany({
      where: { userId, status: { in: ["pending", "active"] } },
    });
    return rows.some((s) => (s.startedAt ?? s.createdAt) >= cutoff);
  };
}

/** Conservative fallback when no check is wired: nothing is ever pending. */
export const noPendingSessions: PendingSessionCheck = async () => false;
