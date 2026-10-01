/**
 * What a search of the request comes to (FR-43).
 *
 * quote_street and search_garages no longer take a place, a time, or a
 * budget from the model: they read the conversation's RequestState, so a
 * constraint can't be dropped on the way into a search. This file holds
 * the part of that with no I/O — the pure step from "the options the
 * providers returned" and "the request" to what the model is handed and
 * what propose_plan will accept:
 *
 *  - `satisfying`: the options that pass every set hard constraint,
 *    ordered for the request (streetOptions.ts `orderForRequest`); the
 *    model never reorders them;
 *  - `nearMisses`: the nearest options that break one, each with the
 *    server's `violates` — the limit and the actual;
 *  - `relaxSuggestions`: only when nothing satisfies — the same filter run
 *    again with one limit loosened a step (never another provider call),
 *    and how many options that would yield;
 *  - a `verdict`, so "nothing meets this" (none_meets), "we have nothing
 *    there" (no_data), and "we don't cover there" (outside_coverage) are
 *    three different facts.
 *
 * Every option id carries the request version it was searched at
 * ("v3-bos-seaport-blvd-…"), so an option from before an edit can never
 * be mistaken for a current one. The latest result is the conversation's
 * `lastSearch`: held on the tool context for the turn, and read back from
 * the stored transcript on the next one (`lastSearchIn`), so it survives a
 * restart and holds across machines.
 */

import { z } from "zod";

import type { GarageOption } from "../garage/garageProvider.js";
import type { ModelTurn } from "./loop.js";
import type { Violation } from "./plans.js";
import { violationSchema } from "./plans.js";
import { KINDS } from "./requestState.js";
import type { Kind, RequestState } from "./requestState.js";
import { orderForRequest } from "./streetOptions.js";
import type { Axis, StreetOption } from "./streetOptions.js";

/** A search older than this is stale: prices are for when they were
 * fetched, and the garage sources' own cache lasts this long. */
export const SEARCH_FRESH_MS = 10 * 60_000;
/** The stay a search assumes when the request names none. */
export const DEFAULT_STAY_MINUTES = 120;
/** What the model is shown of each list. */
export const MAX_SATISFYING_SHOWN = 5;
export const MAX_NEAR_MISSES = 3;
/** One step of relaxing a limit. */
export const RELAX_PRICE_STEP_USD = 5;
export const RELAX_WALK_STEP_MINUTES = 5;

export type Verdict = "meets" | "none_meets" | "no_data" | "outside_coverage";

/** One option of a search, street or garage, as the model sees it and as
 * propose_plan copies it onto a card. */
export interface SearchOption {
  /** `v{request version}-{zone id | garage option id}`. */
  id: string;
  type: Kind;
  label: string;
  priceUsd: number;
  walkMinutes: number;
  distanceM: number;
  /** The minutes the price buys: the stay, or a meter's max stay when the
   * stay outruns it. */
  durationMinutes: number;
  /** When the price was fetched (ISO). */
  fetchedAt: string;
  lat?: number | undefined;
  lng?: number | undefined;
  /** Decision 8 labels, set on satisfying options only. */
  axis?: Axis | undefined;
  secondary?: true | undefined;
  /** Street: the zone, the block in one line, and its facts for the card. */
  zoneId?: string | undefined;
  summary?: string | undefined;
  facts?: StreetOption | undefined;
  /** Garage: the source's own option id, the source, and its checkout. */
  garageOptionId?: string | undefined;
  provider?: string | undefined;
  deepLink?: string | undefined;
  entryType?: string | undefined;
  address?: string | undefined;
}

export interface NearMiss {
  option: SearchOption;
  violates: Violation[];
}

export interface RelaxSuggestion {
  field: "maxPriceUsd" | "maxWalkMinutes" | "kinds";
  to: number | Kind[];
  wouldYield: number;
  label: string;
  reply: string;
}

/** Where a search looked. `default` is the phone's location, used when
 * the user named no place (or, park-now only, when the lookup of the one
 * they named was down) — an assumption the card states. */
export interface SearchPlace {
  lat: number;
  lng: number;
  label: string | null;
  source: "user" | "default";
}

export interface SearchWindow {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  /** The request names no start: the stay starts when the user parks. */
  startsNow: boolean;
  durationSource: "user" | "default";
}

