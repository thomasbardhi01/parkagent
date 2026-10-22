/**
 * The ids a request path carries (#281), parsed before anything reads the
 * database. A NUL byte in one is a Postgres error (22021, invalid UTF-8),
 * not a not-found, so it answered 500; a malformed id now answers 400, in
 * the shape every router answers bad input with. An id that is well formed
 * but not the caller's still answers as a missing one does.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

const ID_CHARS = /^[A-Za-z0-9_-]+$/;

/** One of our rows' ids: a cuid, a UUID, `conv_<uuid>`. */
export const recordId = z.string().min(1).max(64).regex(ID_CHARS);

/** An id a data script builds from a name (a zone's, a garage's: a
 * street name has no length limit) or another service mints (Stripe's):
 * the same characters, up to Fastify's own maxParamLength (100), past
 * which Fastify answers 414 before any of this runs. */
export const externalId = z.string().min(1).max(100).regex(ID_CHARS);

type IdShape = Record<string, z.ZodString>;

/** The path's ids by their schemas; null once the 400 has been sent. */
export function pathIds<S extends IdShape>(
  req: FastifyRequest,
  reply: FastifyReply,
  shape: S,
): { [K in keyof S]: string } | null {
  const parsed = z.object(shape).safeParse(req.params);
  if (!parsed.success) {
    void reply.code(400).send({ error: z.treeifyError(parsed.error) });
    return null;
  }
  return parsed.data as { [K in keyof S]: string };
}

/** pathIds as a route's preHandler. */
export function idParams(shape: IdShape): preHandlerHookHandler {
  return async (req, reply) => {
    if (!pathIds(req, reply, shape)) return reply;
  };
}

/** The `:id` / `:…Id` params that are someone else's ids, by route.
 * Every other one is one of our rows' (recordId). */
const EXTERNAL_IDS: Record<string, string> = {
  "/zones/:zoneId/provider-number": "zoneId",
  "/link/spend-requests/:id/sync": "id",
  "/link/spend-requests/:id/card": "id",
};

/** Routes that parse their ids themselves, before the database:
 * `/agent/*` in the handler, after the key's scope (a key without the
 * scope is refused whatever it sent); a garage's by its own stricter
 * pattern, a malformed one answering garage_not_found (FR-49). */
const OWN_PARSE = (url: string) => url.startsWith("/agent/") || url === "/garages/:id";

/** What a route's path ids are parsed with; null for a route with none,
 * or one that parses its own. */
export function idShapeFor(url: string): IdShape | null {
  if (OWN_PARSE(url)) return null;
  const shape: IdShape = {};
  for (const [, name] of url.matchAll(/:([A-Za-z]+)/g)) {
    if (name === undefined || (name !== "id" && !name.endsWith("Id"))) continue;
    shape[name] = EXTERNAL_IDS[url] === name ? externalId : recordId;
  }
  return Object.keys(shape).length > 0 ? shape : null;
}

/** Every route registered after this parses its path ids before its
 * handler, after its own preHandlers (the rate limiter): default-on, like
 * auth, so a new `:…Id` route can't forget. */
export function registerIdParams(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    const shape = idShapeFor(route.url);
    if (!shape) return;
    const own = route.preHandler === undefined ? [] : [route.preHandler].flat();
    route.preHandler = [...own, idParams(shape)];
  });
}
