/**
 * The structured plans the assistant proposes — the contract between the
 * model's propose_plan tool, the stored assistant_plans row, and the iOS
 * plan cards. Validated with zod at the tool boundary: a malformed plan
 * never reaches the client.
 *
 * Four kinds reach a card (FR-43): `single_spot` and `itinerary`, which
 * the user can act on, and the two honest non-answers the server decides —
 * `none_meets` (options exist, none meets the request's limits) and
 * `no_data` (we have nothing there to offer). Neither can be confirmed.
 */

import { z } from "zod";

import { parseEasternTime } from "../hours.js";

/** A value on either side of a broken limit: a price, a walk, a kind. */
const limitValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.string()), z.null()]);

/** One limit an option breaks, and by how much: SERVER-COMPUTED from the
 * request's hard constraints (search.ts); model input is discarded. */
export const violationSchema = z.object({
  field: z.enum(["maxPriceUsd", "maxWalkMinutes", "kinds", "entryType", "covered"]),
  actual: limitValue,
  limit: limitValue,
});

export const singleSpotOptionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["street", "garage"]),
  label: z.string().min(1).max(120),
  detail: z.string().max(240).default(""),
  priceUsd: z.number().nonnegative(),
  durationMinutes: z.number().int().positive().max(720),
  walkMinutes: z.number().int().nonnegative().max(120).optional(),
  entryType: z.string().max(40).optional(),
  /** street options */
  zoneId: z.string().optional(),
  /** garage options — the id search_garages returned. */
  garageOptionId: z.string().optional(),
  /** ISO start of the stay; how the server tells "now" from "later". */
  startsAt: z.string().optional(),
  /** Where the option physically is — the card's mini map pin. The server
   * re-attaches these from the garage cache / the street quote when the
   * model drops them. */
  lat: z.number().gte(-90).lte(90).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  /** SERVER-COMPUTED on street options (model input ignored): a future
   * meter can't be started now — the detector pays at the curb, so the
   * card shows "We'll pay automatically when you park here" and no
   * Confirm. Garages and street-right-now stay confirmable. */
  payOnArrival: z.boolean().optional(),
  /** SERVER-ATTACHED on garage options from the search cache (model input
   * ignored), like deepLink: which source the offer came from, so the
   * card, the handoff note, and the Link merchant name the right site. */
  provider: z.string().optional(),
  deepLink: z.string().url().optional(),
  /** SERVER-ATTACHED on street options from the street search (model
   * input ignored): the block's street and pay-by-app number, what it's
   * doing during the stay ("Free after 6 PM on Seaport Blvd — 4 min
   * walk"), the price's meter/fee split, the rate, the posted hours that
   * day, and the max stay — the card's detail. */
  street: z.string().optional(),
  zoneNumber: z.string().nullable().optional(),
  streetState: z
    .enum(["free", "metered", "metered_then_free", "free_then_metered", "mixed"])
    .optional(),
  streetSummary: z.string().max(200).optional(),
  priceBreakdown: z
    .object({ meterUsd: z.number().nonnegative(), feeUsd: z.number().nonnegative() })
    .optional(),
  ratePerHourUsd: z.number().nonnegative().optional(),
  hoursToday: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
  maxStayMinutes: z.number().int().positive().nullable().optional(),
  exceedsMaxStay: z.boolean().optional(),
  /** SERVER-ATTACHED from the search (model input ignored), decision 8:
   * what the option is the best on among those that meet the request —
   * the card's "Cheapest" / "Closest" label. */
  axis: z.enum(["cheapest", "closest", "both"]).optional(),
  /** SERVER-ATTACHED: the best option on the axis the user did NOT ask
   * about. An alternative: never the recommended option. */
  secondary: z.literal(true).optional(),
  /** The option breaks a limit of the request. Shown for information, with
   * `violates` saying which limit and by how much; it has no Confirm, and
   * the confirm route refuses it. */
  nearMiss: z.literal(true).optional(),
  violates: z.array(violationSchema).max(5).optional(),
  /** SERVER-ATTACHED: when this option's price was fetched (ISO) — a
   * garage price is a claim about the past (decision 7). */
  fetchedAt: z.string().optional(),
  recommended: z.boolean().default(false),
});

