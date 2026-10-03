/**
 * Deciding what a place search actually found. A search always returns
 * SOMETHING near a name — the 2026-09-25 device test's "Moo steakhouse in
 * Seaport" came back as the Seaport neighborhood and the assistant quietly
 * searched "Seaport center" as if it were the restaurant. So the tool asks
 * three questions of the results before it grounds anything, each answered
 * from the results' scores (placeScore.ts) — numbers the model is shown and
 * can't change:
 *
 *  1. Does any result carry the NAME the user said? Names are compared
 *     loosely — case, punctuation, and stretched letters don't count
 *     ("Moo" is "Mooo....") and generic words ("steakhouse", "restaurant")
 *     and the area the user named ("in Seaport") aren't part of the name.
 *     None → the best result that shares a word with the query is only the
 *     closest thing found, and the assistant must say so instead of
 *     presenting it as the place; a result that shares nothing, or scores
 *     under `closestFloor`, is not offered at all.
 *  2. Did the user name an area? Then matches in that area win ("Moo in
 *     Seaport" is the Seaport location, not the Beacon Hill one).
 *  3. Are the remaining matches one place or several? Several distinct
 *     places (more than `distinctM` apart) are a question for the user, as
 *     tappable choices — never a guess — unless one scores `found` or
 *     better and stands clear of the rest by more than `ambiguousGap`.
 */

import type { GeocodeResult } from "./geocoder.js";
import { metersBetween } from "./geocoder.js";
import type { Scored } from "./placeScore.js";
import {
  RESOLUTION_THRESHOLDS,
  areaTokensOf,
  bestOf,
  nameOf,
  phraseOf,
  readQuery,
  scoreCandidates,
} from "./placeScore.js";
import { nameTokens } from "./placeTokens.js";

export { nameTokens } from "./placeTokens.js";

/** Two results closer than this are the same place listed twice. */
export const DISTINCT_M = RESOLUTION_THRESHOLDS.distinctM;

export type PlaceMatch =
  | { kind: "none" }
  /** nameMatched false ("closest only"): nothing carried the name;
   * `place` is only the closest result, and the user must be told so.
   * `confidence` is the place's score, 0–1. */
  | { kind: "found"; place: GeocodeResult; nameMatched: boolean; confidence: number }
  /** `scores[i]` is `choices[i]`'s score. */
  | { kind: "ambiguous"; choices: GeocodeResult[]; scores: number[] };

/** Collapse results within `distinctM` of an earlier one, keeping order. */
function distinctPlaces(scored: Scored[]): Scored[] {
  const kept: Scored[] = [];
  for (const s of scored) {
    const dup = kept.some(
      (k) =>
        metersBetween(k.result.lat, k.result.lng, s.result.lat, s.result.lng) <
        RESOLUTION_THRESHOLDS.distinctM,
    );
    if (!dup) kept.push(s);
  }
  return kept;
}

const found = (s: Scored, nameMatched: boolean): PlaceMatch => ({
  kind: "found",
  place: s.result,
  nameMatched,
  confidence: s.score,
});

/**
 * What the results come to for this query. `bias` is where the search
 * looked first (geocoder.ts `biasPointFor`): results are scored by their
 * distance from it, and several choices are offered nearest it first.
 */
