/**
 * The assistant's tools. The MODEL plans and phrases; THESE enforce
 * policy: caps and quotes come from the same services the rest of the
 * server uses, and the two consequential tools (book_garage,
 * start_session) refuse without a live confirmation token — which only
 * POST /assistant/confirm (the user's tap on a plan card) can mint.
 * Every call writes a decisions row (kind "assistant_tool").
 */

import { randomUUID } from "node:crypto";

import type { AppDb } from "../../db.js";
import { explainDecision } from "../explanations.js";
import type { GarageProvider } from "../garage/garageProvider.js";
import type { GeocoderProvider } from "./geocoder.js";
import { metersBetween } from "./geocoder.js";
import type { HoursInterval } from "../hours.js";
import type { LinkWallet } from "../link/linkWallet.js";
import type { PolicyService } from "../policy.js";
import { priceStay } from "../quote.js";
import { spentToday } from "../sessions.js";
import type { CandidateFetcher } from "../zoneLookup.js";
import { lookupRadiusM, resolveCandidates } from "../zoneLookup.js";
import { applyObservedToCandidates } from "../zoneTermsObserved.js";
import { currentTimeLine } from "./loop.js";
import { itineraryTotalUsd, planSchema } from "./plans.js";
import type { AssistantPlanBody } from "./plans.js";

export interface AssistantDeps {
  db: AppDb;
  policy: PolicyService;
  findCandidates: CandidateFetcher;
  garage: GarageProvider;
  /** Named-place geocoding (Boston/NYC biased). Absent → geocode_place
   * answers "geocoding not configured" and the model uses coordinates or
   * the phone location directly. */
  geocoder?: GeocoderProvider | undefined;
  linkWallet?: LinkWallet | undefined;
  now?: (() => Date) | undefined;
}

export interface ToolContext {
  userId: string;
  conversationId: string;
  /** The phone's location when the message was sent, if it sent one. */
  location?: { lat: number; lng: number } | undefined;
}

/** What a tool hands back to the loop. `endTurn` is propose_plan's exit. */
export interface ToolOutcome {
  result: unknown;
  endTurn?: { planId: string; plan: AssistantPlanBody };
}

export const CONFIRMATION_TTL_MS = 10 * 60_000;

/** Anthropic tool definitions (Messages API shape). Kept in one place so
 * the schema tests pin exactly what the model sees. */
