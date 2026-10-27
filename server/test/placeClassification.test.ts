/**
 * FR-53/FR-54 — the place policy in placeClassification.ts, pinned offline:
 * what /parked answers for a place (`placeOutcome`), the driver's own answer
 * (`cleanPlaceName`, `confirmationRule`), the request's side (`parseOutcomes`,
 * hint helpers) and a few `classifyPlace` reads that need no garage geometry.
 * Constants are imported, never retyped.
 */

import { describe, expect, test } from "vitest";

import {
  ACT_MARGIN,
  MEMORY_CONFIDENCE,
  MIN_ACT_CONFIDENCE,
  PLACE_OUTCOMES,
  classifyPlace,
  cleanPlaceName,
  confirmationRule,
  hintGarageId,
  hintIsLocated,
  parseOutcomes,
  placeOutcome,
  type Classified,
  type PlaceClass,
  type PlaceHint,
  type PlaceOutcome,
  type StreetAnswer,
} from "../src/services/placeClassification.js";

const BOTH: readonly PlaceOutcome[] = PLACE_OUTCOMES;
const NONE: readonly PlaceOutcome[] = [];

const street = (action: StreetAnswer["action"], charges: boolean): StreetAnswer => ({
  action,
  rule: `street_${action}`,
  charges,
});

const classified = (
  cls: PlaceClass,
  opts: { located?: boolean; lotCharges?: boolean; hasEvidence?: boolean } = {},
): Classified => ({
  place: {
    class: cls,
    confidence: 0.9,
    runnerUp: null,
    garageId: null,
    garageName: null,
    source: "hint",
    attribution: null,
  },
  located: opts.located ?? true,
  memory: false,
  hasEvidence: opts.hasEvidence ?? cls !== "street",
  lotCharges: opts.lotCharges ?? false,
  scores: {},
  footprint: null,
});

const POINT = { lat: 42.35, lng: -71.05 };
const classify = (over: { hint?: PlaceHint | null; zones?: "agree" | "disagree" | "none" }) =>
  classifyPlace({
    point: POINT,
    accuracyM: 10,
    hint: over.hint ?? null,
    zones: over.zones ?? "none",
    garages: [],
    hintGarage: null,
  });

describe("placeOutcome, located", () => {
  test("no understood outcomes: the street answer stands for every class", () => {
    const s = street("pay", true);
    for (const cls of ["garage", "lot", "nopay", "street", "unknown"] as const) {
      expect(placeOutcome(s, classified(cls), NONE)).toEqual({ action: "pay", rule: "street_pay" });
    }
  });

  test("garage answers garage/place_garage when shown, the street answer otherwise", () => {
    const s = street("pay", true);
    expect(placeOutcome(s, classified("garage"), BOTH)).toEqual({
      action: "garage",
      rule: "place_garage",
    });
    expect(placeOutcome(s, classified("garage"), ["nopay"])).toEqual({
      action: "pay",
      rule: "street_pay",
    });
  });

  test("a lot that charges answers garage/place_lot_fee; a free lot asks", () => {
    const s = street("pay", true);
    expect(placeOutcome(s, classified("lot", { lotCharges: true }), BOTH)).toEqual({
      action: "garage",
      rule: "place_lot_fee",
    });
    expect(placeOutcome(s, classified("lot", { lotCharges: true }), ["nopay"])).toEqual({
      action: "pay",
      rule: "street_pay",
    });
    expect(placeOutcome(s, classified("lot"), BOTH)).toEqual({
      action: "confirm",
      rule: "place_unknown",
    });
  });

  test("nopay where the street does not charge answers nopay/place_nopay when shown", () => {
    const s = street("unknown_zone", false);
    expect(placeOutcome(s, classified("nopay"), BOTH)).toEqual({
      action: "nopay",
      rule: "place_nopay",
    });
    expect(placeOutcome(s, classified("nopay"), ["garage"])).toEqual({
      action: "unknown_zone",
      rule: "street_unknown_zone",
    });
    // A street that already says ignore stays as it is.
    expect(placeOutcome(street("ignore", false), classified("nopay"), BOTH)).toEqual({
      action: "ignore",
      rule: "street_ignore",
    });
  });

  test("AC2: nopay where the street charges never answers nopay (pay → confirm/place_unknown)", () => {
    const s = street("pay", true);
    for (const understood of [BOTH, ["nopay"] as const, ["garage"] as const]) {
      const out = placeOutcome(s, classified("nopay"), understood);
      expect(out.action).not.toBe("nopay");
      expect(out).toEqual({ action: "confirm", rule: "place_unknown" });
    }
  });

  test("AC2: nopay where the street charges but needed a tap keeps its own answer", () => {
    const s = street("confirm", true);
    const out = placeOutcome(s, classified("nopay"), BOTH);
    expect(out).toEqual({ action: "confirm", rule: "street_confirm" });
  });

  test("street class and unknown: street answer; unknown with evidence asks", () => {
    const s = street("pay", true);
    expect(placeOutcome(s, classified("street"), BOTH)).toEqual({
      action: "pay",
      rule: "street_pay",
    });
    expect(placeOutcome(s, classified("unknown", { hasEvidence: false }), BOTH)).toEqual({
      action: "pay",
      rule: "street_pay",
    });
    expect(placeOutcome(s, classified("unknown", { hasEvidence: true }), BOTH)).toEqual({
      action: "confirm",
      rule: "place_unknown",
    });
    expect(placeOutcome(street("unknown_zone", false), classified("unknown"), BOTH)).toEqual({
      action: "unknown_zone",
      rule: "place_unknown",
    });
  });
});

