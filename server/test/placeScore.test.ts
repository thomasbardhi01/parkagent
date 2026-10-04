/**
 * FR-44 — how sure a place search is. The score (placeScore.ts) is five
 * parts read off a result; the classifier (placeMatch.ts) reads the scores
 * against RESOLUTION_THRESHOLDS. Pinned here, offline and with no model:
 * each part on its own, and the four outcomes — one place, several, the
 * closest thing only, nothing — on names people type. Every threshold is
 * imported, never retyped, so moving a line moves the tests with it.
 */

import { describe, expect, test } from "vitest";

import type { GeocodeResult } from "../src/services/assistant/geocoder.js";
import { METRO_CENTER, metersBetween } from "../src/services/assistant/geocoder.js";
import { carriesTheName, classifyPlaceMatches } from "../src/services/assistant/placeMatch.js";
import {
  RESOLUTION_THRESHOLDS,
  WEAK_SEARCH_BELOW,
  nameOf,
  scoreCandidates,
  searchIsWeak,
} from "../src/services/assistant/placeScore.js";
import { isGenericWord, nameMatch, nameTokens } from "../src/services/assistant/placeTokens.js";

const T = RESOLUTION_THRESHOLDS;
/** Where a Braintree phone's search looks: the city's center. */
const BOSTON = METRO_CENTER.bos;
/** A phone in the Seaport. */
const SEAPORT_PHONE = { lat: 42.3519, lng: -71.0446 };

const poi = (
  name: string,
  lat: number,
  lng: number,
  address: string,
  area: string,
  extra: Partial<GeocodeResult> = {},
): GeocodeResult => ({
  lat,
  lng,
  displayName: `${name}, ${address}, ${area}`,
  city: "bos",
  name,
  address,
  area,
  areaNames: ["Boston", area],
  kind: "poi",
  ...extra,
});

const LOLA_42 = poi("LoLa 42", 42.35458, -71.04526, "22 Liberty Dr", "Seaport");
const MOOO_SEAPORT = poi("Mooo....", 42.34945, -71.05034, "49 Melcher St", "Seaport");
const MOOO_BEACON_HILL = poi("Mooo....", 42.35829, -71.06198, "15 Beacon St", "Beacon Hill");
const SEAPORT_AREA: GeocodeResult = {
  lat: 42.34627,
  lng: -71.04216,
  displayName: "Seaport, Boston, Suffolk County",
  city: "bos",
  name: "Seaport",
  areaNames: ["Boston", "Suffolk County"],
  kind: "area",
};
/** Something a search returns for a name it has never heard: nearby,
 * listed first, and nothing to do with what was asked. */
const UNRELATED = poi("Yankee Lobster", 42.3489, -71.0379, "300 Northern Ave", "Seaport");
/** The negative control: a name no place has, in any city. (It used to be
 * "xyzzy restaurant", judged against W XYZ Bar — which is a real bar, in
 * Boston and in New York, and so no control for "not found". W XYZ Bar is
 * a positive control now, below.) */
const NOWHERE = "Blorptastic Noodle House";

/** Metres north of a point, as degrees of latitude. */
const north = (from: { lat: number; lng: number }, meters: number) => ({
  lat: from.lat + meters / 111_195,
  lng: from.lng,
});

