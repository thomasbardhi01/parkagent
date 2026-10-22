/**
 * What the agent surface takes, as zod schemas: the routes parse with
 * them, and GET /agent/openapi.json and examples/grok-tool.json are
 * generated from them (z.toJSONSchema, JSON Schema 2020-12, which OpenAPI
 * 3.1 takes as-is), so the documents can't drift from the code.
 *
 * Places are named, never given as coordinates: an agent supplies no
 * location (D0 §4). The server looks each name up.
 */

import { z } from "zod";

import { recordId } from "./ids.js";

const kind = z.enum(["street", "garage"]);

/** One parking request: a named place, when, for how long, and limits. */
export const agentRequestSchema = z.strictObject({
  place: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("A named place in the user's words, e.g. 'Fenway Park' or 'Lola 42 Seaport'"),
  startsAt: z
    .string()
    .max(40)
    .optional()
    .describe("ISO 8601 with the UTC offset, e.g. 2026-10-22T19:00:00-04:00; absent means now"),
  durationMinutes: z.number().int().min(1).max(720).describe("How long, 1 to 720 minutes"),
  maxPriceUsd: z.number().min(0).max(500).optional().describe("Most the user will pay"),
  maxWalkMinutes: z.number().int().min(1).max(60).optional().describe("Longest walk"),
  kinds: z.array(kind).min(1).max(2).optional().describe("street, garage, or both (default)"),
});

export const geocodeSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).describe("A named place in the user's words"),
  city: z.enum(["nyc", "bos"]).optional().describe("Bias toward this city"),
});

export const searchSchema = z.strictObject({ request: agentRequestSchema });

export const itinerarySchema = z.strictObject({
  stops: z
    .array(
      z.strictObject({
        place: z.string().trim().min(1).max(200),
        label: z.string().trim().min(1).max(80).optional(),
        arrival: z.string().max(40).describe("ISO 8601 with the UTC offset"),
        durationMinutes: z.number().int().min(1).max(720),
      }),
    )
    .min(1)
    .max(12),
});

export const planSchema = z.strictObject({ request: agentRequestSchema });

export const confirmSchema = z.strictObject({
  confirmToken: z.string().min(16).max(200).describe("From POST /agent/plans, used once"),
});

export const explainSchema = z.strictObject({
  // A cuid: anything else never reaches the database (a NUL byte there
  // is a Postgres error, not a not-found; routes/ids.ts).
  decisionId: recordId.describe("The decisionId a confirm or a refusal answered with"),
});

/** The six tools an agent calls, with the route each one is. */
export const AGENT_TOOLS = [
  {
    name: "geocode_place",
    route: "/agent/geocode",
    description: "Look up a named place in the cities ParkAgent covers.",
    schema: geocodeSchema,
  },
  {
    name: "quote_street",
    route: "/agent/quote-street",
    description:
      "Metered street parking for a request, each block priced for its window. Read-only; pays nothing.",
    schema: searchSchema,
  },
  {
    name: "search_garages",
    route: "/agent/garages/search",
    description: "Garages for a request, merged across sources. Read-only; books nothing.",
    schema: searchSchema,
  },
  {
    name: "build_itinerary",
    route: "/agent/itinerary",
    description:
      "Price a multi-stop day: street and the best garage per stop, against the user's daily cap.",
    schema: itinerarySchema,
  },
  {
    name: "propose_plan",
    route: "/agent/plans",
    description:
      "Search a request and propose a plan. Returns the plan and, for a key with the confirm scope, a one-time confirmToken (10 minutes).",
    schema: planSchema,
  },
  {
    name: "confirm_plan",
    route: "/agent/plans/{planId}/confirm",
    description:
      "Confirm a proposed plan with its confirmToken, once. A garage answers with its checkout link; a street spot answers pending_arrival: nothing is paid until the user's phone reports the car parked there. Needs the confirm scope and the user's consent for agents.",
    schema: confirmSchema,
  },
] as const;

/** A schema as the JSON Schema an agent reads (input side). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = { ...(z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) };
  delete out["$schema"];
  return out;
}