export interface StreetSearchMeta {
  radiusM: number;
  zonesInRadius: number;
}

export interface GarageSearchMeta {
  provider: string;
  /** Offers found (priced, and within reach of a named place). */
  found: number;
  /** The search FAILED — a different fact from "no garages". */
  unavailable?: true | undefined;
  reason?: string | undefined;
  degraded?: { provider: string; error: string }[] | undefined;
  droppedForDistance?: number | undefined;
  nearestBeyondM?: number | undefined;
  droppedNoPrice?: number | undefined;
}

export interface SearchResult {
  stateVersion: number;
  verdict: Verdict;
  /** The kinds searched at this version, failures included. */
  searched: Kind[];
  searchedAt: string;
  place: SearchPlace;
  window: SearchWindow;
  satisfying: SearchOption[];
  nearMisses: NearMiss[];
  relaxSuggestions?: RelaxSuggestion[] | undefined;
  street?: StreetSearchMeta | undefined;
  garage?: GarageSearchMeta | undefined;
}

/** Everything the searches found at one request version, before it is cut
 * to what the model is shown: what a relaxation is counted over. */
export interface SearchPool {
  stateVersion: number;
  place: SearchPlace;
  window: SearchWindow;
  street?: { options: SearchOption[]; meta: StreetSearchMeta; fetchedAt: string } | undefined;
  garage?: { options: SearchOption[]; meta: GarageSearchMeta; fetchedAt: string } | undefined;
}

export const optionId = (version: number, rawId: string) => `v${version}-${rawId}`;

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** A street block as a search option. */
export function streetSearchOption(
  option: StreetOption,
  at: { version: number; startsAt: string | null; fetchedAt: string },
): SearchOption {
  return {
    id: optionId(at.version, option.zoneId),
    type: "street",
    // The zone id is an internal slug and never shown; a block with no
    // street name and no number says so on the meter instead.
    label: option.street
      ? `Street — ${option.street}`
      : option.zoneNumber
        ? `Street — Zone ${option.zoneNumber}`
        : "Street — zone number on the meter",
    priceUsd: option.costUsd,
    walkMinutes: option.walkMinutes,
    distanceM: option.distanceM,
    durationMinutes: option.clampedMinutes,
    fetchedAt: at.fetchedAt,
    lat: option.lat,
    lng: option.lng,
    zoneId: option.zoneId,
    summary: option.summary,
    facts: option,
  };
}

/** A garage offer as a search option, or null when it has no usable
 * price: an offer we can't price can't be held to a budget, shown on a
 * card, or ranked, so it is dropped (and counted). */
export function garageSearchOption(
  option: GarageOption,
  at: { version: number; minutes: number; fetchedAt: string; distanceM?: number | undefined },
): SearchOption | null {
  const price: unknown = option.priceUsd;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  const distanceM = Math.round(at.distanceM ?? option.distanceM);
  const walk: unknown = option.walkMinutes;
  return {
    id: optionId(at.version, option.id),
    type: "garage",
    label: option.name || "Garage",
    priceUsd: Math.round(price * 100) / 100,
    walkMinutes:
      typeof walk === "number" && Number.isFinite(walk) && walk >= 0
        ? Math.round(walk)
        : Math.max(1, Math.round((distanceM * 1.3) / 80)),
    distanceM,
    durationMinutes: at.minutes,
    fetchedAt: at.fetchedAt,
    ...(typeof option.lat === "number" && typeof option.lng === "number"
      ? { lat: option.lat, lng: option.lng }
      : {}),
    garageOptionId: option.id,
    provider: option.provider,
    deepLink: option.deepLink,
    entryType: option.entryType,
    address: option.address,
  };
}

/** The hard constraints an option breaks; empty when it meets them all.
 * What we can't verify doesn't count as met: "valet" needs an offer that
 * says valet, and no source says whether a garage is covered. "Self-park"
 * is broken only by an offer that says valet. */