export const TOOL_DEFINITIONS = [
  {
    name: "geocode_place",
    description:
      "Resolve a NAMED place or area to coordinates, biased to the two cities ParkAgent covers (New York City and Boston). Call this FIRST whenever the user names a street, neighborhood, or landmark ('Newbury Street', 'near India Street', 'in South Boston', 'near Fenway') instead of relying on their current location. Returns up to 3 matches, best first, each with lat/lng, a display name, and which city it's in. Then pass the chosen lat/lng to quote_street or search_garages. Empty results mean the place isn't in either city.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "The named place, e.g. 'Newbury Street' or 'Fenway'",
        },
        city: {
          type: "string",
          enum: ["nyc", "bos"],
          description:
            "Bias toward this city when you know it (e.g. the user's current city). Omit to search both.",
        },
      },
    },
  },
  {
    name: "search_garages",
    description:
      "Search off-street garages near a point for a time window. Returns up to 8 options with price, walk time, entry type, and a checkout deep link. Provider today: SpotHero (deep-link checkout — the user finishes the purchase there). For a NAMED area, geocode_place it first and pass within_m: 600 so every option is walkable from that place.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["lat", "lng", "starts_at", "ends_at"],
      properties: {
        lat: { type: "number", description: "Latitude of the destination" },
        lng: { type: "number", description: "Longitude of the destination" },
        starts_at: { type: "string", description: "ISO start of the parking window" },
        ends_at: { type: "string", description: "ISO end of the parking window" },
        budget_usd: {
          type: "number",
          description: "Optional price ceiling; pricier options are dropped",
        },
        within_m: {
          type: "number",
          description:
            "Optional max walking distance in metres from the point; options farther away are dropped. Use 600 for a named-area search so results are actually at that place.",
        },
      },
    },
  },
  {
    name: "quote_street",
    description:
      "Quote metered street parking at a point: nearest zone terms and the cost of a stay of the given duration starting at the given time. Uses the same zone data and pricing as automatic payments.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["lat", "lng", "duration_minutes", "when"],
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        duration_minutes: { type: "integer", minimum: 1, maximum: 720 },
        when: { type: "string", description: "ISO start time of the stay" },
      },
    },
  },
  {
    name: "build_itinerary",
    description:
      "Price a multi-stop day: for each stop, quote street parking AND the best garage, and check the day total against the user's daily cap. Use the result to decide street vs garage per stop before proposing the plan.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["stops"],
      properties: {
        stops: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "lat", "lng", "arrival", "duration_minutes"],
            properties: {
              label: { type: "string" },
              address: { type: "string" },
              lat: { type: "number" },
              lng: { type: "number" },
              arrival: { type: "string", description: "ISO arrival time" },
              duration_minutes: { type: "integer", minimum: 1, maximum: 720 },
            },
          },
        },
      },
    },
  },
  {
    name: "propose_plan",
    description:
      "Present the final plan to the user as cards and END your turn. Single-spot: up to 3 options, exactly one recommended. Itinerary: the per-stop choices with costs and the day total. Nothing is booked or paid by this tool — the user must tap Confirm/Sign off.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["plan"],
      properties: {
        plan: { type: "object", description: "The plan object (single_spot or itinerary shape)" },
      },
    },
  },
  {
    name: "book_garage",
    description:
      "Book (or hand off) a garage option. REQUIRES a confirmation_token minted by the user's explicit Confirm tap on a proposed plan — calls without one are refused. Propose a plan instead if you have no token.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["option_id"],
      properties: {
        option_id: { type: "string" },
        confirmation_token: { type: "string" },
      },
    },
  },
  {
    name: "start_session",
    description:
      "Start a paid street-meter session. REQUIRES a confirmation_token minted by the user's explicit Confirm tap — calls without one are refused. Propose a plan instead if you have no token.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["zone", "duration_minutes"],
      properties: {
        zone: { type: "string", description: "Zone id, e.g. nyc-110436" },
        duration_minutes: { type: "integer", minimum: 1, maximum: 720 },
        confirmation_token: { type: "string" },
      },
    },
  },
  {
    name: "get_history",
    description: "The user's recent parking sessions (zone, city, cost, when), newest first.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 90,
          description: "Look-back window, default 14",
        },
      },
    },
  },
  {
    name: "explain_decision",
    description: "Plain-language explanation of one recorded decision by its id.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["decision_id"],
      properties: { decision_id: { type: "string" } },
    },
  },
];

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export class AssistantTools {
  constructor(private readonly deps: AssistantDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async audit(
    ctx: ToolContext,
    tool: string,
    input: unknown,
    rule: string,
    outcome: Record<string, unknown>,
  ): Promise<string> {
    const { id } = await this.deps.db.decision.create({
      data: {
        kind: "assistant_tool",
        inputs: { tool, input, conversationId: ctx.conversationId },
        rule,
        outcome,
        userId: ctx.userId,
      },
    });
    return id;
  }

  /** Dispatch one model tool call. Unknown tools come back as errors the
   * model can read, never as throws that kill the turn. */
  async execute(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
    try {
      switch (name) {
        case "geocode_place":
          return await this.geocodePlace(ctx, input as Record<string, unknown>);
        case "search_garages":
          return await this.searchGarages(ctx, input as Record<string, unknown>);
        case "quote_street":
          return await this.quoteStreet(ctx, input as Record<string, unknown>);
        case "build_itinerary":
          return await this.buildItinerary(ctx, input as Record<string, unknown>);
        case "propose_plan":
          return await this.proposePlan(ctx, input as Record<string, unknown>);
        case "book_garage":
          return await this.bookGarage(ctx, input as Record<string, unknown>);
        case "start_session":
          return await this.startSession(ctx, input as Record<string, unknown>);
        case "get_history":
          return await this.getHistory(ctx, input as Record<string, unknown>);
        case "explain_decision":
          return await this.explain(ctx, input as Record<string, unknown>);
        default:
          return { result: { error: `unknown tool ${name}` } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      await this.audit(ctx, name, input, "tool_error", { error: message });
      return { result: { error: message } };
    }
  }

  /** A window starting in the past is always a model date mistake (the
   * prod bug: "tonight" hallucinated as a 2024 date → SpotHero 400).
   * Bounce it back with the current time so the model self-corrects in
   * the same turn instead of the provider erroring opaquely. */
  private pastWindowError(ctx: ToolContext, tool: string, input: unknown, startsAt: string) {
    const at = this.now();
    if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) return null;
    if (at.getTime() - new Date(startsAt).getTime() <= 60 * 60_000) return null;
    return this.audit(ctx, tool, input, "past_window", { startsAt }).then(() => ({
      result: {
        error: "window_in_the_past",
        startsAt,
        instruction:
          `That start time is in the past — you guessed the date. ${currentTimeLine(at)} ` +
          "Recompute the window from the current time and call this tool again.",
      },
    }));
  }

  /** Resolve a named place to coordinates, biased to NYC/Boston. The model
   * calls this before quoting a named area so it searches the PLACE, not
   * the phone's dot. */
  private async geocodePlace(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const query = String(input["query"] ?? "").trim();
    if (!query) {
      return { result: { error: "query is required" } };
    }
    if (!this.deps.geocoder) {
      await this.audit(ctx, "geocode_place", input, "geocoder_unavailable", {});
      return {
        result: {
          error: "geocoding_unavailable",
          instruction:
            "Geocoding isn't configured. If the user gave an explicit address or coordinates, use those; otherwise ask them to share their location or name a more specific spot.",
        },
      };
    }
    const cityRaw = input["city"];
    const city = cityRaw === "nyc" || cityRaw === "bos" ? cityRaw : undefined;
    const outcome = await this.deps.geocoder.geocode({ query, ...(city ? { city } : {}) }, 3);
    if (!outcome.ok) {
      await this.audit(ctx, "geocode_place", input, "geocode_error", { reason: outcome.reason });
      return {
        result: {
          error: "geocode_failed",
          instruction:
            "Couldn't look that place up right now — tell the user and ask them to try a nearby cross-street or share their location.",
        },
      };
    }
    if (outcome.results.length === 0) {
      await this.audit(ctx, "geocode_place", input, "no_match", { query });
      return {
        result: {
          found: false,
          instruction:
            "That place isn't in New York City or Boston, the two cities ParkAgent covers. Say so; don't fall back to the user's current location for a place we can't place.",
        },
      };
    }
    await this.audit(ctx, "geocode_place", input, "ok", {
      query,
      count: outcome.results.length,
      top: outcome.results[0],
    });
    return { result: { found: true, results: outcome.results } };
  }

  private async searchGarages(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const past = await this.pastWindowError(
      ctx,
      "search_garages",
      input,
      String(input["starts_at"] ?? ""),
    );
    if (past) return past;
    const anchorLat = num(input["lat"]);
    const anchorLng = num(input["lng"]);
    const withinM = input["within_m"] !== undefined ? num(input["within_m"]) : null;
    const outcome = await this.deps.garage.search({
      lat: anchorLat,
      lng: anchorLng,
      startsAt: String(input["starts_at"]),
      endsAt: String(input["ends_at"]),
      ...(input["budget_usd"] !== undefined ? { budgetUsd: num(input["budget_usd"]) } : {}),
    });
    if (!outcome.ok) {
      // Search FAILED — a different fact from "no garages". The model
      // must say it couldn't check and still offer street.
      await this.audit(ctx, "search_garages", input, "garage_search_error", {
        provider: this.deps.garage.id,
        error: outcome.error,
        detail: outcome.detail,
      });
      return {
        result: {
          error: "garage_search_unavailable",
          reason: outcome.error,
          instruction:
            "The garage search is unavailable right now (this is NOT 'no garages'). Tell the user " +
            "you couldn't check garages at the moment, and still offer the street option.",
        },
      };
    }
    // Named-area guard: when the caller anchored the search to a geocoded
    // place (within_m), drop any option farther than that from the point,
    // so every option we surface is actually walkable from the named place.
    // The provider reports distanceM, but recompute from the option's own
    // coordinates when it carries them so the guard can't be fooled.
    let options = outcome.options;
    let droppedFar = 0;
    if (withinM !== null && Number.isFinite(withinM)) {
      const near = options.filter((o) => {
        const withCoords = o as typeof o & { lat?: number; lng?: number };
        const d =
          typeof withCoords.lat === "number" && typeof withCoords.lng === "number"
            ? metersBetween(anchorLat, anchorLng, withCoords.lat, withCoords.lng)
            : o.distanceM;
        return d <= withinM;
      });
      droppedFar = options.length - near.length;
      options = near;
    }
    await this.audit(ctx, "search_garages", input, "ok", {
      provider: this.deps.garage.id,
      count: options.length,
      fromCache: outcome.fromCache,
      ...(withinM !== null ? { withinM, droppedFar } : {}),
    });
    return {
      result: {
        provider: this.deps.garage.id,
        options,
        ...(droppedFar > 0 ? { droppedForDistance: droppedFar } : {}),
      },
    };
  }

  private async quoteStreet(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const past = await this.pastWindowError(
      ctx,
      "quote_street",
      input,
      String(input["when"] ?? ""),
    );
    if (past) return past;
    const lat = num(input["lat"]);
    const lng = num(input["lng"]);
    const minutes = num(input["duration_minutes"]);
    const when = new Date(String(input["when"]));
    const policy = this.deps.policy.get();
    const raw = await this.deps.findCandidates({ lat, lng, radiusM: lookupRadiusM(25) });
    // Provider-observed terms beat the dataset (e.g. Boston's real "Max 5 Hr"
    // vs the data's assumed 2-hour cap) — the same override /parked and
    // session start apply, so a named-area quote matches what the curb pays.
    const found = await applyObservedToCandidates(this.deps.db, raw);
    const resolution = resolveCandidates(found, when, policy.respect_enforcement_hours);
    if (resolution.kind === "unknown") {
      await this.audit(ctx, "quote_street", input, "unknown_zone", {});
      return { result: { found: false, reason: "no metered zone within 25 m of that point" } };
    }
    const zone = resolution.nearest;
    const price = priceStay(
      {
        city: zone.city,
        rateFirstHourUsd: zone.rateFirstHourUsd,
        rateAdditionalHourUsd: zone.rateAdditionalHourUsd,
        hours: zone.hours as HoursInterval[],
      },
      policy,
      when,
      Math.min(minutes, zone.maxStayMinutes ?? minutes),
    );
    const result = {
      found: true,
      zoneId: zone.zoneId,
      city: zone.city,
      zoneNumber: zone.providerZoneNumber || null,
      maxStayMinutes: zone.maxStayMinutes,
      ambiguousWithOtherSide: resolution.kind === "disagree",
      clampedMinutes: Math.min(minutes, zone.maxStayMinutes ?? minutes),
      costUsd: price.totalUsd,
      chargedMinutes: price.chargedMinutes,
      freePeriod: price.totalUsd === 0,
      // "observed" when a driver-reported provider term (rate/max stay)
      // overrode the dataset for this zone number.
      ...(zone.termsSource === "observed" ? { termsSource: "observed" as const } : {}),
    };
    await this.audit(ctx, "quote_street", input, "ok", {
      zoneId: zone.zoneId,
      costUsd: price.totalUsd,
      ...(zone.termsSource === "observed" ? { termsSource: "observed" } : {}),
    });
    return { result };
  }

  private async buildItinerary(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const stops = input["stops"] as Record<string, unknown>[];
    const policy = this.deps.policy.get();
    const at = this.now();
    const out = [];
    for (const stop of stops) {
      const arrival = String(stop["arrival"]);
      const minutes = num(stop["duration_minutes"]);
      const street = await this.quoteStreet(ctx, {
        lat: stop["lat"],
        lng: stop["lng"],
        duration_minutes: minutes,
        when: arrival,
      });
      const endsAt = new Date(new Date(arrival).getTime() + minutes * 60_000).toISOString();
      const garages = await this.deps.garage.search({
        lat: num(stop["lat"]),
        lng: num(stop["lng"]),
        startsAt: arrival,
        endsAt,
      });
      out.push({
        label: stop["label"],
        address: stop["address"] ?? "",
        arrival,
        durationMinutes: minutes,
        street: street.result,
        garage: garages.ok ? (garages.options[0] ?? null) : null,
        ...(garages.ok ? {} : { garageSearchUnavailable: true, garageSearchError: garages.error }),
      });
    }
    const spentTodayUsd = await spentToday(this.deps.db, ctx.userId, at);
    const summary = {
      stops: out,
      dailyCapUsd: policy.daily_cap_usd,
      spentTodayUsd,
      remainingBudgetUsd: Math.max(0, policy.daily_cap_usd - spentTodayUsd),
    };
    await this.audit(ctx, "build_itinerary", { stopCount: stops.length }, "ok", {
      stops: out.length,
    });
    return { result: summary };
  }

  private async proposePlan(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const parsed = planSchema.safeParse(input["plan"]);
    if (!parsed.success) {
      await this.audit(ctx, "propose_plan", input, "invalid_plan", {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 8),
      });
      return {
        result: {
          error: "invalid plan shape",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 8),
        },
      };
    }
    let plan = parsed.data;
    const policy = this.deps.policy.get();
    if (plan.kind === "itinerary") {
      // Never trust model arithmetic: recompute the total, pin the cap,
      // and refuse a plan that busts the day's remaining budget.
      const totalUsd = itineraryTotalUsd(plan.stops);
      const spentTodayUsd = await spentToday(this.deps.db, ctx.userId, this.now());
      if (spentTodayUsd + totalUsd > policy.daily_cap_usd) {
        await this.audit(ctx, "propose_plan", { kind: plan.kind, totalUsd }, "over_daily_cap", {
          totalUsd,
          spentTodayUsd,
          capUsd: policy.daily_cap_usd,
        });
        return {
          result: {
            error: "plan_over_daily_cap",
            totalUsd,
            spentTodayUsd,
            capUsd: policy.daily_cap_usd,
            hint: "drop or shorten stops until the total fits the remaining budget",
          },
        };
      }
      plan = { ...plan, totalUsd, capUsd: policy.daily_cap_usd };
    } else {
      const badges = plan.options.filter((o) => o.recommended).length;
      if (badges !== 1) {
        // Normalize instead of bouncing: first option wins the badge.
        plan = {
          ...plan,
          options: plan.options.map((o, i) => ({ ...o, recommended: i === 0 })),
        };
      }
      // payOnArrival is OURS to decide, never the model's: a street
      // option starting more than 15 minutes out cannot be confirmed
      // now (meters run from payment) — the detector pays on arrival.
      // Garage options get their deepLink re-attached from the search
      // cache when the model dropped it (the schema is optional and
      // models often omit it) — the card and a late confirm both need
      // it on the stored plan, not in a 10-minute in-memory cache.
      const at = this.now().getTime();
      plan = {
        ...plan,
        options: plan.options.map((o) => {
          if (o.type !== "street") {
            const cached = this.deps.garage.optionById(o.garageOptionId ?? o.id);
            const deepLink = o.deepLink ?? cached?.deepLink;
            return { ...o, payOnArrival: false, ...(deepLink ? { deepLink } : {}) };
          }
          const starts = o.startsAt ? new Date(o.startsAt).getTime() : Number.NaN;
          const future = Number.isFinite(starts) && starts - at > 15 * 60_000;
          return { ...o, payOnArrival: future };
        }),
      };
    }
    const planId = randomUUID();
    await this.deps.db.assistantPlan.create({
      data: {
        id: planId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        kind: plan.kind,
        plan,
      },
    });
    await this.deps.db.decision.create({
      data: {
        kind: "assistant_plan",
        inputs: { conversationId: ctx.conversationId, kind: plan.kind },
        rule: "proposed",
        outcome: { planId, plan },
        userId: ctx.userId,
      },
    });
    return { result: { planId, presented: true }, endTurn: { planId, plan } };
  }

  /** Shared gate for the two consequential tools: a token minted by the
   * user's tap, unused, unexpired, owned by this user — or a refusal the
   * model can read. Marks the token used on success (single-use). */
  private async consumeConfirmation(
    ctx: ToolContext,
    token: unknown,
    tool: string,
    input: unknown,
  ): Promise<
    { ok: true; planId: string; optionId: string | null } | { ok: false; result: unknown }
  > {
    const refusal = async (why: string) => {
      await this.audit(ctx, tool, input, "needs_confirmation", { refused: why });
      return {
        ok: false as const,
        result: {
          error: "needs_confirmation",
          message: `${why}. Nothing books or spends without the user's explicit Confirm tap on a proposed `,
        },
      };
    };
    if (typeof token !== "string" || token.length === 0) {
      return refusal("no confirmation_token was provided");
    }
    const row = await this.deps.db.assistantConfirmation.findUnique({ where: { token } });
    if (!row || row.userId !== ctx.userId) return refusal("the confirmation token is not valid");
    if (row.usedAt !== null) return refusal("the confirmation token was already used");
    if (row.expiresAt.getTime() <= this.now().getTime()) {
      return refusal("the confirmation token expired — propose the plan again");
    }
    await this.deps.db.assistantConfirmation.update({
      where: { token },
      data: { usedAt: this.now() },
    });
    return { ok: true, planId: row.planId, optionId: row.optionId };
  }

  private async bookGarage(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
    const gate = await this.consumeConfirmation(ctx, input["confirmation_token"], "book_garage", {
      option_id: input["option_id"],
    });
    if (!gate.ok) return { result: gate.result };
    const booking = await this.deps.garage.book(String(input["option_id"]));
    await this.audit(
      ctx,
      "book_garage",
      { option_id: input["option_id"], planId: gate.planId },
      "booked",
      { kind: booking.kind, provider: booking.option.provider, priceUsd: booking.option.priceUsd },
    );
    return {
      result: {
        kind: booking.kind,
        deepLink: booking.deepLink ?? null,
        option: booking.option,
        note:
          booking.kind === "deeplink_handoff"
            ? "The user completes checkout at the provider; the pass lives in the provider's app."
            : "Reserved.",
      },
    };
  }

  private async startSession(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const gate = await this.consumeConfirmation(ctx, input["confirmation_token"], "start_session", {
      zone: input["zone"],
      duration_minutes: input["duration_minutes"],
    });
    if (!gate.ok) return { result: gate.result };
    // The meter session itself starts through the app's existing paid
    // flow (detector → /parked → /session/start): a meter runs from the
    // moment it's paid, so the confirmed choice is handed to the client
    // to execute at the curb rather than paid from here early.
    await this.audit(
      ctx,
      "start_session",
      { zone: input["zone"], minutes: input["duration_minutes"], planId: gate.planId },
      "confirmed",
      { directive: "start_via_app" },
    );
    return {
      result: {
        confirmed: true,
        directive: "start_via_app",
        zoneId: String(input["zone"]),
        durationMinutes: num(input["duration_minutes"]),
      },
    };
  }

  private async getHistory(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
    const days = input["days"] !== undefined ? num(input["days"]) : 14;
    const since = new Date(this.now().getTime() - days * 24 * 60 * 60_000);
    const sessions = await this.deps.db.session.findMany({
      where: { userId: ctx.userId, createdAt: { gte: since } },
    });
    const rows = sessions
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 30)
      .map((s) => ({
        when: s.createdAt.toISOString(),
        city: s.city,
        zoneId: s.zoneId,
        status: s.status,
        totalUsd: Math.round((Number(s.amountUsd ?? 0) + Number(s.feeUsd ?? 0)) * 100) / 100,
        minutes: s.purchasedMinutes,
        paymentSource: s.paymentSource ?? "issuing_card",
      }));
    await this.audit(ctx, "get_history", { days }, "ok", { count: rows.length });
    return { result: { sessions: rows } };
  }

  private async explain(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
    const id = String(input["decision_id"]);
    const row = await this.deps.db.decision.findUnique({ where: { id } });
    if (!row || (row.userId !== null && row.userId !== ctx.userId)) {
      await this.audit(ctx, "explain_decision", input, "not_found", {});
      return { result: { error: "no such decision (or it belongs to another user)" } };
    }
    const text = explainDecision(row);
    await this.audit(ctx, "explain_decision", input, "ok", {});
    return { result: { explanation: text } };
  }
}
