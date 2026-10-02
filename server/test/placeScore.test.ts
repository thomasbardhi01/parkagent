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
  scoreCandidates,
  searchIsWeak,
} from "../src/services/assistant/placeScore.js";

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

  test("'xyzzy restaurant' with an unrelated result nearby: nothing, not the closest thing", () => {
    const [scored] = scoreCandidates("xyzzy restaurant", [UNRELATED], SEAPORT_PHONE);
    // Near the phone, a business, listed first: its score alone reaches
    // the floor. What rules it out is that it shares no word with the ask.
    expect(scored!.score).toBeGreaterThanOrEqual(T.closestFloor);
    expect(scored!.evidence).toBe(false);
    expect(classifyPlaceMatches("xyzzy restaurant", [UNRELATED], SEAPORT_PHONE)).toEqual({
      kind: "none",
    });
    // And the chain keeps asking: a source that answered with this hasn't
    // found the name.
    expect(carriesTheName("xyzzy restaurant", [UNRELATED], SEAPORT_PHONE)).toBe(false);
  });

  test("naming the city is not a reason to offer a result: 'xyzzy restaurant in Boston'", () => {
    const scored = scoreCandidates("xyzzy restaurant in Boston", [UNRELATED], SEAPORT_PHONE);
    // It IS in Boston, and scores for it — like every other result.
    expect(scored[0]!.parts.area).toBe(0.2);
    expect(scored[0]!.evidence).toBe(false);
    expect(classifyPlaceMatches("xyzzy restaurant in Boston", [UNRELATED], SEAPORT_PHONE)).toEqual({
      kind: "none",
    });
  });

  test("the neighborhood the user named is the closest thing, said as that", () => {
    const match = classifyPlaceMatches("xyzzy restaurant in Seaport", [SEAPORT_AREA], BOSTON);
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
