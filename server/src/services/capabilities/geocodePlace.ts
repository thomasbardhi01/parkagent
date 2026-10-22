/** geocodePlace: a named place looked up, biased to the covered metros,
 * and made the request's place (FR-44). */

import { coveredCitiesSentence, providerForCity } from "../../providers/registry.js";
import type { GeocodeQuery } from "../assistant/geocoder.js";
import { biasPointFor, homeMetroForPoint, metroForPoint } from "../assistant/geocoder.js";
import { applyPlaceResolution, emptyState } from "../assistant/requestState.js";
import { choiceLabel, choiceReply, classifyPlaceMatches } from "../assistant/placeMatch.js";
import { bestOf, candidateRecord, scoreCandidates } from "../assistant/placeScore.js";
import type { Principal } from "../principal.js";
import {
  resolutionOf,
  placeLabel,
  placeSummary,
  closestOnlyInstruction,
  now,
  audit,
} from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome, PlaceLookup } from "./turn.js";

/**
 * Look a named place up, biased to the covered metros: the geocoder's
 * results classified into one place, several, the closest thing only, or
 * nothing (placeMatch.ts). One lookup per query per turn — geocode_place
 * and a search that finds the request's place unresolved share it.
 */
export async function lookUpPlace(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  query: string,
  cityRaw?: unknown,
): Promise<PlaceLookup> {
  const key = `${String(cityRaw ?? "")}:${query.toLowerCase()}`;
  const cached = turn.placeLookups?.get(key);
  if (cached) return cached;
  const remember = (lookup: PlaceLookup): PlaceLookup => {
    (turn.placeLookups ??= new Map()).set(key, lookup);
    return lookup;
  };
  if (!deps.geocoder) return remember({ kind: "unavailable", reason: "not_configured" });
  // Bias order: the model's explicit choice, else the metro the phone
  // is in or near — "Seaport" from a Braintree phone searches Boston
  // first, and never comes back as a which-city question.
  const phoneMetro = turn.location ? homeMetroForPoint(turn.location.lat, turn.location.lng) : null;
  const city = cityRaw === "nyc" || cityRaw === "bos" ? cityRaw : (phoneMetro ?? undefined);
  // Search around the phone only when it's inside that metro; a phone
  // outside the box (Braintree) searches around the city's center.
  const near =
    turn.location && city && metroForPoint(turn.location.lat, turn.location.lng) === city
      ? turn.location
      : undefined;
  const asked: GeocodeQuery = {
    query,
    ...(city ? { city } : {}),
    ...(near ? { near } : {}),
    ...(turn.location ? { userLocation: turn.location } : {}),
  };
  const outcome = await deps.geocoder.geocode(asked, 5);
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
export function recordPlace(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  query: string,
  lookup: PlaceLookup,
): void {
  const state = turn.requestState ?? emptyState();
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
  turn.requestState = applyPlaceResolution(state, found, turn.utterance ?? "", now(deps)).state;
  turn.placeChoices =
    lookup.kind === "ambiguous"
      ? lookup.choices.map(({ label, reply }) => ({ label, reply }))
      : undefined;
}

/** Look a named place up and make it the request's place. The model
 * calls this before searching a named area so the search is at the
 * PLACE, not the phone's dot. */
export async function geocodePlace(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const query = String(input["query"] ?? "").trim();
  if (!query) {
    return { result: { error: "query is required" } };
  }
  const lookup = await lookUpPlace(deps, principal, turn, query, input["city"]);
  // Found or not, the request now names this place: a search after a
  // failed lookup must ask for it, never search the phone's location.
  recordPlace(deps, principal, turn, query, lookup);
  const stateVersion = (turn.requestState ?? emptyState()).version;
  if (lookup.kind === "unavailable" && lookup.reason === "not_configured") {
    await audit(deps, principal, turn, "geocode_place", input, "geocoder_unavailable", {});
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
    await audit(deps, principal, turn, "geocode_place", input, "geocode_error", {
      reason: lookup.reason,
    });
    return {
      result: {
        error: "geocode_failed",
        stateVersion,
        instruction:
          "Couldn't look that place up right now — tell the user and ask them to try a nearby cross-street or share their location.",
      },
    };
  }
  const phoneMetro = turn.location ? homeMetroForPoint(turn.location.lat, turn.location.lng) : null;
  const phoneCity = phoneMetro ? providerForCity(phoneMetro)?.cityDisplayName : undefined;
  if (lookup.kind === "none") {
    await audit(deps, principal, turn, "geocode_place", input, "no_match", {
      query,
      ...lookup.scoring,
    });
    return {
      result: {
        found: false,
        resolution: resolutionOf(lookup),
        stateVersion,
        instruction:
          `Couldn't find "${query}" in ${coveredCitiesSentence()}. Tell the user plainly and ask for its street address or a cross street. ` +
          "Never substitute the phone's location or a neighborhood center for a place you couldn't find" +
          (phoneCity ? `, and don't ask which city — the phone is in or near ${phoneCity}.` : "."),
      },
    };
  }
  if (lookup.kind === "ambiguous") {
    await audit(deps, principal, turn, "geocode_place", input, "ambiguous", {
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
  await audit(
    deps,
    principal,
    turn,
    "geocode_place",
    input,
    lookup.nameMatched ? "ok" : "closest_only",
    {
      query,
      ...lookup.scoring,
      count: lookup.count,
      top: summary,
    },
  );
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
