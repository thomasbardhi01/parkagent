/**
 * The external-agent surface (WS-4): `/agent/*`, reached only with an
 * agent key (`Authorization: Bearer pak_…`, resolved in makeAuthenticate)
 * and refused to a session or the admin key. Every route acts as the key's
 * principal — the person's own caps, consent and dry run, through the same
 * capabilities and the one money gate the app uses. 60 calls a minute per
 * key (in-memory, per machine).
 */

import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../app.js";
import { makeRateLimiter } from "../services/rateLimit.js";

export const AGENT_RATE_PER_MINUTE = 60;

export function registerAgent(app: FastifyInstance, deps: AppDeps): void {
  const limit = makeRateLimiter({
    max: AGENT_RATE_PER_MINUTE,
    windowMs: 60_000,
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  });

  /** Who the key acts for, what it may do, and whether the person has
   * said agents may act. */
  app.get("/agent/me", { preHandler: limit }, async (req) => {
    const principal = req.principal!;
    const user = await deps.db.user.findUnique({
      where: { id: principal.userId },
      select: { agentsMayAct: true },
    });
    return {
      userId: principal.userId,
      agentKeyId: principal.agentKeyId ?? null,
      scopes: [...principal.scopes].sort(),
      agentsMayAct: user?.agentsMayAct === true,
    };
  });
}