export function classifyPlaceMatches(
  query: string,
  results: GeocodeResult[],
  bias?: { lat: number; lng: number } | null,
): PlaceMatch {
  if (results.length === 0) return { kind: "none" };
  const reading = readQuery(query, results);
  const scored = scoreCandidates(query, results, bias);
  // A query that names nothing ("a cafe") takes the source's first.
  if (reading.name.length === 0) return found(scored[0]!, true);

  let matched = scored.filter((s) => s.nameMatched);
  // A neighborhood's name ("Seaport", "Back Bay") is the neighborhood: a
  // result called exactly that, the area itself first. A business named
  // after it ("Seaport Hotel") only carries the name.
  if (reading.areaName) {
    const named = matched.filter((s) => phraseOf(nameOf(s.result)) === reading.areaName);
    const areas = named.filter((s) => s.result.kind === "area");
    matched = areas.length > 0 ? areas : named;
  }
  if (matched.length === 0) {
    // Nothing carries the name. The closest thing is offered as exactly
    // that — and only if it shares a word with what the user said: a
    // result that is merely nearby and listed first is the phone's
    // location by another name.
    const closest = bestOf(scored.filter((s) => s.evidence));
    return closest && closest.score >= RESOLUTION_THRESHOLDS.closestFloor
      ? found(closest, false)
      : { kind: "none" };
  }
  // An exact name beats a longer one that contains it ("Seaport" the
  // neighborhood, not "Seaport Hotel") — the name as the user said it
  // first, kind words included: "Seaport Hotel" is the hotel, and only
  // then the name without them ("Moo steakhouse" is "Mooo....").
  const said = phraseOf(nameTokens(query).filter((t) => !reading.area.includes(t)));
  const asSaid = matched.filter((s) => phraseOf(nameOf(s.result)) === said);
  const exact =
    asSaid.length > 0
      ? asSaid
      : matched.filter((s) => nameOf(s.result).join(" ") === reading.name.join(" "));
  if (exact.length > 0) matched = exact;
  // The area the user named narrows a chain to its location there. Every
  // location is "in" the city, so the most specific wins: the results
  // matching the MOST named area words ("Seaport" and "Boston" beats
  // "Boston" alone).
  if (reading.area.length > 0) {
    const hits = (s: Scored) => {
      const tokens = areaTokensOf(s.result);
      return reading.area.filter((t) => tokens.has(t)).length;
    };
    const most = Math.max(...matched.map(hits));
    if (most > 0) matched = matched.filter((s) => hits(s) === most);
  }
  // Choices the user couldn't tell apart are one place: a long street
  // comes back as several segments ("Newbury Street · Back Bay" three
  // times, 2026-09-25 live run) — only different names or neighborhoods
  // are a question worth asking.
  const seen = new Set<string>();
  const places = distinctPlaces(matched).filter((s) => {
    const label = choiceLabel(s.result).toLowerCase();
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
  if (places.length === 1) return found(places[0]!, true);

  const best = bestOf(places)!;
  const { found: sure, ambiguousFloor, ambiguousGap } = RESOLUTION_THRESHOLDS;
  // One place far ahead of its namesakes is the place: no question.
  const clear = places.every((s) => s === best || s.score < best.score - ambiguousGap);
  if (best.score >= sure && clear) return found(best, true);
  // Streets, neighborhoods, and stops of one name in one city ("Fenway":
  // the road called Fenway and the Fenway T stop, live 2026-09-25) mean the
  // best one — a question there is noise. Two or more businesses of one
  // name (a chain's locations), or the name in two cities, is a real
  // question.
  const oneCity = places.every((s) => s.result.city === places[0]!.result.city);
  if (oneCity && places.filter((s) => s.result.kind === "poi").length < 2) {
    return found(best, true);
  }
  // The choices: the places in real contention when there are two or more
  // of them, else every place that carries the name. With a bias point the
  // nearest come first (a chain's six locations are the three nearest);
  // without one, the source's order stands.
  const strong = places.filter(
    (s) => s.score >= ambiguousFloor && s.score >= best.score - ambiguousGap,
  );
  const contenders = strong.length >= 2 ? strong : places;
  const ordered = bias
    ? [...contenders].sort(
        (a, b) =>
          metersBetween(bias.lat, bias.lng, a.result.lat, a.result.lng) -
          metersBetween(bias.lat, bias.lng, b.result.lat, b.result.lng),
      )
    : contenders;
  const choices = ordered.slice(0, 3);
  return {
    kind: "ambiguous",
    choices: choices.map((s) => s.result),
    scores: choices.map((s) => s.score),
  };
}

/** Whether some result carries the whole name the query says: what tells
 * the geocoder chain to stop asking further sources. */
export function carriesTheName(
  query: string,
  results: GeocodeResult[],
  bias?: { lat: number; lng: number } | null,
): boolean {
  const match = classifyPlaceMatches(query, results, bias);
  if (match.kind === "none" || (match.kind === "found" && !match.nameMatched)) return false;
  // A neighborhood's name is carried only by the neighborhood: a T stop or
  // a park called exactly that will do if no source has the area, but the
  // next source is asked for it first.
  const { areaName } = readQuery(query, results);
  return (
    areaName === null || results.some((r) => r.kind === "area" && phraseOf(nameOf(r)) === areaName)
  );
}

/** A choice's button text: the name, then where it is. */
export function choiceLabel(place: GeocodeResult): string {
  const name = place.name ?? place.displayName.split(",")[0] ?? place.displayName;
  const where = [place.address, place.area].filter(
    (part): part is string => !!part && part !== name,
  );
  return where.length > 0 ? `${name} · ${where.join(", ")}` : name;
}

/** What a choice sends when tapped — specific enough to resolve to exactly
 * that place on the next search (its name and street address). */
export function choiceReply(place: GeocodeResult): string {
  const name = place.name ?? place.displayName.split(",")[0] ?? place.displayName;
  const where = place.address ?? place.area;
  return where && where !== name ? `${name}, ${where}` : place.displayName;
}
