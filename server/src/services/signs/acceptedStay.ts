/**
 * The shortest max stay the driver accepted for a park from a stricter
 * sign check (Issue N, routes/signs.ts), or null: what a session started
 * for that park is held to (routes/session.ts, services/pendingSession.ts).
 * Only ever tightens: see tightenedMaxStay (signRules.ts).
 */

import type { AppDb } from "../../db.js";
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

/** What a running session is held to after holdToAcceptedStay. */
export interface HeldStay {
  sessionId: string;
  /** The shortest stay accepted for its park. */
  acceptedMinutes: number;
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
 * was accepted for the park, the session isn't active, or every attempt
 * missed.
 */
export async function holdToAcceptedStay(db: AppDb, sessionId: string): Promise<HeldStay | null> {
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
  return null;
}

/** holdToAcceptedStay after a purchase (a start's or an extension's),
 * on the ledger when it tightened. The provider has already charged, so it
 * never throws: a failure is logged, and the next purchase holds it again. */
export async function holdAcceptedAfter(
  deps: { db: AppDb },
  sessionId: string,
  userId: string,
  parkedEventId: string,
  trigger: "start" | "extend",
  log?: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    const held = await holdToAcceptedStay(deps.db, sessionId);
    if (held?.tightened) await recordHeldStay(deps.db, held, { userId, parkedEventId, trigger });
  } catch (err) {
    log?.warn({ err, sessionId, trigger }, "signs: couldn't hold the session to an accepted stay");
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
