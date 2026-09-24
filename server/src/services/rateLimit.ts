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
  /** Read the caller's IP from Fly's `Fly-Client-IP` header. Default: on
   * Fly (the platform sets FLY_APP_NAME), off elsewhere. */
  trustFlyClientIp?: boolean;
}

/**
 * Who an unauthenticated request is, for the per-IP buckets. Behind Fly's
 * proxy the socket peer is the PROXY: `req.ip` is the same few addresses
 * for every client, so "per IP" would mean one global bucket — ten email
 * codes per 15 minutes for the whole world, and one person could lock
 * everyone out of sign-in. Fly's edge sets Fly-Client-IP to the address it
 * accepted the connection from; that is trusted only when actually on Fly,
 * because anywhere else the header is whatever the caller typed.
 */
export function clientIp(req: FastifyRequest, trustFlyClientIp: boolean): string {
  if (trustFlyClientIp) {
    const fly = req.headers["fly-client-ip"];
    if (typeof fly === "string" && fly.length > 0) return fly;
  }
  return req.ip;
}

export function makeRateLimiter(options: RateLimitOptions): preHandlerHookHandler {
  const { max, windowMs } = options;
  const now = options.now ?? Date.now;
  const trustFly = options.trustFlyClientIp ?? Boolean(process.env["FLY_APP_NAME"]);
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
    const key = req.authedUser?.id ?? `ip:${clientIp(req, trustFly)}`;
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
