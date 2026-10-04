/**
 * How sure a place search is, as a number (FR-44).
 *
 * A search always returns something. Each result is scored 0–1 against
 * what the user said, from five things that can be read off the result
 * with no I/O and no model:
 *
 *   name      0–0.5   the share of the query's name words its name carries
 *                     (a word it carries only the start of counts half)
 *   area      ±0.2    the area the user named: carried, or absent (0 when
 *                     they named none)
 *   distance  0–0.15  full within 3 km of the bias point, falling in a
 *                     straight line to nothing at 15 km
 *   poi       +0.1    the query names something other than a neighborhood,
 *                     and this is a business, venue, or landmark
 *   rank      +0.05   its source listed it first
 *
 * The classifier (placeMatch.ts) reads the scores against
 * RESOLUTION_THRESHOLDS to tell one place from several, the closest thing
 * from nothing at all. The model is handed the outcome and the number; it
 * sets neither.
 */

import { coveredCities } from "../../providers/registry.js";
import type { GeocodeResult } from "./geocoder.js";
import { metersBetween } from "./geocoder.js";
import { carriesAll, isFillerWord, isGenericWord, nameMatch, nameTokens } from "./placeTokens.js";

/** The lines the classifier draws, in one place so tests pin them. */
export const RESOLUTION_THRESHOLDS = {
  /** Among several places carrying the name, the best is taken without a
   * question only at or above this — and only when it is clear of the
   * rest by more than `ambiguousGap`. */
  found: 0.75,
  /** A place this sure, and within `ambiguousGap` of the best, is one of
   * the choices offered. */
  ambiguousFloor: 0.6,
  ambiguousGap: 0.2,
  /** With nothing carrying the name, a result below this isn't even "the
   * closest thing": the answer is "couldn't find it". */
  closestFloor: 0.3,
  /** Two results closer than this (metres) are one place listed twice. */
  distinctM: 250,
} as const;

/** A search this weak is retried through autocomplete (appleMaps.ts). */
export const WEAK_SEARCH_BELOW = 0.55;

const NAME_WEIGHT = 0.5;
const AREA_WEIGHT = 0.2;
const DISTANCE_WEIGHT = 0.15;
const POI_BONUS = 0.1;
const RANK_BONUS = 0.05;
const NEAR_M = 3_000;
const FAR_M = 15_000;

export interface Scored {
  result: GeocodeResult;
  /** 0–1, to three decimals. */
  score: number;
  /** Its name carries every name word of the query. */
  nameMatched: boolean;
  /** It shares a word with the query: a whole name word (not only the
   * start of one), or an area the user named that is narrower than a whole
   * covered city. Without one, being near the phone and listed first is
   * not a reason to offer it. */
  evidence: boolean;
  parts: { name: number; area: number; distance: number; poi: number; rank: number };
}

/** What a query says, read against the results it returned. */
export interface QueryReading {
  /** The words that are the place's name. */
  name: string[];
  /** The words that say where it is, not what it's called. */
  area: string[];
  /** The query has a word that isn't a generic one ("bar", "the"). */
  specific: boolean;
  /** The query is, as a whole, the name of an area some result lists —
   * "Seaport", "Back Bay": the neighborhood, not a business named after
   * it. The phrase as compared (`phraseOf`), or null. */
  areaName: string | null;
}

/** A name as compared whole: its tokens without filler words. */
export function phraseOf(text: string | readonly string[]): string {
  const tokens = typeof text === "string" ? nameTokens(text) : text;
  return tokens.filter((t) => !isFillerWord(t)).join(" ");
}

/** The names of the areas the results say they are in: a place lying in
 * "Seaport" is what makes "Seaport" a neighborhood's name. (A result that
 * is itself an area doesn't count on its own: a park or a street can be
 * "an area" and still be what the user meant by its name.) */
function areaPhrases(results: readonly GeocodeResult[]): Set<string> {
  return new Set(
    results
      .flatMap((r) => [...(r.areaNames ?? []), r.area ?? ""])
      .map((name) => phraseOf(name))
      .filter((p) => p.length > 0),
  );
}

/** A result's name as tokens. */
export function nameOf(result: GeocodeResult): string[] {
  return nameTokens(result.name ?? result.displayName.split(",")[0] ?? "");
}

/** The words that say WHERE a result is: its neighborhoods, its street
 * address, and — for a street or neighborhood — its own name. A tapped
 * choice sends "Mooo...., 15 Beacon St": the address picks the location,
 * it isn't part of the name. */
export function areaTokensOf(result: GeocodeResult): Set<string> {
  return new Set(
    [
      ...(result.areaNames ?? []),
      result.area ?? "",
      result.address ?? "",
      result.kind === "area" ? (result.name ?? "") : "",
    ].flatMap((name) => nameTokens(name)),
  );
}

/** The covered cities' own names: "in Boston" says which city, never
 * which place. From the registry, so a new city needs no edit here. */
function cityWords(): Set<string> {
  return new Set(coveredCities().flatMap((p) => nameTokens(p.cityDisplayName)));
}

/**
 * Which words of the query are the name and which the area. Generic words
 * ("steakhouse") are neither. A word some result lists as a locality is
 * the area — unless a result carries it in its NAME along with everything
 * else ("Fenway Park" is a name with a neighborhood in it; "Lola 42
 * Seaport" is a name and an area; "Seaport" alone IS the name).
 */
