/** quoteStreet / searchGarages (FR-43): the request as it stands, searched
 * one kind at a time; the result is the conversation's latest search. */

import { coveredCitiesSentence } from "../../providers/registry.js";
import type { GarageProvider } from "../garage/garageProvider.js";
import { metersBetween, metroForPoint } from "../assistant/geocoder.js";
import { STAY_QUESTION, STAY_SUGGESTIONS } from "../assistant/clarify.js";
import { heldToItsStart, intentOf, stayFor, toolAllowed } from "../assistant/intentRouter.js";
import { type Kind, type PlaceCandidate, type RequestState } from "../assistant/requestState.js";
import { easternIso, parseEasternTime } from "../hours.js";
import type { NoneMeetsPlan } from "../assistant/plans.js";
import {
  buildSearchResult,
  garageSearchOption,
  isGarageOnly,
  kindsToSearch,
  poolFromResult,
  requestSummaryFor,
  streetSearchOption,
} from "../assistant/search.js";
import type {
  GarageSearchMeta,
  SearchOption,
  SearchPlace,
  SearchPool,
  SearchResult,
  SearchWindow,
} from "../assistant/search.js";
import type { StreetSearch } from "../assistant/streetOptions.js";
import {
  MAX_STREET_RADIUS_M,
  streetOptionsNear,
  streetSummary,
  walkMinutesFor,
} from "../assistant/streetOptions.js";
import type { Principal } from "../principal.js";
import {
  resolutionOf,
  closestOnlyInstruction,
  NAMED_PLACE_GARAGE_RADIUS_M,
  MAX_WALK_TIMED,
  MAX_WALK_REQUESTS,
  now,
  audit,
  stateOf,
  currentSearch,
  pastWindowError,
} from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome } from "./turn.js";
import { cardFrame, presentPlan } from "./cards.js";
import { lookUpPlace, recordPlace } from "./geocodePlace.js";

/** When the request starts: its start, or now when it names none.
 * Refused when the start is in the past (V7 holds a later or garage-only
 * request to five minutes) or moves a time the user named. */
