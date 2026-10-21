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
import type { GeocodeFailure, GeocodeQuery, GeocodeResult, GeocoderProvider } from "./geocoder.js";
import { biasPointFor, homeMetroForPoint, metersBetween, metroForPoint } from "./geocoder.js";
import {
  STAY_QUESTION,
  STAY_SUGGESTIONS,
  asksAboutStay,
  assumptionsFor,
  windowAssumption,
} from "./clarify.js";
import {
  TIME_IN_PAST_MS,
  heldToItsStart,
  intentOf,
  stayFor,
  toolAllowed,
  toolOffInstruction,
} from "./intentRouter.js";
import { requestedTimeProblem, type TimeRequest } from "./requestedTime.js";
import {
  MAX_REQUEST_EDITS_PER_TURN,
  UPDATE_REQUEST_INPUT_SCHEMA,
  applyPatch,
  applyPlaceResolution,
  emptyState,
  parsePatch,
  setsNothing,
  stateForModel,
  type Kind,
  type PlaceCandidate,
  type RequestState,
} from "./requestState.js";
import { choiceLabel, choiceReply, classifyPlaceMatches, nameTokens } from "./placeMatch.js";
import { bestOf, candidateRecord, scoreCandidates } from "./placeScore.js";
import type { ModelClient, ModelUsage } from "./loop.js";
import { easternIso, parseEasternTime } from "../hours.js";
import type { LinkWallet } from "../link/linkWallet.js";
import { confirmWarnUsd } from "../policy.js";
import type { PolicyService } from "../policy.js";
import { spentToday } from "../sessions.js";
import type { CandidateFetcher, NearbyZoneFetcher } from "../zoneLookup.js";
import { currentTimeLine, scrubUngroundedAmounts } from "./loop.js";
import {
  MODEL_PLAN_JSON_SCHEMA,
  itineraryTotalUsd,
  orderStopsByArrival,
  planSchema,
  proposedPlanSchema,
  recommendationReason,
} from "./plans.js";
import type {
  AssistantPlanBody,
  EditedItineraryStop,
  ItineraryStop,
  NoDataPlan,
  NoneMeetsPlan,
  ProposedPlan,
  SingleSpotOption,
  SingleSpotPlan,
  Violation,
} from "./plans.js";
import type { GarageOption } from "../garage/garageProvider.js";
import {
  buildSearchResult,
  constraintsFailedFor,
  garageSearchOption,
  isFresh,
  isGarageOnly,
  kindsToSearch,
  noneMeetsHeadline,
  poolFromResult,
  poolOptions,
  requestSummaryFor,
  streetSearchOption,
} from "./search.js";
import type {
  GarageSearchMeta,
  SearchOption,
  SearchPlace,
  SearchPool,
  SearchResult,
  SearchWindow,
} from "./search.js";
import type { StreetSearch } from "./streetOptions.js";
import {
  DEFAULT_STREET_RADIUS_M,
  MAX_STREET_RADIUS_M,
  displayStreet,
  nearestPointOn,
  streetOptionsNear,
  streetSummary,
  walkMinutesFor,
} from "./streetOptions.js";
import { policyFor } from "../limits.js";