describe("the score, part by part", () => {
  test("name: the share of the query's name words the result's name carries, up to 0.5", () => {
    const [whole] = scoreCandidates("Lola 42", [LOLA_42], BOSTON);
    expect(whole!.parts.name).toBe(0.5);
    expect(whole!.nameMatched).toBe(true);
    const [half] = scoreCandidates("Lola 99", [LOLA_42], BOSTON);
    expect(half!.parts.name).toBe(0.25);
    expect(half!.nameMatched).toBe(false);
    // Generic words and the area the user named aren't part of the name.
    const [said] = scoreCandidates("the Lola 42 restaurant in Seaport", [LOLA_42], BOSTON);
    expect(said!.parts.name).toBe(0.5);
  });

  test("area: +0.2 where the named area is, −0.2 where it isn't, nothing when none was named", () => {
    const named = scoreCandidates(
      "Moo steakhouse in Seaport",
      [MOOO_BEACON_HILL, MOOO_SEAPORT],
      BOSTON,
    );
    expect(named.map((s) => s.parts.area)).toEqual([-0.2, 0.2]);
    const unnamed = scoreCandidates("Moo steakhouse", [MOOO_BEACON_HILL, MOOO_SEAPORT], BOSTON);
    expect(unnamed.map((s) => s.parts.area)).toEqual([0, 0]);
    // Every location is "in" the city: the most specific agreement counts.
    const both = scoreCandidates(
      "Moo steakhouse in Seaport Boston",
      [MOOO_BEACON_HILL, MOOO_SEAPORT],
      BOSTON,
    );
    expect(both.map((s) => s.parts.area)).toEqual([-0.2, 0.2]);
  });

  test("distance: full within 3 km of the bias, a straight line down to nothing at 15 km", () => {
    const at = (meters: number) => {
      const p = north(BOSTON, meters);
      return scoreCandidates("Lola 42", [{ ...LOLA_42, ...p }], BOSTON)[0]!.parts.distance;
    };
    expect(at(0)).toBe(0.15);
    expect(at(2_900)).toBe(0.15);
    expect(at(9_000)).toBeCloseTo(0.075, 3);
    expect(at(12_000)).toBeCloseTo(0.0375, 3);
    expect(at(15_100)).toBe(0);
    // No phone and no city: distance is held against no one.
    expect(scoreCandidates("Lola 42", [LOLA_42])[0]!.parts.distance).toBe(0.15);
    expect(scoreCandidates("Lola 42", [LOLA_42], null)[0]!.parts.distance).toBe(0.15);
  });

  test("poi: +0.1 for a business when the query names something", () => {
    expect(scoreCandidates("Lola 42", [LOLA_42], BOSTON)[0]!.parts.poi).toBe(0.1);
    expect(scoreCandidates("Seaport", [SEAPORT_AREA], BOSTON)[0]!.parts.poi).toBe(0);
    // "the bar" names nothing: being a business is no evidence of anything.
    expect(scoreCandidates("the bar", [LOLA_42], BOSTON)[0]!.parts.poi).toBe(0);
  });

  test("rank: +0.05 for its source's first result — its own rank when it carries one", () => {
    const listed = scoreCandidates("Moo steakhouse", [MOOO_BEACON_HILL, MOOO_SEAPORT], BOSTON);
    expect(listed.map((s) => s.parts.rank)).toEqual([0.05, 0]);
    // Two sources' results in one list: each source's first is a first.
    const merged = scoreCandidates(
      "Moo steakhouse",
      [
        { ...MOOO_BEACON_HILL, rank: 1 },
        { ...MOOO_SEAPORT, rank: 0 },
      ],
      BOSTON,
    );
    expect(merged.map((s) => s.parts.rank)).toEqual([0, 0.05]);
  });

  test("the score is the sum, held to 0–1", () => {
    const [top] = scoreCandidates("Moo steakhouse in Seaport", [MOOO_SEAPORT], BOSTON);
    expect(top!.parts).toEqual({ name: 0.5, area: 0.2, distance: 0.15, poi: 0.1, rank: 0.05 });
    expect(top!.score).toBe(1);
    // Named area absent, far away, not first, not a business: below zero.
    const far = { ...SEAPORT_AREA, ...north(BOSTON, 20_000), name: "Harborwalk", rank: 3 };
    const scored = scoreCandidates("Lola 42 Seaport", [MOOO_SEAPORT, far], BOSTON);
    expect(scored[1]!.parts.area).toBe(-0.2);
    expect(scored[1]!.score).toBe(0);
  });

  test("the scores come back in the order the results went in", () => {
    const scored = scoreCandidates("Lola 42 Seaport", [SEAPORT_AREA, LOLA_42, UNRELATED], BOSTON);
    expect(scored.map((s) => s.result)).toEqual([SEAPORT_AREA, LOLA_42, UNRELATED]);
  });
});

