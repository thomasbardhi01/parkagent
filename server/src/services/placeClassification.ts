/**
 * What kind of place a park is (FR-54): street, garage, lot, no-pay, or
 * unknown, and what /parked answers for it.
 *
 * Two reads go in. The phone's (`placeHint`, FR-53) knows what the server
 * can't: the driver's saved places, GPS dying on the ramp, the barometer.
 * The server's knows what the phone can't: the metered zones in reach, and
 * the garage outlines as loaded today. Each class gets a score from 0 to 1
 * and the top one is acted on only when it beats the next by `ACT_MARGIN`,
 * the phone classifier's own rule (ios Detection/PlaceClassifier.swift,
 * docs/research/3-park-now.md §2), with the same numbers:
 *
 * - street: the zone lookup agrees 0.9, disagrees 0.6.
 * - garage: the fix inside a structure's outline 0.9, or 0.7 when it is
 *   nearer the outline's edge than its own accuracy (the street beside
 *   it); no fix at the spot and the entry fix at a structure's entrance 0.9.
 * - lot: inside a lot that charges 0.85, one nobody tagged a fee on 0.6.
 * - nopay: inside a free or private lot 0.8; an untagged one 0.3.
 * - the phone's class at the phone's confidence; a saved place 0.95, in
 *   place of anything the footprints say (the driver's own answer).
 *
 * Whatever the scores say, two things hold (`placeOutcome`): no answer here
 * is ever `pay` unless the street lookup alone said `pay`, and a meter that
 * would charge is never answered with silence.
 *
 * Pure: nothing here reads a table or the clock.
 */

import { z } from "zod";

import type { GarageFootprint, LatLng } from "./garageLookup.js";
import { classifyByFootprint, describeFootprint } from "./garageLookup.js";

export const PLACE_CLASSES = ["street", "garage", "lot", "nopay", "unknown"] as const;
export type PlaceClass = (typeof PLACE_CLASSES)[number];

/** The /parked actions beyond the street's, each shown only by an app that
 * lists it in the request's `outcomes`. */
export const PLACE_OUTCOMES = ["garage", "nopay"] as const;
export type PlaceOutcome = (typeof PLACE_OUTCOMES)[number];

export const ACT_MARGIN = 0.3;
/** A top score under this is a guess, whatever it beats. */
export const MIN_ACT_CONFIDENCE = 0.5;
export const MEMORY_CONFIDENCE = 0.95;
/** How far around the fix garages are fetched: past an entrance's reach
 * (100 m) and the entrance's own distance from its outline. */
export const GARAGE_REACH_M = 150;

/** What each source's license asks us to say wherever its data shows; the
 * same lines GET /garages/near answers (routes/garages.ts). */
const ATTRIBUTIONS: Record<string, string> = {
  osm: "© OpenStreetMap contributors",
};

/** Kinds a car drives into (garageLookup's entrance rule covers the same). */
const STRUCTURE_KINDS: readonly string[] = ["multi_storey", "underground", "rooftop"];

// ---------------------------------------------------------------------------
// The request's side
// ---------------------------------------------------------------------------

const scoredSchema = z.object({
  class: z.enum(PLACE_CLASSES),
  confidence: z.number().min(0).max(1),
});

const placeHintSchema = z.object({
  class: z.enum(PLACE_CLASSES),
  confidence: z.number().min(0).max(1),
  runnerUp: scoredSchema.nullish(),
  garageId: z.string().min(1).max(100).nullish(),
  entryFix: z
    .object({
      lat: z.number().gte(-90).lte(90),
      lng: z.number().gte(-180).lte(180),
      accuracy: z.number().nonnegative().lte(10_000),
      ts: z.string().max(40),
    })
    .nullish(),
  inputs: z
    .object({
      located: z.boolean().optional(),
      memoryHit: z.boolean().optional(),
      footprintId: z.string().max(100).nullish(),
      containsPoint: z.boolean().optional(),
      nearestEntranceM: z.number().nullish(),
      gpsLoss: z.boolean().optional(),
      baroDeltaM: z.number().nullish(),
      crawl: z.boolean().optional(),
    })
    .nullish(),
});

export type PlaceHint = z.infer<typeof placeHintSchema>;

/** The phone's hint, or null for none or one that isn't a hint: a park is
 * never refused over it. */
