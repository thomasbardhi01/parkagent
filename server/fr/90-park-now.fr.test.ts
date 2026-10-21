/**
 * FR-53, FR-54, and FR-55 — where the car parked and when its session
 * runs, against the live API in dry run.
 *
 * FR-53: the phone classifies the place it parked (street, garage, lot,
 * no-pay, or unknown) and sends that read as `placeHint` with /parked. The
 * classifier itself runs on the phone (iOS unit tests, trace replays, and
 * the field test); what the live API must do for an app that only sends
 * the hint is answer what it would without one.
 *
 * FR-54: for an app that lists the place outcomes it can show (`outcomes`),
 * /parked answers `garage` at a garage or paid lot and `nopay` where there
 * is nothing to pay, never silences a meter that would charge, and
 * `POST /parked/:id/place` records the driver's own answer.
 *
 * FR-55: a street park from an app that waits for the walk-away
 * (`outcomes` lists `walk_away`) starts nothing and asks nothing while the
 * phone is at the car; the phone leaving is what asks, with the server's
 * own quote; and the one way to pay it is its tap, POST /parked/:id/confirm,
 * which runs the start path once (refused here: a throwaway has no linked
 * parking account, so nothing can start).
 *
 * The garage case needs the target's garages loaded (`pnpm -C server
 * load:garages`, by hand per city) and skips itself until they are, like
 * FR-49's.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  BOS_GARAGE,
  easternHourWithin,
  easternWeekday,
  frFetch,
  gate,
  mostRecentEasternAt,
  NOWHERE,
  NYC_AUTOPAY,
  ownUser,
  parkedBody,
  userFetch,
} from "./client.js";

/** This file's own throwaway user (client.ts `ownUser`). */
const me = ownUser(import.meta.url);

const AFTERNOON = mostRecentEasternAt(14, 0);
/** No enforcement on Sunday: the fixture block is a free period then. */
const SUNDAY = easternWeekday(AFTERNOON) === "Sun";

/** What an app that shows the place outcomes lists (ParkedRequest.outcomes). */
const OUTCOMES = ["garage", "nopay"];

type Place = Record<string, unknown>;

/** What the app sends for a park it read as a garage (PlaceHint in APIModels.swift). */
const GARAGE_HINT = {
  class: "garage",
  confidence: 0.95,
  runnerUp: { class: "nopay", confidence: 0.3 },
  garageId: "fr-fixture-garage",
  entryFix: { lat: NYC_AUTOPAY.lat + 0.0002, lng: NYC_AUTOPAY.lng, accuracy: 9, ts: AFTERNOON },
  inputs: {
    located: true,
    memoryHit: false,
    footprintId: "fr-fixture-garage",
    containsPoint: true,
    nearestEntranceM: 8,
    gpsLoss: true,
    baroDeltaM: 6.5,
    crawl: true,
  },
};

/** One of the driver's saved places matched (PlaceMemory, two
 * confirmations): the phone sends the class and that a place matched,
 * never the place's name or where it is. */
function savedPlace(placeClass: string) {
  return {
    class: placeClass,
    confidence: 0.95,
    inputs: {
      located: true,
      memoryHit: true,
      containsPoint: false,
      gpsLoss: false,
      crawl: false,
    },
  };
}

/** Whether the target has garages loaded around the fixture garage. */
let garagesLoaded = false;

beforeAll(async () => {
  await gate();
  const res = await userFetch(
    me,
    "GET",
    `/garages/near?lat=${BOS_GARAGE.lat}&lng=${BOS_GARAGE.lng}&radius=250&limit=50`,
  );
  expect(res.status).toBe(200);
  garagesLoaded = (res.body["garages"] as unknown[]).length > 0;
});

