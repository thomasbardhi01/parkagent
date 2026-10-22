/**
 * The shortest max stay the driver accepted for a park from a stricter
 * sign check (Issue N, routes/signs.ts), or null: what a session started
 * for that park is held to (routes/session.ts, services/pendingSession.ts).
 * Only ever tightens: see tightenedMaxStay (signRules.ts).
 */

import type { AppDb, SessionRow } from "../../db.js";
import { tightenedMaxStay } from "./signRules.js";

export async function acceptedSignStay(db: AppDb, parkedEventId: string): Promise<number | null> {
  const accepted = await db.signCheck.findMany({
    where: { parkedEventId, acceptedAt: { not: null } },
  });
  const offers = accepted.flatMap((c) =>
    c.offerMaxStayMinutes === null ? [] : [c.offerMaxStayMinutes],
  );
  return offers.length > 0 ? Math.min(...offers) : null;
}

/**
 * The session as the money gate judges an extension of it: held to the
 * shortest stay accepted for its park, never below what it has bought,
 * whatever its stored max stay says. Every extension is judged on this
 * (under the lock, in the worker's own arithmetic, and before the lock on
 * the manual route), so a hold that failed to write can't let a purchase
 * past the sign: the stored hold below is bookkeeping, for the row and the
 * app.
 */
export async function withAcceptedStay(db: AppDb, session: SessionRow): Promise<SessionRow> {
  if (!session.parkedEventId) return session;
  const accepted = await acceptedSignStay(db, session.parkedEventId);
  if (accepted === null) return session;
  const current = session.maxStayMinutes ?? null;
  const held = tightenedMaxStay(current, accepted, session.purchasedMinutes);
  return held === current ? session : { ...session, maxStayMinutes: held };
}

/** What a running session is held to after holdToAcceptedStay. */
export interface HeldStay {
  sessionId: string;
  /** The shortest stay accepted for its park. */
  acceptedMinutes: number;
  /** What the session's max stay was before this call. */
  previousMaxStayMinutes: number | null;
  /** What the session's max stay is now. */
  sessionMaxStayMinutes: number | null;
  /** What the session had bought: the floor. */
  paidMinutes: number;
  /** Whether this call changed it (down to the accepted stay, or up to
   * what was paid when a purchase landed after the accept). */
  tightened: boolean;
}

/** Misses of the compare-and-set before giving up: each one is another
 * write to the row (an extension's purchase), and extensions run one at a
 * time, so a second miss in a row is already unlikely. */
const HOLD_ATTEMPTS = 5;

/**
 * Hold an active session to the shortest stay accepted for its park, never
 * below the minutes it has bought (tightenedMaxStay). Three paths call it,
 * so an accept is never lost and never undercuts a purchase, whatever the
 * order:
 * - the accept, once its acceptedAt is written;
 * - the start, once its session is active (an accept made while the
 *   start was still pending found no active session);
 * - every extension, once it has bought (an accept read the row before
 *   the purchase landed).
 *
 * The write is a compare-and-set on the row it read (minutes bought and
 * max stay), re-read on a miss. One case still undercuts: an extension
 * already past the money gate when the accept writes, which then buys.
 * Its own call here finds the stay below what it paid, and raises it to
 * exactly that: no more time can be bought (the gate holds purchased +
 * more to the stay), and the row says what was paid. Null when nothing
 * was accepted for the park or the session isn't active; "missed" when
 * every attempt lost the compare-and-set (the gate still judges against
 * the accepted stay: withAcceptedStay).
 */
export async function holdToAcceptedStay(
  db: AppDb,
  sessionId: string,
): Promise<HeldStay | "missed" | null> {
  for (let attempt = 0; attempt < HOLD_ATTEMPTS; attempt += 1) {
    const session = await db.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== "active" || !session.parkedEventId) return null;
    const accepted = await acceptedSignStay(db, session.parkedEventId);
    if (accepted === null) return null;
    const current = session.maxStayMinutes ?? null;
    const held = Math.max(
      tightenedMaxStay(current, accepted, session.purchasedMinutes)!,
      session.purchasedMinutes,
    );
    const stay = {
      sessionId,
      acceptedMinutes: accepted,
      previousMaxStayMinutes: current,
      sessionMaxStayMinutes: held,
      paidMinutes: session.purchasedMinutes,
    };
    if (held === current) return { ...stay, tightened: false };
    const won = await db.session.updateMany({
      where: { id: sessionId, purchasedMinutes: session.purchasedMinutes, maxStayMinutes: current },
      data: { maxStayMinutes: held },
    });
    if (won.count > 0) return { ...stay, tightened: true };
  }
  return "missed";
}

/** What a hold's caller logs a failure through (Fastify's and the
 * workers' loggers both take a message). */
export interface HoldLog {
  warn: (msg: string) => void;
}

/** holdToAcceptedStay after a purchase (a start's or an extension's),
 * on the ledger when it changed the stay. The provider has already
 * charged, so it never throws: a failure is logged, the next purchase holds
 * it again, and the gate judges against the accepted stay meanwhile. */
export async function holdAcceptedAfter(
  deps: { db: AppDb },
  sessionId: string,
  userId: string,
  parkedEventId: string,
  trigger: "start" | "extend",
  log?: HoldLog,
): Promise<void> {
  try {
    const held = await holdToAcceptedStay(deps.db, sessionId);
    if (held === "missed") {
      log?.warn(`signs: session ${sessionId}'s accepted stay lost every write (${trigger})`);
    } else if (held?.tightened) {
      await recordHeldStay(deps.db, held, { userId, parkedEventId, trigger });
    }
  } catch (err) {
    log?.warn(
      `signs: couldn't hold session ${sessionId} to an accepted stay (${trigger}): ${String(err)}`,
    );
  }
}

/** The ledger row for a stay the start or an extension applied (the
 * accept writes its own, with its check). */
async function recordHeldStay(
  db: AppDb,
  held: HeldStay,
  where: { userId: string; parkedEventId: string; trigger: "start" | "extend" },
): Promise<void> {
  await db.decision.create({
    data: {
      kind: "sign_check",
      inputs: { sessionId: held.sessionId, parkedEventId: where.parkedEventId },
      rule: "accepted_shorter_stay",
      outcome: {
        maxStayMinutes: held.acceptedMinutes,
        tightenedSession: held.sessionId,
        previousMaxStayMinutes: held.previousMaxStayMinutes,
        sessionMaxStayMinutes: held.sessionMaxStayMinutes,
        paidMinutes: held.paidMinutes,
        appliedAt: where.trigger,
      },
      userId: where.userId,
      parkedEventId: where.parkedEventId,
      sessionId: held.sessionId,
    },
  });
}
