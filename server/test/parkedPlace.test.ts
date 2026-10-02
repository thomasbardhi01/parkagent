import { describe, expect, test } from "vitest";

import { at, garage, pair, square } from "./garageFixtures.js";
import {
  API_KEY,
  makeTestApp,
  MONDAY_8PM,
  MOTT_A,
  MOTT_B,
  NONADMIN_API_KEY,
  parkedBody,
  STEINWAY_A,
  STEINWAY_B,
} from "./helpers.js";

/**
 * FR-54: /parked reads the phone's `placeHint`, classifies the place
 * itself from the garage footprints, and answers two new actions, `garage`
 * (a garage or a paid lot: nothing ParkAgent can pay in V1) and `nopay`,
 * to an app that says it can show them. `POST /parked/:id/place` records
 * the driver's own answer.
 *
 * What must hold whatever the hint says: a hint never makes a park `pay`,
 * and a meter that would charge is never silenced.
 */

const HEADERS = { "x-api-key": API_KEY };

/** What an app that shows the place outcomes sends. */
const OUTCOMES = ["garage", "nopay"];

// A 60 m deck around the fixture origin with its entrance on the east
// wall, and four lots in a row to the east, 300 m apart.
const DECK = garage({
  id: "bos-fixture-deck-0a1b2c",
  name: "Fixture Deck",
  kind: "multi_storey",
  fee: true,
  polygon: square(0, 0, 30),
  entrances: [pair(30, 0)],
});
const PAID_LOT = garage({
  id: "bos-fixture-lot-111111",
  name: "Fixture Lot",
  kind: "surface",
  fee: true,
  polygon: square(300, 0, 30),
});
const UNTAGGED_LOT = garage({
  id: "bos-surface-222222",
  kind: "surface",
  polygon: square(600, 0, 30),
});
const PRIVATE_LOT = garage({
  id: "bos-surface-333333",
  kind: "surface",
  access: "private",
  polygon: square(900, 0, 30),
});
const FREE_LOT = garage({
  id: "bos-surface-444444",
  kind: "surface",
  fee: false,
  polygon: square(1200, 0, 30),
});
const GARAGES = [DECK, PAID_LOT, UNTAGGED_LOT, PRIVATE_LOT, FREE_LOT];

/** 30 m from every wall of the deck: further in than the fix is vague. */
const DEEP_IN_DECK = at(0, 0);
/** 5 m inside the deck's east wall: it could be the street beside it. */
const AT_DECK_EDGE = at(25, 0);
/** On the street, 10 m outside the deck's entrance. */
const AT_DECK_ENTRANCE = at(40, 0);
/** Half a kilometer from every outline. */
const OPEN_STREET = at(0, 500);

type App = ReturnType<typeof makeTestApp>["app"];

function post(app: App, body: unknown, headers = HEADERS) {
  return app.inject({ method: "POST", url: "/parked", headers, payload: body as object });
}

/** A park from an app that shows the place outcomes. */
function park(app: App, point: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  return post(app, parkedBody({ ...point, outcomes: OUTCOMES, ...extra }));
}

function hint(
  placeClass: string,
  confidence: number,
  extra: { garageId?: string; inputs?: Record<string, unknown>; entryFix?: unknown } = {},
) {
  return {
    class: placeClass,
    confidence,
    ...(extra.garageId ? { garageId: extra.garageId } : {}),
    ...(extra.entryFix ? { entryFix: extra.entryFix } : {}),
    inputs: {
      located: true,
      memoryHit: false,
      containsPoint: false,
      gpsLoss: false,
      crawl: false,
      ...extra.inputs,
    },
  };
}

/** The driver's own saved place (two confirmations on the phone). */
function memory(placeClass: string) {
  return hint(placeClass, 0.95, { inputs: { memoryHit: true } });
}

/** A park with no fix at the spot: lat/lng are the entry fix. */
function unlocated(placeClass: string, confidence: number, garageId?: string) {
  return hint(placeClass, confidence, {
    ...(garageId ? { garageId } : {}),
    inputs: { located: false, gpsLoss: true },
  });
}

