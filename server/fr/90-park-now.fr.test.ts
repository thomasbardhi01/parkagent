/**
 * FR-53 — the phone classifies the place it parked (street, garage, lot,
 * no-pay, or unknown) and sends that read as `placeHint` with /parked.
 * The classifier itself runs on the phone (iOS unit tests, trace replays,
 * and the field test); what the live API must do today is accept the hint
 * and answer exactly as it would without one, until #179 (FR-54) reads it.
 * This file is also where FR-54 and FR-55's live cases go.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  gate,
  mostRecentEasternAt,
  NYC_AUTOPAY,
  ownUser,
  parkedBody,
  userFetch,
} from "./client.js";

/** This file's own throwaway user (client.ts `ownUser`). */
const me = ownUser(import.meta.url);

const AFTERNOON = mostRecentEasternAt(14, 0);

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

beforeAll(async () => {
  await gate();
});

describe("FR-53 place classification", () => {
  it("FR-53 /parked accepts the phone's placeHint and answers as it does without one", async () => {
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
    expect(hinted.body["dryRun"]).toBe(true);
    // Its own park and decision, like any other.
    expect(typeof hinted.body["decisionId"]).toBe("string");
    expect(hinted.body["parkedEventId"]).not.toBe(plain.body["parkedEventId"]);
  });
});