export function readQuery(query: string, results: readonly GeocodeResult[]): QueryReading {
  const tokens = nameTokens(query);
  const specific = tokens.filter((t) => !isGenericWord(t));
  const areaTokens = new Set(results.flatMap((r) => [...areaTokensOf(r)]));
  const saidArea = tokens.filter((t) => areaTokens.has(t));
  const withoutArea = specific.filter((t) => !saidArea.includes(t));
  const wholeNameFound = results.some((r) => carriesAll(nameOf(r), specific));
  // Every word is a place word ("Back Bay Boston"): the name is what's left
  // without the covered city's — the city says where, not what.
  const cities = cityWords();
  const citiless = specific.filter((t) => !cities.has(t));
  const name = wholeNameFound
    ? specific
    : withoutArea.length > 0
      ? withoutArea
      : citiless.length > 0
        ? citiless
        : specific;
  // "Seaport", or "Seaport Boston": the covered city's name doesn't make
  // a neighborhood's name something else.
  const areas = areaPhrases(results);
  const areaName =
    [phraseOf(tokens), phraseOf(tokens.filter((t) => !cities.has(t)))].find(
      (p) => p.length > 0 && areas.has(p),
    ) ?? null;
  return {
    name,
    area: saidArea.filter((t) => !name.includes(t)),
    specific: specific.length > 0,
    areaName,
  };
}

/** The distance prior: full within 3 km, nothing past 15 km. With no bias
 * point — no phone location and no city named — distance says nothing
 * about anyone, so it is held against no one. */
function distancePart(result: GeocodeResult, bias: { lat: number; lng: number } | null): number {
  if (!bias) return DISTANCE_WEIGHT;
  const d = metersBetween(bias.lat, bias.lng, result.lat, result.lng);
  if (d <= NEAR_M) return DISTANCE_WEIGHT;
  if (d >= FAR_M) return 0;
  return (DISTANCE_WEIGHT * (FAR_M - d)) / (FAR_M - NEAR_M);
}

/**
 * Score every result against the query, in the order given. `bias` is
 * where the search looked first: the phone when it's in the city, else
 * the city's center. A result's rank is its own `rank` (its place in the
 * response that produced it) or, without one, its place in `results`.
 */
export function scoreCandidates(
  query: string,
  results: readonly GeocodeResult[],
  bias?: { lat: number; lng: number } | null,
): Scored[] {
  const reading = readQuery(query, results);
  const cities = cityWords();
  const areaHits = results.map((r) => {
    const tokens = areaTokensOf(r);
    return reading.area.filter((t) => tokens.has(t));
  });
  // Every result is "in" the city, so the most specific agreement is the
  // one that counts: "Seaport" and "Boston" beats "Boston" alone.
  const mostHits = Math.max(0, ...areaHits.map((hits) => hits.length));
  return results.map((result, index) => {
    const name = nameOf(result);
    const matches = reading.name.map((t) => nameMatch(name, t));
    // A word the name carries only the start of ("Pru" of "Prudential")
    // is half a word.
    const carried = matches.reduce(
      (sum, m) => sum + (m === null ? 0 : m === "fragment" ? 0.5 : 1),
      0,
    );
    const hits = areaHits[index]!;
    const parts = {
      name: reading.name.length > 0 ? (NAME_WEIGHT * carried) / reading.name.length : 0,
      area:
        reading.area.length === 0
          ? 0
          : hits.length > 0 && hits.length === mostHits
            ? AREA_WEIGHT
            : -AREA_WEIGHT,
      distance: distancePart(result, bias ?? null),
      // A neighborhood's name says nothing for a business named after it.
      poi: reading.specific && !reading.areaName && result.kind === "poi" ? POI_BONUS : 0,
      rank: (result.rank ?? index) === 0 ? RANK_BONUS : 0,
    };
    const sum = parts.name + parts.area + parts.distance + parts.poi + parts.rank;
    return {
      result,
      score: Math.round(Math.min(1, Math.max(0, sum)) * 1000) / 1000,
      nameMatched: carriesAll(name, reading.name),
      evidence:
        matches.some((m) => m !== null && m !== "fragment") || hits.some((t) => !cities.has(t)),
      parts,
    };
  });
}

/** The best-scored of a list, the earlier one on a tie; null when empty. */
export function bestOf(scored: readonly Scored[]): Scored | null {
  let best: Scored | null = null;
  for (const s of scored) if (best === null || s.score > best.score) best = s;
  return best;
}

/**
 * Whether a search came back too weak to stand on: nothing found, nothing
 * carrying even one word of the name, or a best score under
 * WEAK_SEARCH_BELOW. A query that names nothing ("a cafe") has no
 * name to complete, so it is never weak in this sense.
 */
export function searchIsWeak(
  query: string,
  results: readonly GeocodeResult[],
  bias?: { lat: number; lng: number } | null,
): boolean {
  if (readQuery(query, results).name.length === 0) return false;
  const scored = scoreCandidates(query, results, bias);
  const best = bestOf(scored);
  return best === null || best.score < WEAK_SEARCH_BELOW || scored.every((s) => s.parts.name === 0);
}

/** What a decisions row keeps of a scored candidate. */
export function candidateRecord(s: Scored): {
  name: string;
  lat: number;
  lng: number;
  score: number;
} {
  return {
    name: s.result.name ?? s.result.displayName,
    lat: s.result.lat,
    lng: s.result.lng,
    score: s.score,
  };
}
