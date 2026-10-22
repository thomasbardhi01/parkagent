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
    const at = now();
    const { principal } = ok;
    const decide = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: {
          kind: "agent_confirm",
          inputs: { planId },
          rule,
          outcome,
          userId: principal.userId,
        },
      });
    const markConfirmed = (optionId: string) =>
      deps.db.assistantPlan.update({
        where: { id: planId },
        data: { confirmedAt: at, confirmedOptionId: optionId },
      });
    // The one confirm sequence the app's tap runs too (confirmPlan.ts):
    // consent first, then the mandate, the plan unchanged, the dry run as
    // shown, the caps now, a garage still bookable; only then the claim.
    const turn = turnFor(principal);
    if (!turn.ok) return reply.code(400).send({ error: "invalid_request", issues: turn.issues });
    const confirmed = await consumeConfirmation(ok.deps, principal, turn.turn, body.confirmToken, {
      tool: "agent_confirm",
      planId,
    });
    if (!confirmed.ok) {
      const { code, error, extra } = refusalAnswer(confirmed.refusal);
      const decision = await decide(error, { allowed: false, ...extra });
      return reply.code(code).send({ error, ...extra, decisionId: decision.id });
    }
    const { option, dryRun } = confirmed;
    if (option.type === "garage") {
      // Bookable a moment ago (the sequence checked); a provider that
      // still fails here leaves the mandate spent, and says so.
      let booking: Awaited<ReturnType<typeof ok.deps.garage.book>>;
      try {
        booking = await ok.deps.garage.book(option.garageOptionId ?? option.id);
      } catch (err) {
        const detail = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
        const decision = await decide("garage_book_failed", { allowed: true, detail });
        return reply
          .code(409)
          .send({ error: "garage_book_failed", detail, decisionId: decision.id });
      }
      await markConfirmed(option.id);
      const decision = await decide("garage_handoff", {
        allowed: true,
        optionId: option.id,
        provider: booking.option.provider,
        priceUsd: booking.option.priceUsd,
        dryRun,
      });
      return {
        status: "garage_handoff",
        deepLink: booking.deepLink ?? null,
        priceUsd: booking.option.priceUsd,
        dryRun,
        decisionId: decision.id,
      };
    }
    // A street spot: no park here; the phone reports where the car is. But
    // this is the person's tap given ahead: the phone's next park at that
    // spot, in the window, is held confirmed and pays on left_car with no
    // prompt (agentBindingFor in pendingSession.ts, E3).
    await markConfirmed(option.id);
    const decision = await decide("pending_arrival", {
      allowed: true,
      optionId: option.id,
      zoneId: option.zoneId ?? null,
      priceUsd: option.priceUsd,
      dryRun,
    });
    return {
      status: "pending_arrival",
      zoneId: option.zoneId ?? null,
      durationMinutes: option.durationMinutes,
      priceUsd: option.priceUsd,
      dryRun,
      expiresAt: confirmed.expiresAt.toISOString(),
      decisionId: decision.id,
    };
  });

  app.get("/agent/plans/:planId", { preHandler: limit }, async (req, reply) => {
    const { planId } = req.params as { planId: string };
    return send(reply, await actions.getPlan(req.principal!, planId));
    const row = await deps.db.assistantPlan.findUnique({ where: { id: planId } });
    if (!row || row.userId !== req.principal!.userId) {
      return reply.code(404).send({ error: "plan_not_found" });
    }
    return {
      planId: row.id,
      kind: row.kind,
      // proposed → confirmed (the agent's confirm) → bound (the phone
      // reported the car at its spot, inside the mandate's window: E3).
      status: row.boundParkedEventId ? "bound" : row.confirmedAt ? "confirmed" : "proposed",
      plan: row.plan,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      confirmedOptionId: row.confirmedOptionId ?? null,
      boundAt: row.boundAt?.toISOString() ?? null,
    };
  });

  /** A park the phone reported, by id: its status only. */
  app.get("/agent/parks/:parkId", { preHandler: limit }, async (req, reply) => {
    const { parkId } = req.params as { parkId: string };
    return send(reply, await actions.getPark(req.principal!, parkId));
  });

  /** Why a decision came out as it did: Issue M's. Until it lands, 501. */
  app.get("/agent/decisions/:decisionId/why", { preHandler: limit }, async (_req, reply) =>
    reply.code(501).send({ error: "not_implemented", until: "Issue M (why explanations)" }),
  );
}
