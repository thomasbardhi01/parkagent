/**
 * The Vehicles-chooser plumbing and observed zone terms.
 *
 * The Passport executor reads the chooser's Zone Information line
 * ("$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm") and returns it as providerTerms;
 * the server logs it on the decision, flags zone_terms_mismatch when it
 * disagrees with the dataset, and upserts zone_terms_observed — which
 * quoting then prefers over the dataset (Boston's data assumed a 2-hour
 * max everywhere; zone 456 is posted 5 hours). The session's vehicle
 * (plate + state) rides the executor protocol so the chooser's matching
 * button gets clicked; no match is a typed vehicle_missing that pushes
 * "Add your plate to ParkBoston".
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import type {
  Executor,
  ExecutorResult,
  ProviderZoneTerms,
  StartSessionArgs,
} from "../src/services/executor.js";
import {
  API_KEY,
  BOYLSTON_BOS,
  MONDAY_2PM,
  makeTestApp,
  parkedBody,
  seedProviderAccount,
  seedVehicle,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);

const HOURS_BOS = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];

// The Boylston block with its number already known (user-reported); the
// dataset says $3.75 flat and a 2-hour max.
const ZONE: ZoneTermsRow = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  street: "BOYLSTON ST",
  providerZoneNumber: "81234",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 120,
  hoursJson: HOURS_BOS,
};

/** What the chooser's Zone Information line said: same rate, FIVE hours. */
const CHOOSER_TERMS: ProviderZoneTerms = {
  rawText: "$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm",
  ratePerHourUsd: 3.75,
  maxStayMinutes: 300,
  hours: {
    startLabel: "8am",
    endLabel: "8pm",
    startMinutes: 480,
    endMinutes: 1200,
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    tz: null,
  },
  zoneNumber: "81234",
  zoneName: "North Boylston between Dartmouth and Clarendon",
};

/** An executor that records startSession args and answers `result`. */
function scriptedExecutor(result: ExecutorResult): {
  executor: Executor;
  starts: StartSessionArgs[];
} {
  const starts: StartSessionArgs[] = [];
  const unused = async (): Promise<ExecutorResult> => {
    throw new Error("not exercised here");
  };
  return {
    starts,
    executor: {
      startSession: async (args) => {
        starts.push(args);
        return result;
      },
      extendSession: unused,
      stopSession: unused,
    },
  };
}

function makeApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp({
    zones: [ZONE],
    now: () => NOW,
    seedLinkedProvider: false,
    ...options,
  });
  seedProviderAccount(t.state, { provider: "passport" });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 42.3495,
    lng: -71.0798,
    accuracyM: 8,
    ts: NOW,
    signals: ["motion_stop"],
  });
  return t;
}

function startBody(overrides: Record<string, unknown> = {}) {
  return { parkedEventId: "pe1", zoneId: ZONE.zoneId, ...overrides };
}

test("the session's vehicle rides the executor protocol and lands on the row", async () => {
  const { executor, starts } = scriptedExecutor({
    ok: true,
    providerSessionId: "PB-1",
    expiresAt: new Date(NOW.getTime() + 90 * 60_000),
    amountUsd: 5.98,
  });
  const t = makeApp({ executor });
  seedVehicle(t.state); // ABC123 (MA)

  const res = await t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: startBody(),
  });
  expect(res.statusCode).toBe(200);
  expect(starts[0]!.vehicle).toEqual({ plate: "ABC123", state: "MA" });
  expect(t.state.sessions[0]!.vehicleId).toBe("v1");
});

test("vehicle_missing fails the session and pushes 'Add your plate to ParkBoston'", async () => {
  const { executor } = scriptedExecutor({
    ok: false,
    code: "vehicle_missing",
    message: "ParkBoston has no saved vehicle matching ABC123 (MA); saved: none",
    providerTerms: CHOOSER_TERMS,
  });
  const t = makeApp({ executor });
  seedVehicle(t.state);

  const res = await t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: startBody(),
  });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toMatchObject({ error: "executor_failed", code: "vehicle_missing" });
  expect(t.state.sessions[0]!.status).toBe("failed");
  const push = t.pushes.at(-1)!.push;
  expect(push.title).toBe("Add your plate to ParkBoston");
  // Terms the provider showed before the flow stopped are still recorded.
  expect(t.state.zoneTermsObserved).toHaveLength(1);
  const decision = t.state.decisions.find((d) => d.rule === "executor_failed")!;
  expect(decision.outcome).toMatchObject({
    code: "vehicle_missing",
    providerTerms: CHOOSER_TERMS,
    zoneTermsMismatch: true, // dataset says 120 min, the chooser said 300
  });
});