describe("one place, several, the closest thing, or nothing", () => {
  test("'Moo steakhouse': two locations within the gap of each other → a question", () => {
    const match = classifyPlaceMatches("Moo steakhouse", [MOOO_BEACON_HILL, MOOO_SEAPORT], BOSTON);
    expect(match.kind).toBe("ambiguous");
    if (match.kind !== "ambiguous") return;
    expect(match.choices).toEqual([MOOO_BEACON_HILL, MOOO_SEAPORT]);
    expect(match.scores).toHaveLength(2);
    const [a, b] = match.scores as [number, number];
    expect(Math.abs(a - b)).toBeLessThanOrEqual(T.ambiguousGap);
    expect(Math.min(a, b)).toBeGreaterThanOrEqual(T.ambiguousFloor);
  });

  test("'Moo steakhouse in Seaport': the Melcher St location, sure enough to take", () => {
    const match = classifyPlaceMatches(
      "Moo steakhouse in Seaport",
      [MOOO_BEACON_HILL, MOOO_SEAPORT],
      BOSTON,
    );
    expect(match).toEqual({
      kind: "found",
      place: MOOO_SEAPORT,
      nameMatched: true,
      confidence: expect.any(Number),
    });
    expect(match.kind === "found" && match.confidence).toBeGreaterThanOrEqual(T.found);
    expect(match.kind === "found" && match.place.address).toBe("49 Melcher St");
  });

  test("'Starbucks' with six locations: at most three choices, nearest the phone first", () => {
    // Listed in no order of distance: 1.5 km, 4.6 km, 75 m, 2.8 km, 720 m, 420 m.
    const starbucks = (lat: number, lng: number, address: string, area: string) =>
      poi("Starbucks", lat, lng, address, area);
    const d = starbucks(42.356, -71.062, "62 Boylston St", "Downtown");
    const f = starbucks(42.342, -71.099, "1304 Boylston St", "Fenway");
    const a = starbucks(42.3525, -71.045, "100 Northern Ave", "Seaport");
    const e = starbucks(42.349, -71.078, "755 Boylston St", "Back Bay");
    const c = starbucks(42.3553, -71.052, "211 Congress St", "Financial District");
    const b = starbucks(42.3498, -71.0489, "303 Congress St", "Fort Point");
    const match = classifyPlaceMatches("Starbucks", [d, f, a, e, c, b], SEAPORT_PHONE);
    expect(match.kind).toBe("ambiguous");
    if (match.kind !== "ambiguous") return;
    expect(match.choices.length).toBeLessThanOrEqual(3);
    expect(match.choices).toEqual([a, b, c]);
    const meters = match.choices.map((p) =>
      metersBetween(SEAPORT_PHONE.lat, SEAPORT_PHONE.lng, p.lat, p.lng),
    );
    expect(meters).toEqual([...meters].sort((x, y) => x - y));
    expect(match.scores).toHaveLength(3);
  });

  test("a name that exists nowhere, with an unrelated result nearby: nothing, not the closest thing", () => {
    const [scored] = scoreCandidates(NOWHERE, [UNRELATED], SEAPORT_PHONE);
    // Near the phone, a business, listed first: its score alone reaches
    // the floor. What rules it out is that it shares no word with the ask.
    expect(scored!.score).toBeGreaterThanOrEqual(T.closestFloor);
    expect(scored!.evidence).toBe(false);
    expect(classifyPlaceMatches(NOWHERE, [UNRELATED], SEAPORT_PHONE)).toEqual({
      kind: "none",
    });
    // And the chain keeps asking: a source that answered with this hasn't
    // found the name.
    expect(carriesTheName(NOWHERE, [UNRELATED], SEAPORT_PHONE)).toBe(false);
  });

  test("naming the city is not a reason to offer a result: a name that exists nowhere 'in Boston'", () => {
    const scored = scoreCandidates(`${NOWHERE} in Boston`, [UNRELATED], SEAPORT_PHONE);
    // It IS in Boston, and scores for it — like every other result.
    expect(scored[0]!.parts.area).toBe(0.2);
    expect(scored[0]!.evidence).toBe(false);
    expect(classifyPlaceMatches(`${NOWHERE} in Boston`, [UNRELATED], SEAPORT_PHONE)).toEqual({
      kind: "none",
    });
  });

  test("the neighborhood the user named is the closest thing, said as that", () => {
    const match = classifyPlaceMatches(`${NOWHERE} in Seaport`, [SEAPORT_AREA], BOSTON);
    expect(match).toEqual({
      kind: "found",
      place: SEAPORT_AREA,
      nameMatched: false,
      confidence: expect.any(Number),
    });
    const confidence = match.kind === "found" ? match.confidence : NaN;
    expect(confidence).toBeGreaterThanOrEqual(T.closestFloor);
    expect(confidence).toBeLessThan(T.ambiguousFloor);
  });

  test("a result sharing one word of four, far away, is under the floor: nothing", () => {
    const legalAid: GeocodeResult = {
      ...SEAPORT_AREA,
      name: "Legal Aid",
      displayName: "Legal Aid, Boston",
      areaNames: ["Boston"],
      rank: 1,
    };
    const [scored] = scoreCandidates("Legal Sea Foods Harborside", [legalAid], METRO_CENTER.nyc);
    expect(scored!.evidence).toBe(true);
    expect(scored!.score).toBeLessThan(T.closestFloor);
    expect(
      classifyPlaceMatches("Legal Sea Foods Harborside", [legalAid], METRO_CENTER.nyc),
    ).toEqual({ kind: "none" });
  });

  test("one place carrying the name is found however little else speaks for it", () => {
    // A venue asked for from the other city: far from the bias, and still
    // the only thing called that.
    const garden = poi("TD Garden", 42.36621, -71.06216, "100 Legends Way", "West End");
    const match = classifyPlaceMatches("TD Garden", [garden], METRO_CENTER.nyc);
    expect(match).toMatchObject({ kind: "found", place: garden, nameMatched: true });
    expect(match.kind === "found" && match.confidence).toBeLessThan(T.found);
  });

  test("a place far ahead of its namesake is taken without a question", () => {
    const venue = poi("Fenway Park", 42.3467, -71.0972, "4 Jersey St", "Fenway");
    const namesake: GeocodeResult = {
      lat: 40.75,
      lng: -73.99,
      displayName: "Fenway Park, Midtown",
      city: "nyc",
      name: "Fenway Park",
      area: "Midtown",
      kind: "area",
    };
    const phone = { lat: 42.3505, lng: -71.08 };
    const scored = scoreCandidates("Fenway Park", [venue, namesake], phone);
    expect(scored[0]!.score).toBeGreaterThanOrEqual(T.found);
    expect(scored[0]!.score - scored[1]!.score).toBeGreaterThan(T.ambiguousGap);
    expect(classifyPlaceMatches("Fenway Park", [venue, namesake], phone)).toMatchObject({
      kind: "found",
      place: venue,
      nameMatched: true,
    });
    // With nothing to tell them apart (no phone, no city), it is asked.
    expect(classifyPlaceMatches("Fenway Park", [venue, { ...namesake, kind: "poi" }]).kind).toBe(
      "ambiguous",
    );
  });

  test("the name as it was said, kind word and all: 'Seaport Hotel' is the hotel, 'Seaport' the neighborhood", () => {
    const hotel = poi("Seaport Hotel", 42.3487, -71.0415, "1 Seaport Ln", "Seaport");
    for (const results of [
      [SEAPORT_AREA, hotel],
      [hotel, SEAPORT_AREA],
    ]) {
      expect(classifyPlaceMatches("Seaport Hotel", results, BOSTON)).toMatchObject({
        kind: "found",
        place: hotel,
        nameMatched: true,
      });
      expect(classifyPlaceMatches("the Seaport hotel", results, BOSTON)).toMatchObject({
        kind: "found",
        place: hotel,
      });
      expect(classifyPlaceMatches("Seaport", results, BOSTON)).toMatchObject({
        kind: "found",
        place: SEAPORT_AREA,
      });
      expect(classifyPlaceMatches("the Seaport", results, BOSTON)).toMatchObject({
        kind: "found",
        place: SEAPORT_AREA,
      });
    }
    // A kind word that is in no result's name still isn't part of the name.
    expect(
      classifyPlaceMatches("Moo steakhouse in Seaport", [MOOO_BEACON_HILL, MOOO_SEAPORT], BOSTON),
    ).toMatchObject({ kind: "found", place: MOOO_SEAPORT });
  });

  test("initials are the name: 'MFA' is the Museum of Fine Arts, and nothing else", () => {
    const mfa = poi(
      "Museum of Fine Arts, Boston",
      42.3394,
      -71.094,
      "465 Huntington Ave",
      "Fenway",
    );
    // The source's own name carries the city; the initials are the museum's.
    const plain = { ...mfa, name: "Museum of Fine Arts" };
    expect(classifyPlaceMatches("MFA", [plain], BOSTON)).toMatchObject({
      kind: "found",
      place: plain,
      nameMatched: true,
    });
    const mit = poi(
      "Massachusetts Institute of Technology",
      42.3601,
      -71.0942,
      "77 Massachusetts Ave",
      "Cambridge",
    );
    expect(classifyPlaceMatches("MIT", [mit], BOSTON)).toMatchObject({
      kind: "found",
      nameMatched: true,
    });
    const science = poi("Museum of Science", 42.3677, -71.0709, "1 Science Park", "West End");
    expect(classifyPlaceMatches("MFA", [science], BOSTON)).toEqual({ kind: "none" });
    // One letter of a one-word name is not its initials.
    expect(scoreCandidates("m", [science], BOSTON)[0]!.nameMatched).toBe(false);
  });
});

