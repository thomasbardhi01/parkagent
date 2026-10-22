/**
 * The external-agent surface (WS-4): `/agent/*`, reached only with an
 * agent key (`Authorization: Bearer pak_…`, resolved in makeAuthenticate)
 * and refused to a session or the admin key. Every route acts as the key's
 * principal — the person's own caps, consent and dry run — through the
 * same capabilities and the one money gate the app uses. 60 calls a
 * minute per key (in-memory, per machine), shared with `/mcp`. The `read`
 * scope searches and plans; `confirm` confirms.
 *
 * Nothing here pays. A confirmed garage answers with its checkout link; a
 * confirmed street spot answers `pending_arrival`: consent and a cap for a
 * spot, never a park. Arrival comes only from the phone (D0 §4). What each
 * call does is services/agentActions.ts, the same for MCP (routes/mcp.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { AgentActions, AgentAnswer } from "../services/agentActions.js";
import { agentActions } from "../services/agentActions.js";
import type { Scope } from "../services/principal.js";
import type { RateBuckets } from "../services/rateLimit.js";
import { makeRateBuckets, makeRateLimiter } from "../services/rateLimit.js";
import {
  confirmSchema,
  explainSchema,
  geocodeSchema,
  itinerarySchema,
  planSchema,
  searchSchema,
} from "./agentSchemas.js";
import { agentOpenApi } from "./agentOpenApi.js";

export const AGENT_RATE_PER_MINUTE = 60;

/** One budget per key across the agent surfaces: the REST routes' limiter
 * and the MCP tools take from the same buckets. */
export interface AgentLimit {
  buckets: RateBuckets;
  preHandler: preHandlerHookHandler;
}

export function makeAgentLimit(deps: AppDeps): AgentLimit {
  const options = {
    max: AGENT_RATE_PER_MINUTE,
    windowMs: 60_000,
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  };
  const buckets = makeRateBuckets(options);
  return { buckets, preHandler: makeRateLimiter(options, buckets) };
}

export function registerAgent(
  app: FastifyInstance,
  deps: AppDeps,
  agentLimit: AgentLimit = makeAgentLimit(deps),
  actions: AgentActions = agentActions(deps),
): void {
  const limit = agentLimit.preHandler;
  const send = (reply: FastifyReply, answer: AgentAnswer) =>
    reply.code(answer.status).send(answer.body);

  /** The scope first (a key without it is refused whatever it sent),
   * then the body. Null when the reply has been sent. */
  const take = <T>(
    schema: z.ZodType<T>,
    req: FastifyRequest,
    reply: FastifyReply,
    scope: Scope,
  ): T | null => {
    const refused = actions.refusal(req.principal!, scope);
    if (refused) {
      void send(reply, refused);
      return null;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400).send({ error: z.treeifyError(parsed.error) });
      return null;
    }
    return parsed.data;
  };

  app.get("/agent/openapi.json", async () => agentOpenApi());

  /** Who the key acts for, what it may do, and whether the person has
   * said agents may act. */
  app.get("/agent/me", { preHandler: limit }, async (req, reply) =>
    send(reply, await actions.me(req.principal!)),
  );

  app.post("/agent/geocode", { preHandler: limit }, async (req, reply) => {
    const body = take(geocodeSchema, req, reply, "read");
    return body ? send(reply, await actions.geocode(req.principal!, body)) : reply;
  });

  app.post("/agent/quote-street", { preHandler: limit }, async (req, reply) => {
    const body = take(searchSchema, req, reply, "read");
    return body ? send(reply, await actions.quoteStreet(req.principal!, body)) : reply;
  });

  app.post("/agent/garages/search", { preHandler: limit }, async (req, reply) => {
    const body = take(searchSchema, req, reply, "read");
    return body ? send(reply, await actions.searchGarages(req.principal!, body)) : reply;
  });

  app.post("/agent/itinerary", { preHandler: limit }, async (req, reply) => {
    const body = take(itinerarySchema, req, reply, "read");
    return body ? send(reply, await actions.itinerary(req.principal!, body)) : reply;
  });

  /** Search a request and propose a plan. A key with `confirm` gets the
   * mandate for the recommended option. */
  app.post("/agent/plans", { preHandler: limit }, async (req, reply) => {
    const body = take(planSchema, req, reply, "read");
    return body ? send(reply, await actions.plan(req.principal!, body)) : reply;
  });

  app.post("/agent/plans/:planId/confirm", { preHandler: limit }, async (req, reply) => {
    const body = take(confirmSchema, req, reply, "confirm");
    if (!body) return reply;
    const { planId } = req.params as { planId: string };
    return send(reply, await actions.confirm(req.principal!, planId, body.confirmToken));
  });

  app.get("/agent/plans/:planId", { preHandler: limit }, async (req, reply) => {
    const { planId } = req.params as { planId: string };
    return send(reply, await actions.getPlan(req.principal!, planId));
  });

  /** A park the phone reported, by id: its status only. */
  app.get("/agent/parks/:parkId", { preHandler: limit }, async (req, reply) => {
    const { parkId } = req.params as { parkId: string };
    return send(reply, await actions.getPark(req.principal!, parkId));
  });

  /** Why one of the person's decisions came out as it did (Issue M). */
  app.get("/agent/decisions/:decisionId/why", { preHandler: limit }, async (req, reply) => {
    const { decisionId } = req.params as { decisionId: string };
    // The scope first (actions.why refuses a key without it, whatever it
    // sent), then the id as MCP's explain_decision takes it: anything else
    // (a NUL is a Postgres error) is a 400, never a 500.
    const parsed = explainSchema.shape.decisionId.safeParse(decisionId);
    if (req.principal!.scopes.has("read") && !parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    return send(reply, await actions.why(req.principal!, decisionId));
  });
}
