/**
 * What a capability runs with: the deps, who is acting (Principal), and
 * the turn's own state (TurnState) — the request and the latest search as
 * this conversation has them so far. The capabilities under this
 * directory are the assistant's abilities as functions of
 * (deps, principal, input): geocodePlace, quoteStreet / searchGarages,
 * buildItinerary, proposePlan, confirmPlan. AssistantTools (tools.ts) is
 * the model's adapter onto them; WS-4's REST and MCP surfaces call them
 * the same way, with the same gate.
 */

import type { AppDb } from "../../db.js";
import type { GarageProvider } from "../garage/garageProvider.js";
import type { GeocodeFailure, GeocodeResult, GeocoderProvider } from "../assistant/geocoder.js";
import { TIME_IN_PAST_MS } from "../assistant/intentRouter.js";
import { requestedTimeProblem, type TimeRequest } from "../assistant/requestedTime.js";
import { emptyState, type PlaceCandidate, type RequestState } from "../assistant/requestState.js";
import { nameTokens } from "../assistant/placeMatch.js";
import { easternIso, parseEasternTime } from "../hours.js";
import type { LinkWallet } from "../link/linkWallet.js";
import type { PolicyService } from "../policy.js";
import type { CandidateFetcher, NearbyZoneFetcher } from "../zoneLookup.js";
import type { AssistantPlanBody } from "../assistant/plans.js";
import { isFresh } from "../assistant/search.js";
import type { SearchOption, SearchPool, SearchResult, SearchWindow } from "../assistant/search.js";
import { currentTimeLine } from "../assistant/replyText.js";
import type { Principal } from "../principal.js";

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

export function resolutionOf(
  lookup: Exclude<PlaceLookup, { kind: "unavailable" }>,
): PlaceResolution {
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

/** "LoLa 42, Seaport" — a found place as the card's destination label;
 * a source that gives no name keeps its own display name. */
export function placeLabel(place: GeocodeResult): string {
  if (!place.name) return place.displayName;
  return place.area && place.area !== place.name ? `${place.name}, ${place.area}` : place.name;
}

/** What the model sees of a found place. */
export function placeSummary(place: GeocodeResult) {
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
export function closestOnlyInstruction(query: string, place: GeocodeResult): string {
  const named = nameTokens(query).length > 0 ? `"${query}"` : "that place";
  const label = placeLabel(place);
  return (
    `No place called ${named} was found — the closest result is ${label}` +
    `${place.kind === "area" ? " (an area, not the place they named)" : ""}. ` +
    `Tell the user you couldn't find ${named} and that you're searching around ${label} instead, or ask for the address. ` +
    `Never present ${label} as the place they named.`
  );
}

/** Garage options farther than this from a NAMED place are dropped: every
 * option surfaced for a place is walkable from it (FR-23). */
export const NAMED_PLACE_GARAGE_RADIUS_M = 600;
/** Options a walking-time request carries (Apple's limit). */
export const MAX_WALK_TIMED = 10;
/** Walking-time requests a search may make: the options it shows and the
 * nearest, then whatever the real walks brought into view. */
export const MAX_WALK_REQUESTS = 2;
/** How far the "no data" card looks for the nearest zones we do have. */
export const NEAREST_ZONE_RADIUS_M = 3000;
/** A start more than this far ahead is paid on arrival, not confirmed now
 * (the same line the request's intent draws). */
export const PAY_ON_ARRIVAL_MS = 15 * 60_000;

export function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

/** The amounts an option's own words may state, in cents: its price, its
 * meter/fee split, and its hourly rate. */
export function ownAmounts(option: SearchOption): Set<number> {
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
export function isUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const TIME_FORMAT_HINT =
  "Send times as ISO 8601 with the UTC offset, e.g. 2026-09-26T18:00:00-04:00.";

/** What every capability takes besides who is acting. */
export interface CapabilityDeps {
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
  /** What mandates and agent keys are hashed with (API_KEY_PEPPER). */
  apiKeyPepper: string;
  now?: (() => Date) | undefined;
}

/**
 * Per-turn state the capabilities read and write. The request and the
 * latest search are this CONVERSATION's so far: the loop loads the request
 * from its row and the search from the stored transcript (so a follow-up
 * turn, or another server machine, sees what earlier turns found), and the
 * capabilities replace them as they run. The model's adapter adds who is
 * calling (tools.ts ToolContext); a REST caller builds one per request.
 */
export interface TurnState {
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

export function now(deps: CapabilityDeps): Date {
  return deps.now?.() ?? new Date();
}

/** One assistant_tool decision row: what was asked, by whom, and what came
 * of it. The one writer stamps the actor (services/decisionLog.ts). */
export async function audit(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  tool: string,
  input: unknown,
  rule: string,
  outcome: Record<string, unknown>,
): Promise<string> {
  const { id } = await deps.db.decision.create({
    data: {
      kind: "assistant_tool",
      inputs: { tool, input, conversationId: turn.conversationId },
      rule,
      outcome,
      userId: principal.userId,
    },
  });
  return id;
}

/** A window starting in the past is always a model date mistake (the
 * prod bug: "tonight" hallucinated as a 2024 date → SpotHero 400).
 * Bounce it back with the current time so the model self-corrects in
 * the same turn instead of the provider erroring opaquely. */
export function pastWindowError(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
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
  const at = now(deps);
  const starts = parseEasternTime(startsAt);
  if (!starts) {
    return audit(deps, principal, turn, tool, input, "unreadable_time", { startsAt }).then(() => ({
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
  const moved = requestedTimeProblem(turn.timeRequest, starts, at, { earlierOnly: true });
  if (moved) {
    return audit(deps, principal, turn, tool, input, "requested_time_moved", { startsAt }).then(
      () => ({
        result: { error: "requested_time_moved", startsAt, instruction: `${moved}${fix}` },
      }),
    );
  }
  if (held) {
    if (at.getTime() - starts.getTime() <= TIME_IN_PAST_MS) return null;
    return audit(deps, principal, turn, tool, input, "time_in_past", { startsAt }).then(() => ({
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
  return audit(deps, principal, turn, tool, input, "past_window", { startsAt }).then(() => ({
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

// -------------------------------------------------------------------------
// The searches (FR-43). quote_street and search_garages read the place,
// the window, the limits, and the ranking from the request; nothing the
// model passes can change what is searched.
// -------------------------------------------------------------------------

export function stateOf(turn: TurnState): RequestState {
  return turn.requestState ?? emptyState();
}

/** The latest search, when it is still good to propose from: run at the
 * request's current version, and fresh. */
export function currentSearch(deps: CapabilityDeps, turn: TurnState): SearchResult | null {
  const last = turn.lastSearch;
  if (!last || last.stateVersion !== stateOf(turn).version) return null;
  return isFresh(last, now(deps)) ? last : null;
}

/** Why a plan for `window` moves the time the user named, or null. */
export function requestedTimeMoved(
  turn: TurnState,
  window: SearchWindow,
  now: Date,
): string | null {
  if (!turn.timeRequest) return null;
  const start = window.startsNow ? now : (parseEasternTime(window.startsAt) ?? now);
  return requestedTimeProblem(turn.timeRequest, start, now);
}