/** A real bar (in Boston and in New York): what autocomplete offered for
 * "xyzzy restaurant" on prod (2026-10-02), taken at 0.80 because "XYZ"
 * spells the start of "xyzzy". A positive control: said by its words, it
 * is the place. */
const W_XYZ = poi("W XYZ Bar", 42.3517, -71.0645, "100 Stuart St", "Bay Village");

describe("a fragment of a word is not the word", () => {
  /** A place that exists nowhere either, whose one name word is the start
   * of the control's first word: the shape the prod mismatch had. */
  const BLORP = poi("Blorp Bar", 42.3517, -71.0645, "100 Stuart St", "Bay Village");
  const PRUDENTIAL = poi("Prudential Center", 42.3471, -71.0825, "800 Boylston St", "Back Bay");
  const MASS_AVE: GeocodeResult = {
    lat: 42.3466,
    lng: -71.0887,
    displayName: "Massachusetts Avenue, Back Bay",
    city: "bos",
    name: "Massachusetts Avenue",
    area: "Back Bay",
    areaNames: ["Boston", "Back Bay"],
    kind: "area",
  };

  test("a name word that is only the START of what was said is no match: not found, at no confidence", () => {
    // "Blorp" spells the start of "Blorptastic", and that is all it does.
    expect(nameMatch(nameOf(BLORP), nameTokens("Blorptastic")[0]!)).toBeNull();
    const [scored] = scoreCandidates(NOWHERE, [BLORP], SEAPORT_PHONE);
    expect(scored!.parts.name).toBe(0);
    expect(scored!.nameMatched).toBe(false);
    expect(scored!.evidence).toBe(false);
    expect(classifyPlaceMatches(NOWHERE, [BLORP], SEAPORT_PHONE)).toEqual({ kind: "none" });
    expect(carriesTheName(NOWHERE, [BLORP], SEAPORT_PHONE)).toBe(false);
  });

  test("the negative control is never the place, whatever a search returns for it", () => {
    // What a search might answer a made-up name with: something unrelated,
    // something that starts like it, and something sharing its common
    // words — alone and together.
    const noodles = poi("Pho Noodle House", 42.3512, -71.0603, "8 Tyler St", "Chinatown");
    const sets = [[UNRELATED], [BLORP], [noodles], [noodles, BLORP, UNRELATED], [SEAPORT_AREA]];
    for (const results of sets) {
      const about = `← ${results.map((r) => r.name).join(", ")}`;
      // The control as it is asked: not found — or only "the closest
      // thing", said as that, under the line a place is taken at.
      const match = classifyPlaceMatches(NOWHERE, results, SEAPORT_PHONE);
      expect(match.kind, about).not.toBe("ambiguous");
      if (match.kind === "found") {
        expect(match.nameMatched, about).toBe(false);
        expect(match.confidence, about).toBeLessThan(T.found);
      }
      // With a city or an area said too, it is still never the place by
      // name, and the chain keeps asking the next source.
      for (const query of [NOWHERE, `${NOWHERE} Boston`, `${NOWHERE} in Seaport`]) {
        const named = classifyPlaceMatches(query, results, SEAPORT_PHONE);
        expect(named.kind, `${query} ${about}`).not.toBe("ambiguous");
        if (named.kind === "found") expect(named.nameMatched, `${query} ${about}`).toBe(false);
        expect(carriesTheName(query, results, SEAPORT_PHONE), `${query} ${about}`).toBe(false);
      }
    }
  });

  test("a word that is only the start of a name word counts half, and alone is never the place", () => {
    const [pru] = scoreCandidates("Pru", [PRUDENTIAL], BOSTON);
    expect(pru!.parts.name).toBe(0.25);
    expect(pru!.nameMatched).toBe(false);
    expect(pru!.evidence).toBe(false);
    expect(classifyPlaceMatches("Pru", [PRUDENTIAL], BOSTON)).toEqual({ kind: "none" });
    // With a whole word beside it, it is the place, and less sure than a
    // name said in full.
    const mass = classifyPlaceMatches("Mass Ave", [MASS_AVE], BOSTON);
    const full = classifyPlaceMatches("Massachusetts Ave", [MASS_AVE], BOSTON);
    expect(mass).toMatchObject({ kind: "found", place: MASS_AVE, nameMatched: true });
    expect(full).toMatchObject({ kind: "found", place: MASS_AVE, nameMatched: true });
    const confidence = (m: typeof mass) => (m.kind === "found" ? m.confidence : NaN);
    expect(confidence(mass)).toBeLessThan(confidence(full));
  });

  test("words run together are the words: 'lola42', 'Trader Joes', 'Legal Seafoods'", () => {
    expect(classifyPlaceMatches("lola42", [LOLA_42], BOSTON)).toMatchObject({
      kind: "found",
      nameMatched: true,
    });
    const joes = poi("Trader Joe's", 42.3489, -71.0889, "899 Boylston St", "Back Bay");
    expect(classifyPlaceMatches("Trader Joes", [joes], BOSTON)).toMatchObject({
      kind: "found",
      place: joes,
      nameMatched: true,
    });
    const legal = poi("Legal Sea Foods", 42.3519, -71.0447, "270 Northern Ave", "Seaport");
    expect(classifyPlaceMatches("Legal Seafoods", [legal], BOSTON)).toMatchObject({
      kind: "found",
      place: legal,
      nameMatched: true,
    });
    // Run together, but not what the name says: no match.
    expect(scoreCandidates("lola43", [LOLA_42], BOSTON)[0]!.parts.name).toBe(0);
  });
});

