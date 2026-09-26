/**
 * Deciding what a place search actually found. A search always returns
 * SOMETHING near a name — the 2026-09-25 device test's "Moo steakhouse in
 * Seaport" came back as the Seaport neighborhood and the assistant quietly
 * searched "Seaport center" as if it were the restaurant. So the tool asks
 * three questions of the results before it grounds anything:
 *
 *  1. Does any result carry the NAME the user said? Names are compared
 *     loosely — case, punctuation, and stretched letters don't count
 *     ("Moo" is "Mooo....") and generic words ("steakhouse", "restaurant")
 *     and the area the user named ("in Seaport") aren't part of the name.
 *     None → the best result is only the closest thing found, and the
 *     assistant must say so instead of presenting it as the place.
 *  2. Did the user name an area? Then matches in that area win ("Moo in
 *     Seaport" is the Seaport location, not the Beacon Hill one).
 *  3. Are the remaining matches one place or several? Several distinct
 *     places (more than DISTINCT_M apart) are a question for the user, as
 *     tappable choices — never a guess.
 */

import type { GeocodeResult } from "./geocoder.js";
import { metersBetween } from "./geocoder.js";

/** Two results closer than this are the same place listed twice. */
export const DISTINCT_M = 250;

/** Words that describe a kind of place, not its name. */
const GENERIC_WORDS = new Set([
  "a",
  "an",
  "the",
  "at",
  "in",
  "on",
  "near",
  "by",
  "of",
  "and",
  "restaurant",
  "steakhouse",
  "steak",
  "bar",
  "grill",
  "cafe",
  "coffee",
  "pub",
  "bistro",
  "diner",
  "tavern",
  "kitchen",
  "hotel",
  "place",
  "spot",
  "venue",
  "club",
]);

/** Street-name abbreviations people say or type, spelled out — "Newbury
 * St" is "Newbury Street". */
const ABBREVIATIONS: Record<string, string> = {
  st: "street",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  rd: "road",
  sq: "square",
  pl: "place",
  ln: "lane",
  dr: "drive",
  ct: "court",
  pkwy: "parkway",
  hwy: "highway",
  wy: "way",
};

/** Lowercased, accent- and punctuation-free word tokens, abbreviations
 * spelled out, stretched letters collapsed ("Mooo...." → ["mo"], "LoLa 42"
 * → ["lola", "42"], "Newbury St" and "Newbury Street" alike). */
export function nameTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .map((t) => t.replace(/([a-z])\1+/g, "$1"));
}

export type PlaceMatch =
  | { kind: "none" }
  /** nameMatched false: nothing carried the name; `place` is only the
   * closest result, and the user must be told so. */
  | { kind: "found"; place: GeocodeResult; nameMatched: boolean }
  | { kind: "ambiguous"; choices: GeocodeResult[] };

/** The words that say WHERE a result is: its neighborhoods and its street
 * address. A tapped choice sends "Mooo...., 15 Beacon St" — the address
 * picks the location, it isn't part of the name. */
function areaTokensOf(result: GeocodeResult): Set<string> {
  return new Set(
    [...(result.areaNames ?? []), result.area ?? "", result.address ?? ""].flatMap((name) =>
      nameTokens(name),
    ),
  );
}

function tokenMatches(queryToken: string, nameToken: string): boolean {
  if (queryToken === nameToken) return true;
  // A partial word counts only past two letters ("lol" ≠ "lola 42").
  return (
    Math.min(queryToken.length, nameToken.length) >= 3 &&
    (nameToken.startsWith(queryToken) || queryToken.startsWith(nameToken))
  );
}

/** Collapse results within DISTINCT_M of an earlier one, keeping order. */
function distinctPlaces(results: GeocodeResult[]): GeocodeResult[] {
  const kept: GeocodeResult[] = [];
  for (const r of results) {
    if (kept.some((k) => metersBetween(k.lat, k.lng, r.lat, r.lng) < DISTINCT_M)) continue;
    kept.push(r);
  }
  return kept;
}

export function classifyPlaceMatches(query: string, results: GeocodeResult[]): PlaceMatch {
  if (results.length === 0) return { kind: "none" };
  const queryTokens = nameTokens(query);
  // The area words the user said: any query word some result lists among
  // its localities/neighborhoods ("seaport", "boston").
  const allAreaTokens = new Set(results.flatMap((r) => [...areaTokensOf(r)]));
  const saidArea = queryTokens.filter((t) => allAreaTokens.has(t));
  const nameOf = (r: GeocodeResult) => nameTokens(r.name ?? r.displayName.split(",")[0] ?? "");
  // The name part: what's left after generic words — and after area words
  // only when no result carries them in its NAME ("Fenway Park" is a name
  // with a neighborhood in it; "Lola 42 Seaport" is a name and an area;
  // "Seaport" alone IS the name).
  const withoutGeneric = queryTokens.filter((t) => !GENERIC_WORDS.has(t));
  const matching = (tokens: string[]) =>
    results.filter((r) => {
      const name = nameOf(r);
      return tokens.every((t) => name.some((n) => tokenMatches(t, n)));
    });
  const withoutArea = withoutGeneric.filter((t) => !saidArea.includes(t));
  const whole = withoutGeneric.length > 0 ? matching(withoutGeneric) : [];
  const core = whole.length > 0 || withoutArea.length === 0 ? withoutGeneric : withoutArea;
  if (core.length === 0) return { kind: "found", place: results[0]!, nameMatched: true };

  let matched = whole.length > 0 ? whole : matching(core);
  if (matched.length === 0) {
    return { kind: "found", place: results[0]!, nameMatched: false };
  }
  // An exact name beats a longer one that contains it ("Seaport" the
  // neighborhood, not "Seaport Hotel").
  const exact = matched.filter((r) => nameOf(r).join(" ") === core.join(" "));
  if (exact.length > 0) matched = exact;
  // The area the user named narrows a chain to its location there. Every
  // location is "in" the city, so the most specific wins: the results
  // matching the MOST named area words ("Seaport" and "Boston" beats
  // "Boston" alone).
  const areaWords = saidArea.filter((t) => !core.includes(t));
  if (areaWords.length > 0) {
    const score = (r: GeocodeResult) => {
      const tokens = areaTokensOf(r);
      return areaWords.filter((t) => tokens.has(t)).length;
    };
    const best = Math.max(...matched.map(score));
    if (best > 0) matched = matched.filter((r) => score(r) === best);
  }
  // Choices the user couldn't tell apart are one place: a long street
  // comes back as several segments ("Newbury Street · Back Bay" three
  // times, 2026-09-25 live run) — only different names or neighborhoods
  // are a question worth asking.
  const seen = new Set<string>();
  const places = distinctPlaces(matched).filter((place) => {
    const label = choiceLabel(place).toLowerCase();
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
  if (places.length === 1) return { kind: "found", place: places[0]!, nameMatched: true };
  // Streets, neighborhoods, and stops of one name in one city ("Fenway":
  // the road called Fenway and the Fenway T stop, live 2026-09-25) mean the
  // best-ranked one — a question there is noise. Two or more businesses of
  // one name (a chain's locations), or the name in two cities, is a real
  // question.
  const oneCity = places.every((place) => place.city === places[0]!.city);
  if (oneCity && places.filter((place) => place.kind === "poi").length < 2) {
    return { kind: "found", place: places[0]!, nameMatched: true };
  }
  return { kind: "ambiguous", choices: places.slice(0, 3) };
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
