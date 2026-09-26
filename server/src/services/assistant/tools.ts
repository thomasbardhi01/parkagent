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
import { z } from "zod";

import { coveredCitiesSentence, providerForCity } from "../../providers/registry.js";
import { explainDecision } from "../explanations.js";
import type { GarageProvider } from "../garage/garageProvider.js";
import type { GeocodeResult, GeocoderProvider } from "./geocoder.js";
import { homeMetroForPoint, metersBetween, metroForPoint } from "./geocoder.js";
import { choiceLabel, choiceReply, classifyPlaceMatches, nameTokens } from "./placeMatch.js";
import type { ModelClient, ModelUsage } from "./loop.js";
import { easternIso, parseEasternTime } from "../hours.js";
import type { HoursInterval } from "../hours.js";
import type { LinkWallet } from "../link/linkWallet.js";
import type { PolicyService } from "../policy.js";
import { priceStay } from "../quote.js";
import { spentToday } from "../sessions.js";
import type { CandidateFetcher } from "../zoneLookup.js";
import { lookupRadiusM, resolveCandidates } from "../zoneLookup.js";
import { applyObservedToCandidates } from "../zoneTermsObserved.js";
import { currentTimeLine } from "./loop.js";
import {
  MODEL_PLAN_JSON_SCHEMA,
  itineraryTotalUsd,
  orderStopsByArrival,
  planSchema,
} from "./plans.js";
import type {
  AssistantPlanBody,
  EditedItineraryStop,
  ItineraryStop,
  SingleSpotOption,
  SingleSpotPlan,
} from "./plans.js";
import type { GarageOption } from "../garage/garageProvider.js";
import type { StayPrice } from "../quote.js";
import type { Candidate } from "../zoneLookup.js";

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
  /** The cheap EXPLAIN_MODEL transport. Absent → explain_decision returns
   * the plain template sentence unphrased. */
  explainModel?: ModelClient | undefined;
  now?: (() => Date) | undefined;
}

/** One zone quote_street found — what a street option is grounded in. */
export interface StreetQuote {
  zoneId: string;
  costUsd: number;
  /** The point quote_street was asked about — the option's map pin. */
  lat?: number | undefined;
  lng?: number | undefined;
}

/** The place geocode_place resolved — the card's destination pin. */
export interface GeocodedPlace {
  lat: number;
  lng: number;
  label: string;
}

/** The latest garage search — the card's "checked 2:05 PM". */
export interface GarageSearchStamp {
  provider: string;
  searchedAt: string;
}

/**
 * Per-turn state the tools read and write. The grounding fields are this
 * CONVERSATION's so far: the loop seeds them from the stored transcript
 * (so a follow-up turn, or another server machine, sees what earlier turns
 * found) and the tools append as they run. propose_plan grounds and
 * backfills plans from them — models drop optional fields routinely.
 */
export interface ToolContext {
  userId: string;
  conversationId: string;
  /** The phone's location when the message was sent, if it sent one. */
  location?: { lat: number; lng: number } | undefined;
  /** Street quotes: a street option's zoneId and map pin come from here. */
  streetQuotes?: StreetQuote[] | undefined;
  /** The latest geocode_place match. */
  geocode?: GeocodedPlace | undefined;
  /** The latest search_garages. */
  garageSearch?: GarageSearchStamp | undefined;
  /** This turn's ambiguous place matches, if a search found several — the
   * suggestions the loop offers when the model asks in prose instead of
   * calling ask_user. */
  placeChoices?: Suggestion[] | undefined;
  /** Model calls a tool makes on its own (explain_decision's phrasing)
   * report here, so the turn's accounting row — and the daily spend cap
   * that reads it — counts them too. */
  onModelUsage?: ((usage: ModelUsage) => void) | undefined;
}

/** One tappable answer to a clarifying question: the chip's text and the
 * message it sends. */
export interface Suggestion {
  label: string;
  reply: string;
}

/** A clarifying question with its tappable answers — ask_user's exit. */
export interface Ask {
  question: string;
  suggestions: Suggestion[];
}

/** What a tool hands back to the loop. `endTurn` is propose_plan's exit,
 * `ask` is ask_user's; either ends the turn. */
export interface ToolOutcome {
  result: unknown;
  endTurn?: { planId: string; plan: AssistantPlanBody };
  ask?: Ask;
}