function placeAnswer(app: App, parkedEventId: string, body: unknown, headers = HEADERS) {
  return app.inject({
    method: "POST",
    url: `/parked/${parkedEventId}/place`,
    headers,
    payload: body as object,
  });
}

describe("FR-54 old builds", () => {
  test("FR-54 an app that doesn't list the new outcomes gets exactly today's answer", async () => {
    // Shipped builds decode `action` strictly: `garage` would fail the
    // whole response. They send no `outcomes`, hint or not.
    const metered = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const paid = await post(
      metered.app,
      parkedBody({ ...DEEP_IN_DECK, placeHint: hint("garage", 0.9, { garageId: DECK.id }) }),
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
    expect(paid.json().quote.totalUsd).toBe(3.65);

    const nowhere = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await post(nowhere.app, parkedBody({ ...DEEP_IN_DECK }));
    expect(res.json()).toMatchObject({
      action: "unknown_zone",
      rule: "unknown_zone",
      candidates: [],
      quote: null,
    });
    // The classification still rides along (an old build ignores the key)
    // and is on the decision: the field test scores it either way.
    expect(res.json().place).toMatchObject({ class: "garage", garageId: DECK.id });
    expect(nowhere.state.decisions[0]!.inputs).toMatchObject({
      place: { understood: [], footprint: { garageId: DECK.id, containsPoint: true } },
    });
  });

  test("FR-54 listing one outcome doesn't unlock the other", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const onlyNopay = await post(app, parkedBody({ ...DEEP_IN_DECK, outcomes: ["nopay"] }));
    expect(onlyNopay.json()).toMatchObject({ action: "unknown_zone", rule: "unknown_zone" });
    const onlyGarage = await post(app, parkedBody({ ...at(900, 0), outcomes: ["garage"] }));
    expect(onlyGarage.json()).toMatchObject({ action: "unknown_zone", rule: "unknown_zone" });
  });
});