describe("FR-53 place classification", () => {
  it("FR-53 from an app that lists no place outcomes, a placeHint changes nothing it acts on", async () => {
    const plain = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }),
    );
    expect(plain.status).toBe(200);
    const hinted = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: AFTERNOON, placeHint: GARAGE_HINT }),
    );
    expect(hinted.status).toBe(200);
    for (const key of ["action", "rule", "quote", "candidates", "needsZoneNumber", "dryRun"]) {
      expect(hinted.body[key], key).toEqual(plain.body[key]);
    }
    expect(["pay", "confirm", "ignore", "unknown_zone"]).toContain(hinted.body["action"]);
    expect(hinted.body["dryRun"]).toBe(true);
    // Its own park and decision, like any other.
    expect(typeof hinted.body["decisionId"]).toBe("string");
    expect(hinted.body["parkedEventId"]).not.toBe(plain.body["parkedEventId"]);
  });
});

describe("FR-54 place outcomes", () => {
  it("FR-54 a garage hint at a known garage answers garage, with the garage's name", async (ctx) => {
    if (!garagesLoaded) {
      ctx.skip();
      return;
    }
    const hint = { ...GARAGE_HINT, confidence: 0.9, runnerUp: undefined, entryFix: undefined };
    const res = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(BOS_GARAGE, { ts: AFTERNOON, outcomes: OUTCOMES, placeHint: hint }),
    );
    expect(res.status).toBe(200);
    expect(res.body["action"]).toBe("garage");
    expect(res.body["rule"]).toBe("place_garage");
    expect(res.body["dryRun"]).toBe(true);
    const place = res.body["place"] as Place;
    expect(place["class"]).toBe("garage");
    expect(String(place["garageName"])).toMatch(BOS_GARAGE.name);
    expect(place["garageId"]).toMatch(/^bos-/);
    expect(place["attribution"]).toMatch(/OpenStreetMap/);
    expect(typeof res.body["decisionId"]).toBe("string");

    // With no hint at all, the server's own footprints say the same.
    const own = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(BOS_GARAGE, { ts: AFTERNOON, outcomes: OUTCOMES }),
    );
    expect(own.body["action"]).toBe("garage");
    const ownPlace = own.body["place"] as Place;
    expect(ownPlace["garageId"]).toBe(place["garageId"]);
    expect(ownPlace["source"]).toBe("footprint");

    // And an app that lists no outcomes is never answered `garage`.
    const old = await userFetch(me, "POST", "/parked", parkedBody(BOS_GARAGE, { ts: AFTERNOON }));
    expect(["pay", "confirm", "ignore", "unknown_zone"]).toContain(old.body["action"]);
  });

  it("FR-54 a saved no-pay place with nothing metered in reach answers nopay, with no quote", async () => {
    const res = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NOWHERE, { outcomes: OUTCOMES, placeHint: savedPlace("nopay") }),
    );
    expect(res.status).toBe(200);
    expect(res.body["action"]).toBe("nopay");
    expect(res.body["rule"]).toBe("place_nopay");
    expect(res.body["quote"]).toBeNull();
    expect(res.body["candidates"]).toEqual([]);
    expect(res.body["provider"]).toBeNull();
    const place = res.body["place"] as Place;
    expect(place["class"]).toBe("nopay");
    expect(place["source"]).toBe("memory");
    // Silent for the driver, and still on the ledger.
    expect(typeof res.body["parkedEventId"]).toBe("string");
    expect(typeof res.body["decisionId"]).toBe("string");
  });

  it("FR-54 a no-pay hint never silences a meter that would charge", async () => {
    const street = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: AFTERNOON, outcomes: OUTCOMES }),
    );
    expect(street.status).toBe(200);
    const res = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, {
        ts: AFTERNOON,
        outcomes: OUTCOMES,
        placeHint: savedPlace("nopay"),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body["action"]).not.toBe("nopay");
    expect(res.body["action"]).not.toBe("pay");
    // Nothing the street answer offers is lost: the driver can still pay.
    expect((res.body["candidates"] as unknown[]).length).toBeGreaterThan(0);
    expect(res.body["candidates"]).toEqual(street.body["candidates"]);
    expect(res.body["quote"]).toEqual(street.body["quote"]);
    if (SUNDAY) {
      expect(res.body["action"]).toBe("ignore");
      expect(res.body["rule"]).toBe("free_period");
      return;
    }
    // On its own the block auto-pays; with the place in doubt it asks.
    expect(street.body["action"]).toBe("pay");
    expect(res.body["action"]).toBe("confirm");
    expect(res.body["rule"]).toBe("place_unknown");
  });

  it("FR-54 the driver's answer is one decision per answer, and only for their own park", async () => {
    const parked = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NOWHERE, { outcomes: OUTCOMES, placeHint: savedPlace("nopay") }),
    );
    expect(parked.status).toBe(200);
    const id = String(parked.body["parkedEventId"]);

    const first = await userFetch(me, "POST", `/parked/${id}/place`, { class: "nopay" });
    expect(first.status).toBe(200);
    expect(first.body["ok"]).toBe(true);
    expect(first.body["class"]).toBe("nopay");
    expect(first.body["changed"]).toBe(false);
    expect((first.body["was"] as Place)["class"]).toBe("nopay");
    expect(typeof first.body["decisionId"]).toBe("string");
    expect(first.body["decisionId"]).not.toBe(parked.body["decisionId"]);

    // The same answer again is the same decision.
    const again = await userFetch(me, "POST", `/parked/${id}/place`, { class: "nopay" });
    expect(again.status).toBe(200);
    expect(again.body["decisionId"]).toBe(first.body["decisionId"]);

    // A correction is a new one.
    const corrected = await userFetch(me, "POST", `/parked/${id}/place`, {
      class: "garage",
      name: "FR fixture garage",
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body["changed"]).toBe(true);
    expect(corrected.body["name"]).toBe("FR fixture garage");
    expect(corrected.body["decisionId"]).not.toBe(first.body["decisionId"]);

    // Someone else's park, and no park at all, are both 404; a class that
    // isn't one is a 400.
    const other = await frFetch("POST", `/parked/${id}/place`, { class: "street" });
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: "parked_event_not_found" });
    const missing = await userFetch(me, "POST", "/parked/fr-no-such-park/place", {
      class: "street",
    });
    expect(missing.status).toBe(404);
    const invalid = await userFetch(me, "POST", `/parked/${id}/place`, { class: "valet" });
    expect(invalid.status).toBe(400);
  });
});

