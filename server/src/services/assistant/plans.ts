/**
 * The structured plans the assistant proposes — the contract between the
 * model's propose_plan tool, the stored assistant_plans row, and the iOS
 * plan cards. Validated with zod at the tool boundary: a malformed plan
 * never reaches the client.
 */

import { z } from "zod";

import { parseEasternTime } from "../hours.js";

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
  provenance: z.object({ provider: z.string(), searchedAt: z.string() }).optional(),
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
});

export const planSchema = z.discriminatedUnion("kind", [singleSpotPlanSchema, itineraryPlanSchema]);

/**
 * What propose_plan's input_schema shows the MODEL: the same zod schemas
 * the tool validates with, minus the fields the server attaches itself
 * (payOnArrival, provider, deepLink, pins, provenance). The tool used to
 * describe `plan` as a bare object, so models guessed the shape — `kind:
 * "street"`, `title`, `costUsd`, `optionId` — and every guess cost a
 * bounced call (three per turn on a live Sonnet 5 run, 2026-09-24).
 */
const modelOptionSchema = singleSpotOptionSchema
  .omit({ payOnArrival: true, provider: true, deepLink: true, lat: true, lng: true })
  .extend({
    zoneId: z.string().optional().describe("street options: the zoneId quote_street returned"),
    garageOptionId: z
      .string()
      .optional()
      .describe("garage options: the option id search_garages returned"),
    startsAt: z
      .string()
      .optional()
      .describe("ISO 8601 start with the UTC offset, e.g. 2026-09-26T14:00:00-04:00"),
    recommended: z.boolean().default(false).describe("exactly one option is recommended"),
  });

const modelPlanSchema = z.discriminatedUnion("kind", [
  singleSpotPlanSchema
    .omit({ provenance: true })
    .extend({ options: z.array(modelOptionSchema).min(1).max(3) }),
  itineraryPlanSchema.extend({
    stops: z
      .array(itineraryStopSchema.omit({ deepLink: true }))
      .min(1)
      .max(12),
  }),
]);

/** JSON Schema for propose_plan's `plan` argument (anyOf the two kinds). */
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

export type SingleSpotOption = z.infer<typeof singleSpotOptionSchema>;
export type SingleSpotPlan = z.infer<typeof singleSpotPlanSchema>;
export type ItineraryStop = z.infer<typeof itineraryStopSchema>;
export type EditedItineraryStop = z.infer<typeof editedItineraryStopSchema>;
export type ItineraryPlan = z.infer<typeof itineraryPlanSchema>;
export type AssistantPlanBody = z.infer<typeof planSchema>;

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