export const singleSpotPlanSchema = z.object({
  kind: z.literal("single_spot"),
  /** ≤3 options; exactly one may carry the recommended badge. */
  options: z.array(singleSpotOptionSchema).min(1).max(3),
  /** The place the user asked about (geocoded) — the map's destination
   * pin. The server backfills it from the turn's geocode when omitted. */
  destination: z
    .object({
      lat: z.number().gte(-90).lte(90),
      lng: z.number().gte(-180).lte(180),
      label: z.string().max(120),
    })
    .optional(),
  /** SERVER-ATTACHED: where garage results came from and when the search
   * ran, so the card can say "From SpotHero · checked 2:05 PM". */
  provenance: z
    .object({
      provider: z.string(),
      searchedAt: z.string(),
      /** The garage search failed, so the card holds street options only:
       * "couldn't check garages", never "no garages". */
      garage: z.literal("unavailable").optional(),
    })
    .optional(),
  /** SERVER-ATTACHED: why the recommended option is the recommended one,
   * in one line from the options on the card ("Cheapest and closest —
   * free, 4 min walk"). */
  recommendedReason: z.string().max(200).optional(),
  /** SERVER-ATTACHED: what the plan assumed, in one line — the window and
   * the place ("Sat 7:00–10:00 PM, near LoLa 42, Seaport"). */
  assumptions: z.string().max(200).optional(),
  note: z.string().max(400).optional(),
});

export const itineraryStopSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  address: z.string().max(240),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  /** ISO arrival time. */
  arrival: z.string().min(1),
  durationMinutes: z.number().int().positive().max(720),
  choice: z.enum(["street", "garage"]),
  costUsd: z.number().nonnegative(),
  zoneId: z.string().optional(),
  garageOptionId: z.string().optional(),
  deepLink: z.string().url().optional(),
});

/**
 * A stop as the user edits it after sign-off (PATCH): the model's shape,
 * except the arrival may be cleared — `null` (or omitted) is "no set
 * time". The model must still give every stop a time, because pricing
 * needs one; only the edit path is looser.
 */
export const editedItineraryStopSchema = itineraryStopSchema.extend({
  arrival: z.string().min(1).nullable().optional(),
  // Accepted for compatibility, never read: the server prices every
  // edited stop itself (AssistantTools.repriceStops).
  costUsd: z.number().nonnegative().optional(),
  estimate: z.boolean().optional(),
});

export const itineraryPlanSchema = z.object({
  kind: z.literal("itinerary"),
  /** ISO date of the day being planned. */
  date: z.string().min(1),
  stops: z.array(itineraryStopSchema).min(1).max(12),
  totalUsd: z.number().nonnegative(),
  capUsd: z.number().positive(),
  note: z.string().max(400).optional(),
  /** SERVER-ATTACHED: the day and window it covers ("Mon 3 stops,
   * 10:00 AM–4:30 PM"). */
  assumptions: z.string().max(200).optional(),
});

/** One limit of the request nothing met: the limit, and the nearest any
 * option came to it. `garageSearch` / `unavailable` is the one failure
 * that isn't a limit: a garage-only request whose garage search is down. */
export const constraintFailedSchema = z.object({
  field: z.string().min(1),
  limit: limitValue.optional(),
  nearestActual: limitValue.optional(),
  reason: z.string().optional(),
});

/** What relaxing one limit a step would yield. `reply` is a plain
 * sentence in the user's voice: a tap sends it like any message, so the
 * USER changes the request (through update_request), never the assistant. */
export const relaxSuggestionSchema = z.object({
  field: z.enum(["maxPriceUsd", "maxWalkMinutes", "kinds"]),
  to: z.union([z.number(), z.array(z.enum(["street", "garage"]))]),
  wouldYield: z.number().int().nonnegative(),
  label: z.string().min(1).max(60),
  reply: z.string().min(1).max(200),
});

/**
 * "Nothing meets this" as a card of its own, decided by the server
 * (tools.ts V4) and filled by it: the model only names the kind. Up to
 * three near-misses, each with what it breaks.
 */
export const noneMeetsPlanSchema = z.object({
  kind: z.literal("none_meets"),
  /** The no, in one or two sentences ("Nothing under $2.00 near Cambridge
   * Common. Closest: …"). It is the turn's reply, word for word: model
   * text can't restate a near-miss as a fit. */
  headline: z.string().min(1).max(400),
  constraintsFailed: z.array(constraintFailedSchema).max(6),
  nearMisses: z.array(singleSpotOptionSchema).max(3),
  relaxSuggestions: z.array(relaxSuggestionSchema).max(3),
  destination: singleSpotPlanSchema.shape.destination,
  provenance: singleSpotPlanSchema.shape.provenance,
  assumptions: z.string().max(200).optional(),
  note: z.string().max(400).optional(),
});