describe("FR-55 street session lifecycle", () => {
  /** A phone fix `metersNorth` of the fixture block's car, taken now. */
  const fix = (metersNorth: number, extra: Record<string, unknown> = {}) => ({
    lat: NYC_AUTOPAY.lat + metersNorth / 111_320,
    lng: NYC_AUTOPAY.lng,
    accuracy: 8,
    ts: new Date().toISOString(),
    ...extra,
  });

  it("FR-55 a street park starts and asks nothing at the car; walk-away asks with the quote; only its tap reaches the start path", async () => {
    const parked = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: AFTERNOON, outcomes: [...OUTCOMES, "walk_away"] }),
    );
    expect(parked.status).toBe(200);
    expect(parked.body["dryRun"]).toBe(true);
    if (SUNDAY) {
      // Nothing to pay on the fixture block: nothing waits on a walk-away.
      expect(parked.body["action"]).toBe("ignore");
      expect(parked.body["awaitsWalkAway"]).toBeUndefined();
      return;
    }
    expect(parked.body["action"]).toBe("pay");
    expect(parked.body["awaitsWalkAway"]).toBe(true);
    const id = String(parked.body["parkedEventId"]);
    const zoneId = String((parked.body["candidates"] as { zoneId: string }[])[0]!.zoneId);

    // In the driver's seat: the park waits, and nothing is asked.
    const seat = await userFetch(me, "POST", "/location", fix(4));
    expect(seat.status).toBe(200);
    expect(seat.body["park"]).toEqual({ parkedEventId: id, status: "at_car" });
    expect(seat.body["prompt"]).toBeUndefined();
    expect(seat.body["sessionId"]).toBeUndefined();

    // The start route can't pay a waiting park, and nobody else can tap it.
    const direct = await userFetch(me, "POST", "/session/start", { parkedEventId: id, zoneId });
    expect(direct.status).toBe(409);
    expect(direct.body["error"]).toBe("park_awaits_walk_away");
    const other = await frFetch("POST", `/parked/${id}/confirm`, {});
    expect(other.status).toBe(404);

    // The phone leaves the car (the app's own report: on foot, 60 m out).
    const left = await userFetch(me, "POST", "/location", fix(60, { event: "left_car" }));
    expect(left.status).toBe(200);
    const park = left.body["park"] as { parkedEventId: string; status: string };
    expect(park.parkedEventId).toBe(id);
    if (park.status === "free") {
      // The quote is for a stay that starts now, and the meters aren't
      // charging now (the nightly runs before they do): nothing to ask,
      // and a park that is over is never paid from.
      expect(easternHourWithin(10, 17)).toBe(false);
      expect(left.body["prompt"]).toBeUndefined();
      const closed = await userFetch(me, "POST", `/parked/${id}/confirm`, {});
      expect(closed.status).toBe(409);
      expect(closed.body).toMatchObject({ error: "park_closed", status: "free" });
      return;
    }

    // Meter hours: asked once, with the server's quote. A throwaway has no
    // linked account, so the prompt says that instead of offering Pay.
    expect(park.status).toBe("prompted");
    const prompt = left.body["prompt"] as Record<string, unknown>;
    expect(prompt["parkedEventId"]).toBe(id);
    expect(prompt["kind"]).toBe("attention");
    expect(prompt["reason"]).toBe("provider_not_linked");
    expect(prompt["amountUsd"]).toBeGreaterThan(0);
    expect(prompt["dryRun"]).toBe(true);
    expect(typeof left.body["decisionId"]).toBe("string");
    const again = await userFetch(me, "POST", "/location", fix(90));
    expect(again.status).toBe(200);
    expect(again.body["prompt"]).toEqual(prompt);
    expect(again.body["decisionId"]).toBeUndefined();

    // The tap runs the start path, once, and it refuses: nothing started.
    const tap = await userFetch(me, "POST", `/parked/${id}/confirm`, {});
    expect(tap.status).toBe(409);
    expect(tap.body["error"]).toBe("provider_not_linked");
    expect(typeof tap.body["decisionId"]).toBe("string");
    const still = await userFetch(me, "POST", "/location", fix(120));
    expect(still.status).toBe(200);
    expect((still.body["park"] as { status: string }).status).toBe("prompted");
    expect(still.body["sessionId"]).toBeUndefined();

    // Not now: nothing paid, and the phone is told to stop reporting.
    const declined = await userFetch(me, "POST", `/parked/${id}/decline`, {});
    expect(declined.status).toBe(200);
    expect(declined.body["status"]).toBe("declined");
    const after = await userFetch(me, "POST", "/location", fix(150));
    expect(after.status).toBe(409);
    expect(after.body).toEqual({ error: "no_active_session" });
  });

  it("FR-55 an app that doesn't wait for the walk-away is answered as before", async () => {
    const res = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: AFTERNOON, outcomes: OUTCOMES }),
    );
    expect(res.status).toBe(200);
    expect(res.body["awaitsWalkAway"]).toBeUndefined();
    // No park waits, so a fix has nothing to attach to (the lifecycle
    // case above, whichever ran first, leaves none waiting).
    const fixed = await userFetch(me, "POST", "/location", fix(4));
    expect(fixed.status).toBe(409);
    expect(fixed.body).toEqual({ error: "no_active_session" });
  });
});
