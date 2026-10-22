/**
 * The shortest max stay the driver accepted for a park from a stricter
 * sign check (Issue N, routes/signs.ts), or null: what a session started
 * for that park is held to (routes/session.ts, services/pendingSession.ts).
 * Only ever tightens: see tightenedMaxStay (signRules.ts).
 */

import type { AppDb } from "../../db.js";

export async function acceptedSignStay(db: AppDb, parkedEventId: string): Promise<number | null> {
  const accepted = await db.signCheck.findMany({
    where: { parkedEventId, acceptedAt: { not: null } },
  });
  const offers = accepted.flatMap((c) =>
    c.offerMaxStayMinutes === null ? [] : [c.offerMaxStayMinutes],
  );
  return offers.length > 0 ? Math.min(...offers) : null;
}
