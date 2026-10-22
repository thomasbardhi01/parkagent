/**
 * The path a request is routed by, never the raw `req.url`: the router
 * percent-decodes before it matches, so `/%61gent/me` reaches the
 * `/agent/me` handler, and a check that read the raw string would judge
 * something else. The auth hook's public paths and agent surfaces, and
 * idempotency's never-stored routes, all ask these.
 */

import type { FastifyRequest } from "fastify";

/** The concrete path, percent-decoded once (`/agent/plans/abc`). What a
 * stored idempotency key is scoped to: two plans' ids stay two paths. */
export function decodedPath(req: FastifyRequest): string {
  const raw = req.url.split("?")[0] ?? req.url;
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed encoding: no route matches it either; fail closed.
    return raw;
  }
}

/** The matched route's own pattern (`/agent/plans/:planId`) when the
 * router found one, else the decoded path: which surface, which public
 * path, which never-stored route. */
export function routePath(req: FastifyRequest): string {
  const matched = req.routeOptions?.url;
  return typeof matched === "string" && matched.length > 0 ? matched : decodedPath(req);
}