export function violationsOf(option: SearchOption, hard: RequestState["hard"]): Violation[] {
  const out: Violation[] = [];
  if (hard.maxPriceUsd !== null && option.priceUsd > hard.maxPriceUsd + 0.004) {
    out.push({ field: "maxPriceUsd", actual: option.priceUsd, limit: hard.maxPriceUsd });
  }
  if (hard.maxWalkMinutes !== null && option.walkMinutes > hard.maxWalkMinutes) {
    out.push({ field: "maxWalkMinutes", actual: option.walkMinutes, limit: hard.maxWalkMinutes });
  }
  if (hard.kinds !== null && !hard.kinds.includes(option.type)) {
    out.push({ field: "kinds", actual: option.type, limit: [...hard.kinds] });
  }
  if (hard.entryType !== null) {
    const actual = option.type === "street" ? "self" : (option.entryType ?? "unknown");
    const met = hard.entryType === "valet" ? actual === "valet" : actual !== "valet";
    if (!met) out.push({ field: "entryType", actual, limit: hard.entryType });
  }
  if (hard.covered === true) {
    out.push({
      field: "covered",
      actual: option.type === "street" ? false : "unknown",
      limit: true,
    });
  }
  return out;
}

/** How far past its limits an option is, for ordering near-misses: fewer
 * broken limits first, then the smaller overshoot. */
function overshoot(violates: Violation[]): number {
  return violates.reduce((sum, v) => {
    if (typeof v.actual === "number" && typeof v.limit === "number") {
      return sum + (v.actual - v.limit) / Math.max(v.limit, 1);
    }
    return sum + 1;
  }, 0);
}

function relaxed(
  hard: RequestState["hard"],
  field: RelaxSuggestion["field"],
): { hard: RequestState["hard"]; to: number | Kind[] } | null {
  if (field === "maxPriceUsd" && hard.maxPriceUsd !== null) {
    const to = Math.round((hard.maxPriceUsd + RELAX_PRICE_STEP_USD) * 100) / 100;
    return { hard: { ...hard, maxPriceUsd: to }, to };
  }
  if (field === "maxWalkMinutes" && hard.maxWalkMinutes !== null) {
    const to = hard.maxWalkMinutes + RELAX_WALK_STEP_MINUTES;
    return { hard: { ...hard, maxWalkMinutes: to }, to };
  }
  if (field === "kinds" && hard.kinds !== null && hard.kinds.length < KINDS.length) {
    return { hard: { ...hard, kinds: null }, to: [...KINDS] };
  }
  return null;
}

function relaxWords(field: RelaxSuggestion["field"], to: number | Kind[]): string {
  if (field === "maxPriceUsd") return `Allow up to ${money(to as number)}`;
  if (field === "maxWalkMinutes") return `Walk up to ${to as number} min`;
  return "Street or garage is fine";
}

/**
 * What relaxing each set limit one step would yield: the FILTER re-run
 * over the options already fetched (price +$5, walk +5 min, kinds → both),
 * never another provider call. Every relaxable limit is reported with its
 * count, zero included, so "raising the budget wouldn't help" is a fact on
 * the record too.
 */
export function relaxSuggestionsFor(
  pool: readonly SearchOption[],
  hard: RequestState["hard"],
): RelaxSuggestion[] {
  const out: RelaxSuggestion[] = [];
  for (const field of ["maxPriceUsd", "maxWalkMinutes", "kinds"] as const) {
    const step = relaxed(hard, field);
    if (!step) continue;
    const words = relaxWords(field, step.to);
    out.push({
      field,
      to: step.to,
      wouldYield: pool.filter((o) => violationsOf(o, step.hard).length === 0).length,
      label: words,
      reply: words,
    });
  }
  return out;
}

/** Whether any hard constraint is set. */
export function hasHardConstraint(hard: RequestState["hard"]): boolean {
  return (
    hard.maxPriceUsd !== null ||
    hard.maxWalkMinutes !== null ||
    hard.kinds !== null ||
    hard.entryType !== null ||
    hard.covered !== null
  );
}

/** The kinds a "nothing meets this" verdict needs searched first: street
 * always (our own data, and what "street or garage is fine" would yield),
 * garages unless the request rules them out. */
export function kindsToSearch(hard: RequestState["hard"]): Kind[] {
  return hard.kinds !== null && !hard.kinds.includes("garage") ? ["street"] : ["street", "garage"];
}

/** Every option the pool holds, both kinds. */
export function poolOptions(pool: SearchPool): SearchOption[] {
  return [...(pool.street?.options ?? []), ...(pool.garage?.options ?? [])];
}

/**
 * The pool, filtered and ordered for the request: the result the model is
 * handed and propose_plan validates against.
 */