describe("FR-54 street parks are unchanged", () => {
  test("FR-54 with no garage or lot near, every street answer is today's, with the place named", async () => {
    const pay = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const paid = await park(pay.app, OPEN_STREET);
    expect(paid.json()).toMatchObject({
      action: "pay",
      rule: "auto_pay_ok",
      place: {
        class: "street",
        confidence: 0.9,
        garageId: null,
        garageName: null,
        source: "zones",
      },
    });
    expect(paid.json().candidates).toHaveLength(1);
    expect(paid.json().quote.totalUsd).toBe(3.65);

    const sides = makeTestApp({ candidates: [MOTT_A, MOTT_B], garages: GARAGES });
    const which = await park(sides.app, OPEN_STREET);
    expect(which.json()).toMatchObject({
      action: "confirm",
      rule: "candidates_disagree",
      place: { class: "street", confidence: 0.6, source: "zones" },
    });
    expect(which.json().candidates).toHaveLength(2);

    const free = makeTestApp({
      candidates: [STEINWAY_A],
      garages: GARAGES,
      now: () => new Date(MONDAY_8PM),
    });
    const evening = await park(free.app, OPEN_STREET, { ts: MONDAY_8PM });
    expect(evening.json()).toMatchObject({ action: "ignore", rule: "free_period" });

    const none = makeTestApp({ candidates: [], garages: GARAGES });
    const nothing = await park(none.app, OPEN_STREET);
    expect(nothing.json()).toMatchObject({
      action: "unknown_zone",
      rule: "unknown_zone",
      candidates: [],
      quote: null,
      place: { class: "unknown", confidence: 0, source: "none" },
    });
  });

  test("FR-54 a deployment with no footprint store answers street parks as before", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
    const res = await park(app, DEEP_IN_DECK);
    expect(res.json()).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
    expect(state.decisions[0]!.inputs).toMatchObject({ place: { garageLookup: "unavailable" } });
  });

  test("FR-54 a garage lookup that fails never fails the park", async () => {
    const t = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    t.deps.garageFootprints = {
      near: async () => {
        throw new Error("garages table unreachable");
      },
      byId: async () => {
        throw new Error("garages table unreachable");
      },
    };
    const res = await park(t.app, DEEP_IN_DECK, {
      placeHint: hint("unknown", 0, { garageId: DECK.id }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
    expect(t.state.decisions[0]!.inputs).toMatchObject({ place: { garageLookup: "failed" } });
  });
});

describe("FR-54 garages and paid lots", () => {
  test("FR-54 a garage hint at a known garage answers garage, with the garage's name", async () => {
    const { app, state, pushes } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, DEEP_IN_DECK, {
      placeHint: hint("garage", 0.9, { garageId: DECK.id, inputs: { containsPoint: true } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      candidates: [],
      quote: null,
      needsZoneNumber: false,
      dryRun: true,
      place: {
        class: "garage",
        confidence: 0.9,
        garageId: DECK.id,
        garageName: "Fixture Deck",
        attribution: "© OpenStreetMap contributors",
      },
    });
    expect(typeof res.json().parkedEventId).toBe("string");
    expect(pushes).toHaveLength(0);

    // Every /parked decision carries what the classification saw.
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      kind: "parked_quote",
      rule: "place_garage",
      userId: "u1",
      parkedEventId: "pe1",
    });
    expect(state.decisions[0]!.outcome).toMatchObject({
      action: "garage",
      place: { class: "garage", garageId: DECK.id },
    });
    expect(state.decisions[0]!.inputs).toMatchObject({
      dryRun: true,
      place: {
        understood: OUTCOMES,
        located: true,
        hint: { class: "garage", confidence: 0.9, garageId: DECK.id },
        zones: "none",
        street: { action: "unknown_zone", rule: "unknown_zone" },
        footprint: { garageId: DECK.id, kind: "multi_storey", containsPoint: true },
        garageLookup: "ok",
      },
    });
  });

  test("FR-54 with no hint the server classifies from its own footprints", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, DEEP_IN_DECK);
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      place: {
        class: "garage",
        confidence: 0.9,
        garageId: DECK.id,
        garageName: "Fixture Deck",
        source: "footprint",
      },
    });
    // And the same for a hint that says unknown.
    const unsure = await park(app, DEEP_IN_DECK, { placeHint: hint("unknown", 0) });
    expect(unsure.json()).toMatchObject({ action: "garage", place: { source: "footprint" } });
  });

  test("FR-54 a garage only the phone knows of answers garage with no name", async () => {
    // GPS died on the way in and no outline is mapped there: the phone
    // says garage 0.6, and names one the server has never loaded.
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, OPEN_STREET, {
      placeHint: hint("garage", 0.6, { garageId: "bos-not-in-the-table-000000" }),
    });
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      place: {
        class: "garage",
        confidence: 0.6,
        garageId: null,
        garageName: null,
        source: "hint",
        attribution: null,
      },
    });
  });

  test("FR-54 a hint can't borrow the name of a garage somewhere else", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, OPEN_STREET, {
      placeHint: hint("garage", 0.9, { garageId: DECK.id }),
    });
    expect(res.json()).toMatchObject({
      action: "garage",
      place: { garageId: null, garageName: null },
    });
  });

  test("FR-54 a paid lot answers garage under place_lot_fee", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, at(300, 0));
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_lot_fee",
      quote: null,
      place: {
        class: "lot",
        confidence: 0.85,
        garageId: PAID_LOT.id,
        garageName: "Fixture Lot",
        source: "footprint",
      },
    });
  });

  test("FR-54 a lot nobody tagged a fee on is asked about, not announced as paid", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, at(600, 0));
    expect(res.json()).toMatchObject({
      action: "unknown_zone",
      rule: "place_unknown",
      candidates: [],
      quote: null,
      place: {
        class: "lot",
        confidence: 0.6,
        runnerUp: { class: "nopay", confidence: 0.3 },
        garageId: UNTAGGED_LOT.id,
      },
    });
  });

  test("FR-54 deep in a garage with the two sides of a street in reach: garage, and neither side is lost", async () => {
    // Garage 0.9 against a street the lookup itself is unsure of (0.6).
    const { app } = makeTestApp({ candidates: [MOTT_A, MOTT_B], garages: GARAGES });
    const res = await park(app, DEEP_IN_DECK);
    const body = res.json();
    expect(body).toMatchObject({
      action: "garage",
      rule: "place_garage",
      place: { class: "garage", garageName: "Fixture Deck", runnerUp: { class: "street" } },
    });
    // "Not a garage" still has both sides and their quotes to offer.
    expect(body.candidates.map((c: { zoneId: string }) => c.zoneId)).toEqual([
      "nyc-107114",
      "nyc-101369",
    ]);
    expect(body.quote.zoneId).toBe("nyc-107114");
  });
});