export interface AssistantDeps {
  db: AppDb;
  policy: PolicyService;
  findCandidates: CandidateFetcher;
  /** Zones with street names and curb geometry (/zones/near's fetcher):
   * street options within a walk of a destination name their street and
   * pin the nearest curb. Absent → findCandidates, pinned at the point. */
  findNearbyZones?: NearbyZoneFetcher | undefined;
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

/**
 * Per-turn state the tools read and write. The request and the latest
 * search are this CONVERSATION's so far: the loop loads the request from
 * its row and the search from the stored transcript (so a follow-up turn,
 * or another server machine, sees what earlier turns found), and the tools
 * replace them as they run.
 */
export interface ToolContext {
  userId: string;
  conversationId: string;
  /** The phone's location when the message was sent, if it sent one. */
  location?: { lat: number; lng: number } | undefined;
  /** The latest search of the request (search.ts): what propose_plan
   * accepts options from, at the request's current version only. */
  lastSearch?: SearchResult | undefined;
  /** Everything this turn's searches found at one version, before it was
   * cut to what the model is shown: what relaxing a limit is counted over. */
  searchPool?: SearchPool | undefined;
  /** Searches run this turn. A turn that searched owes the user a card. */
  searchesThisTurn?: number | undefined;
  /** This turn's ambiguous place matches, if a search found several — the
   * suggestions the loop offers when the model asks in prose instead of
   * calling ask_user. */
  placeChoices?: Suggestion[] | undefined;
  /** Place lookups made this turn, by query: the search that finds the
   * request's place unresolved never looks the same words up twice. */
  placeLookups?: Map<string, PlaceLookup> | undefined;
  /** Model calls a tool makes on its own (explain_decision's phrasing)
   * report here, so the turn's accounting row — and the daily spend cap
   * that reads it — counts them too. */
  onModelUsage?: ((usage: ModelUsage) => void) | undefined;
  /** The clock time this turn's message asked for (requestedTime.ts):
   * searches and single-spot plans must honor it, never move it to now. */
  timeRequest?: TimeRequest | undefined;
  /** The conversation's request (requestState.ts), loaded from its row
   * before the turn; update_request (and a place lookup) replace it, and
   * the loop saves it. Absent → the empty request. */
  requestState?: RequestState | undefined;
  /** update_request calls so far this turn — refused past the limit. */
  requestEdits?: number | undefined;
  /** Set when this turn's message was a tap the server applied to the
   * request itself (a relax chip, FR-45): the tap changed exactly these
   * fields, so update_request is refused for the rest of the turn. */
  requestLock?: { changed: string[] } | undefined;
  /** This turn's user message: the words each request change is logged
   * with. */
  utterance?: string | undefined;
}

/** How a lookup was decided, for its decisions row (FR-44): which source
 * the answer came from, how sure it is, the scored candidates (the best
 * five), and any source that failed on the way — "quota" among them. */
export interface PlaceScoring {
  source: string | null;
  confidence: number | null;
  candidates: { name: string; lat: number; lng: number; score: number }[];
  failures?: GeocodeFailure[];
}

/** What looking a place up came to. The outcome and its confidence are
 * the server's (placeMatch.ts, placeScore.ts): the model reads them and
 * sets neither. */
export type PlaceLookup =
  /** No geocoder is configured, or its sources failed. */
  | { kind: "unavailable"; reason: string }
  | { kind: "none"; scoring: PlaceScoring }
  | { kind: "ambiguous"; choices: PlaceCandidate[]; scores: number[]; scoring: PlaceScoring }
  /** nameMatched false ("closest only"): nothing carried the name;
   * `place` is only the closest thing found, and the user must be told so. */
  | {
      kind: "found";
      place: GeocodeResult;
      nameMatched: boolean;
      confidence: number;
      count: number;
      scoring: PlaceScoring;
    };

/** The four ways a lookup that answered can come out. */
export type PlaceResolution = "found" | "closest_only" | "ambiguous" | "none";

function resolutionOf(lookup: Exclude<PlaceLookup, { kind: "unavailable" }>): PlaceResolution {
  if (lookup.kind === "found") return lookup.nameMatched ? "found" : "closest_only";
  return lookup.kind;
}

/** One tappable answer to a clarifying question: the chip's text and the
 * message it sends. */
export interface Suggestion {
  label: string;
  reply: string;
}

/** A clarifying question with its tappable answers — ask_user's exit,
 * and a search's when the request's place can't be resolved (then the
 * answers are the places it could be, or none at all). */
export interface Ask {
  question: string;
  suggestions: Suggestion[];
  /** The server asked, not the model: the question is the server's own
   * words (it may quote the user's), so the reply check leaves it be. */
  server?: true;
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

/** What the model is told when a lookup found only the closest thing:
 * say so, never present it as the place the user named. */
function closestOnlyInstruction(query: string, place: GeocodeResult): string {
  const named = nameTokens(query).length > 0 ? `"${query}"` : "that place";
  const label = placeLabel(place);
  return (
    `No place called ${named} was found — the closest result is ${label}` +
    `${place.kind === "area" ? " (an area, not the place they named)" : ""}. ` +
    `Tell the user you couldn't find ${named} and that you're searching around ${label} instead, or ask for the address. ` +
    `Never present ${label} as the place they named.`
  );
}

export const CONFIRMATION_TTL_MS = 10 * 60_000;

/**
 * What quote_street and search_garages take: nothing but an optional note
 * (FR-43). The place, the window, the limits, and the ranking are read
 * from the conversation's request, so there is no argument to drop a
 * constraint from. Strict, so the API holds the model to it.
 */
const SEARCH_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: [] as string[],
  properties: {
    note: {
      type: "string",
      description: "Optional, a few words on why you're searching. It changes nothing.",
    },
  },
};

/** Garage options farther than this from a NAMED place are dropped: every
 * option surfaced for a place is walkable from it (FR-23). */
export const NAMED_PLACE_GARAGE_RADIUS_M = 600;
/** Options a walking-time request carries (Apple's limit). */
export const MAX_WALK_TIMED = 10;
/** Walking-time requests a search may make: the options it shows and the
 * nearest, then whatever the real walks brought into view. */
export const MAX_WALK_REQUESTS = 2;
/** How far the "no data" card looks for the nearest zones we do have. */
const NEAREST_ZONE_RADIUS_M = 3000;
/** A start more than this far ahead is paid on arrival, not confirmed now
 * (the same line the request's intent draws). */
const PAY_ON_ARRIVAL_MS = 15 * 60_000;

/** Anthropic tool definitions (Messages API shape). Kept in one place so
 * the schema tests pin exactly what the model sees. */
export const TOOL_DEFINITIONS = [
  {
    name: "update_request",
    description:
      'Record a change to the user\'s parking request — the server-owned state shown as "Current request". Put each change in its own field and send ONLY what changed, never the whole request — e.g. {placeQuery: "Fenway", startsAt: "2026-09-26T19:00:00-04:00", durationMinutes: 120, maxPriceUsd: 20}. A value you send replaces the old one, `clear` removes one, and unmentioned fields keep their values; `reason` is only a note and changes nothing. Call it before searching whenever the user states or changes the place, the time, the stay, a limit (price, walk, garage or street, valet, covered), or a preference (cheapest, closest). The server derives the intent from the time and the kinds; yours is advisory. The result is the full new request, what changed, and any intent the server overrode. At most two calls per turn.',
    strict: true,
    input_schema: UPDATE_REQUEST_INPUT_SCHEMA,
  },
  {
    name: "geocode_place",
    description: `Look up a NAMED place — a restaurant, bar, venue, business, hotel, landmark, street, or neighborhood — and make it the request's place, biased to the phone's city among the cities ParkAgent covers (${coveredCitiesSentence()}). Call this FIRST whenever the user names a place instead of relying on their current location, passing their words including any area they named (e.g. 'Lola 42 Seaport'); quote_street and search_garages then search there. Answers: found with match "exact" → the request's place is set; match "closest" → the NAME wasn't found, only the nearest thing (tell the user); ambiguous with choices → call ask_user with those choices; found:false → couldn't find it. Every answer carries the server's \`resolution\` (found, closest_only, ambiguous, or none) and its 0–1 \`confidence\`: act on the resolution as given — it isn't yours to upgrade.`,
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
      "Off-street garages for the CURRENT REQUEST. Takes no arguments: it reads the place, the time, the stay, the limits, and the ranking from the request — to search another place, time, stay, or budget, change the request first (update_request, geocode_place). Sources: SpotHero and ParkWhiz, merged; each option names its provider, and checkout is a deep link to that site (the user finishes the purchase there). Returns {stateVersion, verdict, satisfying, nearMisses, relaxSuggestions?}: `satisfying` options meet every limit and are already ranked (keep the order); each of `nearMisses` breaks a limit, and its `violates` says which and by how much; the result covers street too once quote_street has run for this request. A garage-only request is answered with garages; the server may add ONE street option to `nearMisses` — a cheaper meter — which is never an option that meets the request. Propose options by `id`.",
    strict: true,
    input_schema: SEARCH_INPUT_SCHEMA,
  },
  {
    name: "quote_street",
    description: `Street parking for the CURRENT REQUEST: every metered block within a walk of the request's place (${DEFAULT_STREET_RADIUS_M} m, about a ${walkMinutesFor(DEFAULT_STREET_RADIUS_M)}-minute walk; wider when that holds none), each priced for the request's window and described for THAT window — free (e.g. "Free after 6 PM"), metered then free, or metered with its rate and max stay. Takes no arguments: it reads the place, the time, the stay, the limits, and the ranking from the request — to search another place, time, stay, or budget, change the request first (update_request, geocode_place). Uses the same zone data and pricing as automatic payments. Not available for a garage-only request. Returns {stateVersion, verdict, satisfying, nearMisses, relaxSuggestions?}: \`satisfying\` options meet every limit and are already ranked (keep the order); each of \`nearMisses\` breaks a limit, and its \`violates\` says which and by how much; the result covers garages too once search_garages has run for this request. Propose options by \`id\`.`,
    strict: true,
    input_schema: SEARCH_INPUT_SCHEMA,
  },
  {
    name: "build_itinerary",
    description:
      "Price a multi-stop day: for each stop, quote street parking AND the best garage, and check the day total against the user's daily cap. Use the result to decide street vs garage per stop before proposing the plan. Available for a request that starts later: put the day's first arrival on the request first (update_request startsAt).",
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
      'Present the final plan to the user as a card and END your turn. Single-spot: up to 3 options from the LATEST search, each named by its `id` exactly as the search returned it — the server attaches the price, walk, time, and link, puts the options in the search\'s order, and recommends the first. An option from `nearMisses` may ride along only with nearMiss: true. When the search\'s verdict is not "meets", send {kind: "none_meets"} instead: the server fills in what came closest and what relaxing a limit would yield. Itinerary: the per-stop choices with costs and the day total. Nothing is booked or paid by this tool — the user must tap Confirm/Sign off.',
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["plan"],
      properties: {
        plan: {
          ...MODEL_PLAN_JSON_SCHEMA,
          description:
            "The plan: a single_spot plan (1–3 options by id), an itinerary (1–12 stops), or none_meets",
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

/** The amounts an option's own words may state, in cents: its price, its
 * meter/fee split, and its hourly rate. */
function ownAmounts(option: SearchOption): Set<number> {
  const cents = (usd: number | undefined) => (usd === undefined ? [] : [Math.round(usd * 100)]);
  return new Set([
    ...cents(option.priceUsd),
    ...cents(option.facts?.meterUsd),
    ...cents(option.facts?.feeUsd),
    ...cents(option.facts?.ratePerHourUsd),
    ...cents(option.facts?.rateAdditionalHourUsd),
  ]);
}

/** A checkout link the card can carry: an https URL. */
function isUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const TIME_FORMAT_HINT =
  "Send times as ISO 8601 with the UTC offset, e.g. 2026-09-26T18:00:00-04:00.";

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
      // The request's intent decides which tools are on (intentRouter.ts).
      // The loop only offers the model those; one called anyway is refused
      // here, before it runs, and the refusal is on the record.
      const intent = intentOf(this.stateOf(ctx));
      if (!toolAllowed(intent, name)) {
        await this.audit(ctx, name, input, "tool_not_available_for_intent", { intent });
        return {
          result: {
            error: "tool_not_available_for_intent",
            intent,
            instruction: toolOffInstruction(intent, name),
          },
        };
      }
      switch (name) {
        case "update_request":
          return await this.updateRequest(ctx, input);
        case "geocode_place":
          return await this.geocodePlace(ctx, input as Record<string, unknown>);
        case "search_garages":
          return await this.searchGarages(ctx, input);
        case "quote_street":
          return await this.quoteStreet(ctx, input);
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
  private pastWindowError(
    ctx: ToolContext,
    tool: string,
    input: unknown,
    startsAt: string,
    /** How to fix it, appended to the instruction: a search reads its
     * start from the request, so the fix is an update_request. */
    fix = "",
    /** V7 (FR-45): the start is one the user set on a later or garage-only
     * request, and is held to five minutes rather than an hour. */
    held = false,
  ) {
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
    // A time the user named is theirs: a quote starting before it — "now",
    // or a 7 PM that has passed today — is refused with the time they
    // asked for (requestedTime.ts). Later windows can be a day's other
    // stops, so only earlier ones are refused here.
    const moved = requestedTimeProblem(ctx.timeRequest, starts, at, { earlierOnly: true });
    if (moved) {
      return this.audit(ctx, tool, input, "requested_time_moved", { startsAt }).then(() => ({
        result: { error: "requested_time_moved", startsAt, instruction: `${moved}${fix}` },
      }));
    }
    if (held) {
      if (at.getTime() - starts.getTime() <= TIME_IN_PAST_MS) return null;
      return this.audit(ctx, tool, input, "time_in_past", { startsAt }).then(() => ({
        result: {
          error: "time_in_past",
          startsAt,
          nowEastern: easternIso(at),
          instruction:
            `The request's start has passed. ${currentTimeLine(at)} ` +
            "If the user means now, clear window.startsAt; if they mean that clock time on a later day, set the new startsAt; " +
            `if you can't tell, ask with ask_user ("Now" / "Tomorrow at …"). Never pick one for them.${fix}`,
        },
      }));
    }
    if (at.getTime() - starts.getTime() <= 60 * 60_000) return null;
    return this.audit(ctx, tool, input, "past_window", { startsAt }).then(() => ({
      result: {
        error: "window_in_the_past",
        startsAt,
        // Not "recompute from the current time": that turned a requested
        // 7 PM that had passed into "now" (nightly 36361125345).
        instruction:
          `That start time is in the past — you guessed the date. ${currentTimeLine(at)} ` +
          "Recompute the DATE from the current time and keep the clock time the user asked for; " +
          "if it has already passed today, use tomorrow and say so, or ask with ask_user " +
          `("Tomorrow at …" / "Now"). Never move a requested time to now.${fix}`,
      },
    }));
  }

  /**
   * update_request: apply the model's patch to the conversation's request
   * (requestState.ts decides what it means). Every call is audited with
   * the patch it sent and what came of it, refusals included, and counts
   * toward the per-turn limit — a malformed call is a call.
   */
  private async updateRequest(ctx: ToolContext, input: unknown): Promise<ToolOutcome> {
    const before = ctx.requestState ?? emptyState();
    const audit = (rule: string, outcome: Record<string, unknown>) =>
      this.deps.db.decision.create({
        data: {
          kind: "assistant_tool",
          inputs: { tool: "update_request", patch: input, conversationId: ctx.conversationId },
          rule,
          outcome,
          userId: ctx.userId,
        },
      });
    // This turn's message was a relax chip, and the server applied it: the
    // user changed exactly that. An edit on top of it could only be the
    // chip's words read as some other field.
    if (ctx.requestLock) {
      await audit("request_already_updated", {
        error: "request_already_updated",
        version: before.version,
        changed: ctx.requestLock.changed,
      });
      return {
        result: {
          error: "request_already_updated",
          changed: ctx.requestLock.changed,
          state: stateForModel(before),
          instruction:
            "The user's tap already changed the request this turn (`changed`), and nothing else about it changed. " +
            "Don't edit it: search the request as it stands.",
        },
      };
    }
    ctx.requestEdits = (ctx.requestEdits ?? 0) + 1;
    if (ctx.requestEdits > MAX_REQUEST_EDITS_PER_TURN) {
      await audit("too_many_edits", { error: "too_many_edits", version: before.version });
      return {
        result: {
          error: "too_many_edits",
          instruction:
            `The request was already edited ${MAX_REQUEST_EDITS_PER_TURN} times this turn. Don't edit it again: ` +
            "go on with the request as it stands (the last update_request result), or ask the user with ask_user.",
        },
      };
    }
    const parsed = parsePatch(input);
    if (!parsed.ok) {
      await audit("invalid_patch", { error: "invalid_patch", issues: parsed.issues });
      return {
        result: {
          error: "invalid_patch",
          issues: parsed.issues,
          instruction:
            'Send only what changed, flat, e.g. {"maxPriceUsd": 20, "reason": "under $20"}. ' +
            "Settable: intent, placeQuery, startsAt, durationMinutes, maxPriceUsd, maxWalkMinutes, kinds, entryType, covered, rank, prefer. " +
            "To remove one, name it in clear.",
        },
      };
    }
    const at = this.now();
    const applied = applyPatch(before, parsed.patch, ctx.utterance ?? "", at);
    if (!applied.ok) {
      if (applied.error === "unreadable_time") {
        await audit("unreadable_time", { error: "unreadable_time", value: applied.value });
        return {
          result: {
            error: "unreadable_time",
            value: applied.value,
            instruction: `Couldn't read that time. ${TIME_FORMAT_HINT} ${currentTimeLine(at)}`,
          },
        };
      }
      await audit("conflicting_patch", { error: "conflicting_patch", fields: applied.fields });
      return {
        result: {
          error: "invalid_patch",
          issues: applied.fields.map((f) => `${f} is both set and cleared`),
          instruction: "Set a field or clear it, not both.",
        },
      };
    }
    ctx.requestState = applied.state;
    const outcome = {
      version: applied.state.version,
      changed: applied.changed,
      overrides: applied.overrides,
    };
    // A note with no field is the live failure mode (the request written
    // into reason): say exactly that, so the next call puts it in fields.
    const empty = applied.changed.length === 0 && setsNothing(parsed.patch);
    await audit(
      applied.changed.length > 0 ? "request_updated" : empty ? "empty_patch" : "request_unchanged",
      outcome,
    );
    return {
      result: {
        ...outcome,
        state: stateForModel(applied.state),
        ...(empty
          ? {
              instruction:
                "This patch set no field, so nothing changed: reason is only a note. Put each change in its own field, " +
                'e.g. {"placeQuery": "Newbury Street", "startsAt": "2026-10-06T14:00:00-04:00", "durationMinutes": 120}.',
            }
          : applied.changed.length === 0
            ? { instruction: "Nothing changed: the request already says that." }
            : {}),
        ...(applied.overrides.length > 0
          ? {
              note: `The intent is ${applied.state.intent}: ${applied.overrides[0]!.why}. The server derives it; change startsAt or kinds to change it.`,
            }
          : {}),
      },
    };
  }

  /**
   * Look a named place up, biased to the covered metros: the geocoder's
   * results classified into one place, several, the closest thing only, or
   * nothing (placeMatch.ts). One lookup per query per turn — geocode_place
   * and a search that finds the request's place unresolved share it.
   */
  private async lookUpPlace(
    ctx: ToolContext,
    query: string,
    cityRaw?: unknown,
  ): Promise<PlaceLookup> {
    const key = `${String(cityRaw ?? "")}:${query.toLowerCase()}`;
    const cached = ctx.placeLookups?.get(key);
    if (cached) return cached;
    const remember = (lookup: PlaceLookup): PlaceLookup => {
      (ctx.placeLookups ??= new Map()).set(key, lookup);
      return lookup;
    };
    if (!this.deps.geocoder) return remember({ kind: "unavailable", reason: "not_configured" });
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
    const asked: GeocodeQuery = {
      query,
      ...(city ? { city } : {}),
      ...(near ? { near } : {}),
      ...(ctx.location ? { userLocation: ctx.location } : {}),
    };
    const outcome = await this.deps.geocoder.geocode(asked, 5);
    if (!outcome.ok) return remember({ kind: "unavailable", reason: outcome.reason });
    // Scored from where the search looked first: the phone, or the city's
    // center when the phone is outside it.
    const bias = biasPointFor(asked);
    const match = classifyPlaceMatches(query, outcome.results, bias);
    const scored = scoreCandidates(query, outcome.results, bias);
    const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 5);
    const scoring = (source: string | null | undefined, confidence: number | null) => ({
      source: source ?? null,
      confidence,
      candidates: top.map(candidateRecord),
      ...(outcome.failures?.length ? { failures: outcome.failures } : {}),
    });
    if (match.kind === "none") {
      return remember({ kind: "none", scoring: scoring(bestOf(scored)?.result.source, null) });
    }
    if (match.kind === "ambiguous") {
      return remember({
        kind: "ambiguous",
        choices: match.choices.map((place) => ({
          label: choiceLabel(place),
          reply: choiceReply(place),
          lat: place.lat,
          lng: place.lng,
        })),
        scores: match.scores,
        scoring: scoring(match.choices[0]?.source, Math.max(...match.scores)),
      });
    }
    return remember({
      kind: "found",
      place: match.place,
      nameMatched: match.nameMatched,
      confidence: match.confidence,
      count: outcome.results.length,
      scoring: scoring(match.place.source, match.confidence),
    });
  }

  /** Write what a lookup found onto the request (requestState.ts): the
   * one place, the several it could be, or — found nothing — the words
   * alone, so a search knows a place was named and never falls back to
   * the phone's location for it. */
  private recordPlace(ctx: ToolContext, query: string, lookup: PlaceLookup): void {
    const state = ctx.requestState ?? emptyState();
    const found =
      lookup.kind === "found"
        ? {
            query,
            resolved: {
              lat: lookup.place.lat,
              lng: lookup.place.lng,
              label: placeLabel(lookup.place),
              city: lookup.place.city,
            },
          }
        : lookup.kind === "ambiguous"
          ? { query, candidates: lookup.choices }
          : { query, candidates: [] };
    ctx.requestState = applyPlaceResolution(state, found, ctx.utterance ?? "", this.now()).state;
    ctx.placeChoices =
      lookup.kind === "ambiguous"
        ? lookup.choices.map(({ label, reply }) => ({ label, reply }))
        : undefined;
  }

  /** Look a named place up and make it the request's place. The model
   * calls this before searching a named area so the search is at the
   * PLACE, not the phone's dot. */
  private async geocodePlace(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const query = String(input["query"] ?? "").trim();
    if (!query) {
      return { result: { error: "query is required" } };
    }
    const lookup = await this.lookUpPlace(ctx, query, input["city"]);
    // Found or not, the request now names this place: a search after a
    // failed lookup must ask for it, never search the phone's location.
    this.recordPlace(ctx, query, lookup);
    const stateVersion = (ctx.requestState ?? emptyState()).version;
    if (lookup.kind === "unavailable" && lookup.reason === "not_configured") {
      await this.audit(ctx, "geocode_place", input, "geocoder_unavailable", {});
      return {
        result: {
          error: "geocoding_unavailable",
          stateVersion,
          instruction:
            "Geocoding isn't configured. Ask the user to share their location or name a more specific spot.",
        },
      };
    }
    if (lookup.kind === "unavailable") {
      await this.audit(ctx, "geocode_place", input, "geocode_error", { reason: lookup.reason });
      return {
        result: {
          error: "geocode_failed",
          stateVersion,
          instruction:
            "Couldn't look that place up right now — tell the user and ask them to try a nearby cross-street or share their location.",
        },
      };
    }
    const phoneMetro = ctx.location ? homeMetroForPoint(ctx.location.lat, ctx.location.lng) : null;
    const phoneCity = phoneMetro ? providerForCity(phoneMetro)?.cityDisplayName : undefined;
    if (lookup.kind === "none") {
      await this.audit(ctx, "geocode_place", input, "no_match", { query, ...lookup.scoring });
      return {
        result: {
          found: false,
          resolution: resolutionOf(lookup),
          stateVersion,
          instruction:
            `Couldn't find "${query}" in ${coveredCitiesSentence()}. Tell the user plainly and ask for its street address or a cross street. ` +
            "Never substitute the phone's location or a neighborhood center for a place you couldn't find" +
            (phoneCity
              ? `, and don't ask which city — the phone is in or near ${phoneCity}.`
              : "."),
        },
      };
    }
    if (lookup.kind === "ambiguous") {
      await this.audit(ctx, "geocode_place", input, "ambiguous", {
        query,
        ...lookup.scoring,
        choices: lookup.choices,
        scores: lookup.scores,
      });
      return {
        result: {
          found: true,
          ambiguous: true,
          resolution: resolutionOf(lookup),
          confidence: lookup.scoring.confidence,
          stateVersion,
          choices: lookup.choices,
          instruction: `Several places match "${query}". Call ask_user now with one suggestion per choice, using each choice's label and reply exactly. Don't pick one yourself.`,
        },
      };
    }
    const place = lookup.place;
    const summary = placeSummary(place);
    await this.audit(ctx, "geocode_place", input, lookup.nameMatched ? "ok" : "closest_only", {
      query,
      ...lookup.scoring,
      count: lookup.count,
      top: summary,
    });
    return {
      result: {
        found: true,
        match: lookup.nameMatched ? "exact" : "closest",
        resolution: resolutionOf(lookup),
        confidence: lookup.confidence,
        stateVersion,
        place: summary,
        ...(lookup.nameMatched ? {} : { instruction: closestOnlyInstruction(query, place) }),
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
    // "How long?" has one wording and one set of answers, whoever asks
    // (FR-45): a model that asks it itself — instead of searching and
    // letting the search ask — still gets the server's question and its
    // four chips, not answers of its own.
    if (asksAboutStay(parsed.data.question)) {
      await this.audit(ctx, "ask_user", input, "asked", {
        suggestions: STAY_SUGGESTIONS.length,
        stay: true,
      });
      return {
        result: { presented: true },
        ask: { question: STAY_QUESTION, suggestions: [...STAY_SUGGESTIONS], server: true },
      };
    }
    await this.audit(ctx, "ask_user", input, "asked", {
      suggestions: parsed.data.suggestions.length,
    });
    return { result: { presented: true }, ask: parsed.data };
  }

  // -------------------------------------------------------------------------
  // The searches (FR-43). quote_street and search_garages read the place,
  // the window, the limits, and the ranking from the request; nothing the
  // model passes can change what is searched.
  // -------------------------------------------------------------------------

  private stateOf(ctx: ToolContext): RequestState {
    return ctx.requestState ?? emptyState();
  }

  /** The latest search, when it is still good to propose from: run at the
   * request's current version, and fresh. */
  private currentSearch(ctx: ToolContext): SearchResult | null {
    const last = ctx.lastSearch;
    if (!last || last.stateVersion !== this.stateOf(ctx).version) return null;
    return isFresh(last, this.now()) ? last : null;
  }

  /** When the request starts: its start, or now when it names none.
   * Refused when the start is in the past (V7 holds a later or garage-only
   * request to five minutes) or moves a time the user named. */
  private async searchStart(
    ctx: ToolContext,
    tool: string,
    input: unknown,
  ): Promise<{ ok: true; start: Date } | { ok: false; outcome: ToolOutcome }> {
    const state = this.stateOf(ctx);
    const at = this.now();
    const startsAt = state.window.startsAt ?? easternIso(at);
    const refused = await this.pastWindowError(
      ctx,
      tool,
      input,
      startsAt,
      " The search reads its start from the request: set it with update_request (startsAt), then search again.",
      heldToItsStart(state),
    );
    if (refused) return { ok: false, outcome: refused };
    // Readable by construction: pastWindowError bounced anything else.
    return { ok: true, start: parseEasternTime(startsAt)! };
  }

  /**
   * The window a search covers: the start, for the request's stay — or,
   * when it names none, the hour a search for right now assumes (said as
   * an assumption). A later or garage-only request with no stay has no
   * window: nothing is searched, and the turn ends asking the user how
   * long, with the usual answers as chips (intentRouter.ts `stayFor`).
   */
  private async searchWindow(
    ctx: ToolContext,
    tool: string,
    input: unknown,
    start: Date,
  ): Promise<{ ok: true; window: SearchWindow } | { ok: false; outcome: ToolOutcome }> {
    const state = this.stateOf(ctx);
    const stay = stayFor(state);
    if (!stay) {
      const intent = intentOf(state);
      await this.audit(ctx, tool, input, "duration_needed", {
        intent,
        stateVersion: state.version,
      });
      return {
        ok: false,
        outcome: {
          result: {
            error: "duration_needed",
            intent,
            stateVersion: state.version,
            instruction:
              "Nothing was searched: a request for later, or for a garage only, needs the stay, and this one names none. " +
              "The user is being asked how long. Put their answer on the request (update_request durationMinutes), then search. Never pick a stay for them.",
          },
          ask: { question: STAY_QUESTION, suggestions: [...STAY_SUGGESTIONS], server: true },
        },
      };
    }
    return {
      ok: true,
      window: {
        startsAt: easternIso(start),
        endsAt: easternIso(new Date(start.getTime() + stay.minutes * 60_000)),
        durationMinutes: stay.minutes,
        startsNow: state.window.startsAt === null,
        durationSource: stay.source,
      },
    };
  }

  /**
   * Where the request says to search. A place the user named is searched
   * at its resolved point, looked up here if nothing has yet; one that
   * matched several places, or none, is never guessed at — the search
   * answers place_unresolved and the turn ends asking the user (with the
   * candidates as chips when there are any). With no place named, the
   * phone's location is the place, stated as an assumption. The one time a
   * named place falls back to the phone is a park-now request whose lookup
   * is DOWN: the driver is at the curb, and the card says what it assumed.
   */
  private async placeFor(
    ctx: ToolContext,
    tool: string,
    input: unknown,
  ): Promise<
    { ok: true; place: SearchPlace; note?: string } | { ok: false; outcome: ToolOutcome }
  > {
    const unresolved = async (
      reason: "ambiguous" | "not_found" | "lookup_unavailable" | "no_place",
      question: string,
      candidates: PlaceCandidate[] = [],
    ) => {
      const state = this.stateOf(ctx);
      await this.audit(ctx, tool, input, "place_unresolved", {
        reason,
        query: state.place.query,
        candidates: candidates.length,
        stateVersion: state.version,
      });
      const suggestions = candidates.slice(0, 4).map(({ label, reply }) => ({ label, reply }));
      if (suggestions.length >= 2) ctx.placeChoices = suggestions;
      return {
        ok: false as const,
        outcome: {
          result: {
            error: "place_unresolved",
            reason,
            stateVersion: state.version,
            ...(candidates.length > 0 ? { candidates } : {}),
            instruction:
              "Nothing was searched: the request's place isn't resolved. The user is being asked for it.",
          },
          ask: { question, suggestions, server: true as const },
        },
      };
    };

    let state = this.stateOf(ctx);
    const query = state.place.query;
    if (!state.place.resolved && !state.place.candidates?.length && query) {
      // Named, never resolved: look it up now (once per turn).
      const lookup = await this.lookUpPlace(ctx, query);
      if (lookup.kind !== "unavailable") {
        // The search resolved the place itself: the same record
        // geocode_place leaves, under this tool's name.
        await this.audit(ctx, tool, input, "place_lookup", {
          query,
          resolution: resolutionOf(lookup),
          ...lookup.scoring,
        });
      }
      if (lookup.kind === "found" || lookup.kind === "ambiguous") {
        this.recordPlace(ctx, query, lookup);
        state = this.stateOf(ctx);
        if (lookup.kind === "found") {
          return {
            ok: true,
            place: { ...state.place.resolved!, source: "user" },
            ...(lookup.nameMatched ? {} : { note: closestOnlyInstruction(query, lookup.place) }),
          };
        }
      } else if (lookup.kind === "none") {
        return unresolved(
          "not_found",
          `I couldn't find "${query}". What's its address or a nearby cross street?`,
        );
      } else if (state.intent === "park_now" && ctx.location) {
        return {
          ok: true,
          place: { ...ctx.location, label: null, source: "default" },
          note: `Couldn't look up "${query}" right now, so this searched around the phone's location instead. Say so: never present these as being at "${query}".`,
        };
      } else {
        return unresolved(
          "lookup_unavailable",
          `I couldn't look up "${query}" right now. What's its address or a nearby cross street?`,
        );
      }
    }
    if (state.place.resolved) {
      const { lat, lng, label } = state.place.resolved;
      return { ok: true, place: { lat, lng, label, source: "user" } };
    }
    if (state.place.candidates?.length) {
      return unresolved("ambiguous", "Which one did you mean?", state.place.candidates);
    }
    if (ctx.location) {
      return { ok: true, place: { ...ctx.location, label: null, source: "default" } };
    }
    return unresolved("no_place", "Where do you want to park? Name a place or an address.");
  }

  /** The pool this search adds to: this turn's, or the previous turn's
   * read back from the transcript — when it is for the same request
   * version and the same point, and still fresh. Otherwise a new one. */
  private poolFor(
    ctx: ToolContext,
    version: number,
    place: SearchPlace,
    window: SearchWindow,
  ): SearchPool {
    const last = this.currentSearch(ctx);
    const held = ctx.searchPool ?? (last ? poolFromResult(last) : null);
    const same =
      held !== null &&
      held !== undefined &&
      held.stateVersion === version &&
      metersBetween(held.place.lat, held.place.lng, place.lat, place.lng) < 50;
    return same ? { ...held, place, window } : { stateVersion: version, place, window };
  }

  /** Every metered block within a walk of the place, as search options.
   * When the usual walk holds none, the widest one is tried. */
  private async streetPool(
    place: SearchPlace,
    start: Date,
    window: SearchWindow,
    version: number,
    fetchedAt: string,
  ): Promise<NonNullable<SearchPool["street"]>> {
    let search = await this.streetSearch(place.lat, place.lng, start, window.durationMinutes);
    if (search.all.length === 0) {
      search = await this.streetSearch(
        place.lat,
        place.lng,
        start,
        window.durationMinutes,
        MAX_STREET_RADIUS_M,
      );
    }
    return {
      options: search.all.map((o) =>
        streetSearchOption(o, {
          version,
          startsAt: window.startsNow ? null : window.startsAt,
          fetchedAt,
        }),
      ),
      meta: { radiusM: search.radiusM, zonesInRadius: search.zonesInRadius },
      fetchedAt,
    };
  }

  /** The garage sources' offers for the window, as search options. A
   * failure — thrown or typed — is a different fact from "no garages",
   * and comes back as `unavailable`, audited with the error. */
  private async garagePool(
    ctx: ToolContext,
    input: unknown,
    place: SearchPlace,
    window: SearchWindow,
    version: number,
    fetchedAt: string,
  ): Promise<NonNullable<SearchPool["garage"]> & { fromCache?: boolean }> {
    const provider = this.deps.garage.id;
    let outcome: Awaited<ReturnType<GarageProvider["search"]>>;
    try {
      outcome = await this.deps.garage.search({
        lat: place.lat,
        lng: place.lng,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      });
    } catch (err) {
      outcome = {
        ok: false,
        error: "network",
        detail: err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err),
      };
    }
    if (!outcome.ok) {
      await this.audit(ctx, "search_garages", input, "garage_search_error", {
        provider,
        error: outcome.error,
        detail: outcome.detail,
      });
      return {
        options: [],
        meta: { provider, found: 0, unavailable: true, reason: outcome.error },
        fetchedAt,
      };
    }
    // Named-place guard (FR-23): every option surfaced for a named place
    // is walkable from it. The provider reports distanceM, but it is
    // recomputed from the option's own coordinates when it carries them,
    // so the guard can't be fooled.
    const measured = outcome.options.map((option) => ({
      option,
      distanceM:
        typeof option.lat === "number" && typeof option.lng === "number"
          ? metersBetween(place.lat, place.lng, option.lat, option.lng)
          : option.distanceM,
    }));
    const guarded = place.source === "user";
    const near = guarded
      ? measured.filter((m) => m.distanceM <= NAMED_PLACE_GARAGE_RADIUS_M)
      : measured;
    const far = guarded ? measured.filter((m) => m.distanceM > NAMED_PLACE_GARAGE_RADIUS_M) : [];
    const options = near
      .map((m) =>
        garageSearchOption(m.option, {
          version,
          minutes: window.durationMinutes,
          fetchedAt,
          distanceM: m.distanceM,
        }),
      )
      .filter((o): o is SearchOption => o !== null);
    const droppedNoPrice = near.length - options.length;
    const meta: GarageSearchMeta = {
      provider,
      found: options.length,
      ...(outcome.degraded?.length ? { degraded: outcome.degraded } : {}),
      ...(far.length > 0
        ? {
            droppedForDistance: far.length,
            // How far the closest too-far garage is, so the reply can say
            // "the nearest is about 900 m away" instead of "none found".
            nearestBeyondM: Math.round(Math.min(...far.map((m) => m.distanceM))),
          }
        : {}),
      ...(droppedNoPrice > 0 ? { droppedNoPrice } : {}),
    };
    return { options, meta, fetchedAt, fromCache: outcome.fromCache };
  }

  /**
   * Real walking times for this search's options (FR-44), before the
   * request's limits and order are read off them: from the place the user
   * named to each option's pin. The options the result will SHOW are timed
   * first, then the nearest, MAX_WALK_TIMED a request: what a search shows
   * is decided by the request's order, not by distance — on a Saturday
   * evening the free blocks it leads with were the 12th to 15th nearest,
   * and kept their estimates while ten nearer ones were timed. If the real
   * walks reorder the list so that an untimed option comes into view, one
   * more request times it (MAX_WALK_REQUESTS). `walkMinutes` becomes
   * ceil(seconds / 60), at least 1, with `walkEstimate: false`; every other
   * option keeps its straight-line estimate, marked `walkEstimate: true`.
   * So does every option when the request names no place (the card has no
   * destination to walk to), no source has walking times, or the call
   * fails. A street option's one-line summary is rebuilt, so it never
   * states a walk the option doesn't carry. Returns how many were timed.
   */
  private async timeWalks(
    kind: Kind,
    pool: SearchPool,
    state: RequestState,
    place: SearchPlace,
    at: { searchedAt: string; inCoverage: boolean },
  ): Promise<number> {
    const held = pool[kind];
    if (!held) return 0;
    held.options = held.options.map((o) => ({ ...o, walkEstimate: true }));
    const geocoder = this.deps.geocoder;
    if (!geocoder?.walkingEtas || place.source !== "user") return 0;
    const pinned = (o: SearchOption): o is SearchOption & { lat: number; lng: number } =>
      o.type === kind && o.lat !== undefined && o.lng !== undefined;
    const asked = new Set<string>();
    let timed = 0;
    for (let request = 0; request < MAX_WALK_REQUESTS; request += 1) {
      const result = buildSearchResult(pool, state, at);
      const shown = [...result.satisfying, ...result.nearMisses.map((n) => n.option)]
        .filter(pinned)
        .filter((o) => !asked.has(o.id));
      // The first request fills up with the nearest; a second only times
      // what came into view.
      const nearest =
        request === 0
          ? held.options
              .filter(pinned)
              .filter((o) => !asked.has(o.id))
              .sort((a, b) => a.distanceM - b.distanceM)
          : [];
      const targets = [...new Map([...shown, ...nearest].map((o) => [o.id, o])).values()].slice(
        0,
        MAX_WALK_TIMED,
      );
      if (targets.length === 0) break;
      const etas = await geocoder.walkingEtas(
        { lat: place.lat, lng: place.lng },
        targets.map((o) => ({ lat: o.lat, lng: o.lng })),
      );
      if (!etas) break;
      const minutes = new Map<string, number>();
      targets.forEach((o, i) => {
        asked.add(o.id);
        const eta = etas[i];
        // Never under a minute, like the estimate: "0 min walk" reads as none.
        if (eta) minutes.set(o.id, Math.max(1, Math.ceil(eta.seconds / 60)));
      });
      timed += minutes.size;
      held.options = held.options.map((o) => {
        const walkMinutes = minutes.get(o.id);
        if (walkMinutes === undefined) return o;
        const facts = o.facts
          ? { ...o.facts, walkMinutes, summary: streetSummary({ ...o.facts, walkMinutes }) }
          : undefined;
        return {
          ...o,
          walkMinutes,
          walkEstimate: false,
          ...(facts ? { facts, summary: facts.summary } : {}),
        };
      });
    }
    return timed;
  }

  /** Whether a point is inside a city we cover: what tells "we have no
   * data here" from "we don't cover there". */
  private inCoverage(place: SearchPlace): boolean {
    return metroForPoint(place.lat, place.lng) !== null;
  }

  /**
   * quote_street / search_garages. Searches one kind for the request as
   * it stands and answers with the request's whole search so far at this
   * version — both kinds once both have run — filtered and ordered by the
   * server (search.ts). That result becomes the conversation's latest
   * search: the only thing propose_plan accepts options from.
   */
  private async runSearch(ctx: ToolContext, kind: Kind, input: unknown): Promise<ToolOutcome> {
    const tool = kind === "street" ? "quote_street" : "search_garages";
    const started = await this.searchStart(ctx, tool, input);
    if (!started.ok) return started.outcome;
    const placed = await this.placeFor(ctx, tool, input);
    if (!placed.ok) return placed.outcome;
    // Where first, then how long: a stay asked about a place the search
    // can't find would be a question wasted.
    const windowed = await this.searchWindow(ctx, tool, input, started.start);
    if (!windowed.ok) return windowed.outcome;
    // Read after the place: resolving it may have bumped the version.
    const state = this.stateOf(ctx);
    const { start } = started;
    const { window } = windowed;
    const { place } = placed;
    const fetchedAt = this.now().toISOString();
    const pool = this.poolFor(ctx, state.version, place, window);

    let fromCache: boolean | undefined;
    if (kind === "street") {
      pool.street = await this.streetPool(place, start, window, state.version, fetchedAt);
    } else {
      const garage = await this.garagePool(ctx, input, place, window, state.version, fetchedAt);
      fromCache = garage.fromCache;
      pool.garage = { options: garage.options, meta: garage.meta, fetchedAt };
      // A garage-only request whose garage search is down has nothing to
      // show: the turn ends on an "unavailable" card, with no street
      // substitute — the user asked for a garage.
      if (garage.meta.unavailable && state.intent === "garage_or_lot") {
        return this.garageUnavailableCard(ctx, state, place, window, garage.meta, fetchedAt);
      }
      // A garage-only request has no street quote of its own: the tool is
      // off. The server runs one here, for two things only — the cheaper
      // meter the result may show as a near-miss (search.ts), and what
      // "street or garage is fine" would yield.
      if (isGarageOnly(state.hard) && !pool.street) {
        pool.street = await this.streetPool(place, start, window, state.version, fetchedAt);
      }
    }
    const at = { searchedAt: fetchedAt, inCoverage: this.inCoverage(place) };
    const walksTimed = await this.timeWalks(kind, pool, state, place, at);
    ctx.searchPool = pool;
    const result = buildSearchResult(pool, state, at);
    ctx.lastSearch = result;
    ctx.searchesThisTurn = (ctx.searchesThisTurn ?? 0) + 1;
    await this.audit(ctx, tool, input, "ok", {
      stateVersion: result.stateVersion,
      verdict: result.verdict,
      searched: result.searched,
      satisfying: result.satisfying.map((o) => ({ id: o.id, priceUsd: o.priceUsd })),
      nearMisses: result.nearMisses.map((n) => ({
        id: n.option.id,
        violates: n.violates.map((v) => v.field),
      })),
      placeSource: place.source,
      // How many of this search's options carry a real walking time.
      walksTimed,
      ...(isGarageOnly(state.hard)
        ? {
            cheaperStreet:
              result.nearMisses.find((n) => n.option.type === "street")?.option.id ?? null,
          }
        : {}),
      ...(kind === "street"
        ? { streetCount: pool.street!.options.length, ...pool.street!.meta }
        : {
            garageCount: pool.garage!.options.length,
            ...pool.garage!.meta,
            ...(fromCache !== undefined ? { fromCache } : {}),
          }),
    });
    return {
      result: { ...result, instruction: this.searchInstruction(result, state, placed.note) },
    };
  }

  /** What the model is told to do with a search result. The verdict is
   * the server's; this only says which propose_plan follows from it. */
  private searchInstruction(result: SearchResult, state: RequestState, placeNote?: string): string {
    const parts: string[] = [];
    if (placeNote) parts.push(placeNote);
    const other = (k: Kind) => (k === "street" ? "quote_street" : "search_garages");
    // Only a search the model can run is one it is told to run.
    const missing = kindsToSearch(state.hard)
      .filter((k) => !result.searched.includes(k))
      .filter((k) => toolAllowed(intentOf(state), other(k)));
    if (result.verdict === "meets") {
      parts.push(
        "Propose with propose_plan: a single_spot plan of up to 3 options from `satisfying`, each by its id. The order is the server's and the first is the recommendation.",
      );
      const [first, second] = result.satisfying;
      if (first?.axis === "cheapest" && second?.axis === "closest" && !second.secondary) {
        parts.push(
          "The user asked for no ranking, so offer both the cheapest and the closest — the first two.",
        );
      } else if (second?.secondary) {
        parts.push(
          "The second option is the best on the other axis: an alternative, never the recommendation.",
        );
      }
      if (result.nearMisses.length > 0) {
        parts.push(
          "An option from `nearMisses` breaks a limit: it may ride along only with nearMiss: true, and never as if it met the request.",
        );
      }
      if (isGarageOnly(state.hard) && result.nearMisses.some((n) => n.option.type === "street")) {
        parts.push(
          "The street option among `nearMisses` is a cheaper meter the server found: the card shows it as an alternative that isn't a garage. The user asked for a garage — recommend one.",
        );
      }
    } else if (missing.length > 0) {
      parts.push(
        `Nothing found so far meets the request. Call ${missing.map(other).join(" and ")} too before deciding.`,
      );
    } else if (result.verdict === "none_meets") {
      parts.push(
        'Nothing meets the request. Call propose_plan with {kind: "none_meets"}: the card shows what came closest and what relaxing a limit would yield. Never present a near-miss as if it met the request, and never loosen a limit yourself — that is the user\'s tap.',
      );
    } else if (result.verdict === "no_data") {
      parts.push(
        'Our data has no parking to offer at that place. Call propose_plan with {kind: "none_meets"}: the card names the nearest blocks we do have.',
      );
    } else {
      parts.push(
        `That place is outside the cities ParkAgent covers (${coveredCitiesSentence()}). Say so in one sentence; there is no card for it.`,
      );
    }
    if (result.garage?.unavailable) {
      parts.push(
        "The garage search is unavailable right now (this is NOT 'no garages'). Tell the user you couldn't check garages at the moment, and still offer the street options.",
      );
    } else if (result.garage?.nearestBeyondM !== undefined && result.garage.found === 0) {
      parts.push(
        `No garage within ${NAMED_PLACE_GARAGE_RADIUS_M} m of that place; the nearest is about ${result.garage.nearestBeyondM} m away. Tell the user that distance — do not say none were found.`,
      );
    }
    if (result.street?.zonesInRadius === 0) {
      parts.push(
        `No metered street parking in our data within ${result.street.radiusM} m (about a ${walkMinutesFor(result.street.radiusM)}-minute walk) of the place — say the radius if you mention it.`,
      );
    }
    if (result.window.durationSource === "default") {
      const hours = result.window.durationMinutes / 60;
      parts.push(
        `The request names no stay, so this assumed ${hours === 1 ? "1 hour" : `${hours} hours`} — say so.`,
      );
    }
    return parts.join(" ");
  }

  /**
   * Before the server says "nothing meets this", it searches whatever the
   * request allows that hasn't been searched at this version: the verdict
   * is never taken on half a search. Street is our own data and is always
   * included; the garage sources are asked unless the request rules
   * garages out.
   */
  private async completeSearch(ctx: ToolContext): Promise<ToolOutcome | null> {
    for (const kind of kindsToSearch(this.stateOf(ctx).hard)) {
      const last = this.currentSearch(ctx);
      if (!last || last.satisfying.length > 0) return null;
      if (last.searched.includes(kind)) continue;
      const outcome = await this.runSearch(ctx, kind, { note: "completing the search" });
      // A garage-only request whose garage search is down ends the turn
      // on its own card.
      if (outcome.endTurn) return outcome;
    }
    return null;
  }

  private searchGarages(ctx: ToolContext, input: unknown): Promise<ToolOutcome> {
    return this.runSearch(ctx, "garage", input);
  }

  private quoteStreet(ctx: ToolContext, input: unknown): Promise<ToolOutcome> {
    return this.runSearch(ctx, "street", input);
  }

  /**
   * The one street pricing path — quote_street, build_itinerary, and the
   * re-pricing of an edited itinerary all come through here: every zone
   * within a walk of the point (streetOptions.ts), provider-observed terms
   * over the dataset (e.g. Boston's real "Max 5 Hr" vs the data's assumed
   * 2-hour cap — the same override /parked and session start apply),
   * each stay priced through the ladder for its window. The first option
   * is the one an itinerary stop takes: the cheapest, then the nearest.
   */
  private streetSearch(
    lat: number,
    lng: number,
    when: Date,
    minutes: number,
    radiusM?: number,
  ): Promise<StreetSearch> {
    return streetOptionsNear(
      {
        db: this.deps.db,
        policy: this.deps.policy.get(),
        findCandidates: this.deps.findCandidates,
        findNearbyZones: this.deps.findNearbyZones,
      },
      { lat, lng, when, minutes, radiusM },
    );
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
        const best = (await this.streetSearch(stop.lat, stop.lng, arrivalAt, stop.durationMinutes))
          .options[0];
        if (!best) {
          stops.push(carried(true));
          estimates.push({ id: stop.id, reason: "no_zone" });
          continue;
        }
        stops.push({ ...base, costUsd: best.costUsd, zoneId: best.zoneId });
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

  /**
   * One itinerary stop's street quote: the blocks within a walk of the
   * stop's own point, for the stop's own window. A day's stops each have
   * their place and time, so this takes them as arguments — unlike
   * quote_street, which searches the one request.
   */
  private async quoteStreetAt(
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
    const search = await this.streetSearch(
      lat,
      lng,
      when,
      minutes,
      input["radius_m"] !== undefined ? num(input["radius_m"]) : undefined,
    );
    const radiusText = `${search.radiusM} m (about a ${walkMinutesFor(search.radiusM)}-minute walk)`;
    if (search.options.length === 0) {
      await this.audit(ctx, "quote_street", input, "unknown_zone", { radiusM: search.radiusM });
      return {
        result: {
          found: false,
          radiusM: search.radiusM,
          reason: `No metered street parking in our data within ${radiusText} of that point.`,
          instruction: `Say there's no metered street parking within ${radiusText} of the place — say the radius — and still offer garages.`,
        },
      };
    }
    const window = {
      startsAt: easternIso(when),
      endsAt: easternIso(new Date(when.getTime() + minutes * 60_000)),
    };
    await this.audit(ctx, "quote_street", input, "ok", {
      radiusM: search.radiusM,
      zonesInRadius: search.zonesInRadius,
      options: search.options.map((o) => ({
        zoneId: o.zoneId,
        costUsd: o.costUsd,
        state: o.state,
      })),
    });
    return {
      result: {
        found: true,
        radiusM: search.radiusM,
        window,
        options: search.options,
        instruction:
          "Offer the street options that fit (usually the best one or two) with their summary; each option's zoneId goes on its plan option. A free block is $0.00.",
      },
    };
  }

  private async buildItinerary(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const stops = input["stops"] as Record<string, unknown>[];
    const policy = await policyFor(this.deps, ctx.userId);
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
      // A day's stops each have their own time: the message's one
      // requested time (if any) isn't theirs to honor.
      const street = await this.quoteStreetAt(
        { ...ctx, timeRequest: undefined },
        {
          lat: stop["lat"],
          lng: stop["lng"],
          duration_minutes: minutes,
          when: arrival,
        },
      );
      const garages = await this.searchGarageWindow(
        num(stop["lat"]),
        num(stop["lng"]),
        arrivalAt,
        minutes,
      );
      // The model picks street vs garage per stop from the best street
      // option or two; five per stop across a 12-stop day is tokens, not
      // information.
      const streetResult = street.result as { options?: unknown[] };
      out.push({
        label: stop["label"],
        address: stop["address"] ?? "",
        arrival,
        durationMinutes: minutes,
        street: Array.isArray(streetResult.options)
          ? { ...streetResult, options: streetResult.options.slice(0, 2) }
          : street.result,
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

  /**
   * propose_plan. A single-spot plan is options from the latest search,
   * by id, held to the request by these rules — in this order, each
   * refusal audited under its own name (FR-43):
   *
   *  V1  every option id is in the latest search, and that search was run
   *      at the request's current version and is fresh
   *      (`stale_or_unknown_option`);
   *  V2  the price, walk, zone, window, and link are the search's; a price
   *      the model typed that differs is recorded (`model_price_mismatch`);
   *  V3  an option that breaks a limit rides along only as nearMiss: true,
   *      with the server's `violates` (`hard_constraint_violation`);
   *  V4  with nothing satisfying, the only plan is the "no" (`must_say_no`);
   *      with something satisfying, a "no" is refused (`options_available`);
   *  V5  an itinerary's total is recomputed and held to the caller's daily
   *      cap (`over_daily_cap`). There is no per-plan cap (decision 9).
   *
   * The reply's own check (V6, `ungrounded_number`) is the loop's.
   */
  private async proposePlan(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const parsed = proposedPlanSchema.safeParse(input["plan"]);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .slice(0, 8);
      await this.audit(ctx, "propose_plan", input, "invalid_plan", { issues });
      return { result: { error: "invalid plan shape", issues } };
    }
    const proposed = parsed.data;
    if (proposed.kind === "itinerary") return this.proposeItinerary(ctx, proposed);
    if (proposed.kind === "none_meets") return this.proposeNoneMeets(ctx, input, proposed);
    return this.proposeSingleSpot(ctx, input, proposed);
  }

  /** Why the latest search can't be proposed from, in the model's words. */
  private staleHint(ctx: ToolContext): string {
    const last = ctx.lastSearch;
    const version = this.stateOf(ctx).version;
    if (!last) {
      return "Nothing has been searched for this request yet: call quote_street and search_garages, then propose options by the ids they return.";
    }
    if (last.stateVersion !== version) {
      return `The request changed after that search (it is at version ${version} now): search again, then propose options by the new ids.`;
    }
    if (!isFresh(last, this.now())) {
      return "That search is more than 10 minutes old, and prices are for when they were fetched: search again, then propose by the new ids.";
    }
    return "Use option ids exactly as the latest search returned them (validIds).";
  }

  private async staleOrUnknown(
    ctx: ToolContext,
    input: unknown,
    optionIds: string[],
    validIds: string[],
  ): Promise<ToolOutcome> {
    const stateVersion = this.stateOf(ctx).version;
    await this.audit(ctx, "propose_plan", input, "stale_or_unknown_option", {
      optionIds,
      stateVersion,
      searchVersion: ctx.lastSearch?.stateVersion ?? null,
    });
    return {
      result: {
        error: "stale_or_unknown_option",
        optionIds,
        validIds,
        stateVersion,
        hint: this.staleHint(ctx),
      },
    };
  }

  private async proposeSingleSpot(
    ctx: ToolContext,
    input: unknown,
    proposed: Extract<ProposedPlan, { kind: "single_spot" }>,
  ): Promise<ToolOutcome> {
    const last = this.currentSearch(ctx);
    const meets = new Map((last?.satisfying ?? []).map((o) => [o.id, o]));
    const misses = new Map((last?.nearMisses ?? []).map((n) => [n.option.id, n]));

    // V1: an option is a result of the latest search or it isn't on the card.
    const unknown = proposed.options.filter((o) => !meets.has(o.id) && !misses.has(o.id));
    if (!last || unknown.length > 0) {
      return this.staleOrUnknown(
        ctx,
        input,
        (last ? unknown : proposed.options).map((o) => o.id),
        [...meets.keys(), ...misses.keys()],
      );
    }
    // V3: a near-miss is shown as one, or not at all.
    const dressed = proposed.options.filter((o) => misses.has(o.id) && o.nearMiss !== true);
    if (dressed.length > 0) {
      const optionIds = dressed.map((o) => o.id);
      await this.audit(ctx, "propose_plan", input, "hard_constraint_violation", { optionIds });
      return {
        result: {
          error: "hard_constraint_violation",
          optionIds,
          violates: Object.fromEntries(optionIds.map((id) => [id, misses.get(id)!.violates])),
          hint: "These options break a limit of the request. Leave them out, or include one with nearMiss: true — never as if it met the request.",
        },
      };
    }
    // V4: nothing satisfies, so the only honest plan is the "no".
    if (last.satisfying.length === 0) {
      await this.audit(ctx, "propose_plan", input, "must_say_no", {
        stateVersion: last.stateVersion,
      });
      return {
        result: {
          error: "must_say_no",
          instruction:
            'Nothing in the latest search meets the request, so there is no single_spot plan to propose. Call propose_plan with {kind: "none_meets"}.',
        },
      };
    }

    // The time the user named is the plan's (requestedTime.ts): a plan
    // starting anywhere else goes back to the model with the time they
    // asked for.
    const now = this.now();
    const moved = this.requestedTimeMoved(ctx, last.window, now);
    if (moved) {
      await this.audit(ctx, "propose_plan", input, "requested_time_moved", {
        startsAt: last.window.startsNow ? null : last.window.startsAt,
      });
      return {
        result: {
          error: "requested_time_moved",
          instruction: `${moved} The plan's time is the request's: set it with update_request (startsAt), then search and propose again.`,
        },
      };
    }

    // The card's options, in the search's order (the model never
    // reorders). Decision 8: the option that honors the ask is always on
    // the card and first — with no ask, the cheapest and the closest both
    // lead — and the best on the other axis is always shown as the
    // secondary alternative. Then what the model chose, then any flagged
    // near-miss.
    const state = this.stateOf(ctx);
    const chosen = new Set(proposed.options.map((o) => o.id));
    const [first, second] = last.satisfying;
    const coPrimary = first?.axis === "cheapest" && second?.axis === "closest" && !second.secondary;
    const leading = new Set(
      [first?.id, coPrimary ? second?.id : undefined].filter((id): id is string => !!id),
    );
    // A garage-only request's cheaper meter (search.ts) is the server's to
    // show: once, last, whatever the model chose — never as a fit.
    const cheaperStreet = isGarageOnly(state.hard)
      ? last.nearMisses.find((n) => n.option.type === "street")?.option
      : undefined;
    const fits = [
      ...last.satisfying.filter(
        (o) => leading.has(o.id) || o.secondary === true || chosen.has(o.id),
      ),
      ...last.nearMisses
        .filter((n) => chosen.has(n.option.id) && n.option.id !== cheaperStreet?.id)
        .map((n) => n.option),
    ];
    const picked = cheaperStreet ? [...fits.slice(0, 2), cheaperStreet] : fits.slice(0, 3);
    // The approval threshold: an amount, not a cap (policy.ts).
    const warnOverUsd = confirmWarnUsd(await policyFor(this.deps, ctx.userId));

    const words = new Map(proposed.options.map((o) => [o.id, o]));
    for (const option of picked) {
      const typed = words.get(option.id)?.priceUsd;
      if (typeof typed === "number" && Math.abs(typed - option.priceUsd) >= 0.005) {
        // V2: the card shows the search's price; the model's is on record.
        await this.audit(ctx, "propose_plan", { optionId: option.id }, "model_price_mismatch", {
          optionId: option.id,
          modelPriceUsd: typed,
          priceUsd: option.priceUsd,
        });
      }
    }
    const options = picked.map((option, index) => {
      // The model's words reach the card only where they can't mislead: a
      // near-miss is named by the server (with what it breaks), and a
      // label or detail quoting an amount that isn't this option's own
      // falls back to the server's.
      const nearMiss = misses.get(option.id);
      const own = ownAmounts(option);
      const said = (text: string | undefined) =>
        text !== undefined && !nearMiss && scrubUngroundedAmounts(text, own).dropped.length === 0
          ? text
          : undefined;
      return {
        ...this.cardOption(option, last.window, now, {
          label: said(words.get(option.id)?.label),
          detail: said(words.get(option.id)?.detail),
          violates: nearMiss?.violates,
          primary: leading.has(option.id),
          warnOverUsd,
        }),
        // The first option is the one that honors the ask: it holds the
        // badge whatever the model marked.
        recommended: index === 0,
      };
    });

    // The card's note is the model's prose: held to the same check as the
    // reply (V6), against the prices of the options that meet the request.
    const sayable = new Set(
      picked.filter((o) => !misses.has(o.id)).flatMap((o) => [...ownAmounts(o)]),
    );
    const note = proposed.note ? scrubUngroundedAmounts(proposed.note, sayable).text : "";
    const plan: SingleSpotPlan = {
      kind: "single_spot",
      options,
      ...this.cardFrame(last, options, now, ctx.timeRequest),
      ...(note.length > 0 ? { note } : {}),
      verdict: "meets",
      requestSummary: requestSummaryFor(state, last),
    };
    const reason = recommendationReason(plan.options);
    if (reason) plan.recommendedReason = reason;
    return this.presentPlan(ctx, input, plan, "proposed");
  }

  /** Why a plan for `window` moves the time the user named, or null. */
  private requestedTimeMoved(ctx: ToolContext, window: SearchWindow, now: Date): string | null {
    if (!ctx.timeRequest) return null;
    const start = window.startsNow ? now : (parseEasternTime(window.startsAt) ?? now);
    return requestedTimeProblem(ctx.timeRequest, start, now);
  }

  /**
   * A search option as a card option: every fact is the search's. Only
   * the label and the one-line detail may be the model's words.
   */
  private cardOption(
    option: SearchOption,
    window: SearchWindow,
    now: Date,
    extra: {
      label?: string | undefined;
      detail?: string | undefined;
      violates?: Violation[] | undefined;
      /** The option leads the card (decision 8). */
      primary?: boolean | undefined;
      /** The approval threshold: a price over it is marked `warn`. */
      warnOverUsd?: number | undefined;
    },
  ): SingleSpotOption {
    const starts = window.startsNow ? null : parseEasternTime(window.startsAt);
    const facts = option.facts;
    return {
      id: option.id,
      type: option.type,
      label: (extra.label ?? option.label).slice(0, 120),
      detail: (
        extra.detail ??
        (option.type === "street"
          ? (option.summary ?? "Metered street parking")
          : "Off-street garage")
      ).slice(0, 240),
      priceUsd: option.priceUsd,
      durationMinutes: Math.min(720, Math.max(1, Math.round(option.durationMinutes))),
      walkMinutes: Math.min(120, Math.max(0, Math.round(option.walkMinutes))),
      // Only a walking time the search fetched is not an estimate.
      walkEstimate: option.walkEstimate !== false,
      fetchedAt: option.fetchedAt,
      // One canonical form, so the phone parses what the server did.
      ...(starts ? { startsAt: easternIso(starts) } : {}),
      ...(option.lat !== undefined && option.lng !== undefined
        ? { lat: option.lat, lng: option.lng }
        : {}),
      ...(option.axis ? { axis: option.axis } : {}),
      ...(option.secondary ? { secondary: true as const } : {}),
      ...(extra.primary && !extra.violates?.length ? { primary: true as const } : {}),
      // Compared in cents: a price AT the threshold doesn't warn.
      ...(extra.warnOverUsd !== undefined &&
      Math.round(option.priceUsd * 100) > Math.round(extra.warnOverUsd * 100)
        ? { warn: true as const }
        : {}),
      ...(extra.violates?.length ? { nearMiss: true as const, violates: extra.violates } : {}),
      ...(option.type === "street"
        ? {
            zoneId: option.zoneId,
            // A future meter can't be started now (meters run from
            // payment): the detector pays on arrival, and the card shows
            // that instead of Confirm.
            payOnArrival: starts !== null && starts.getTime() - now.getTime() > PAY_ON_ARRIVAL_MS,
            ...(facts
              ? {
                  ...(facts.street ? { street: facts.street } : {}),
                  zoneNumber: facts.zoneNumber,
                  streetState: facts.state,
                  streetSummary: facts.summary,
                  priceBreakdown: { meterUsd: facts.meterUsd, feeUsd: facts.feeUsd },
                  ratePerHourUsd: facts.ratePerHourUsd,
                  hoursToday: facts.hoursToday,
                  maxStayMinutes: facts.maxStayMinutes,
                  exceedsMaxStay: facts.exceedsMaxStay,
                }
              : {}),
          }
        : {
            garageOptionId: option.garageOptionId,
            payOnArrival: false,
            ...(option.provider ? { provider: option.provider } : {}),
            ...(option.entryType ? { entryType: option.entryType } : {}),
            ...(isUrl(option.deepLink) ? { deepLink: option.deepLink } : {}),
          }),
      recommended: false,
    };
  }

  /** What every single-place card carries besides its options, all from
   * the search: the place it was searched at, where garage prices came
   * from and when, and what the plan assumed in one line ("Now–3:00 PM,
   * near you" when the place is the phone's location). */
  private cardFrame(
    search: SearchResult,
    shown: SingleSpotOption[],
    now: Date,
    request: TimeRequest | undefined,
  ): Pick<SingleSpotPlan, "destination" | "provenance" | "assumptions"> {
    const { place, window } = search;
    const garages = shown.filter((o) => o.type === "garage");
    // Which sources the SURFACED options came from — with two providers
    // merged, the aggregate id would credit a source with nothing shown.
    const provenance =
      garages.length > 0
        ? {
            provider: [...new Set(garages.map((o) => o.provider ?? ""))]
              .filter((p) => p.length > 0)
              .sort()
              .join("+"),
            searchedAt: garages.map((o) => o.fetchedAt ?? search.searchedAt).sort()[0]!,
          }
        : search.garage?.unavailable
          ? {
              provider: search.garage.provider,
              searchedAt: search.searchedAt,
              garage: "unavailable" as const,
            }
          : null;
    return {
      ...(place.source === "user" && place.label
        ? { destination: { lat: place.lat, lng: place.lng, label: place.label.slice(0, 120) } }
        : {}),
      ...(provenance && provenance.provider.length > 0 ? { provenance } : {}),
      assumptions: windowAssumption(
        {
          start: window.startsNow ? null : parseEasternTime(window.startsAt),
          minutes: window.durationMinutes,
        },
        // The phone's location standing in for a place is an assumption
        // like any other: it is said.
        place.source === "user" ? place.label : "you",
        now,
        request,
      ),
    };
  }

  /**
   * The "no". The model names the kind; the server decides whether it
   * stands and fills the card. Not before the request's whole search has
   * run: an unsearched kind is searched here first, and if that turns
   * something up, the "no" is refused with it (`options_available`).
   */
  private async proposeNoneMeets(
    ctx: ToolContext,
    input: unknown,
    proposed: Extract<ProposedPlan, { kind: "none_meets" }>,
  ): Promise<ToolOutcome> {
    if (!this.currentSearch(ctx)) return this.staleOrUnknown(ctx, input, [], []);
    const ended = await this.completeSearch(ctx);
    if (ended) return ended;
    const last = this.currentSearch(ctx)!;
    const state = this.stateOf(ctx);
    const now = this.now();

    if (last.verdict === "meets") {
      await this.audit(ctx, "propose_plan", input, "options_available", {
        stateVersion: last.stateVersion,
        satisfying: last.satisfying.map((o) => o.id),
      });
      return {
        result: {
          error: "options_available",
          stateVersion: last.stateVersion,
          satisfying: last.satisfying,
          nearMisses: last.nearMisses,
          instruction:
            "Options that meet the request exist, so this is not a none_meets. Propose a single_spot plan from `satisfying`, by id.",
        },
      };
    }
    if (last.verdict === "outside_coverage") {
      await this.audit(ctx, "propose_plan", input, "outside_coverage", {
        stateVersion: last.stateVersion,
      });
      return {
        result: {
          error: "outside_coverage",
          instruction: `That place is outside the cities ParkAgent covers (${coveredCitiesSentence()}). Say so in one sentence; there is no card for it.`,
        },
      };
    }
    if (last.verdict === "no_data") {
      return this.presentPlan(
        ctx,
        input,
        await this.noDataPlan(last, state, now, ctx.timeRequest),
        "no_zone_here",
      );
    }

    // V1 for the near-misses the model named; by default, the nearest three.
    const misses = new Map(last.nearMisses.map((n) => [n.option.id, n]));
    const named = proposed.nearMissIds ?? [];
    const unknown = named.filter((id) => !misses.has(id));
    if (unknown.length > 0) return this.staleOrUnknown(ctx, input, unknown, [...misses.keys()]);
    const shown = (
      named.length > 0
        ? last.nearMisses.filter((n) => named.includes(n.option.id))
        : last.nearMisses
    ).slice(0, 3);
    const warnOverUsd = confirmWarnUsd(await policyFor(this.deps, ctx.userId));
    const nearMisses = shown.map((n) =>
      this.cardOption(n.option, last.window, now, { violates: n.violates, warnOverUsd }),
    );
    const pool =
      ctx.searchPool?.stateVersion === last.stateVersion
        ? poolOptions(ctx.searchPool)
        : last.nearMisses.map((n) => n.option);
    const garageDown = last.garage?.unavailable === true;
    const plan: NoneMeetsPlan = {
      kind: "none_meets",
      headline:
        noneMeetsHeadline(state.hard, last.place, shown[0]?.option) +
        (garageDown ? " I couldn't check garages right now." : ""),
      constraintsFailed: constraintsFailedFor(pool, state.hard),
      nearMisses,
      relaxSuggestions: (last.relaxSuggestions ?? []).slice(0, 3),
      ...this.cardFrame(last, nearMisses, now, ctx.timeRequest),
      verdict: "none_meets",
      requestSummary: requestSummaryFor(state, last),
    };
    return this.presentPlan(ctx, input, plan, "none_meets");
  }

  /** The "we have nothing there" card: the nearest zones we do have. */
  private async noDataPlan(
    search: SearchResult,
    state: RequestState,
    now: Date,
    request: TimeRequest | undefined,
  ): Promise<NoDataPlan> {
    const { place } = search;
    const query = { lat: place.lat, lng: place.lng, radiusM: NEAREST_ZONE_RADIUS_M };
    const zones: (Awaited<ReturnType<CandidateFetcher>>[number] & {
      street?: string | null;
      centerline?: number[][][];
    })[] = this.deps.findNearbyZones
      ? (await this.deps.findNearbyZones(query)).zones
      : await this.deps.findCandidates(query);
    const nearestZones = [...zones]
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 3)
      .map((zone) => {
        const pin = zone.centerline ? nearestPointOn(zone.centerline, place.lat, place.lng) : null;
        return {
          zoneId: zone.zoneId,
          street: displayStreet(zone.street),
          zoneNumber: zone.providerZoneNumber || null,
          distanceM: Math.round(zone.distanceM),
          walkMinutes: walkMinutesFor(zone.distanceM),
          ...(pin ? { lat: pin.lat, lng: pin.lng } : {}),
        };
      });
    const radiusM = search.street?.radiusM ?? MAX_STREET_RADIUS_M;
    const where = place.source === "user" && place.label ? place.label : "you";
    const nearest = nearestZones[0];
    const headline =
      `Our data has no street parking or garages within ${radiusM} m of ${where}.` +
      (nearest
        ? ` The nearest metered block is ${nearest.street ? `on ${nearest.street}, ` : ""}about ${nearest.distanceM} m away.`
        : "") +
      (search.garage?.unavailable ? " I couldn't check garages right now." : "");
    return {
      kind: "no_data",
      rule: "no_zone_here",
      headline,
      radiusM,
      nearestZones,
      ...this.cardFrame(search, [], now, request),
      requestSummary: requestSummaryFor(state, search),
    };
  }

  /**
   * A garage-only request whose garage search is down: a card that says
   * so, with nothing on it — no street substitute, the user asked for a
   * garage — and one chip to try again. Ends the turn.
   */
  private async garageUnavailableCard(
    ctx: ToolContext,
    state: RequestState,
    place: SearchPlace,
    window: SearchWindow,
    meta: GarageSearchMeta,
    searchedAt: string,
  ): Promise<ToolOutcome> {
    const search: SearchResult = {
      stateVersion: state.version,
      verdict: "none_meets",
      searched: ["garage"],
      searchedAt,
      place,
      window,
      satisfying: [],
      nearMisses: [],
      garage: meta,
    };
    const plan: NoneMeetsPlan = {
      kind: "none_meets",
      headline: "I couldn't check garages right now.",
      constraintsFailed: [{ field: "garageSearch", reason: "unavailable" }],
      nearMisses: [],
      relaxSuggestions: [],
      ...this.cardFrame(search, [], this.now(), ctx.timeRequest),
      verdict: "none_meets",
      requestSummary: requestSummaryFor(state, search),
    };
    ctx.searchesThisTurn = (ctx.searchesThisTurn ?? 0) + 1;
    return this.presentPlan(ctx, { tool: "search_garages" }, plan, "garage_search_unavailable");
  }

  /** Store a plan and end the turn on it. The plan is checked against the
   * card contract first: a malformed plan never reaches the client. */
  private async presentPlan(
    ctx: ToolContext,
    input: unknown,
    plan: AssistantPlanBody,
    rule: "proposed" | "none_meets" | "no_zone_here" | "garage_search_unavailable",
  ): Promise<ToolOutcome> {
    const checked = planSchema.safeParse(plan);
    if (!checked.success) {
      const issues = checked.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .slice(0, 8);
      await this.audit(ctx, "propose_plan", input, "invalid_plan", { issues, built: true });
      return { result: { error: "invalid plan shape", issues } };
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
        rule,
        outcome: { planId, plan },
        userId: ctx.userId,
      },
    });
    return { result: { planId, presented: true, kind: plan.kind }, endTurn: { planId, plan } };
  }

  /** An itinerary. V5: never trust model arithmetic — the total is
   * recomputed, the cap pinned to the caller's own, and a day that busts
   * what is left of it refused. (Its per-stop prices are still the ones
   * the model read off build_itinerary, #132.) */
  private async proposeItinerary(
    ctx: ToolContext,
    proposed: Extract<ProposedPlan, { kind: "itinerary" }>,
  ): Promise<ToolOutcome> {
    const policy = await policyFor(this.deps, ctx.userId);
    const totalUsd = itineraryTotalUsd(proposed.stops);
    const spentTodayUsd = await spentToday(this.deps.db, ctx.userId, this.now());
    if (spentTodayUsd + totalUsd > policy.daily_cap_usd) {
      await this.audit(ctx, "propose_plan", { kind: proposed.kind, totalUsd }, "over_daily_cap", {
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
    const unreadable = proposed.stops.find((stop) => !parseEasternTime(stop.arrival));
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
    const plan: AssistantPlanBody = {
      ...proposed,
      totalUsd,
      capUsd: policy.daily_cap_usd,
      // Stored in arrival order, whatever order the model listed them
      // in: the card shows the day as it will happen.
      stops: orderStopsByArrival(proposed.stops).map((stop) => {
        // Arrivals are stored in one canonical form: the itinerary tick
        // pushes each garage link 15 minutes before this instant, and an
        // offset-less string meant a different instant on every host.
        const arrival = easternIso(parseEasternTime(stop.arrival)!);
        // A garage stop's link is pushed to the phone later — it comes
        // from the search cache, never from model text.
        const cached =
          stop.choice === "garage" && stop.garageOptionId
            ? this.deps.garage.optionById(stop.garageOptionId)
            : null;
        return { ...stop, arrival, ...(cached ? { deepLink: cached.deepLink } : {}) };
      }),
    };
    // What the plan assumed — server truth from the plan itself, stated
    // on every card however the model phrased its reply.
    const assumptions = assumptionsFor(plan, this.now(), ctx.timeRequest);
    return this.presentPlan(
      ctx,
      { kind: proposed.kind },
      assumptions ? { ...plan, assumptions } : plan,
      "proposed",
    );
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