describe("placeOutcome, not located", () => {
  test("empty understood: unknown_zone/unknown_zone whatever the class", () => {
    for (const cls of ["garage", "lot", "nopay", "street", "unknown"] as const) {
      expect(placeOutcome(street("pay", true), classified(cls, { located: false }), NONE)).toEqual({
        action: "unknown_zone",
        rule: "unknown_zone",
      });
    }
  });

  test("garage and charging lot answer garage when shown, else unknown_zone", () => {
    const s = street("pay", true);
    expect(placeOutcome(s, classified("garage", { located: false }), BOTH)).toEqual({
      action: "garage",
      rule: "place_garage",
    });
    expect(placeOutcome(s, classified("lot", { located: false, lotCharges: true }), BOTH)).toEqual({
      action: "garage",
      rule: "place_lot_fee",
    });
    expect(placeOutcome(s, classified("garage", { located: false }), ["nopay"])).toEqual({
      action: "unknown_zone",
      rule: "unknown_zone",
    });
    expect(placeOutcome(s, classified("lot", { located: false }), BOTH)).toEqual({
      action: "unknown_zone",
      rule: "place_unknown",
    });
  });

  test("nopay with a free street answers nopay when shown", () => {
    const s = street("unknown_zone", false);
    expect(placeOutcome(s, classified("nopay", { located: false }), BOTH)).toEqual({
      action: "nopay",
      rule: "place_nopay",
    });
  });

  test("AC2: nopay where the street charges asks, never nopay", () => {
    const s = street("pay", true);
    for (const understood of [BOTH, ["nopay"] as const, ["garage"] as const]) {
      const out = placeOutcome(s, classified("nopay", { located: false }), understood);
      expect(out).toEqual({ action: "unknown_zone", rule: "place_unknown" });
    }
    expect(placeOutcome(s, classified("nopay", { located: false }), NONE)).toEqual({
      action: "unknown_zone",
      rule: "unknown_zone",
    });
  });

  test("street and unknown classes ask when something is understood", () => {
    const s = street("pay", true);
    for (const cls of ["street", "unknown"] as const) {
      expect(placeOutcome(s, classified(cls, { located: false }), BOTH)).toEqual({
        action: "unknown_zone",
        rule: "place_unknown",
      });
    }
  });
});

describe("cleanPlaceName", () => {
  test("control characters become spaces, runs collapse, ends trim", () => {
    expect(cleanPlaceName("  Seaport\tGarage\n\nLevel\u0000 2  ")).toBe("Seaport Garage Level 2");
    expect(cleanPlaceName("a\u007fb")).toBe("a b");
  });

  test("null, undefined, empty and blank input are null", () => {
    expect(cleanPlaceName(null)).toBeNull();
    expect(cleanPlaceName(undefined)).toBeNull();
    expect(cleanPlaceName("")).toBeNull();
    expect(cleanPlaceName("  \t\n ")).toBeNull();
    expect(cleanPlaceName("\u0000\u001f\u007f")).toBeNull();
  });
});

