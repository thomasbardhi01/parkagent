/**
 * FR-53 and FR-54 — where the car parked, against the live API in dry run.
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
 * The garage case needs the target's garages loaded (`pnpm -C server
 * load:garages`, by hand per city) and skips itself until they are, like
 * FR-49's. This file is also where FR-55's live cases go.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  BOS_GARAGE,
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