describe("FR-54 what counts as being in a garage", () => {
  test("FR-54 a located park near a garage's entrance is the street outside it", async () => {
    // The entrance rule is for a car that drove in and lost GPS. With a
    // fix at the spot, 10 m outside the entrance is where the curb is.
    const metered = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const paid = await park(metered.app, AT_DECK_ENTRANCE);
    expect(paid.json()).toMatchObject({
      action: "pay",
      rule: "auto_pay_ok",
      place: { class: "street", garageId: null },
    });
    expect(metered.state.decisions[0]!.inputs).toMatchObject({ place: { footprint: null } });

    const none = makeTestApp({ candidates: [], garages: GARAGES });
    const nothing = await park(none.app, AT_DECK_ENTRANCE);
    expect(nothing.json()).toMatchObject({ action: "unknown_zone", rule: "unknown_zone" });
  });

  test("FR-54 a faint guess is asked about, not acted on", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const garage = await park(app, OPEN_STREET, { placeHint: hint("garage", 0.3) });
    expect(garage.json()).toMatchObject({
      action: "unknown_zone",
      rule: "place_unknown",
      place: { class: "unknown", confidence: 0, runnerUp: { class: "garage", confidence: 0.3 } },
    });
    // Least of all a silent one.
    const nopay = await park(app, OPEN_STREET, { placeHint: hint("nopay", 0.45) });
    expect(nopay.json()).toMatchObject({ action: "unknown_zone", rule: "place_unknown" });
    expect(nopay.json().action).not.toBe("nopay");
  });

  test("FR-54 the phone doesn't get to say street: that is the zone lookup's", async () => {
    // Deep in the deck with no meter in reach, a "street" hint changes nothing.
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, DEEP_IN_DECK, { placeHint: hint("street", 0.9) });
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      place: { class: "garage", source: "footprint" },
    });
  });

  test("FR-54 the driver's saved place outranks the footprints, so it isn't asked about again", async () => {
    // Saved as street, beside the deck's wall: the garage 5 m away no
    // longer puts the park in doubt.
    const metered = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const paid = await park(metered.app, AT_DECK_EDGE, { placeHint: memory("street") });
    expect(paid.json()).toMatchObject({
      action: "pay",
      rule: "auto_pay_ok",
      place: { class: "street", confidence: 0.9 },
    });
    // Saved as no-pay, inside a lot the map says charges (a permit): the
    // driver's answer stands where no meter is in reach.
    const lot = makeTestApp({ candidates: [], garages: GARAGES });
    const permit = await park(lot.app, at(300, 0), { placeHint: memory("nopay") });
    expect(permit.json()).toMatchObject({
      action: "nopay",
      rule: "place_nopay",
      place: { class: "nopay", confidence: 0.95, source: "memory" },
    });
    // The footprint is still on the record.
    expect(lot.state.decisions[0]!.inputs).toMatchObject({
      place: { memory: true, footprint: { garageId: PAID_LOT.id } },
    });
  });
});