/**
 * "We have nothing to offer there": both searches came back empty inside
 * a covered city, with no limit set to blame. Not a refusal — a gap in
 * the data — so it has its own kind and rule, and names the nearest zones
 * we do have.
 */
export const noDataPlanSchema = z.object({
  kind: z.literal("no_data"),
  rule: z.literal("no_zone_here"),
  headline: z.string().min(1).max(400),
  /** How far the street search looked. */
  radiusM: z.number().int().positive(),
  nearestZones: z
    .array(
      z.object({
        zoneId: z.string(),
        street: z.string().nullable(),
        zoneNumber: z.string().nullable(),
        distanceM: z.number().int().nonnegative(),
        walkMinutes: z.number().int().nonnegative(),
        lat: z.number().gte(-90).lte(90).optional(),
        lng: z.number().gte(-180).lte(180).optional(),
      }),
    )
    .max(3),
  destination: singleSpotPlanSchema.shape.destination,
  provenance: singleSpotPlanSchema.shape.provenance,
  assumptions: z.string().max(200).optional(),
});

export const planSchema = z.discriminatedUnion("kind", [
  singleSpotPlanSchema,
  itineraryPlanSchema,
  noneMeetsPlanSchema,
  noDataPlanSchema,
]);

/**
 * What propose_plan takes from the MODEL (FR-43). A single-spot option is
 * a result of the latest search, named by its id: the price, walk, zone,
 * link, and window are the search's, so the id is all the model must send
 * and the words are all it may add. (It used to send the whole option;
 * every field it typed was one the server had to distrust.) A price it
 * sends anyway is read only to record a mismatch. The "no" card is the
 * server's to fill: the model names the kind.
 */
const modelOptionSchema = z.object({
  id: z.string().min(1).describe("The option's id, exactly as the latest search returned it"),
  label: z.string().min(1).max(120).optional().describe("A short name; the server has a default"),
  detail: z.string().max(240).optional().describe("One line about the spot"),
  recommended: z
    .boolean()
    .optional()
    .describe("The server recommends the first option the search ranked; this is advisory"),
  nearMiss: z
    .boolean()
    .optional()
    .describe("Required true for an option from the search's nearMisses; never for one that meets"),
});

const modelSingleSpotSchema = z.object({
  kind: z.literal("single_spot"),
  options: z.array(modelOptionSchema).min(1).max(3),
  note: z.string().max(400).optional(),
});

const modelNoneMeetsSchema = z.object({
  kind: z.literal("none_meets"),
  nearMissIds: z
    .array(z.string().min(1))
    .max(3)
    .optional()
    .describe("Which near-misses to show, by id; omit for the server's nearest three"),
});

const modelItinerarySchema = itineraryPlanSchema.omit({ assumptions: true }).extend({
  stops: z
    .array(itineraryStopSchema.omit({ deepLink: true }))
    .min(1)
    .max(12),
});

const modelPlanSchema = z.discriminatedUnion("kind", [
  modelSingleSpotSchema,
  modelItinerarySchema,
  modelNoneMeetsSchema,
]);

/** The validator for propose_plan's input: the model's shape, plus the
 * price a model may still type on an option (read for the mismatch audit
 * and never used). */
export const proposedPlanSchema = z.discriminatedUnion("kind", [
  modelSingleSpotSchema.extend({
    options: z
      .array(modelOptionSchema.extend({ priceUsd: z.unknown().optional() }))
      .min(1)
      .max(3),
  }),
  modelItinerarySchema,
  modelNoneMeetsSchema,
]);

/** JSON Schema for propose_plan's `plan` argument (anyOf the three kinds
 * a model can send; `no_data` is only ever the server's). */
export const MODEL_PLAN_JSON_SCHEMA: Record<string, unknown> = (() => {
  const schema = {
    ...(z.toJSONSchema(modelPlanSchema, { io: "input" }) as Record<string, unknown>),
  };
  // A tool's nested schema carries no dialect marker; the union is anyOf.
  delete schema["$schema"];
  schema["anyOf"] = schema["oneOf"];
  delete schema["oneOf"];
  return schema;
})();