const askSchema = z.object({
  question: z.string().min(1).max(300),
  suggestions: z
    .array(z.object({ label: z.string().min(1).max(60), reply: z.string().min(1).max(200) }))
    .min(2)
    .max(4),
});

/** "LoLa 42, Seaport" — a found place as the card's destination label;
 * a source that gives no name keeps its own display name. */
function placeLabel(place: GeocodeResult): string {
  if (!place.name) return place.displayName;
  return place.area && place.area !== place.name ? `${place.name}, ${place.area}` : place.name;
}

/** What the model sees of a found place. */
function placeSummary(place: GeocodeResult) {
  return {
    lat: place.lat,
    lng: place.lng,
    displayName: placeLabel(place),
    name: place.name ?? null,
    address: place.address ?? null,
    area: place.area ?? null,
    kind: place.kind ?? null,
    city: place.city,
  };
}

export const CONFIRMATION_TTL_MS = 10 * 60_000;

/** Anthropic tool definitions (Messages API shape). Kept in one place so
 * the schema tests pin exactly what the model sees. */
export const TOOL_DEFINITIONS = [
  {
    name: "geocode_place",
    description: `Resolve a NAMED place to coordinates — a restaurant, bar, venue, business, hotel, landmark, street, or neighborhood — biased to the phone's city among the cities ParkAgent covers (${coveredCitiesSentence()}). Call this FIRST whenever the user names a place instead of relying on their current location, passing their words including any area they named (e.g. 'Lola 42 Seaport'). Answers: found with match "exact" → use place.lat/lng; match "closest" → the NAME wasn't found, only the nearest thing (tell the user); ambiguous with choices → call ask_user with those choices; found:false → couldn't find it. Then pass the place's lat/lng to quote_street or search_garages.`,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "The named place in the user's words, with any area they named: e.g. 'Lola 42 Seaport', 'Moo steakhouse Seaport', 'Newbury Street', 'SoHo'",
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
      "Search off-street garages near a point for a time window. Returns up to 8 options with price, walk time, entry type, and a checkout deep link. Sources: SpotHero and ParkWhiz, merged — each option names its provider, and checkout is a deep link to that site (the user finishes the purchase there). For a NAMED area, geocode_place it first and pass within_m: 600 so every option is walkable from that place.",
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
      "Present the final plan to the user as cards and END your turn. Single-spot: up to 3 options, exactly one recommended; a street option carries the zoneId quote_street returned, a garage option the garageOptionId search_garages returned. Itinerary: the per-stop choices with costs and the day total. Nothing is booked or paid by this tool — the user must tap Confirm/Sign off.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["plan"],
      properties: {
        plan: {
          ...MODEL_PLAN_JSON_SCHEMA,
          description: "The plan: a single_spot plan (1–3 options) or an itinerary (1–12 stops)",
        },
      },
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user ONE short clarifying question with 2–4 tappable suggestions, and END your turn. Use it whenever you must ask something instead of asking in prose: which of several matching places (use geocode_place's choices: their label and reply exactly), what time, how long, or which city (only when there's no phone location). In the question, state what you already assumed.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["question", "suggestions"],
      properties: {
        question: { type: "string", description: "One short question" },
        suggestions: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "reply"],
            properties: {
              label: { type: "string", description: "The chip's text, a few words" },
              reply: {
                type: "string",
                description: "The message sent when the user taps it, in their voice",
              },
            },
          },
        },
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
        zone: { type: "string", description: "Zone id, as returned by quote_street" },
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

/** Fill each street option's missing zoneId from the conversation's
 * quotes: a quoted zone the option's id names (prod's sonnet-5 put the
 * zone there), else the only zone quoted, else the only zone quoted at
 * the option's price. Anything else is ambiguous — the model must say. */
export function groundStreetOptions(
  options: SingleSpotOption[],
  quotes: StreetQuote[],
): { ok: true; options: SingleSpotOption[] } | { ok: false; optionId: string } {
  const zones = new Set(quotes.map((q) => q.zoneId));
  const grounded: SingleSpotOption[] = [];
  for (const option of options) {
    if (option.type !== "street" || option.zoneId) {
      grounded.push(option);
      continue;
    }
    const atPrice = new Set(
      quotes.filter((q) => Math.abs(q.costUsd - option.priceUsd) < 0.005).map((q) => q.zoneId),
    );
    const zoneId = zones.has(option.id)
      ? option.id
      : zones.size === 1
        ? [...zones][0]
        : atPrice.size === 1
          ? [...atPrice][0]
          : null;
    if (!zoneId) return { ok: false, optionId: option.id };
    grounded.push({ ...option, zoneId });
  }
  return { ok: true, options: grounded };
}