describe("FR-54 the place is unclear", () => {
  test("FR-54 unknown → place_unknown, and no candidates are lost", async () => {
    // A fix 5 m inside a garage's wall, vague by 12.5 m, with an agreeing
    // metered block in reach: garage 0.7 against street 0.9.
    const plain = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
    const street = (await park(plain.app, OPEN_STREET)).json();
    expect(street.action).toBe("pay");

    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await park(app, AT_DECK_EDGE);
    const body = res.json();
    expect(body).toMatchObject({
      action: "confirm",
      rule: "place_unknown",
      needsZoneNumber: false,
      place: {
        class: "unknown",
        confidence: 0,
        runnerUp: { class: "street", confidence: 0.9 },
        garageId: DECK.id,
        garageName: "Fixture Deck",
      },
    });
    // Exactly what the street answer carries: the driver can still pay it.
    expect(body.candidates).toEqual(street.candidates);
    expect(body.quote).toEqual(street.quote);
    expect(body.provider).toEqual(street.provider);
    expect(state.decisions[0]).toMatchObject({ kind: "parked_quote", rule: "place_unknown" });
    expect(state.decisions[0]!.inputs).toMatchObject({
      candidateZoneIds: ["nyc-417371", "nyc-425957"],
      place: {
        zones: "agree",
        street: { action: "pay", rule: "auto_pay_ok" },
        scores: { street: 0.9, garage: 0.7 },
      },
    });
  });

  test("FR-54 deep in a garage beside an agreeing metered block: asked, never auto-paid", async () => {
    const { app } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await park(app, DEEP_IN_DECK);
    expect(res.json()).toMatchObject({ action: "confirm", rule: "place_unknown" });
    expect(res.json().candidates).toHaveLength(1);
    expect(res.json().quote.totalUsd).toBe(3.65);
  });

  test("FR-54 a park that already needed a tap keeps its own reason", async () => {
    const { app } = makeTestApp({
      candidates: [STEINWAY_A],
      garages: GARAGES,
      policy: { session_cap_usd: 3, auto_pay_max_rate_per_hour: 10 },
    });
    const res = await park(app, AT_DECK_EDGE);
    expect(res.json()).toMatchObject({ action: "confirm", rule: "session_cap_exceeded" });
  });

  test("FR-54 at a garage's edge with nothing metered in reach, it is the garage", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, AT_DECK_EDGE);
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      place: { class: "garage", confidence: 0.7, garageId: DECK.id },
    });
  });

  test("FR-54 a free street beside a garage stays a free street", async () => {
    const { app } = makeTestApp({
      candidates: [STEINWAY_A],
      garages: GARAGES,
      now: () => new Date(MONDAY_8PM),
    });
    const res = await park(app, AT_DECK_EDGE, { ts: MONDAY_8PM });
    expect(res.json()).toMatchObject({ action: "ignore", rule: "free_period" });
  });
});