export function buildSearchResult(
  pool: SearchPool,
  state: RequestState,
  at: { searchedAt: string; inCoverage: boolean },
): SearchResult {
  // Labels from an earlier build of the same pool don't carry over.
  const options = poolOptions(pool).map((o) => {
    const plain = { ...o };
    delete plain.axis;
    delete plain.secondary;
    return plain;
  });
  const judged = options.map((option) => ({ option, violates: violationsOf(option, state.hard) }));
  const ordered = orderForRequest(
    judged.filter((j) => j.violates.length === 0).map((j) => j.option),
    {
      rank: state.soft.rank,
      prefer: state.soft.prefer,
      priceLimited: state.hard.maxPriceUsd !== null,
      walkLimited: state.hard.maxWalkMinutes !== null,
    },
  );
  // What the model is shown: the head of the order — and the best option
  // of each kind, so a handful of cheap meters never hides every garage
  // (or the reverse) from a request that didn't rule the kind out.
  const satisfying = ordered.slice(0, MAX_SATISFYING_SHOWN);
  for (const kind of KINDS) {
    if (satisfying.some((o) => o.type === kind)) continue;
    const best = ordered.find((o) => o.type === kind);
    if (best) satisfying[satisfying.length - 1] = best;
  }
  const nearMisses = judged
    .filter((j) => j.violates.length > 0)
    .sort(
      (a, b) =>
        a.violates.length - b.violates.length ||
        overshoot(a.violates) - overshoot(b.violates) ||
        a.option.priceUsd - b.option.priceUsd ||
        a.option.walkMinutes - b.option.walkMinutes ||
        (a.option.id < b.option.id ? -1 : 1),
    )
    .slice(0, MAX_NEAR_MISSES);

  const searched = KINDS.filter((kind) => pool[kind] !== undefined);
  const verdict: Verdict =
    satisfying.length > 0
      ? "meets"
      : hasHardConstraint(state.hard)
        ? "none_meets"
        : at.inCoverage
          ? "no_data"
          : "outside_coverage";
  return {
    stateVersion: pool.stateVersion,
    verdict,
    searched,
    searchedAt: at.searchedAt,
    place: pool.place,
    window: pool.window,
    satisfying,
    nearMisses,
    ...(satisfying.length === 0 && hasHardConstraint(state.hard)
      ? { relaxSuggestions: relaxSuggestionsFor(options, state.hard) }
      : {}),
    ...(pool.street ? { street: pool.street.meta } : {}),
    ...(pool.garage ? { garage: pool.garage.meta } : {}),
  };
}

/**
 * The limits nothing met, each with the nearest any option came: what the
 * "no" card's headline is built from. With no option at all, every set
 * limit is listed (there is no actual to report).
 */
export function constraintsFailedFor(
  pool: readonly SearchOption[],
  hard: RequestState["hard"],
): { field: string; limit: Violation["limit"]; nearestActual?: number }[] {
  const limits: [Violation["field"], Violation["limit"]][] = [
    ["maxPriceUsd", hard.maxPriceUsd],
    ["maxWalkMinutes", hard.maxWalkMinutes],
    ["kinds", hard.kinds],
    ["entryType", hard.entryType],
    ["covered", hard.covered],
  ];
  const out: { field: string; limit: Violation["limit"]; nearestActual?: number }[] = [];
  for (const [field, limit] of limits) {
    if (limit === null) continue;
    const actuals = pool.flatMap((o) =>
      violationsOf(o, hard)
        .filter((v) => v.field === field)
        .map((v) => v.actual),
    );
    if (pool.length > 0 && actuals.length === 0) continue;
    const numbers = actuals.filter((a): a is number => typeof a === "number");
    out.push({
      field,
      limit,
      ...(numbers.length > 0 ? { nearestActual: Math.min(...numbers) } : {}),
    });
  }
  return out;
}

/** The "no" in a sentence or two, from the limits and the nearest
 * near-miss: "Nothing under $2.00 near Cambridge Common. Closest: Street —
 * Mass Ave, $4.50, 5 min walk." */
