/**
 * The external-agent surface (WS-4): `/agent/*`, reached only with an
 * agent key (`Authorization: Bearer pak_…`, resolved in makeAuthenticate)
 * and refused to a session or the admin key. Every route acts as the key's
 * principal — the person's own caps, consent and dry run — through the
 * same capabilities and the one money gate the app uses. 60 calls a
 * minute per key (in-memory, per machine). The `read` scope searches and
 * plans; `confirm` confirms.
 *
 * Nothing here pays. A confirmed garage answers with its checkout link; a
 * confirmed street spot answers `pending_arrival`: consent and a cap for a
 * spot, never a park. Arrival comes only from the phone (D0 §4).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { SingleSpotPlan } from "../services/assistant/plans.js";
import { applyPatch, emptyState } from "../services/assistant/requestState.js";
import type { RequestState } from "../services/assistant/requestState.js";
import type { SearchResult } from "../services/assistant/search.js";
import { buildItinerary } from "../services/capabilities/buildItinerary.js";
import type { ConfirmRefusal } from "../services/capabilities/confirmPlan.js";
import { consumeConfirmation } from "../services/capabilities/confirmPlan.js";
import { geocodePlace } from "../services/capabilities/geocodePlace.js";
import { proposePlan } from "../services/capabilities/proposePlan.js";
import { quoteStreet, searchGarages } from "../services/capabilities/search.js";
import type { CapabilityDeps, TurnState } from "../services/capabilities/turn.js";
import { policyFor } from "../services/limits.js";
import type { MandateRefusal } from "../services/mandates.js";
import { mintMandate, planHashOf } from "../services/mandates.js";
import type { Principal, Scope } from "../services/principal.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import {
  agentRequestSchema,
  confirmSchema,
  geocodeSchema,
  itinerarySchema,
  planSchema,
  searchSchema,
} from "./agentSchemas.js";
import { agentOpenApi } from "./agentOpenApi.js";

export const AGENT_RATE_PER_MINUTE = 60;

/** How a mandate refusal answers over REST. */
const MANDATE_ERRORS: Record<MandateRefusal, { code: number; error: string }> = {
  not_valid: { code: 404, error: "mandate_not_found" },
  used: { code: 409, error: "mandate_used" },
  expired: { code: 410, error: "mandate_expired" },
  plan_changed: { code: 409, error: "plan_hash_mismatch" },
  scope: { code: 403, error: "scope_required" },
};

/** How a refused confirm answers over REST. */
function refusalAnswer(refusal: ConfirmRefusal): {
  code: number;
  error: string;
  extra: Record<string, unknown>;
} {
  switch (refusal.why) {
    case "consent":
      return { code: 403, error: refusal.rule, extra: {} };
    case "mandate":
      return { ...MANDATE_ERRORS[refusal.reason], extra: {} };
    case "different_option":
      return { code: 404, error: "mandate_not_found", extra: {} };
    case "nothing_to_confirm":
      return { code: 409, error: "nothing_to_confirm", extra: {} };
    case "dry_run_changed":
      return {
        code: 409,
        error: "dry_run_changed",
        extra: { shownDryRun: refusal.shown, dryRun: refusal.now },
      };
    case "over_cap":
      return { code: 409, error: "policy_violation", extra: { rule: refusal.rule } };
    case "amount_invalid":
      return { code: 409, error: "policy_violation", extra: { rule: "amount_invalid" } };
    case "option_expired":
      return { code: 409, error: "garage_option_expired", extra: {} };
  }
}