export type Violation = z.infer<typeof violationSchema>;
export type SingleSpotOption = z.infer<typeof singleSpotOptionSchema>;
export type SingleSpotPlan = z.infer<typeof singleSpotPlanSchema>;
export type ItineraryStop = z.infer<typeof itineraryStopSchema>;
export type EditedItineraryStop = z.infer<typeof editedItineraryStopSchema>;
export type ItineraryPlan = z.infer<typeof itineraryPlanSchema>;
export type ConstraintFailed = z.infer<typeof constraintFailedSchema>;
export type RelaxSuggestion = z.infer<typeof relaxSuggestionSchema>;
export type NoneMeetsPlan = z.infer<typeof noneMeetsPlanSchema>;
export type NoDataPlan = z.infer<typeof noDataPlanSchema>;
export type ProposedPlan = z.infer<typeof proposedPlanSchema>;
export type AssistantPlanBody = z.infer<typeof planSchema>;

/** The chips a "no" card offers: each relaxation that would yield
 * something, or — when the garage search itself was down — trying again.
 * Null for a plan the user acts on by tapping the card. */
export function suggestionsForPlan(
  plan: AssistantPlanBody,
): { label: string; reply: string }[] | null {
  if (plan.kind !== "none_meets") return null;
  if (plan.constraintsFailed.some((c) => c.field === "garageSearch")) {
    return [{ label: "Try again", reply: "Search garages again" }];
  }
  const chips = plan.relaxSuggestions
    .filter((r) => r.wouldYield > 0)
    .map(({ label, reply }) => ({ label, reply }));
  return chips.length > 0 ? chips : null;
}

const money = (usd: number) => (usd === 0 ? "free" : `$${usd.toFixed(2)}`);

/**
 * Why the recommended option is the one on top, in one line, from the
 * options actually on the card: cheapest, closest, both, or — when it's
 * neither — best value, naming what the cheapest would cost instead.
 * "Closest" is only claimed when every other option has a walk to compare.
 */
export function recommendationReason(options: SingleSpotOption[]): string | null {
  const rec = options.find((o) => o.recommended);
  if (!rec) return null;
  const facts = [
    money(rec.priceUsd),
    rec.walkMinutes !== undefined ? `${rec.walkMinutes} min walk` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const others = options.filter((o) => o !== rec);
  if (others.length === 0) return `The only option found — ${facts}`;
  const cheapest = others.every((o) => rec.priceUsd <= o.priceUsd);
  const closest =
    rec.walkMinutes !== undefined &&
    others.every((o) => o.walkMinutes !== undefined && rec.walkMinutes! <= o.walkMinutes);
  if (cheapest && closest) return `Cheapest and closest — ${facts}`;
  if (cheapest) return `Cheapest — ${facts}`;
  if (closest) return `Closest — ${facts}`;
  const cheapestOther = others.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a));
  const alt = [
    money(cheapestOther.priceUsd),
    cheapestOther.walkMinutes !== undefined ? `${cheapestOther.walkMinutes} min walk` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return `Best value — ${facts}; the cheapest is ${alt}`;
}

/** Recompute an itinerary's total from its stops — never trust a total
 * the model typed. Half-up to the cent. */
export function itineraryTotalUsd(stops: { costUsd: number }[]): number {
  return Math.round(stops.reduce((sum, s) => sum + s.costUsd, 0) * 100) / 100;
}

/**
 * The one ordering rule for an itinerary's stops. The app applies the same
 * rule (ios ItineraryOrder.swift), so the stored order is the order shown.
 * A stop with no set time keeps the slot it occupies — the user put it
 * there; the timed stops fill the remaining slots in ascending arrival,
 * ties keeping their relative order. A later stop can never sit above an
 * earlier one, and only an untimed stop is ever placed by hand. An arrival
 * that doesn't parse orders like no time at all (callers refuse those
 * before storing).
 */
export function orderStopsByArrival<T extends { arrival?: string | null }>(
  stops: readonly T[],
): T[] {
  const instant = (stop: T): number | null => {
    if (!stop.arrival) return null;
    return parseEasternTime(stop.arrival)?.getTime() ?? null;
  };
  const timed = stops
    .map((stop, index) => ({ stop, index, at: instant(stop) }))
    .filter((entry): entry is { stop: T; index: number; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at || a.index - b.index);
  let next = 0;
  return stops.map((stop) => (instant(stop) === null ? stop : timed[next++]!.stop));
}