describe("FR-54 no payment", () => {
  test.each([
    ["a private lot", at(900, 0), PRIVATE_LOT.id],
    ["a free lot", at(1200, 0), FREE_LOT.id],
  ])(
    "FR-54 %s with nothing metered in reach answers nopay, silently",
    async (_label, point, id) => {
      const { app, state, pushes } = makeTestApp({ candidates: [], garages: GARAGES });
      const res = await park(app, point);
      expect(res.json()).toMatchObject({
        action: "nopay",
        rule: "place_nopay",
        candidates: [],
        quote: null,
        provider: null,
        place: { class: "nopay", confidence: 0.8, garageId: id, source: "footprint" },
      });
      // Silent, and still on the ledger.
      expect(pushes).toHaveLength(0);
      expect(state.parkedEvents).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({ kind: "parked_quote", rule: "place_nopay" });
    },
  );

  test("FR-54 the driver's own saved no-pay place answers nopay", async () => {
    const { app, state } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, OPEN_STREET, { placeHint: memory("nopay") });
    expect(res.json()).toMatchObject({
      action: "nopay",
      rule: "place_nopay",
      quote: null,
      place: { class: "nopay", confidence: 0.95, source: "memory", garageId: null },
    });
    // Only that a saved place matched: the phone never sends its name.
    expect(state.decisions[0]!.inputs).toMatchObject({
      place: { hint: { class: "nopay", inputs: { memoryHit: true } } },
    });
  });

  test("FR-54 a no-pay hint never silences a meter that would charge", async () => {
    // Home's driveway is saved; the metered street in front of it is
    // within the same 60 m.
    for (const placeHint of [memory("nopay"), hint("nopay", 0.8)]) {
      const { app } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
      const res = await park(app, OPEN_STREET, { placeHint });
      const body = res.json();
      expect(body.action).toBe("confirm");
      expect(body.rule).toBe("place_unknown");
      expect(body.candidates).toHaveLength(1);
      expect(body.quote.totalUsd).toBe(3.65);
    }

    // Against a street the lookup is unsure of, the saved place outscores
    // it, and still can't silence it.
    const sides = makeTestApp({ candidates: [MOTT_A, MOTT_B], garages: GARAGES });
    const which = await park(sides.app, OPEN_STREET, { placeHint: memory("nopay") });
    expect(which.json()).toMatchObject({ action: "confirm", rule: "candidates_disagree" });
    expect(which.json().candidates).toHaveLength(2);

    // Inside a private lot's outline with a payable meter in reach.
    const lot = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const beside = await park(lot.app, at(900, 0));
    expect(beside.json()).toMatchObject({ action: "confirm", rule: "place_unknown" });
    expect(beside.json().candidates).toHaveLength(1);
  });

  test("FR-54 a no-pay guess the server can't see is not acted on", async () => {
    // The phone's footprints said a free lot (0.8), not the driver: with
    // no metered block there is nothing to silence, so it stands…
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    const res = await park(app, OPEN_STREET, { placeHint: hint("nopay", 0.8) });
    expect(res.json()).toMatchObject({ action: "nopay", place: { source: "hint" } });
    // …but a hint that isn't a class is nothing at all.
    const none = await park(app, OPEN_STREET, { placeHint: hint("unknown", 0) });
    expect(none.json()).toMatchObject({ action: "unknown_zone", rule: "unknown_zone" });
  });
});

describe("FR-54 a hint can only make an answer more careful", () => {
  test.each(["street", "garage", "lot", "nopay", "unknown"])(
    "FR-54 a %s hint never makes a park pay",
    async (placeClass) => {
      for (const confidence of [0.3, 0.9, 1]) {
        for (const placeHint of [hint(placeClass, confidence), memory(placeClass)]) {
          // Nothing metered: no hint can conjure a quote.
          const none = makeTestApp({ candidates: [], garages: GARAGES });
          const nothing = (await park(none.app, OPEN_STREET, { placeHint })).json();
          expect(["unknown_zone", "garage", "nopay"]).toContain(nothing.action);
          expect(nothing.quote).toBeNull();

          // A block that needs a tap: no hint can turn that into pay.
          const sides = makeTestApp({ candidates: [MOTT_A, MOTT_B], garages: GARAGES });
          const which = (await park(sides.app, OPEN_STREET, { placeHint })).json();
          expect(which.action).not.toBe("pay");
          expect(which.action).not.toBe("nopay");
          expect(which.candidates).toHaveLength(2);

          // A payable block: paid as today, or asked about. Never silent.
          const metered = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
          const paid = (await park(metered.app, OPEN_STREET, { placeHint })).json();
          expect(["pay", "confirm"]).toContain(paid.action);
          expect(paid.candidates).toHaveLength(1);
        }
      }
    },
  );

  test.each([
    ["a string", "garage"],
    ["a number", 42],
    ["null", null],
    ["an array", [1, 2]],
    ["an unknown class", { class: "valet", confidence: 0.9 }],
    ["a confidence out of range", { class: "nopay", confidence: 7 }],
  ])("FR-54 a malformed placeHint (%s) is no hint at all", async (_label, placeHint) => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await park(app, OPEN_STREET, { placeHint });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
    expect(state.decisions[0]!.inputs).toMatchObject({ place: { hint: null } });
  });

  test("FR-54 a malformed outcomes list is none listed", async () => {
    const { app } = makeTestApp({ candidates: [], garages: GARAGES });
    for (const outcomes of ["garage", 7, { garage: true }, [1, 2]]) {
      const res = await post(app, parkedBody({ ...DEEP_IN_DECK, outcomes }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ action: "unknown_zone", rule: "unknown_zone" });
    }
  });
});

