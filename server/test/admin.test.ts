/**
 * GET /admin/summary — the field-test dashboard read. Seeds a day of
 * activity across both cities and checks the aggregation.
 */

import { expect, test } from "vitest";

import { API_KEY, MONDAY_2PM, STEINWAY_A, makeTestApp, parkedBody, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

test("aggregates today's parks, sessions, declines, and detector signals per city", async () => {
  const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });

  // Two parks through the real route (one auto_pay, one with signals).
  await app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody({ signals: ["motion_stop", "audio_disconnect"] }),
  });
  await app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody({ signals: ["motion_stop", "location_settled"] }),
  });

  // Sessions seeded directly: one Boston active, one NYC failed.
  seedSession(state, { status: "stopped", city: "bos", amountUsd: 7.5, feeUsd: 0.35 });
  seedSession(state, { status: "failed", city: "nyc" });
  // An executor failure and an auto-extend, as the decisions the jobs write.
  state.decisions.push(
    {
      kind: "session_start",
      inputs: {},
      rule: "executor_failed",
      outcome: { code: "ui_changed" },
      sessionId: "seed2",
    },
    { kind: "extend_tick", inputs: {}, rule: "extend", outcome: { action: "extend" }, sessionId: "seed1" },
    { kind: "issuing_authorization", inputs: {}, rule: "declined_wrong_mcc", outcome: {} },
  );

  const res = await app.inject({ method: "GET", url: "/admin/summary", headers: HEADERS });
  expect(res.statusCode).toBe(200);
  const body = res.json();

  expect(body.dryRun).toBe(true);
  expect(body.detectorSignals).toMatchObject({
    motion_stop: 2,
    audio_disconnect: 1,
    location_settled: 1,
  });
  expect(body.cities.nyc).toMatchObject({ parks: 2, sessionsFailed: 1 });
  expect(body.cities.nyc.executorErrors).toMatchObject({ ui_changed: 1 });
  expect(body.cities.bos).toMatchObject({
    sessionsStarted: 1,
    extensionsAuto: 1,
    spendUsd: 7.85,
  });
  expect(body.cities.unknown.declines).toMatchObject({ declined_wrong_mcc: 1 });
  expect(new Date(body.since).getTime()).toBeLessThanOrEqual(new Date(MONDAY_2PM).getTime());
});

test("requires auth like everything else", async () => {
  const { app } = makeTestApp({});
  const res = await app.inject({ method: "GET", url: "/admin/summary" });
  expect(res.statusCode).toBe(401);
});