export async function searchStart(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  tool: string,
  input: unknown,
): Promise<{ ok: true; start: Date } | { ok: false; outcome: ToolOutcome }> {
  const state = stateOf(turn);
  const at = now(deps);
  const startsAt = state.window.startsAt ?? easternIso(at);
  const refused = await pastWindowError(
    deps,
    principal,
    turn,
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
export async function searchWindow(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  tool: string,
  input: unknown,
  start: Date,
): Promise<{ ok: true; window: SearchWindow } | { ok: false; outcome: ToolOutcome }> {
  const state = stateOf(turn);
  const stay = stayFor(state);
  if (!stay) {
    const intent = intentOf(state);
    await audit(deps, principal, turn, tool, input, "duration_needed", {
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
export async function placeFor(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  tool: string,
  input: unknown,
): Promise<{ ok: true; place: SearchPlace; note?: string } | { ok: false; outcome: ToolOutcome }> {
  const unresolved = async (
    reason: "ambiguous" | "not_found" | "lookup_unavailable" | "no_place",
    question: string,
    candidates: PlaceCandidate[] = [],
  ) => {
    const state = stateOf(turn);
    await audit(deps, principal, turn, tool, input, "place_unresolved", {
      reason,
      query: state.place.query,
      candidates: candidates.length,
      stateVersion: state.version,
    });
    const suggestions = candidates.slice(0, 4).map(({ label, reply }) => ({ label, reply }));
    if (suggestions.length >= 2) turn.placeChoices = suggestions;
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

  let state = stateOf(turn);
  const query = state.place.query;
  if (!state.place.resolved && !state.place.candidates?.length && query) {
    // Named, never resolved: look it up now (once per turn).
    const lookup = await lookUpPlace(deps, principal, turn, query);
    if (lookup.kind !== "unavailable") {
      // The search resolved the place itself: the same record
      // geocode_place leaves, under this tool's name.
      await audit(deps, principal, turn, tool, input, "place_lookup", {
        query,
        resolution: resolutionOf(lookup),
        ...lookup.scoring,
      });
    }
    if (lookup.kind === "found" || lookup.kind === "ambiguous") {
      recordPlace(deps, principal, turn, query, lookup);
      state = stateOf(turn);
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
    } else if (state.intent === "park_now" && turn.location) {
      return {
        ok: true,
        place: { ...turn.location, label: null, source: "default" },
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
  if (turn.location) {
    return { ok: true, place: { ...turn.location, label: null, source: "default" } };
  }
  return unresolved("no_place", "Where do you want to park? Name a place or an address.");
}

/** The pool this search adds to: this turn's, or the previous turn's
 * read back from the transcript — when it is for the same request
 * version and the same point, and still fresh. Otherwise a new one. */
export function poolFor(
  deps: CapabilityDeps,
  turn: TurnState,
  version: number,
  place: SearchPlace,
  window: SearchWindow,
): SearchPool {
  const last = currentSearch(deps, turn);
  const held = turn.searchPool ?? (last ? poolFromResult(last) : null);
  const same =
    held !== null &&
    held !== undefined &&
    held.stateVersion === version &&
    metersBetween(held.place.lat, held.place.lng, place.lat, place.lng) < 50;
  return same ? { ...held, place, window } : { stateVersion: version, place, window };
}

/** Every metered block within a walk of the place, as search options.
 * When the usual walk holds none, the widest one is tried. */
export async function streetPool(
  deps: CapabilityDeps,
  place: SearchPlace,
  start: Date,
  window: SearchWindow,
  version: number,
  fetchedAt: string,
): Promise<NonNullable<SearchPool["street"]>> {
  let search = await streetSearch(deps, place.lat, place.lng, start, window.durationMinutes);
  if (search.all.length === 0) {
    search = await streetSearch(
      deps,
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
export async function garagePool(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
  place: SearchPlace,
  window: SearchWindow,
  version: number,
  fetchedAt: string,
): Promise<NonNullable<SearchPool["garage"]> & { fromCache?: boolean }> {
  const provider = deps.garage.id;
  let outcome: Awaited<ReturnType<GarageProvider["search"]>>;
  try {
    outcome = await deps.garage.search({
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
    await audit(deps, principal, turn, "search_garages", input, "garage_search_error", {
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
export async function timeWalks(
  deps: CapabilityDeps,
  kind: Kind,
  pool: SearchPool,
  state: RequestState,
  place: SearchPlace,
  at: { searchedAt: string; inCoverage: boolean },
): Promise<number> {
  const held = pool[kind];
  if (!held) return 0;
  held.options = held.options.map((o) => ({ ...o, walkEstimate: true }));
  const geocoder = deps.geocoder;
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
export function inCoverage(place: SearchPlace): boolean {
  return metroForPoint(place.lat, place.lng) !== null;
}

/**
 * quote_street / search_garages. Searches one kind for the request as
 * it stands and answers with the request's whole search so far at this
 * version — both kinds once both have run — filtered and ordered by the
 * server (search.ts). That result becomes the conversation's latest
 * search: the only thing propose_plan accepts options from.
 */
export async function runSearch(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  kind: Kind,
  input: unknown,
): Promise<ToolOutcome> {
  const tool = kind === "street" ? "quote_street" : "search_garages";
  const started = await searchStart(deps, principal, turn, tool, input);
  if (!started.ok) return started.outcome;
  const placed = await placeFor(deps, principal, turn, tool, input);
  if (!placed.ok) return placed.outcome;
  // Where first, then how long: a stay asked about a place the search
  // can't find would be a question wasted.
  const windowed = await searchWindow(deps, principal, turn, tool, input, started.start);
  if (!windowed.ok) return windowed.outcome;
  // Read after the place: resolving it may have bumped the version.
  const state = stateOf(turn);
  const { start } = started;
  const { window } = windowed;
  const { place } = placed;
  const fetchedAt = now(deps).toISOString();
  const pool = poolFor(deps, turn, state.version, place, window);

  let fromCache: boolean | undefined;
  if (kind === "street") {
    pool.street = await streetPool(deps, place, start, window, state.version, fetchedAt);
  } else {
    const garage = await garagePool(
      deps,
      principal,
      turn,
      input,
      place,
      window,
      state.version,
      fetchedAt,
    );
    fromCache = garage.fromCache;
    pool.garage = { options: garage.options, meta: garage.meta, fetchedAt };
    // A garage-only request whose garage search is down has nothing to
    // show: the turn ends on an "unavailable" card, with no street
    // substitute — the user asked for a garage.
    if (garage.meta.unavailable && state.intent === "garage_or_lot") {
      return garageUnavailableCard(
        deps,
        principal,
        turn,
        state,
        place,
        window,
        garage.meta,
        fetchedAt,
      );
    }
    // A garage-only request has no street quote of its own: the tool is
    // off. The server runs one here, for two things only — the cheaper
    // meter the result may show as a near-miss (search.ts), and what
    // "street or garage is fine" would yield.
    if (isGarageOnly(state.hard) && !pool.street) {
      pool.street = await streetPool(deps, place, start, window, state.version, fetchedAt);
    }
  }
  const at = { searchedAt: fetchedAt, inCoverage: inCoverage(place) };
  const walksTimed = await timeWalks(deps, kind, pool, state, place, at);
  turn.searchPool = pool;
  const result = buildSearchResult(pool, state, at);
  turn.lastSearch = result;
  turn.searchesThisTurn = (turn.searchesThisTurn ?? 0) + 1;
  await audit(deps, principal, turn, tool, input, "ok", {
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
    result: { ...result, instruction: searchInstruction(result, state, placed.note) },
  };
}

/** What the model is told to do with a search result. The verdict is
 * the server's; this only says which propose_plan follows from it. */
export function searchInstruction(
  result: SearchResult,
  state: RequestState,
  placeNote?: string,
): string {
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
export async function completeSearch(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
): Promise<ToolOutcome | null> {
  for (const kind of kindsToSearch(stateOf(turn).hard)) {
    const last = currentSearch(deps, turn);
    if (!last || last.satisfying.length > 0) return null;
    if (last.searched.includes(kind)) continue;
    const outcome = await runSearch(deps, principal, turn, kind, { note: "completing the search" });
    // A garage-only request whose garage search is down ends the turn
    // on its own card.
    if (outcome.endTurn) return outcome;
  }
  return null;
}

export function searchGarages(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
): Promise<ToolOutcome> {
  return runSearch(deps, principal, turn, "garage", input);
}

export function quoteStreet(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
): Promise<ToolOutcome> {
  return runSearch(deps, principal, turn, "street", input);
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
export function streetSearch(
  deps: CapabilityDeps,
  lat: number,
  lng: number,
  when: Date,
  minutes: number,
  radiusM?: number,
): Promise<StreetSearch> {
  return streetOptionsNear(
    {
      db: deps.db,
      policy: deps.policy.get(),
      findCandidates: deps.findCandidates,
      findNearbyZones: deps.findNearbyZones,
    },
    { lat, lng, when, minutes, radiusM },
  );
}

/** The garage search build_itinerary runs for a stop's window, in the
 * canonical ET form the providers and the cache key on. */
export function searchGarageWindow(
  deps: CapabilityDeps,
  lat: number,
  lng: number,
  arrivalAt: Date,
  minutes: number,
) {
  return deps.garage.search({
    lat,
    lng,
    startsAt: easternIso(arrivalAt),
    endsAt: easternIso(new Date(arrivalAt.getTime() + minutes * 60_000)),
  });
}

/**
 * A garage-only request whose garage search is down: a card that says
 * so, with nothing on it — no street substitute, the user asked for a
 * garage — and one chip to try again. Ends the turn.
 */
export async function garageUnavailableCard(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
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
    ...cardFrame(search, [], now(deps), turn.timeRequest),
    verdict: "none_meets",
    requestSummary: requestSummaryFor(state, search),
  };
  turn.searchesThisTurn = (turn.searchesThisTurn ?? 0) + 1;
  return presentPlan(
    deps,
    principal,
    turn,
    { tool: "search_garages" },
    plan,
    "garage_search_unavailable",
  );
}
