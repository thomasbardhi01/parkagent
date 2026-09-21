/**
 * The structured plans the assistant proposes — the contract between the
 * model's propose_plan tool, the stored assistant_plans row, and the iOS
 * plan cards. Validated with zod at the tool boundary: a malformed plan
 * never reaches the client.
 */

import { z } from "zod";

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
  deepLink: z.string().url().optional(),
  recommended: z.boolean().default(false),
});

export const singleSpotPlanSchema = z.object({
  kind: z.literal("single_spot"),
  /** ≤3 options; exactly one may carry the recommended badge. */
  options: z.array(singleSpotOptionSchema).min(1).max(3),
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

export const itineraryPlanSchema = z.object({
  kind: z.literal("itinerary"),
  /** ISO date of the day being planned. */
  date: z.string().min(1),
  stops: z.array(itineraryStopSchema).min(1).max(12),
  totalUsd: z.number().nonnegative(),
  capUsd: z.number().positive(),
  note: z.string().max(400).optional(),
});

export const planSchema = z.discriminatedUnion("kind", [
  singleSpotPlanSchema,
  itineraryPlanSchema,
]);

export type SingleSpotOption = z.infer<typeof singleSpotOptionSchema>;
export type SingleSpotPlan = z.infer<typeof singleSpotPlanSchema>;
export type ItineraryStop = z.infer<typeof itineraryStopSchema>;
export type ItineraryPlan = z.infer<typeof itineraryPlanSchema>;
export type AssistantPlanBody = z.infer<typeof planSchema>;

/** Recompute an itinerary's total from its stops — never trust a total
 * the model typed. Half-up to the cent. */
export function itineraryTotalUsd(stops: { costUsd: number }[]): number {
  return Math.round(stops.reduce((sum, s) => sum + s.costUsd, 0) * 100) / 100;
}