describe("FR-54 a park with no fix at the spot", () => {
  test("FR-54 the entry fix at a garage's entrance answers that garage, and no street is quoted", async () => {
    // lat/lng are where GPS last saw the car driving in: on the street,
    // 10 m from the entrance. The meters there are not where the car is.
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await park(app, AT_DECK_ENTRANCE, { placeHint: unlocated("garage", 0.9, DECK.id) });
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      candidates: [],
      quote: null,
      provider: null,
      needsZoneNumber: false,
      place: { class: "garage", garageId: DECK.id, garageName: "Fixture Deck" },
    });
    expect(state.decisions[0]!.inputs).toMatchObject({
      candidateZoneIds: ["nyc-417371", "nyc-425957"],
      place: { located: false, footprint: { garageId: DECK.id, containsPoint: false } },
    });
  });

  test("FR-54 GPS lost with no outline near: a garage with no name", async () => {
    const { app } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await park(app, OPEN_STREET, { placeHint: unlocated("garage", 0.6) });
    expect(res.json()).toMatchObject({
      action: "garage",
      rule: "place_garage",
      candidates: [],
      quote: null,
      place: { class: "garage", confidence: 0.6, garageId: null, garageName: null },
    });
  });

  test("FR-54 nothing to go on: asked, and never a street payment", async () => {
    const { app } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await park(app, OPEN_STREET, { placeHint: unlocated("unknown", 0) });
    expect(res.json()).toMatchObject({
      action: "unknown_zone",
      rule: "place_unknown",
      candidates: [],
      quote: null,
      place: { class: "unknown" },
    });
    // The driver's saved no-pay place, with a payable block at the entry
    // fix: the car may be on it.
    const home = await park(app, OPEN_STREET, {
      placeHint: hint("nopay", 0.95, { inputs: { located: false, memoryHit: true } }),
    });
    expect(home.json()).toMatchObject({ action: "unknown_zone", rule: "place_unknown" });
  });

  test("FR-54 no fix at the spot is never quoted a street, whatever the app can show", async () => {
    // No `outcomes`, so no new action: but the meters at the entry fix
    // are still not where the car is.
    const { app } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B], garages: GARAGES });
    const res = await post(
      app,
      parkedBody({ ...AT_DECK_ENTRANCE, placeHint: unlocated("garage", 0.9, DECK.id) }),
    );
    expect(res.json()).toMatchObject({
      action: "unknown_zone",
      rule: "unknown_zone",
      candidates: [],
      quote: null,
    });
  });
});