const TIME_FORMAT_HINT =
  "Send times as ISO 8601 with the UTC offset, e.g. 2026-09-26T18:00:00-04:00.";

/** What a street stay costs at a point and window — found or not. */
type StreetPrice =
  | { found: false }
  | {
      found: true;
      zone: Candidate & { termsSource?: "observed" | "dataset" };
      price: StayPrice;
      clampedMinutes: number;
      ambiguous: boolean;
    };

/**
 * An itinerary stop priced by the server. The client's costUsd, zoneId,
 * garageOptionId, and deepLink are never read: a stop keeps its previous
 * SERVER value when nothing that sets the price changed, or is re-quoted
 * the way build_itinerary quotes it (the nearest zone for street, the
 * search's first option for a garage).
 */
export type PricedStop = Omit<ItineraryStop, "arrival"> & {
  arrival: string | null;
  /** The price is a carry-over, not a fresh quote for these inputs: the
   * stop has no set time, or the quote couldn't be made (no zone there,
   * no garage, or the garage search was down). */
  estimate?: true;
};

/** The server's previous version of a stop: a plan stop or a stored
 * itinerary stop (whose arrival may be null, and which may carry an
 * estimate flag from an earlier re-price). */
export type PreviousStop = Partial<Omit<ItineraryStop, "arrival">> & {
  arrival?: string | null;
  estimate?: boolean;
};

export interface RepriceResult {
  stops: PricedStop[];
  /** Ids actually re-quoted (their price-setting inputs changed). */
  repriced: string[];
  /** Ids that kept a carried-over price, and why. */
  estimates: { id: string; reason: "untimed" | "no_zone" | "no_garage" | "search_unavailable" }[];
}

/** Arrival as an instant; null for no set time (or an unreadable one). */
function arrivalInstant(arrival: string | null | undefined): number | null {
  return arrival ? (parseEasternTime(arrival)?.getTime() ?? null) : null;
}

