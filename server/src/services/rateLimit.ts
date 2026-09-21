/**
 * Tiny in-process sliding-window rate limiter — no dependency, no shared
 * store (one Fly machine, two users). Keyed by the authenticated user (so
 * it sits after auth), with a per-IP fallback for anything unauthenticated
 * that ever opts in. Exceeding the window answers
 * 429 {"error": "rate_limited"} with a Retry-After.
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  /** Window length, ms. */
  windowMs: number;
  now?: () => number;
}

export function makeRateLimiter(options: RateLimitOptions): preHandlerHookHandler {
  const { max, windowMs } = options;
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();

  // Bound the map: prune dead keys occasionally so a long-lived process
  // doesn't accumulate one entry per key forever.
  let pruneAt = 0;

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const at = now();
    if (at > pruneAt) {
      pruneAt = at + windowMs;
      for (const [key, times] of hits) {
        if (times.every((t) => at - t >= windowMs)) hits.delete(key);
      }
    }
    const key = req.authedUser?.id ?? req.ip;
    const times = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    if (times.length >= max) {
      const retryAfterS = Math.ceil((windowMs - (at - times[0]!)) / 1000);
      return reply
        .code(429)
        .header("Retry-After", String(Math.max(1, retryAfterS)))
        .send({ error: "rate_limited" });
    }
    times.push(at);
    hits.set(key, times);
  };
}
