/**
 * What each external-agent call does, once, for every agent surface: the
 * REST routes (`/agent/*`, routes/agent.ts) and the MCP tools (`/mcp`,
 * routes/mcp.ts) are two ways in to these functions, so a refusal carries
 * the same code and a confirm the same answer on both.
 *
 * Every function acts as the principal it is handed (the key's, resolved
 * once in makeAuthenticate), through the same capabilities and the one
 * money gate the app uses. A confirm runs the one confirm sequence the
 * app's tap runs too (`consumeConfirmation`, capabilities/confirmPlan.ts).
 * Nothing here pays. A confirmed garage answers with its checkout link; a
 * confirmed street spot answers `pending_arrival`: consent and a cap for a
 * spot, never a park. Arrival comes only from the phone (D0 §4).
 */

import type { z } from "zod";

import type { AppDeps } from "../app.js";
import type {
  agentRequestSchema,
  geocodeSchema,
  itinerarySchema,
  planSchema,
  searchSchema,
} from "../routes/agentSchemas.js";
import type { SingleSpotPlan } from "./assistant/plans.js";
import { applyPatch, emptyState } from "./assistant/requestState.js";
import type { RequestState } from "./assistant/requestState.js";
import type { SearchResult } from "./assistant/search.js";
import { buildItinerary } from "./capabilities/buildItinerary.js";
import type { ConfirmRefusal } from "./capabilities/confirmPlan.js";
import { consumeConfirmation } from "./capabilities/confirmPlan.js";
import { geocodePlace } from "./capabilities/geocodePlace.js";
import { proposePlan } from "./capabilities/proposePlan.js";
import { quoteStreet, searchGarages } from "./capabilities/search.js";
import type { CapabilityDeps, TurnState } from "./capabilities/turn.js";
import { policyFor } from "./limits.js";
import type { MandateRefusal } from "./mandates.js";
import { mintMandate, planHashOf } from "./mandates.js";
import type { Principal, Scope } from "./principal.js";

/** One call's answer: the REST status and body. 200 is a result; anything
 * else is a refusal whose body carries `error`, the code agents act on. */
export interface AgentAnswer {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown>): AgentAnswer => ({ status: 200, body });
const no = (status: number, body: Record<string, unknown>): AgentAnswer => ({ status, body });

/** How a mandate refusal answers. */
const MANDATE_ERRORS: Record<MandateRefusal, { code: number; error: string }> = {
  not_valid: { code: 404, error: "mandate_not_found" },
  used: { code: 409, error: "mandate_used" },
  expired: { code: 410, error: "mandate_expired" },
  plan_changed: { code: 409, error: "plan_hash_mismatch" },
  scope: { code: 403, error: "scope_required" },
};

/** How a refused confirm answers. */
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

export type AgentActions = ReturnType<typeof agentActions>;