/** Whether any input that sets a stop's price changed. */
function priceInputsChanged(
  edited: EditedItineraryStop,
  previous: {
    arrival?: string | null;
    durationMinutes: number;
    choice: string;
    lat: number;
    lng: number;
  },
): boolean {
  return (
    edited.choice !== previous.choice ||
    edited.durationMinutes !== previous.durationMinutes ||
    edited.lat !== previous.lat ||
    edited.lng !== previous.lng ||
    arrivalInstant(edited.arrival) !== arrivalInstant(previous.arrival)
  );
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
        case "ask_user":
          return await this.askUser(ctx, input);
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
    const starts = parseEasternTime(startsAt);
    if (!starts) {
      return this.audit(ctx, tool, input, "unreadable_time", { startsAt }).then(() => ({
        result: {
          error: "unreadable_time",
          value: startsAt,
          instruction: `Couldn't read that time. ${TIME_FORMAT_HINT} ${currentTimeLine(at)}`,
        },
      }));
    }
    if (at.getTime() - starts.getTime() <= 60 * 60_000) return null;
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
    // Bias order: the model's explicit choice, else the metro the phone
    // is in or near — "Seaport" from a Braintree phone searches Boston
    // first, and never comes back as a which-city question.
    const phoneMetro = ctx.location ? homeMetroForPoint(ctx.location.lat, ctx.location.lng) : null;
    const city = cityRaw === "nyc" || cityRaw === "bos" ? cityRaw : (phoneMetro ?? undefined);
    // Search around the phone only when it's inside that metro; a phone
    // outside the box (Braintree) searches around the city's center.
    const near =
      ctx.location && city && metroForPoint(ctx.location.lat, ctx.location.lng) === city
        ? ctx.location
        : undefined;
    const outcome = await this.deps.geocoder.geocode(
      {
        query,
        ...(city ? { city } : {}),
        ...(near ? { near } : {}),
        ...(ctx.location ? { userLocation: ctx.location } : {}),
      },
      5,
    );
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
    const phoneCity = phoneMetro ? providerForCity(phoneMetro)?.cityDisplayName : undefined;
    const match = classifyPlaceMatches(query, outcome.results);
    if (match.kind === "none") {
      await this.audit(ctx, "geocode_place", input, "no_match", { query });
      return {
        result: {
          found: false,
          instruction:
            `Couldn't find "${query}" in ${coveredCitiesSentence()}. Tell the user plainly and ask for its street address or a cross street. ` +
            "Never substitute the phone's location or a neighborhood center for a place you couldn't find" +
            (phoneCity
              ? `, and don't ask which city — the phone is in or near ${phoneCity}.`
              : "."),
        },
      };
    }
    if (match.kind === "ambiguous") {
      const choices = match.choices.map((place) => ({
        label: choiceLabel(place),
        reply: choiceReply(place),
        lat: place.lat,
        lng: place.lng,
      }));
      ctx.placeChoices = choices.map(({ label, reply }) => ({ label, reply }));
      await this.audit(ctx, "geocode_place", input, "ambiguous", { query, choices });
      return {
        result: {
          found: true,
          ambiguous: true,
          choices,
          instruction: `Several places match "${query}". Call ask_user now with one suggestion per choice, using each choice's label and reply exactly. Don't pick one yourself.`,
        },
      };
    }
    const place = match.place;
    const summary = placeSummary(place);
    await this.audit(ctx, "geocode_place", input, match.nameMatched ? "ok" : "closest_only", {
      query,
      count: outcome.results.length,
      top: summary,
      source: place.source ?? null,
    });
    // Remember the resolved place so propose_plan can pin it as the
    // card's destination even when the model drops the optional field.
    ctx.geocode = { lat: place.lat, lng: place.lng, label: summary.displayName };
    const named = nameTokens(query).length > 0 ? `"${query}"` : "that place";
    return {
      result: {
        found: true,
        match: match.nameMatched ? "exact" : "closest",
        place: summary,
        // The shape earlier turns stored (groundingIn reads results[0]).
        results: [summary],
        ...(match.nameMatched
          ? {}
          : {
              instruction:
                `No place called ${named} was found — the closest result is ${summary.displayName}` +
                `${place.kind === "area" ? " (an area, not the place they named)" : ""}. ` +
                `Tell the user you couldn't find ${named} and that you're searching around ${summary.displayName} instead, or ask for the address. ` +
                `Never present ${summary.displayName} as the place they named.`,
            }),
      },
    };
  }

  /** A clarifying question with tappable answers; ends the turn like
   * propose_plan. */
  private async askUser(ctx: ToolContext, input: unknown): Promise<ToolOutcome> {
    const parsed = askSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: {
          error: "invalid ask",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 6),
        },
      };
    }
    await this.audit(ctx, "ask_user", input, "asked", {
      suggestions: parsed.data.suggestions.length,
    });
    return { result: { presented: true }, ask: parsed.data };
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
    // One canonical form for the window (NYC offset spelled out): the
    // providers read it, the cache keys on it, and the checkout links
    // carry it — an offset-less or UTC string meant a different hour to
    // each of them.
    const starts = parseEasternTime(String(input["starts_at"]))!;
    const ends = parseEasternTime(String(input["ends_at"] ?? ""));
    if (!ends || ends.getTime() <= starts.getTime()) {
      await this.audit(ctx, "search_garages", input, "bad_window", {});
      return {
        result: {
          error: "bad_window",
          instruction: `ends_at must be a readable time after starts_at. ${TIME_FORMAT_HINT}`,
        },
      };
    }
    const anchorLat = num(input["lat"]);
    const anchorLng = num(input["lng"]);
    const withinM = input["within_m"] !== undefined ? num(input["within_m"]) : null;
    const outcome = await this.deps.garage.search({
      lat: anchorLat,
      lng: anchorLng,
      startsAt: easternIso(starts),
      endsAt: easternIso(ends),
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
    let nearestBeyondM: number | null = null;
    if (withinM !== null && Number.isFinite(withinM)) {
      const measured = options.map((o) => ({
        option: o,
        d:
          typeof o.lat === "number" && typeof o.lng === "number"
            ? metersBetween(anchorLat, anchorLng, o.lat, o.lng)
            : o.distanceM,
      }));
      const near = measured.filter((m) => m.d <= withinM);
      const far = measured.filter((m) => m.d > withinM);
      droppedFar = far.length;
      if (far.length > 0) {
        nearestBeyondM = Math.round(Math.min(...far.map((m) => m.d)));
      }
      options = near.map((m) => m.option);
    }
    const searchedAt = this.now().toISOString();
    ctx.garageSearch = { provider: this.deps.garage.id, searchedAt };
    await this.audit(ctx, "search_garages", input, "ok", {
      provider: this.deps.garage.id,
      count: options.length,
      fromCache: outcome.fromCache,
      ...(withinM !== null ? { withinM, droppedFar } : {}),
      ...(outcome.degraded?.length ? { degraded: outcome.degraded } : {}),
    });
    return {
      result: {
        provider: this.deps.garage.id,
        searchedAt,
        options,
        ...(droppedFar > 0 ? { droppedForDistance: droppedFar } : {}),
        // How far the closest too-far garage is, so the model can say
        // "the nearest is about 900 m away" instead of "none found".
        ...(nearestBeyondM !== null ? { nearestBeyondM } : {}),
        ...(options.length === 0 && droppedFar > 0
          ? {
              instruction: `No garage within ${withinM} m of that place; the nearest is about ${nearestBeyondM} m away. Tell the user that distance — do not say none were found.`,
            }
          : {}),
        // Providers that failed while others answered — mention reduced
        // coverage when it matters.
        ...(outcome.degraded?.length ? { degraded: outcome.degraded } : {}),
      },
    };
  }

  /**
   * The one street pricing path — quote_street, build_itinerary, and the
   * re-pricing of an edited itinerary all come through here. The nearest
   * zone within 25 m, provider-observed terms over the dataset (e.g.
   * Boston's real "Max 5 Hr" vs the data's assumed 2-hour cap — the same
   * override /parked and session start apply), the stay clamped to the
   * zone's max, priced through the ladder at that time.
   */
  private async priceStreet(
    lat: number,
    lng: number,
    when: Date,
    minutes: number,
  ): Promise<StreetPrice> {
    const policy = this.deps.policy.get();
    const raw = await this.deps.findCandidates({ lat, lng, radiusM: lookupRadiusM(25) });
    const found = await applyObservedToCandidates(this.deps.db, raw);
    const resolution = resolveCandidates(found, when, policy.respect_enforcement_hours);
    if (resolution.kind === "unknown") return { found: false };
    const zone = resolution.nearest;
    const clampedMinutes = Math.min(minutes, zone.maxStayMinutes ?? minutes);
    const price = priceStay(
      {
        city: zone.city,
        rateFirstHourUsd: zone.rateFirstHourUsd,
        rateAdditionalHourUsd: zone.rateAdditionalHourUsd,
        hours: zone.hours as HoursInterval[],
      },
      policy,
      when,
      clampedMinutes,
    );
    return { found: true, zone, price, clampedMinutes, ambiguous: resolution.kind === "disagree" };
  }

  /** The garage search build_itinerary runs for a stop's window, in the
   * canonical ET form the providers and the cache key on. */
  private searchGarageWindow(lat: number, lng: number, arrivalAt: Date, minutes: number) {
    return this.deps.garage.search({
      lat,
      lng,
      startsAt: easternIso(arrivalAt),
      endsAt: easternIso(new Date(arrivalAt.getTime() + minutes * 60_000)),
    });
  }

  /**
   * Price an edited itinerary's stops on the server. `previous` holds the
   * SERVER's version of each stop (the proposed plan's, or the stored
   * itinerary's), by id. The client's cost, zone, and garage fields are
   * never read:
   *  - nothing that sets the price changed (time, duration, street vs
   *    garage, position) → the previous server price and fields;
   *  - no set time → the last price, marked an estimate (pricing needs a
   *    time);
   *  - otherwise re-quoted like build_itinerary: street at the nearest
   *    zone for the new window; garage = the search's first option for
   *    the new window (its id, link, and price). A quote that can't be
   *    made keeps the last price, marked an estimate.
   * The arrival comes back canonical (ET with its offset) or null.
   */
  async repriceStops(
    edited: EditedItineraryStop[],
    previous: ReadonlyMap<string, PreviousStop>,
  ): Promise<RepriceResult> {
    const stops: PricedStop[] = [];
    const repriced: string[] = [];
    const estimates: RepriceResult["estimates"] = [];
    for (const stop of edited) {
      const prior = previous.get(stop.id);
      const arrivalAt = stop.arrival ? parseEasternTime(stop.arrival) : null;
      const base = {
        id: stop.id,
        label: stop.label,
        address: stop.address,
        lat: stop.lat,
        lng: stop.lng,
        arrival: arrivalAt ? easternIso(arrivalAt) : null,
        durationMinutes: stop.durationMinutes,
        choice: stop.choice,
      };
      /** The server's previous price and fields, carried over. */
      const carried = (estimate: boolean): PricedStop => ({
        ...base,
        costUsd: typeof prior?.costUsd === "number" ? prior.costUsd : 0,
        ...(prior?.zoneId ? { zoneId: prior.zoneId } : {}),
        ...(prior?.garageOptionId ? { garageOptionId: prior.garageOptionId } : {}),
        ...(prior?.deepLink ? { deepLink: prior.deepLink } : {}),
        ...(estimate || prior?.estimate === true ? { estimate: true as const } : {}),
      });
      if (!arrivalAt) {
        stops.push(carried(true));
        estimates.push({ id: stop.id, reason: "untimed" });
        continue;
      }
      if (
        prior &&
        typeof prior.durationMinutes === "number" &&
        (prior.choice === "street" || prior.choice === "garage") &&
        typeof prior.lat === "number" &&
        typeof prior.lng === "number" &&
        !priceInputsChanged(stop, {
          arrival: prior.arrival ?? null,
          durationMinutes: prior.durationMinutes,
          choice: prior.choice,
          lat: prior.lat,
          lng: prior.lng,
        })
      ) {
        stops.push(carried(false));
        continue;
      }
      repriced.push(stop.id);
      if (stop.choice === "street") {
        const priced = await this.priceStreet(stop.lat, stop.lng, arrivalAt, stop.durationMinutes);
        if (!priced.found) {
          stops.push(carried(true));
          estimates.push({ id: stop.id, reason: "no_zone" });
          continue;
        }
        stops.push({ ...base, costUsd: priced.price.totalUsd, zoneId: priced.zone.zoneId });
        continue;
      }
      const garages = await this.searchGarageWindow(
        stop.lat,
        stop.lng,
        arrivalAt,
        stop.durationMinutes,
      );
      const option: GarageOption | undefined = garages.ok ? garages.options[0] : undefined;
      if (!option) {
        stops.push(carried(true));
        estimates.push({ id: stop.id, reason: garages.ok ? "no_garage" : "search_unavailable" });
        continue;
      }
      stops.push({
        ...base,
        costUsd: option.priceUsd,
        garageOptionId: option.id,
        deepLink: option.deepLink,
      });
    }
    return { stops, repriced, estimates };
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
    // Readable by construction: pastWindowError bounced anything else.
    const when = parseEasternTime(String(input["when"]))!;
    const priced = await this.priceStreet(lat, lng, when, minutes);
    if (!priced.found) {
      await this.audit(ctx, "quote_street", input, "unknown_zone", {});
      return { result: { found: false, reason: "no metered zone within 25 m of that point" } };
    }
    const { zone, price } = priced;
    const result = {
      found: true,
      zoneId: zone.zoneId,
      city: zone.city,
      zoneNumber: zone.providerZoneNumber || null,
      maxStayMinutes: zone.maxStayMinutes,
      ambiguousWithOtherSide: priced.ambiguous,
      clampedMinutes: priced.clampedMinutes,
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
    // The quoted point becomes the street option's map pin.
    (ctx.streetQuotes ??= []).push({ zoneId: zone.zoneId, costUsd: price.totalUsd, lat, lng });
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
      const arrivalAt = parseEasternTime(String(stop["arrival"]));
      if (!arrivalAt) {
        await this.audit(ctx, "build_itinerary", { stopCount: stops.length }, "unreadable_time", {
          arrival: stop["arrival"],
        });
        return {
          result: {
            error: "unreadable_time",
            value: stop["arrival"],
            instruction: `Couldn't read that arrival time. ${TIME_FORMAT_HINT}`,
          },
        };
      }
      const arrival = easternIso(arrivalAt);
      const minutes = num(stop["duration_minutes"]);
      const street = await this.quoteStreet(ctx, {
        lat: stop["lat"],
        lng: stop["lng"],
        duration_minutes: minutes,
        when: arrival,
      });
      const garages = await this.searchGarageWindow(
        num(stop["lat"]),
        num(stop["lng"]),
        arrivalAt,
        minutes,
      );
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
      const unreadable = plan.stops.find((stop) => !parseEasternTime(stop.arrival));
      if (unreadable) {
        return {
          result: {
            error: "unreadable_time",
            stopId: unreadable.id,
            value: unreadable.arrival,
            instruction: `Couldn't read that stop's arrival. ${TIME_FORMAT_HINT}`,
          },
        };
      }
      plan = {
        ...plan,
        totalUsd,
        capUsd: policy.daily_cap_usd,
        // Stored in arrival order, whatever order the model listed them
        // in: the card shows the day as it will happen.
        stops: orderStopsByArrival(plan.stops).map((stop) => {
          // Arrivals are stored in one canonical form: the itinerary tick
          // pushes each garage link 15 minutes before this instant, and an
          // offset-less string meant a different instant on every host.
          const arrival = easternIso(parseEasternTime(stop.arrival)!);
          // A garage stop's link is pushed to the phone later — it comes
          // from the search cache, never from model text.
          const rest = { ...stop };
          delete rest.deepLink;
          const cached =
            stop.choice === "garage" && stop.garageOptionId
              ? this.deps.garage.optionById(stop.garageOptionId)
              : null;
          return { ...rest, arrival, ...(cached ? { deepLink: cached.deepLink } : {}) };
        }),
      };
    } else {
      // FR-26: a street option carries the zone quote_street quoted.
      // Models drop the optional zoneId, or rename it and zod strips the
      // unknown key, so a missing one is re-attached from this
      // conversation's quotes; one with nothing to ground it in bounces
      // back to the model instead of reaching a card with no zone.
      const quotes = ctx.streetQuotes ?? [];
      const grounded = groundStreetOptions(plan.options, quotes);
      if (!grounded.ok) {
        const quotedZoneIds = [...new Set(quotes.map((q) => q.zoneId))];
        await this.audit(ctx, "propose_plan", input, "ungrounded_street_option", {
          optionId: grounded.optionId,
          quotedZoneIds,
        });
        return {
          result: {
            error: "street_option_ungrounded",
            optionId: grounded.optionId,
            quotedZoneIds,
            hint:
              quotes.length === 0
                ? "quote this spot with quote_street first, then propose with the zoneId it returned"
                : "set zoneId on the street option to the zoneId quote_street returned for it",
          },
        };
      }
      plan = { ...plan, options: grounded.options };
      // The same rule for garages: an option is a search_garages result
      // or it isn't on the card. Its price, link, source, and pin are the
      // search's, never model text — a model-typed deepLink would open
      // whatever URL it wrote, and become the Link merchant URL.
      const garageMisses = plan.options.filter(
        (o) => o.type === "garage" && !this.deps.garage.optionById(o.garageOptionId ?? o.id),
      );
      if (garageMisses.length > 0) {
        await this.audit(ctx, "propose_plan", input, "ungrounded_garage_option", {
          optionIds: garageMisses.map((o) => o.id),
        });
        return {
          result: {
            error: "garage_option_ungrounded",
            optionIds: garageMisses.map((o) => o.id),
            hint: "set garageOptionId to an option id from a search_garages result (search again if it's been a while), then propose again",
          },
        };
      }
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
      // Street options pin at the point their own zone was quoted, and
      // the plan carries destination + provenance from this
      // conversation's grounding when the model left them off.
      const at = this.now().getTime();
      // Which sources the SURFACED options actually came from — with two
      // providers merged, the aggregate search id ("spothero+parkwhiz")
      // would credit a source whose option didn't make the card.
      const shownProviders = new Set<string>();
      plan = {
        ...plan,
        options: plan.options.map((o) => {
          if (o.type !== "street") {
            const cached = this.deps.garage.optionById(o.garageOptionId ?? o.id)!;
            shownProviders.add(cached.provider);
            return {
              ...o,
              garageOptionId: cached.id,
              priceUsd: cached.priceUsd,
              provider: cached.provider,
              deepLink: cached.deepLink,
              payOnArrival: false,
              ...(cached.lat !== undefined && cached.lng !== undefined
                ? { lat: cached.lat, lng: cached.lng }
                : {}),
            };
          }
          // A street option has no checkout link or garage source; model
          // text in either would reach the Link merchant fields.
          const rest = { ...o };
          delete rest.startsAt;
          delete rest.provider;
          delete rest.deepLink;
          const starts = o.startsAt ? parseEasternTime(o.startsAt) : null;
          const future = starts !== null && starts.getTime() - at > 15 * 60_000;
          const pin = [...(ctx.streetQuotes ?? [])]
            .reverse()
            .find((q) => q.zoneId === o.zoneId && q.lat !== undefined && q.lng !== undefined);
          return {
            ...rest,
            // One canonical form, so the phone parses what the server did.
            ...(starts ? { startsAt: easternIso(starts) } : {}),
            payOnArrival: future,
            ...(o.lat === undefined && pin ? { lat: pin.lat!, lng: pin.lng! } : {}),
          };
        }),
        ...(plan.destination === undefined && ctx.geocode ? { destination: ctx.geocode } : {}),
      };
      // Provenance is server truth, never model text.
      delete plan.provenance;
      if (shownProviders.size > 0 && ctx.garageSearch) {
        plan.provenance = {
          provider: [...shownProviders].sort().join("+"),
          searchedAt: ctx.garageSearch.searchedAt,
        };
      }
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
   * user's tap, unused, unexpired, owned by this user, and for THIS call —
   * the tool's input must be the option the tap confirmed — or a refusal
   * the model can read. Claims the token atomically on success
   * (single-use even under concurrent calls). */
  private async consumeConfirmation(
    ctx: ToolContext,
    token: unknown,
    tool: "book_garage" | "start_session",
    input: Record<string, unknown>,
  ): Promise<
    { ok: true; planId: string; optionId: string | null } | { ok: false; result: unknown }
  > {
    const refusal = async (why: string) => {
      await this.audit(ctx, tool, input, "needs_confirmation", { refused: why });
      return {
        ok: false as const,
        result: {
          error: "needs_confirmation",
          message: `${why}. Nothing books or spends without the user's explicit Confirm tap on a proposed plan.`,
        },
      };
    };
    if (typeof token !== "string" || token.length === 0) {
      return refusal("no confirmation_token was provided");
    }
    const row = await this.deps.db.assistantConfirmation.findUnique({ where: { token } });
    if (!row || row.userId !== ctx.userId) return refusal("the confirmation token is not valid");
    if (row.usedAt !== null) return refusal("the confirmation token was already used");
    const now = this.now();
    if (row.expiresAt.getTime() <= now.getTime()) {
      return refusal("the confirmation token expired — propose the plan again");
    }
    // The token authorizes the option that was tapped, not "a" booking.
    const planRow = await this.deps.db.assistantPlan.findUnique({ where: { id: row.planId } });
    const option =
      planRow?.kind === "single_spot"
        ? (planRow.plan as SingleSpotPlan).options.find((o) => o.id === row.optionId)
        : undefined;
    const matches =
      option !== undefined &&
      (tool === "book_garage"
        ? option.type === "garage" &&
          String(input["option_id"]) === (option.garageOptionId ?? option.id)
        : option.type === "street" &&
          String(input["zone"]) === option.zoneId &&
          num(input["duration_minutes"]) === option.durationMinutes);
    if (!matches) return refusal("the confirmation token is for a different option");
    const claimed = await this.deps.db.assistantConfirmation.updateMany({
      where: { token, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return refusal("the confirmation token was already used");
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
        paymentSource: s.paymentSource ?? "provider_card",
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
    const template = explainDecision(row);
    // Phrasing runs on the cheap EXPLAIN_MODEL; the template is the
    // factual floor — a phrasing failure falls back to it, and the model
    // is told to add nothing the template doesn't say.
    let text = template;
    if (this.deps.explainModel) {
      try {
        const phrased = await this.deps.explainModel.create({
          system:
            "Rewrite the given parking-decision record as one or two friendly plain-English sentences. State only facts present in the input — never add, guess, or soften facts. No preamble.",
          messages: [{ role: "user", content: template }],
          maxTokens: 300,
        });
        // A paid call like any other: it counts toward this turn's spend.
        ctx.onModelUsage?.({
          model: phrased.model ?? "unknown",
          inputTokens: phrased.usage?.inputTokens ?? 0,
          outputTokens: phrased.usage?.outputTokens ?? 0,
        });
        const joined = phrased.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        if (joined.length > 0) text = joined;
      } catch {
        // Fall back to the template — an explanation must never fail the turn.
      }
    }
    await this.audit(ctx, "explain_decision", input, "ok", {
      phrased: text !== template,
    });
    return { result: { explanation: text } };
  }
}