describe("a neighborhood's name is the neighborhood", () => {
  // What a place search returns for a bare neighborhood name: businesses
  // and streets named after it, each saying it lies in that neighborhood.
  const SEAPORT_HOTEL = poi("Seaport Hotel", 42.3487, -71.0415, "1 Seaport Ln", "Seaport");
  const WTC = poi("Seaport World Trade Center", 42.3485, -71.0391, "200 Seaport Blvd", "Seaport");
  const BACK_BAY_STATION = poi(
    "Back Bay Station",
    42.3473,
    -71.0755,
    "145 Dartmouth St",
    "Back Bay",
    { category: "PublicTransport" },
  );
  const BACK_BAY_HOTEL = poi("The Back Bay Hotel", 42.3502, -71.0729, "350 Stuart St", "Back Bay");
  const BACK_BAY: GeocodeResult = {
    lat: 42.3503,
    lng: -71.081,
    displayName: "Back Bay, Boston",
    city: "bos",
    name: "Back Bay",
    areaNames: ["Boston"],
    kind: "area",
  };
  const FENWAY_STOP = poi("Fenway", 42.3451, -71.1043, "Park Dr", "Fenway", {
    category: "PublicTransport",
  });
  const FENWAY_PARK = poi("Fenway Park", 42.3467, -71.0972, "4 Jersey St", "Fenway");
  const FENWAY: GeocodeResult = {
    lat: 42.3429,
    lng: -71.1003,
    displayName: "Fenway, Boston",
    city: "bos",
    name: "Fenway",
    areaNames: ["Boston"],
    kind: "area",
  };

  test("'Seaport' with only businesses named after it: not one of them", () => {
    const results = [SEAPORT_HOTEL, WTC];
    const match = classifyPlaceMatches("Seaport", results, BOSTON);
    expect(match.kind === "found" && match.nameMatched).toBe(false);
    // So the chain keeps asking: the next source has the neighborhood.
    expect(carriesTheName("Seaport", results, BOSTON)).toBe(false);
    // With it: the area, ahead of the hotel that lists first.
    const withArea = classifyPlaceMatches("Seaport", [...results, SEAPORT_AREA], BOSTON);
    expect(withArea).toMatchObject({ kind: "found", place: SEAPORT_AREA, nameMatched: true });
    expect(carriesTheName("Seaport", [...results, SEAPORT_AREA], BOSTON)).toBe(true);
  });

  test("'Back Bay' and 'Back Bay Boston': the area, not the station or the hotel", () => {
    const results = [BACK_BAY_STATION, BACK_BAY_HOTEL, BACK_BAY];
    for (const query of ["Back Bay", "back bay boston", "the Back Bay"]) {
      expect(classifyPlaceMatches(query, results, BOSTON), query).toMatchObject({
        kind: "found",
        place: BACK_BAY,
        nameMatched: true,
      });
    }
    expect(carriesTheName("Back Bay", [BACK_BAY_STATION, BACK_BAY_HOTEL], BOSTON)).toBe(false);
  });

  test("'Fenway': the neighborhood over the T stop of the same name; the stop when nothing else is called that", () => {
    expect(
      classifyPlaceMatches("Fenway", [FENWAY_STOP, FENWAY_PARK, FENWAY], BOSTON),
    ).toMatchObject({ kind: "found", place: FENWAY });
    // No source had the area: the stop called exactly that will do...
    expect(classifyPlaceMatches("Fenway", [FENWAY_STOP, FENWAY_PARK], BOSTON)).toMatchObject({
      kind: "found",
      place: FENWAY_STOP,
      nameMatched: true,
    });
    // ...but the next source is asked for the area first.
    expect(carriesTheName("Fenway", [FENWAY_STOP, FENWAY_PARK], BOSTON)).toBe(false);
  });

  test("being in a neighborhood earns a business nothing when the query is that neighborhood", () => {
    const [hotel] = scoreCandidates("Seaport", [SEAPORT_HOTEL], BOSTON);
    expect(hotel!.parts.poi).toBe(0);
    // A business asked for by its own name keeps the bonus.
    expect(scoreCandidates("Seaport Hotel", [SEAPORT_HOTEL], BOSTON)[0]!.parts.poi).toBe(0.1);
  });

  test("names that contain a neighborhood stay what they name", () => {
    expect(
      classifyPlaceMatches("Seaport Hotel", [SEAPORT_AREA, SEAPORT_HOTEL], BOSTON),
    ).toMatchObject({ kind: "found", place: SEAPORT_HOTEL });
    expect(classifyPlaceMatches("Fenway Park", [FENWAY, FENWAY_PARK], BOSTON)).toMatchObject({
      kind: "found",
      place: FENWAY_PARK,
    });
    expect(
      classifyPlaceMatches("Moo steakhouse in Seaport", [MOOO_BEACON_HILL, MOOO_SEAPORT], BOSTON),
    ).toMatchObject({ kind: "found", place: MOOO_SEAPORT });
  });
});