test("providerTerms on a paid start land on the decision and in zone_terms_observed", async () => {
  const { executor } = scriptedExecutor({
    ok: true,
    providerSessionId: "PB-2",
    expiresAt: new Date(NOW.getTime() + 90 * 60_000),
    amountUsd: 5.98,
    providerTerms: CHOOSER_TERMS,
    zoneResolution: {
      mapZoneNumber: "81234",
      mapStreet: "North Boylston between Dartmouth and Clarendon",
      storedZoneNumber: "81234",
      expectedStreet: null,
      matched: true,
    },
  });
  const t = makeApp({ executor });
  seedVehicle(t.state);

  const res = await t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: startBody(),
  });
  expect(res.statusCode).toBe(200);
  const decision = t.state.decisions.find((d) => d.rule === "start_ok")!;
  expect(decision.outcome).toMatchObject({
    providerTerms: CHOOSER_TERMS,
    zoneTermsMismatch: true,
    zoneResolution: { matched: true },
  });
  expect(t.state.zoneTermsObserved[0]).toMatchObject({
    city: "bos",
    zoneNumber: "81234",
    ratePerHourUsd: 3.75,
    maxStayMinutes: 300,
    rawText: CHOOSER_TERMS.rawText,
    zoneId: ZONE.zoneId,
  });
});

test("session start prefers observed terms: a 3-hour stay clears the observed 5-hour max", async () => {
  const t = makeApp();
  seedVehicle(t.state);
  t.state.zoneTermsObserved.push({
    city: "bos",
    zoneNumber: "81234",
    ratePerHourUsd: 4.5,
    maxStayMinutes: 300,
    rawText: "$4.50 Hr|Max 5 Hr|M-Sat 8am-8pm",
    hoursJson: null,
    zoneId: ZONE.zoneId,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });

  // 180 min would trip the dataset's 120-minute max; the observed 300
  // allows it, and the observed $4.50 prices it: 3 h × $4.50 + $0.35 fee.
  const res = await t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: startBody({ minutes: 180 }),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().amountUsd).toBeCloseTo(13.85, 2);
  expect(t.state.sessions[0]).toMatchObject({ maxStayMinutes: 300, rateFirstHour: 4.5 });
  const decision = t.state.decisions.find((d) => d.rule === "start_ok")!;
  expect(decision.inputs).toMatchObject({
    observedTerms: { ratePerHourUsd: 4.5, maxStayMinutes: 300 },
  });
});

test("/parked quotes with observed terms and marks the candidate", async () => {
  const t = makeTestApp({
    candidates: [{ ...BOYLSTON_BOS, providerZoneNumber: "81234" }],
    now: () => NOW,
  });
  seedProviderAccount(t.state, { provider: "passport" });
  t.state.zoneTermsObserved.push({
    city: "bos",
    zoneNumber: "81234",
    ratePerHourUsd: 4.5,
    maxStayMinutes: 300,
    rawText: "$4.50 Hr|Max 5 Hr|M-Sat 8am-8pm",
    hoursJson: null,
    zoneId: BOYLSTON_BOS.zoneId,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });

  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody({ lat: 42.3495, lng: -71.0798 }),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.candidates[0]).toMatchObject({
    rateFirstHourUsd: 4.5,
    rateAdditionalHourUsd: 4.5,
    maxStayMinutes: 300,
    termsSource: "observed",
  });
  // 90 min (default stay) at the observed flat $4.50 + Boston's $0.35 fee.
  expect(body.quote.totalUsd).toBeCloseTo(7.1, 2);
});

test("/parked without an observed row keeps dataset terms unmarked", async () => {
  const t = makeTestApp({
    candidates: [{ ...BOYLSTON_BOS, providerZoneNumber: "81234" }],
    now: () => NOW,
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody({ lat: 42.3495, lng: -71.0798 }),
  });
  expect(res.statusCode).toBe(200);
  const candidate = res.json().candidates[0];
  expect(candidate.rateFirstHourUsd).toBe(3.75);
  expect(candidate.termsSource).toBeUndefined();
});