describe("FR-54 POST /parked/:id/place", () => {
  async function parkedAtTheDeck() {
    const t = makeTestApp({ candidates: [MOTT_A, MOTT_B], garages: GARAGES });
    const res = await park(t.app, DEEP_IN_DECK);
    expect(res.json().action).toBe("garage");
    return { ...t, parkedEventId: res.json().parkedEventId as string };
  }

  test("FR-54 a correction writes a place_confirmation decision with what was classified", async () => {
    const { app, state, parkedEventId } = await parkedAtTheDeck();
    const res = await placeAnswer(app, parkedEventId, { class: "street" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      parkedEventId,
      class: "street",
      name: null,
      was: { class: "garage", garageId: DECK.id },
      changed: true,
    });
    expect(state.decisions).toHaveLength(2);
    expect(res.json().decisionId).toBe("d2");
    expect(state.decisions[1]).toMatchObject({
      kind: "place_confirmation",
      rule: "place_corrected",
      userId: "u1",
      parkedEventId,
    });
    // The classifier's inputs ride along: this row is the training data.
    expect(state.decisions[1]!.inputs).toMatchObject({
      parkedEventId,
      class: "street",
      parkedDecisionId: "d1",
      classified: { class: "garage", garageId: DECK.id },
      classification: { zones: "disagree", footprint: { garageId: DECK.id } },
    });
    expect(state.decisions[1]!.outcome).toMatchObject({ class: "street", changed: true });
  });

  test("FR-54 agreeing with the classifier is a confirmation, and a name is kept", async () => {
    const { app, state, parkedEventId } = await parkedAtTheDeck();
    const res = await placeAnswer(app, parkedEventId, { class: "garage", name: "  Work  garage " });
    expect(res.json()).toMatchObject({ class: "garage", name: "Work garage", changed: false });
    expect(state.decisions[1]).toMatchObject({
      kind: "place_confirmation",
      rule: "place_confirmed",
    });
    expect(state.decisions[1]!.outcome).toMatchObject({ name: "Work garage" });
  });

  test("FR-54 'not here' is recorded as that, not as a class", async () => {
    const { app, state, parkedEventId } = await parkedAtTheDeck();
    const res = await placeAnswer(app, parkedEventId, { class: "not_here" });
    expect(res.json()).toMatchObject({ ok: true, class: "not_here", changed: true });
    expect(state.decisions[1]).toMatchObject({
      kind: "place_confirmation",
      rule: "place_not_here",
    });
  });

  test("FR-54 the same answer again is the same decision: idempotent per user", async () => {
    const { app, state, parkedEventId } = await parkedAtTheDeck();
    const first = await placeAnswer(app, parkedEventId, { class: "nopay" });
    const again = await placeAnswer(app, parkedEventId, { class: "nopay" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(state.decisions.filter((d) => d.kind === "place_confirmation")).toHaveLength(1);

    // A different answer is a new statement, and the last one stands.
    const changed = await placeAnswer(app, parkedEventId, { class: "lot" });
    expect(changed.json().decisionId).not.toBe(first.json().decisionId);
    expect(state.decisions.filter((d) => d.kind === "place_confirmation")).toHaveLength(2);
    const repeat = await placeAnswer(app, parkedEventId, { class: "lot" });
    expect(repeat.json().decisionId).toBe(changed.json().decisionId);
    expect(state.decisions.filter((d) => d.kind === "place_confirmation")).toHaveLength(2);
  });

  test("FR-54 nobody answers for someone else's park", async () => {
    const { app, state, parkedEventId } = await parkedAtTheDeck();
    const other = await placeAnswer(
      app,
      parkedEventId,
      { class: "nopay" },
      { "x-api-key": NONADMIN_API_KEY },
    );
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: "parked_event_not_found" });
    const missing = await placeAnswer(app, "pe-no-such-park", { class: "nopay" });
    expect(missing.statusCode).toBe(404);
    expect(state.decisions.filter((d) => d.kind === "place_confirmation")).toHaveLength(0);

    const noKey = await app.inject({
      method: "POST",
      url: `/parked/${parkedEventId}/place`,
      payload: { class: "nopay" },
    });
    expect(noKey.statusCode).toBe(401);
  });

  test.each([
    ["a class that isn't one", { class: "valet" }],
    ["unknown", { class: "unknown" }],
    ["no class", { name: "Home" }],
    ["a name that is a paragraph", { class: "garage", name: "x".repeat(81) }],
    ["a name that isn't text", { class: "garage", name: 7 }],
  ])("FR-54 %s is a 400 and writes nothing", async (_label, body) => {
    const { app, state, parkedEventId } = await parkedAtTheDeck();
    const res = await placeAnswer(app, parkedEventId, body);
    expect(res.statusCode).toBe(400);
    expect(state.decisions).toHaveLength(1);
  });

  test("FR-54 a park from before this build can still be answered", async () => {
    // Its decision has no classification to copy.
    const { app, state } = makeTestApp({ candidates: [], garages: GARAGES });
    state.parkedEvents.push({
      id: "pe-old",
      userId: "u1",
      lat: DEEP_IN_DECK.lat,
      lng: DEEP_IN_DECK.lng,
      accuracyM: 10,
      ts: new Date("2026-01-05T14:00:00-05:00"),
      signals: [],
    });
    const res = await placeAnswer(app, "pe-old", { class: "garage" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ class: "garage", was: null, changed: true });
  });
});