describe("when a search is too weak to stand on", () => {
  test("nothing found, nothing carrying the name, or a best under the line", () => {
    expect(searchIsWeak("lola42", [], BOSTON)).toBe(true);
    // Only the neighborhood came back: no word of the name in it.
    expect(searchIsWeak("lola42", [SEAPORT_AREA], BOSTON)).toBe(true);
    // The place itself, listed first: strong.
    expect(searchIsWeak("Lola 42", [LOLA_42], BOSTON)).toBe(false);
    // Half the name, far from where the search looked, not first: weak by
    // its score.
    const half = { ...LOLA_42, ...north(BOSTON, 16_000), rank: 2 };
    const [scored] = scoreCandidates("Lola 99", [half], BOSTON);
    expect(scored!.parts.name).toBeGreaterThan(0);
    expect(scored!.score).toBeLessThan(WEAK_SEARCH_BELOW);
    expect(searchIsWeak("Lola 99", [half], BOSTON)).toBe(true);
  });

  test("a query that names nothing has nothing to complete", () => {
    expect(searchIsWeak("a cafe", [], BOSTON)).toBe(false);
    expect(searchIsWeak("the bar", [UNRELATED], BOSTON)).toBe(false);
  });
});

describe("a whole word is the word: positive controls", () => {
  const confidenceOf = (query: string, results: GeocodeResult[]) => {
    const match = classifyPlaceMatches(query, results, SEAPORT_PHONE);
    return match.kind === "found" && match.nameMatched ? match.confidence : null;
  };
  /** What the name said in full comes to: nothing can be surer of it. */
  const FULL = confidenceOf("W XYZ Bar", [W_XYZ]);

  test("'XYZ bar' and 'W XYZ' are W XYZ Bar, as sure as its whole name", () => {
    // Near the phone, a business, listed first, every name word carried:
    // the most a query naming no area can score.
    expect(FULL).toBe(0.8);
    expect(FULL!).toBeGreaterThanOrEqual(T.found);
    for (const query of ["XYZ bar", "W XYZ", "xyz", "w xyz bar", "The W XYZ Bar"]) {
      const [scored] = scoreCandidates(query, [W_XYZ], SEAPORT_PHONE);
      expect(scored!.parts.name, query).toBe(0.5);
      expect(scored!.nameMatched, query).toBe(true);
      expect(scored!.evidence, query).toBe(true);
      expect(classifyPlaceMatches(query, [W_XYZ], SEAPORT_PHONE), query).toEqual({
        kind: "found",
        place: W_XYZ,
        nameMatched: true,
        confidence: FULL,
      });
      expect(carriesTheName(query, [W_XYZ], SEAPORT_PHONE), query).toBe(true);
      // A search that answers with it is not weak: autocomplete isn't asked.
      expect(searchIsWeak(query, [W_XYZ], SEAPORT_PHONE), query).toBe(false);
    }
  });

  test("it is the place among other results too, and wherever its source listed it", () => {
    const stuart = poi("Stuart Street Tavern", 42.3515, -71.0668, "80 Stuart St", "Bay Village");
    for (const query of ["XYZ bar", "W XYZ"]) {
      for (const results of [
        [W_XYZ, UNRELATED, stuart],
        [UNRELATED, stuart, W_XYZ],
      ]) {
        const match = classifyPlaceMatches(query, results, SEAPORT_PHONE);
        expect(match).toMatchObject({ kind: "found", place: W_XYZ, nameMatched: true });
        const scored = scoreCandidates(query, results, SEAPORT_PHONE).find(
          (s) => s.result === W_XYZ,
        )!;
        // The name is carried in full either way; only the 0.05 for being
        // listed first moves.
        expect(scored.parts.name).toBe(0.5);
        expect(scored.score).toBe(results[0] === W_XYZ ? FULL : FULL! - 0.05);
        expect(scored.score).toBeGreaterThanOrEqual(T.found);
      }
    }
  });

  test("an exact word is exact even when a longer name word starts with it, and whatever its length", () => {
    // The fragment rule looks for a name word that STARTS with the query
    // word. A name can hold the word whole as well: whole wins.
    expect(nameMatch(["mass", "massachusetts", "hall"], "mass")).toBe("exact");
    expect(nameMatch(["park", "parking"], "park")).toBe("exact");
    expect(nameMatch(["w", "xyz", "bar"], "w")).toBe("exact");
    expect(nameMatch(["lola", "42"], "42")).toBe("exact");
    expect(nameMatch(["q", "restaurant"], "q")).toBe("exact");
    // And the rule still tells a fragment from a word, both ways.
    expect(nameMatch(["massachusetts", "hall"], "mass")).toBe("fragment");
    expect(nameMatch(["mass", "hall"], "massachusetts")).toBeNull();
  });

  test("no query made of a name's own whole words ever loses credit to the fragment rule", () => {
    const places = [
      W_XYZ,
      LOLA_42,
      MOOO_SEAPORT,
      UNRELATED,
      poi("TD Garden", 42.36621, -71.06216, "100 Legends Way", "West End"),
      poi("Legal Sea Foods", 42.3519, -71.0447, "270 Northern Ave", "Seaport"),
      poi("Trader Joe's", 42.3489, -71.0889, "899 Boylston St", "Back Bay"),
      poi("Prudential Center", 42.3471, -71.0825, "800 Boylston St", "Back Bay"),
      poi("Museum of Fine Arts", 42.3394, -71.094, "465 Huntington Ave", "Fenway"),
      // Names built to tempt the rule: a word that is the start of its
      // neighbor, and one-letter words.
      poi("Park Parking Garage", 42.35, -71.06, "1 Park St", "Downtown"),
      poi("Mass Massachusetts Hall", 42.35, -71.07, "2 Hall St", "Back Bay"),
      poi("A B Sea Grill", 42.35, -71.05, "3 Sea St", "Seaport"),
    ];
    let checked = 0;
    for (const place of places) {
      const words = nameOf(place);
      // Every run of consecutive words of the name, said back as a query.
      for (let from = 0; from < words.length; from += 1) {
        for (let to = from + 1; to <= words.length; to += 1) {
          const query = words.slice(from, to).join(" ");
          const said = nameTokens(query);
          const about = `"${query}" for ${place.name}`;
          for (const word of said) {
            expect(nameMatch(words, word), `${about}: ${word}`).toBe("exact");
          }
          // A query of kind words alone ("bar", "the") names nothing: the
          // score has no name to weigh, by a rule older than this one.
          if (said.every(isGenericWord)) continue;
          const [scored] = scoreCandidates(query, [place], SEAPORT_PHONE);
          expect(scored!.parts.name, about).toBe(0.5);
          expect(scored!.nameMatched, about).toBe(true);
          expect(scored!.evidence, about).toBe(true);
          // As sure as the whole name, to the last digit.
          const [whole] = scoreCandidates(words.join(" "), [place], SEAPORT_PHONE);
          expect(scored!.score, about).toBe(whole!.score);
          checked += 1;
        }
      }
    }
    // The loop really ran over real queries.
    expect(checked).toBeGreaterThan(40);
  });

  test("a whole word keeps its full credit beside a fragment: only the fragment counts half", () => {
    const prudential = poi("Prudential Center", 42.3471, -71.0825, "800 Boylston St", "Back Bay");
    const [mixed] = scoreCandidates("Pru Center", [prudential], BOSTON);
    // "Center" whole (1) + "Pru" half (0.5), of two words.
    expect(mixed!.parts.name).toBe(0.375);
    expect(mixed!.nameMatched).toBe(true);
    const [whole] = scoreCandidates("Center", [prudential], BOSTON);
    expect(whole!.parts.name).toBe(0.5);
  });
});