export function registerAgent(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();
  const limit = makeRateLimiter({
    max: AGENT_RATE_PER_MINUTE,
    windowMs: 60_000,
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  });
  const caps = (): CapabilityDeps | null => deps.assistantTools?.capabilityDeps ?? null;

  /** The scope a route needs, or a 403; and the capabilities, or a 503. */
  const guard = (req: FastifyRequest, reply: FastifyReply, scope: Scope) => {
    const principal = req.principal!;
    if (!principal.scopes.has(scope)) {
      void reply.code(403).send({ error: "scope_required", scope });
      return null;
    }
    const capabilityDeps = caps();
    if (!capabilityDeps) {
      void reply.code(503).send({ error: "agent_surface_unavailable" });
      return null;
    }
    return { principal, deps: capabilityDeps };
  };

  const parse = <T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400).send({ error: z.treeifyError(parsed.error) });
      return null;
    }
    return parsed.data;
  };

  /** One turn of capability state for one REST call: the request as the
   * agent asked for it, nothing remembered between calls. */
  const turnFor = (
    principal: Principal,
    request?: z.infer<typeof agentRequestSchema>,
  ): { ok: true; turn: TurnState } | { ok: false; issues: string[] } => {
    let state: RequestState = emptyState();
    if (request) {
      const applied = applyPatch(
        state,
        {
          placeQuery: request.place,
          ...(request.startsAt ? { startsAt: request.startsAt } : {}),
          durationMinutes: request.durationMinutes,
          ...(request.maxPriceUsd !== undefined ? { maxPriceUsd: request.maxPriceUsd } : {}),
          ...(request.maxWalkMinutes !== undefined
            ? { maxWalkMinutes: request.maxWalkMinutes }
            : {}),
          ...(request.kinds ? { kinds: request.kinds } : {}),
        },
        "",
        now(),
      );
      if (!applied.ok) {
        return {
          ok: false,
          issues:
            applied.error === "unreadable_time" ? ["startsAt: unreadable time"] : applied.fields,
        };
      }
      state = applied.state;
    }
    return {
      ok: true,
      turn: { conversationId: `agent:${principal.agentKeyId ?? "unknown"}`, requestState: state },
    };
  };

  app.get("/agent/openapi.json", async () => agentOpenApi());

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

  app.post("/agent/geocode", { preHandler: limit }, async (req, reply) => {
    const ok = guard(req, reply, "read");
    const body = ok && parse(geocodeSchema, req, reply);
    if (!ok || !body) return reply;
    const turn = turnFor(ok.principal);
    if (!turn.ok) return reply.code(400).send({ error: "invalid_request", issues: turn.issues });
    return (await geocodePlace(ok.deps, ok.principal, turn.turn, body)).result;
  });

  for (const [route, search] of [
    ["/agent/quote-street", quoteStreet],
    ["/agent/garages/search", searchGarages],
  ] as const) {
    app.post(route, { preHandler: limit }, async (req, reply) => {
      const ok = guard(req, reply, "read");
      const body = ok && parse(searchSchema, req, reply);
      if (!ok || !body) return reply;
      const turn = turnFor(ok.principal, body.request);
      if (!turn.ok) return reply.code(400).send({ error: "invalid_request", issues: turn.issues });
      return (await search(ok.deps, ok.principal, turn.turn, {})).result;
    });
  }

  app.post("/agent/itinerary", { preHandler: limit }, async (req, reply) => {
    const ok = guard(req, reply, "read");
    const body = ok && parse(itinerarySchema, req, reply);
    if (!ok || !body) return reply;
    const turn = turnFor(ok.principal);
    if (!turn.ok) return reply.code(400).send({ error: "invalid_request", issues: turn.issues });
    // Each stop's place is looked up here: the agent names places, never
    // coordinates.
    const stops: Record<string, unknown>[] = [];
    const closest: Record<string, unknown>[] = [];
    for (const [index, stop] of body.stops.entries()) {
      const looked = (await geocodePlace(ok.deps, ok.principal, turn.turn, { query: stop.place }))
        .result as {
        found?: boolean;
        ambiguous?: boolean;
        match?: string;
        instruction?: string;
        place?: { lat: number; lng: number };
      };
      if (!looked.found || looked.ambiguous || !looked.place) {
        return reply.code(422).send({ error: "place_not_found", stop: index, place: stop.place });
      }
      // The closest place, not the one named: said, as /agent/geocode says it.
      if (looked.match === "closest") {
        closest.push({ stop: index, place: looked.place, instruction: looked.instruction });
      }
      stops.push({
        label: stop.label ?? stop.place,
        lat: looked.place.lat,
        lng: looked.place.lng,
        arrival: stop.arrival,
        duration_minutes: stop.durationMinutes,
      });
    }
    const built = (await buildItinerary(ok.deps, ok.principal, turn.turn, { stops })).result;
    return closest.length > 0 && built && typeof built === "object"
      ? { ...(built as Record<string, unknown>), closestMatches: closest }
      : built;
  });

  /** Search a request and propose a plan: the options that meet it, by
   * the server's order, or the "no". A key with `confirm` gets the
   * mandate for the recommended option. */
  app.post("/agent/plans", { preHandler: limit }, async (req, reply) => {
    const ok = guard(req, reply, "read");
    const body = ok && parse(planSchema, req, reply);
    if (!ok || !body) return reply;
    const built = turnFor(ok.principal, body.request);
    if (!built.ok) return reply.code(400).send({ error: "invalid_request", issues: built.issues });
    const { turn } = built;
    const kinds = body.request.kinds ?? ["street", "garage"];
    for (const kind of kinds) {
      const search = kind === "street" ? quoteStreet : searchGarages;
      const out = await search(ok.deps, ok.principal, turn, {});
      if (out.endTurn) break;
      if (out.ask) {
        return reply.code(422).send({ error: "needs_more", question: out.ask.question });
      }
    }
    const last = turn.lastSearch as SearchResult | undefined;
    const planInput =
      last?.verdict === "meets"
        ? {
            kind: "single_spot",
            options: last.satisfying.slice(0, 3).map((o) => ({ id: o.id })),
          }
        : { kind: "none_meets" };
    const proposed = await proposePlan(ok.deps, ok.principal, turn, { plan: planInput });
    if (!proposed.endTurn) return reply.code(422).send(proposed.result);
    const { planId, plan } = proposed.endTurn;
    if (plan.kind !== "single_spot" || !ok.principal.scopes.has("confirm")) {
      return { planId, plan };
    }
    const option = (plan as SingleSpotPlan).options[0]!;
    const policy = await policyFor(ok.deps, ok.principal.userId);
    // The dry run the agent is shown rides on the mandate: a confirm or an
    // arrival under a different one is refused (dry_run_changed).
    const dryRun = deps.policy.effectiveDryRun();
    const { token, expiresAt } = await mintMandate(
      { db: deps.db, pepper: deps.apiKeyPepper },
      ok.principal,
      {
        planId,
        optionId: option.id,
        planHash: planHashOf(plan),
        scopes: ["confirm"],
        capsSnapshot: {
          sessionCapUsd: policy.session_cap_usd,
          dailyCapUsd: policy.daily_cap_usd,
          dryRun,
        },
      },
      now(),
    );
    return {
      planId,
      plan,
      confirmToken: token,
      optionId: option.id,
      expiresAt: expiresAt.toISOString(),
      dryRun,
    };
  });

  app.post("/agent/plans/:planId/confirm", { preHandler: limit }, async (req, reply) => {
    const ok = guard(req, reply, "confirm");
    const body = ok && parse(confirmSchema, req, reply);
    if (!ok || !body) return reply;
    const { planId } = req.params as { planId: string };
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
    // A street spot: consent and a cap for that spot, never a park here.
    // The phone reports where the car is (pendingSession.ts binds it).
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
    const row = await deps.db.pendingPark.findUnique({ where: { id: parkId } });
    if (!row || row.userId !== req.principal!.userId) {
      return reply.code(404).send({ error: "park_not_found" });
    }
    return {
      parkId: row.id,
      status: row.status,
      zoneId: row.zoneId,
      parkedAt: row.parkedAt.toISOString(),
      sessionId: row.sessionId,
    };
  });

  /** Why a decision came out as it did: Issue M's. Until it lands, 501. */
  app.get("/agent/decisions/:decisionId/why", { preHandler: limit }, async (_req, reply) =>
    reply.code(501).send({ error: "not_implemented", until: "Issue M (why explanations)" }),
  );
}