export function parsePlaceHint(raw: unknown): PlaceHint | null {
  const parsed = placeHintSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Which place outcomes the app says it can show, in PLACE_OUTCOMES order.
 * Anything that isn't a list of them is none. */
export function parseOutcomes(raw: unknown): PlaceOutcome[] {
  if (!Array.isArray(raw)) return [];
  return PLACE_OUTCOMES.filter((outcome) => raw.includes(outcome));
}

/** No fix at the spot (GPS gone): the request's lat/lng are the entry fix. */
export function hintIsLocated(hint: PlaceHint | null): boolean {
  return hint?.inputs?.located !== false;
}

/** The garage a hint names, if it could be an id at all. */
export function hintGarageId(hint: PlaceHint | null): string | null {
  const id = hint?.garageId ?? hint?.inputs?.footprintId ?? null;
  return id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ZoneAgreement = "agree" | "disagree" | "none";
export type PlaceSource = "memory" | "hint" | "footprint" | "zones" | "none";

export interface FootprintEvidence {
  garageId: string;
  kind: string;
  fee: boolean | null;
  access: string | null;
  containsPoint: boolean;
  /** Meters to the outline's nearest side, to 0.1 m. */
  edgeDistanceM: number;
  nearestEntranceM: number | null;
}

export interface PlaceAnswer {
  class: PlaceClass;
  /** The class's score; 0 for unknown. */
  confidence: number;
  /** The next best class; for unknown, the best guess, which fell short. */
  runnerUp: { class: PlaceClass; confidence: number } | null;
  garageId: string | null;
  garageName: string | null;
  source: PlaceSource;
  /** The line the garage's source asks for wherever its name is shown. */
  attribution: string | null;
}

export interface Classified {
  place: PlaceAnswer;
  located: boolean;
  /** One of the driver's saved places decided the class. */
  memory: boolean;
  /** Something other than the zone lookup had a say. */
  hasEvidence: boolean;
  /** The class is a lot that charges (or the driver said it is a lot). */
  lotCharges: boolean;
  scores: Partial<Record<Exclude<PlaceClass, "unknown">, number>>;
  footprint: FootprintEvidence | null;
}

export interface ClassifyInput {
  /** The fix, or the entry fix when the hint says there is none at the spot. */
  point: LatLng;
  accuracyM: number;
  hint: PlaceHint | null;
  zones: ZoneAgreement;
  /** Garages whose outline is within GARAGE_REACH_M of the point. */
  garages: readonly GarageFootprint[];
  /** The garage the hint names, looked up by id and found near the point. */
  hintGarage: GarageFootprint | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

type Scorable = Exclude<PlaceClass, "unknown">;

export function classifyPlace(input: ClassifyInput): Classified {
  const { point, accuracyM, hint, zones, garages, hintGarage } = input;
  const located = hintIsLocated(hint);
  const memory = hint?.inputs?.memoryHit === true && hint.class !== "unknown";

  const scores = new Map<Scorable, { score: number; source: PlaceSource }>();
  const raise = (placeClass: Scorable, score: number, source: PlaceSource) => {
    const current = scores.get(placeClass);
    // A tie keeps what was there: the server's own read goes in first.
    if (!current || score > current.score) scores.set(placeClass, { score, source });
  };

  // The street is where the fix is. With no fix at the spot, the zones
  // around the entry fix say nothing about where the car ended up.
  if (located && zones === "agree") raise("street", 0.9, "zones");
  if (located && zones === "disagree") raise("street", 0.6, "zones");

  // The server's own footprints. A located park is in a garage or lot only
  // by being inside its outline; the entrance rule is for a car that drove
  // in and lost GPS (near an entrance, located, is the street outside it).
  let footprint: FootprintEvidence | null = null;
  let ownGarage: GarageFootprint | null = null;
  const match = classifyByFootprint(point, accuracyM, garages);
  const matched = match.garageId ? garages.find((g) => g.id === match.garageId) : undefined;
  if (matched && (match.containsPoint || !located)) {
    const at = describeFootprint(point, matched);
    ownGarage = matched;
    footprint = {
      garageId: matched.id,
      kind: matched.kind,
      fee: matched.fee,
      access: matched.access,
      containsPoint: match.containsPoint,
      edgeDistanceM: roundTenth(at.edgeDistanceM),
      nearestEntranceM: match.nearestEntranceM,
    };
    // A saved place is the driver's own answer: the footprints name the
    // garage, but don't argue with it.
    if (!memory) {
      if (STRUCTURE_KINDS.includes(matched.kind)) {
        // Nearer the outline's edge than the fix is vague: it could be
        // the street beside the garage.
        const deep = !located || at.edgeDistanceM >= accuracyM;
        raise("garage", deep ? 0.9 : 0.7, "footprint");
      } else if (matched.fee === false || matched.access === "private") {
        raise("nopay", 0.8, "footprint");
      } else if (matched.fee === true) {
        raise("lot", 0.85, "footprint");
      } else {
        raise("lot", 0.6, "footprint");
        raise("nopay", 0.3, "footprint");
      }
    }
  }

  // The phone's read. `street` is the zone lookup's to say, and `unknown`
  // is no read at all.
  if (hint && hint.class !== "unknown" && hint.class !== "street") {
    if (memory) raise(hint.class, MEMORY_CONFIDENCE, "memory");
    else raise(hint.class, hint.confidence, "hint");
  }

  // Ties go to the class that asks over the one that stays silent.
  const order: Scorable[] = ["garage", "lot", "street", "nopay"];
  const ranked = order
    .flatMap((placeClass, index) => {
      const entry = scores.get(placeClass);
      return entry && entry.score > 0
        ? [{ placeClass, score: round2(entry.score), source: entry.source, index }]
        : [];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const top = ranked[0];
  const next = ranked[1];
  const acts =
    top !== undefined &&
    top.score >= MIN_ACT_CONFIDENCE &&
    top.score - (next?.score ?? 0) >= ACT_MARGIN - 1e-9;

  // The garage or lot in play: the one behind the best class that isn't
  // the street, from whichever read put it there.
  const bestPlace = ranked.find((entry) => entry.placeClass !== "street");
  const named = acts && top.placeClass === "street" ? undefined : bestPlace;
  const garage =
    named === undefined
      ? null
      : named.source === "footprint"
        ? ownGarage
        : (ownGarage ?? hintGarage);

  const place: PlaceAnswer = {
    class: acts ? top.placeClass : "unknown",
    confidence: acts ? top.score : 0,
    runnerUp: acts
      ? next
        ? { class: next.placeClass, confidence: next.score }
        : null
      : top
        ? { class: top.placeClass, confidence: top.score }
        : null,
    garageId: garage?.id ?? null,
    garageName: garage?.name ?? null,
    source: top?.source ?? "none",
    attribution: garage ? (ATTRIBUTIONS[garage.source] ?? null) : null,
  };

  return {
    place,
    located,
    memory: memory && top?.source === "memory",
    hasEvidence: bestPlace !== undefined,
    lotCharges: place.class === "lot" && (garage?.fee === true || top?.source === "memory"),
    scores: Object.fromEntries(ranked.map((entry) => [entry.placeClass, entry.score])),
    footprint,
  };
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export type ParkedAction = "pay" | "confirm" | "ignore" | "unknown_zone" | PlaceOutcome;

export interface StreetAnswer {
  action: "pay" | "confirm" | "ignore" | "unknown_zone";
  rule: string;
  /** A candidate in reach would charge for this stay. */
  charges: boolean;
}

/**
 * What /parked answers, given what the street lookup alone would and what
 * the place is. Existing street answers stand for an app that lists no
 * place outcomes (shipped builds decode `action` strictly), with one
 * exception that is itself a street answer: a park with no fix at the spot
 * is never quoted the meters at its entry fix.
 *
 * - `garage` / `place_garage`, `place_lot_fee`: a garage, or a lot that
 *   charges. Nothing ParkAgent pays in V1; the candidates ride along.
 * - `nopay` / `place_nopay`: nothing to pay, and nothing in reach charges.
 * - `place_unknown`: the place is unclear. `pay` becomes `confirm` (the
 *   driver picks); a park with no zone stays `unknown_zone`; one that
 *   already needed a tap keeps its own rule.
 */
export function placeOutcome(
  street: StreetAnswer,
  classified: Classified,
  understood: readonly PlaceOutcome[],
): { action: ParkedAction; rule: string } {
  const shows = (outcome: PlaceOutcome) => understood.includes(outcome);
  const { place } = classified;

  if (!classified.located) {
    const nothing = { action: "unknown_zone", rule: "unknown_zone" } as const;
    if (understood.length === 0) return nothing;
    const ask = { action: "unknown_zone", rule: "place_unknown" } as const;
    switch (place.class) {
      case "garage":
        return shows("garage") ? { action: "garage", rule: "place_garage" } : nothing;
      case "lot":
        if (!classified.lotCharges) return ask;
        return shows("garage") ? { action: "garage", rule: "place_lot_fee" } : nothing;
      case "nopay":
        // The car may be on the metered block the entry fix is on.
        if (street.charges) return ask;
        return shows("nopay") ? { action: "nopay", rule: "place_nopay" } : nothing;
      default:
        return ask;
    }
  }

  const asStreet = { action: street.action, rule: street.rule };
  if (understood.length === 0) return asStreet;
  const ask =
    street.action === "pay"
      ? ({ action: "confirm", rule: "place_unknown" } as const)
      : street.action === "unknown_zone"
        ? ({ action: "unknown_zone", rule: "place_unknown" } as const)
        : asStreet;
  switch (place.class) {
    case "garage":
      return shows("garage") ? { action: "garage", rule: "place_garage" } : asStreet;
    case "lot":
      if (!classified.lotCharges) return ask;
      return shows("garage") ? { action: "garage", rule: "place_lot_fee" } : asStreet;
    case "nopay":
      // Never silence a meter that would charge, whoever says no-pay.
      if (street.charges) return ask;
      if (street.action === "ignore") return asStreet;
      return shows("nopay") ? { action: "nopay", rule: "place_nopay" } : asStreet;
    case "street":
      return asStreet;
    default:
      return classified.hasEvidence ? ask : asStreet;
  }
}

// ---------------------------------------------------------------------------
// The driver's own answer (POST /parked/:id/place)
// ---------------------------------------------------------------------------

/** What a driver can say a place is. `not_here` is "I'm not parked here"
 * (a passenger, a drive-through): recorded, and nothing is learned. */
export const PLACE_ANSWERS = ["street", "garage", "lot", "nopay", "not_here"] as const;
export type PlaceAnswerClass = (typeof PLACE_ANSWERS)[number];

export const PLACE_NAME_MAX = 80;

/** A place name as stored: one line, single spaces; null for none. */
export function cleanPlaceName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

export function confirmationRule(answer: PlaceAnswerClass, was: string | null): string {
  if (answer === "not_here") return "place_not_here";
  return answer === was ? "place_confirmed" : "place_corrected";
}