export function agentActions(deps: AppDeps) {
  const now = () => deps.now?.() ?? new Date();

  /** The scope a call needs, and the capabilities; or the refusal. */
  const guard = (
    principal: Principal,
    scope: Scope,
  ): { deps: CapabilityDeps } | { refused: AgentAnswer } => {
    if (!principal.scopes.has(scope)) {
      return { refused: no(403, { error: "scope_required", scope }) };
    }
    const capabilityDeps = deps.assistantTools?.capabilityDeps ?? null;
    if (!capabilityDeps) return { refused: no(503, { error: "agent_surface_unavailable" }) };
    return { deps: capabilityDeps };
  };

  /** One turn of capability state for one call: the request as the agent
   * asked for it, nothing remembered between calls. */
  const turnFor = (
    principal: Principal,
    request?: z.infer<typeof agentRequestSchema>,
  ): { turn: TurnState } | { refused: AgentAnswer } => {
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
        const issues =
          applied.error === "unreadable_time" ? ["startsAt: unreadable time"] : applied.fields;
        return { refused: no(400, { error: "invalid_request", issues }) };
      }
      state = applied.state;
    }
    return {
      turn: { conversationId: `agent:${principal.agentKeyId ?? "unknown"}`, requestState: state },
    };
  };

  async function search(
    principal: Principal,
    input: z.infer<typeof searchSchema>,
    fn: typeof quoteStreet,
  ): Promise<AgentAnswer> {
    const g = guard(principal, "read");
    if ("refused" in g) return g.refused;
    const t = turnFor(principal, input.request);
    if ("refused" in t) return t.refused;
    return ok((await fn(g.deps, principal, t.turn, {})).result as Record<string, unknown>);
  }

  return {
    /** The refusal a call needing `scope` gets before anything is read
     * (its input included), or null. */
    refusal(principal: Principal, scope: Scope): AgentAnswer | null {
      const g = guard(principal, scope);
      return "refused" in g ? g.refused : null;
    },

    /** Who the key acts for, what it may do, and whether the person has
     * said agents may act. */
    async me(principal: Principal): Promise<AgentAnswer> {
      const user = await deps.db.user.findUnique({
        where: { id: principal.userId },
        select: { agentsMayAct: true },
      });
      return ok({
        userId: principal.userId,
        agentKeyId: principal.agentKeyId ?? null,
        scopes: [...principal.scopes].sort(),
        agentsMayAct: user?.agentsMayAct === true,
      });
    },

    async geocode(
      principal: Principal,
      input: z.infer<typeof geocodeSchema>,
    ): Promise<AgentAnswer> {
      const g = guard(principal, "read");
      if ("refused" in g) return g.refused;
      const t = turnFor(principal);
      if ("refused" in t) return t.refused;
      return ok(
        (await geocodePlace(g.deps, principal, t.turn, input)).result as Record<string, unknown>,
      );
    },

    quoteStreet: (principal: Principal, input: z.infer<typeof searchSchema>) =>
      search(principal, input, quoteStreet),

    searchGarages: (principal: Principal, input: z.infer<typeof searchSchema>) =>
      search(principal, input, searchGarages),

    async itinerary(
      principal: Principal,
      input: z.infer<typeof itinerarySchema>,
    ): Promise<AgentAnswer> {
      const g = guard(principal, "read");
      if ("refused" in g) return g.refused;
      const t = turnFor(principal);
      if ("refused" in t) return t.refused;
      // Each stop's place is looked up here: the agent names places, never
      // coordinates.
      const stops: Record<string, unknown>[] = [];
      const closest: Record<string, unknown>[] = [];
      for (const [index, stop] of input.stops.entries()) {
        const looked = (await geocodePlace(g.deps, principal, t.turn, { query: stop.place }))
          .result as {
          found?: boolean;
          ambiguous?: boolean;
          match?: string;
          instruction?: string;
          place?: { lat: number; lng: number };
        };
        if (!looked.found || looked.ambiguous || !looked.place) {
          return no(422, { error: "place_not_found", stop: index, place: stop.place });
        }
        // The closest place, not the one named: said, as geocode says it.
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
      const built = (await buildItinerary(g.deps, principal, t.turn, { stops })).result;
      return ok(
        closest.length > 0 && built && typeof built === "object"
          ? { ...(built as Record<string, unknown>), closestMatches: closest }
          : (built as Record<string, unknown>),
      );
    },

    /** Search a request and propose a plan: the options that meet it, by
     * the server's order, or the "no". A key with `confirm` gets the
     * mandate for the recommended option. */
    async plan(principal: Principal, input: z.infer<typeof planSchema>): Promise<AgentAnswer> {
      const g = guard(principal, "read");
      if ("refused" in g) return g.refused;
      const t = turnFor(principal, input.request);
      if ("refused" in t) return t.refused;
      const { turn } = t;
      const kinds = input.request.kinds ?? ["street", "garage"];
      for (const kind of kinds) {
        const searchFn = kind === "street" ? quoteStreet : searchGarages;
        const out = await searchFn(g.deps, principal, turn, {});
        if (out.endTurn) break;
        if (out.ask) return no(422, { error: "needs_more", question: out.ask.question });
      }
      const last = turn.lastSearch as SearchResult | undefined;
      const planInput =
        last?.verdict === "meets"
          ? { kind: "single_spot", options: last.satisfying.slice(0, 3).map((o) => ({ id: o.id })) }
          : { kind: "none_meets" };
      const proposed = await proposePlan(g.deps, principal, turn, { plan: planInput });
      if (!proposed.endTurn) return no(422, proposed.result as Record<string, unknown>);
      const { planId, plan } = proposed.endTurn;
      if (plan.kind !== "single_spot" || !principal.scopes.has("confirm")) {
        return ok({ planId, plan });
      }
      const option = (plan as SingleSpotPlan).options[0]!;
      const policy = await policyFor(g.deps, principal.userId);
      // The dry run the agent is shown rides on the mandate: a confirm or an
      // arrival under a different one is refused (dry_run_changed).
      const dryRun = deps.policy.effectiveDryRun();
      const { token, expiresAt } = await mintMandate(
        { db: deps.db, pepper: deps.apiKeyPepper },
        principal,
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
      return ok({
        planId,
        plan,
        confirmToken: token,
        optionId: option.id,
        expiresAt: expiresAt.toISOString(),
        dryRun,
      });
    },

    /** Confirm a plan with its mandate: the one confirm sequence the app's
     * tap runs too (consent, the mandate, the plan unchanged, the dry run
     * as shown, the caps now, a garage still bookable; only then the
     * claim). */
    async confirm(
      principal: Principal,
      planId: string,
      confirmToken: string,
    ): Promise<AgentAnswer> {
      const g = guard(principal, "confirm");
      if ("refused" in g) return g.refused;
      const at = now();
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
      const t = turnFor(principal);
      if ("refused" in t) return t.refused;
      const confirmed = await consumeConfirmation(g.deps, principal, t.turn, confirmToken, {
        tool: "agent_confirm",
        planId,
      });
      if (!confirmed.ok) {
        const { code, error, extra } = refusalAnswer(confirmed.refusal);
        const decision = await decide(error, { allowed: false, ...extra });
        return no(code, { error, ...extra, decisionId: decision.id });
      }
      const { option, dryRun } = confirmed;
      if (option.type === "garage") {
        // Bookable a moment ago (the sequence checked); a provider that
        // still fails here leaves the mandate spent, and says so.
        let booking: Awaited<ReturnType<typeof g.deps.garage.book>>;
        try {
          booking = await g.deps.garage.book(option.garageOptionId ?? option.id);
        } catch (err) {
          const detail = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
          const decision = await decide("garage_book_failed", { allowed: true, detail });
          return no(409, { error: "garage_book_failed", detail, decisionId: decision.id });
        }
        await markConfirmed(option.id);
        const decision = await decide("garage_handoff", {
          allowed: true,
          optionId: option.id,
          provider: booking.option.provider,
          priceUsd: booking.option.priceUsd,
          dryRun,
        });
        return ok({
          status: "garage_handoff",
          deepLink: booking.deepLink ?? null,
          priceUsd: booking.option.priceUsd,
          dryRun,
          decisionId: decision.id,
        });
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
      return ok({
        status: "pending_arrival",
        zoneId: option.zoneId ?? null,
        durationMinutes: option.durationMinutes,
        priceUsd: option.priceUsd,
        dryRun,
        expiresAt: confirmed.expiresAt.toISOString(),
        decisionId: decision.id,
      });
    },

    /** A plan the key's person was proposed, by id. */
    async getPlan(principal: Principal, planId: string): Promise<AgentAnswer> {
      const row = await deps.db.assistantPlan.findUnique({ where: { id: planId } });
      if (!row || row.userId !== principal.userId) return no(404, { error: "plan_not_found" });
      return ok({
        planId: row.id,
        kind: row.kind,
        plan: row.plan,
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
        confirmedOptionId: row.confirmedOptionId ?? null,
      });
    },

    /** A park the phone reported, by id: its status only. */
    async getPark(principal: Principal, parkId: string): Promise<AgentAnswer> {
      const row = await deps.db.pendingPark.findUnique({ where: { id: parkId } });
      if (!row || row.userId !== principal.userId) return no(404, { error: "park_not_found" });
      return ok({
        parkId: row.id,
        status: row.status,
        zoneId: row.zoneId,
        parkedAt: row.parkedAt.toISOString(),
        sessionId: row.sessionId,
      });
    },
  };
}