describe("confirmationRule", () => {
  test("not_here, confirmed and corrected", () => {
    expect(confirmationRule("not_here", "garage")).toBe("place_not_here");
    expect(confirmationRule("not_here", null)).toBe("place_not_here");
    expect(confirmationRule("garage", "garage")).toBe("place_confirmed");
    expect(confirmationRule("garage", "lot")).toBe("place_corrected");
    expect(confirmationRule("garage", null)).toBe("place_corrected");
  });
});

describe("parseOutcomes", () => {
  test("PLACE_OUTCOMES order, unknown entries dropped", () => {
    const reversed = [...PLACE_OUTCOMES].reverse();
    expect(parseOutcomes(reversed)).toEqual([...PLACE_OUTCOMES]);
    expect(parseOutcomes(["walk_away", "nopay", 3, null])).toEqual(["nopay"]);
    expect(parseOutcomes(["pay"])).toEqual([]);
  });

  test("non-arrays are none", () => {
    for (const raw of [null, undefined, "garage", { garage: true }, 7]) {
      expect(parseOutcomes(raw)).toEqual([]);
    }
  });
});

describe("hint helpers", () => {
  const hint = (over: Partial<PlaceHint>): PlaceHint => ({
    class: "garage",
    confidence: 0.9,
    ...over,
  });

  test("hintGarageId prefers garageId, falls back to footprintId", () => {
    expect(hintGarageId(hint({ garageId: "osm-way-123" }))).toBe("osm-way-123");
    expect(hintGarageId(hint({ inputs: { footprintId: "osm-way-9" } }))).toBe("osm-way-9");
    expect(hintGarageId(hint({ garageId: "a1", inputs: { footprintId: "b2" } }))).toBe("a1");
    expect(hintGarageId(null)).toBeNull();
    expect(hintGarageId(hint({}))).toBeNull();
  });

  test("hintGarageId rejects malformed ids", () => {
    for (const bad of ["Osm-1", "a b", "-abc", "abc-", "a--b", "", "a.b", "a_b", "a/b"]) {
      expect(hintGarageId(hint({ garageId: bad }))).toBeNull();
    }
  });

  test("hintIsLocated is false only when inputs.located is false", () => {
    expect(hintIsLocated(null)).toBe(true);
    expect(hintIsLocated(hint({}))).toBe(true);
    expect(hintIsLocated(hint({ inputs: {} }))).toBe(true);
    expect(hintIsLocated(hint({ inputs: { located: true } }))).toBe(true);
    expect(hintIsLocated(hint({ inputs: { located: false } }))).toBe(false);
  });
});

describe("classifyPlace", () => {
  test("zones agree and no hint: street, from the zones", () => {
    const out = classify({ zones: "agree" });
    expect(out.place.class).toBe("street");
    expect(out.place.source).toBe("zones");
    expect(out.located).toBe(true);
    expect(out.hasEvidence).toBe(false);
  });

  test("no evidence at all: unknown with source none", () => {
    const out = classify({});
    expect(out.place.class).toBe("unknown");
    expect(out.place.source).toBe("none");
    expect(out.place.confidence).toBe(0);
    expect(out.located).toBe(true);
  });

  test("a confident phone read with no zones acts, from the hint", () => {
    const conf = Math.max(MIN_ACT_CONFIDENCE, ACT_MARGIN);
    const out = classify({ hint: { class: "garage", confidence: conf } });
    expect(out.place.class).toBe("garage");
    expect(out.place.source).toBe("hint");
    expect(out.hasEvidence).toBe(true);
  });

  test("a read under MIN_ACT_CONFIDENCE is a guess: unknown, runner-up kept", () => {
    const out = classify({ hint: { class: "garage", confidence: MIN_ACT_CONFIDENCE - 0.1 } });
    expect(out.place.class).toBe("unknown");
    expect(out.place.runnerUp?.class).toBe("garage");
  });

  test("a saved place wins at MEMORY_CONFIDENCE; no fix at the spot is not located", () => {
    const out = classify({
      zones: "agree",
      hint: { class: "lot", confidence: 0.4, inputs: { memoryHit: true, located: false } },
    });
    expect(out.place.class).toBe("lot");
    expect(out.place.source).toBe("memory");
    expect(out.place.confidence).toBe(MEMORY_CONFIDENCE);
    expect(out.memory).toBe(true);
    expect(out.located).toBe(false);
    expect(out.lotCharges).toBe(true);
  });
});