export function noneMeetsHeadline(
  hard: RequestState["hard"],
  place: SearchPlace,
  nearest: SearchOption | undefined,
): string {
  const noun =
    hard.kinds?.length === 1
      ? hard.kinds[0] === "garage"
        ? "No garage"
        : "No street parking"
      : "Nothing";
  const limits = [
    hard.entryType === "valet"
      ? "with valet"
      : hard.entryType === "self"
        ? "you park yourself"
        : null,
    hard.covered === true ? "that's covered" : null,
    hard.maxPriceUsd !== null ? `under ${money(hard.maxPriceUsd)}` : null,
    hard.maxWalkMinutes !== null ? `within a ${hard.maxWalkMinutes}-minute walk` : null,
  ].filter((part): part is string => part !== null);
  const where = place.source === "user" && place.label ? `near ${place.label}` : "near you";
  const no = `${[noun, ...limits].join(" ")} ${where}.`;
  if (!nearest) return no;
  const price = nearest.priceUsd === 0 ? "free" : money(nearest.priceUsd);
  return `${no} Closest: ${nearest.label}, ${price}, ${nearest.walkMinutes} min walk.`;
}

// ---------------------------------------------------------------------------
// The latest search, read back from a stored transcript.
// ---------------------------------------------------------------------------

const storedOptionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(KINDS),
    label: z.string(),
    priceUsd: z.number().nonnegative(),
    walkMinutes: z.number().nonnegative(),
    distanceM: z.number().nonnegative(),
    durationMinutes: z.number().positive(),
    fetchedAt: z.string(),
  })
  .loose();

const storedSearchSchema = z
  .object({
    stateVersion: z.number().int().nonnegative(),
    verdict: z.enum(["meets", "none_meets", "no_data", "outside_coverage"]),
    searched: z.array(z.enum(KINDS)),
    searchedAt: z.string(),
    place: z.object({
      lat: z.number(),
      lng: z.number(),
      label: z.string().nullable(),
      source: z.enum(["user", "default"]),
    }),
    window: z.object({
      startsAt: z.string(),
      endsAt: z.string(),
      durationMinutes: z.number().positive(),
      startsNow: z.boolean(),
      durationSource: z.enum(["user", "default"]),
    }),
    satisfying: z.array(storedOptionSchema),
    nearMisses: z.array(
      z.object({ option: storedOptionSchema, violates: z.array(violationSchema) }),
    ),
  })
  .loose();

/**
 * The latest search a stored transcript holds at `version`: the last
 * quote_street / search_garages result stamped with it. Derived from the
 * transcript rather than held in memory, so a follow-up turn — or another
 * server machine — proposes from what the previous turn found, and it is
 * the conversation OWNER's by construction (the loop only loads a
 * transcript for its owner). A result from another version, one whose
 * tool_use was trimmed away, or one that doesn't read as a search is
 * skipped: the model searches again.
 */
export function lastSearchIn(turns: readonly ModelTurn[], version: number): SearchResult | null {
  const searches = new Set<string>();
  let last: SearchResult | null = null;
  for (const turn of turns) {
    if (typeof turn.content === "string") continue;
    for (const block of turn.content) {
      if (block.type === "tool_use") {
        if (block.name === "quote_street" || block.name === "search_garages")
          searches.add(block.id);
        continue;
      }
      if (block.type !== "tool_result" || !searches.has(block.tool_use_id)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(block.content);
      } catch {
        continue; // Not JSON: nothing searched.
      }
      const parsed = storedSearchSchema.safeParse(raw);
      if (parsed.success && parsed.data.stateVersion === version) {
        last = parsed.data as unknown as SearchResult;
      }
    }
  }
  return last;
}

/** A pool rebuilt from a result read back from the transcript: the
 * options it showed are what the earlier turn's search is known by. */
export function poolFromResult(result: SearchResult): SearchPool {
  const options = [...result.satisfying, ...result.nearMisses.map((n) => n.option)];
  const of = (kind: Kind) => options.filter((o) => o.type === kind);
  return {
    stateVersion: result.stateVersion,
    place: result.place,
    window: result.window,
    ...(result.searched.includes("street") && result.street
      ? { street: { options: of("street"), meta: result.street, fetchedAt: result.searchedAt } }
      : {}),
    ...(result.searched.includes("garage") && result.garage
      ? { garage: { options: of("garage"), meta: result.garage, fetchedAt: result.searchedAt } }
      : {}),
  };
}

/** Whether a search is still good to propose from at `now`. */
export function isFresh(result: SearchResult, now: Date): boolean {
  const at = Date.parse(result.searchedAt);
  return Number.isFinite(at) && now.getTime() - at <= SEARCH_FRESH_MS;
}
