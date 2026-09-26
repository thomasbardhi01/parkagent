/**
 * GET /admin/summary — the field-test dashboard read. Seeds a day of
 * activity across both cities and checks the aggregation.
 */

import { expect, test } from "vitest";

import type { ApnsSendReport } from "../src/services/apns.js";
import { CircuitBreaker } from "../src/services/circuitBreaker.js";
import { ExecutorGate } from "../src/services/executorGate.js";
import {
  API_KEY,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
  seedSession,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NONADMIN = { "x-api-key": NONADMIN_API_KEY, "content-type": "application/json" };

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
    {
      kind: "extend_tick",
      inputs: {},
      rule: "extend",
      outcome: { action: "extend" },
      sessionId: "seed1",
    },
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

test("reports provider stage timings, timeouts, retries, breaker trips, the gate, and dead letters", async () => {
  const { app, state, deps } = makeTestApp({});
  const at = new Date(MONDAY_2PM);
  const job = (id: string, over: Partial<(typeof state.linkJobs)[number]>) => ({
    id,
    userId: "u1",
    provider: "passport",
    phase: "done",
    reason: null,
    retrySafe: null,
    dryRun: null,
    createdAt: at,
    stateSealed: null,
    setUpCard: false,
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    lockedUntil: null,
    startedAt: at,
    finishedAt: at,
    deadAt: null,
    lastError: null,
    queuePosition: null,
    stages: {},
    notify: false,
    notifiedAt: null,
    ...over,
  });
  state.linkJobs.push(
    job("j1", { stages: { queueMs: 0, verifyMs: 6_000, cardMs: 3_000, totalMs: 9_500 } }),
    job("j2", { stages: { queueMs: 2_000, verifyMs: 12_000, totalMs: 16_000 }, attempts: 2 }),
    // Gave up after three timeouts: a dead letter (and one timeout).
    job("j3", { phase: "failed", reason: "timeout", attempts: 3, deadAt: at }),
  );
  seedSession(state, { status: "active", city: "bos" });
  state.decisions.push(
    {
      kind: "session_start",
      inputs: {},
      rule: "start_ok",
      outcome: { ok: true, executor: { queueMs: 500, runMs: 21_000, retries: 1, queuedBehind: 1 } },
      sessionId: "seed1",
    },
    { kind: "circuit_breaker", inputs: { provider: "passport" }, rule: "open", outcome: {} },
  );
  deps.executorRuntime = {
    gate: new ExecutorGate(2),
    breaker: new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 }),
    sessionQueueWaitMs: 45_000,
  };

  const res = await app.inject({ method: "GET", url: "/admin/summary", headers: HEADERS });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const passport = body.providers.passport;
  expect(passport.stages.verify).toEqual({ n: 2, p50Ms: 6_000, p95Ms: 12_000 });
  expect(passport.stages.link).toEqual({ n: 2, p50Ms: 9_500, p95Ms: 16_000 });
  expect(passport.stages.start).toEqual({ n: 1, p50Ms: 21_000, p95Ms: 21_000 });
  // Link attempts past the first (1 + 2) and the start's in-place retry.
  expect(passport.retries).toBe(4);
  expect(passport.timeouts).toBe(1);
  expect(passport.breakerTrips).toBe(1);
  expect(passport.breakerState).toBe("closed");
  expect(passport.links).toMatchObject({ started: 3, done: 2, failed: 1, deadLettered: 1 });
  expect(body.executor).toEqual({ capacity: 2, inUse: 0, queued: 0 });
  expect(body.deadLetters.linkJobs).toEqual([
    expect.objectContaining({ id: "j3", provider: "passport", reason: "timeout", attempts: 3 }),
  ]);
});

test("requires auth like everything else", async () => {
  const { app } = makeTestApp({});
  const res = await app.inject({ method: "GET", url: "/admin/summary" });
  expect(res.statusCode).toBe(401);
});

// --- POST /admin/push-test ---------------------------------------------------

/** A fake reporting delivery: records what it was asked to send and returns
 * a scripted APNs report per push. */
function fakeDelivery(report: (type: string) => ApnsSendReport) {
  const sent: { userId: string; type: string }[] = [];
  const fn = async (userId: string, push: { type: string }) => {
    sent.push({ userId, type: push.type });
    return report(push.type);
  };
  return { fn, sent };
}

test("push-test sends every type and reports the APNs status per device", async () => {
  const { fn, sent } = fakeDelivery(() => ({
    configured: true,
    deviceCount: 1,
    results: [
      {
        tokenPrefix: "abcd1234",
        environment: "development",
        status: 200,
        reason: null,
        deleted: false,
      },
    ],
  }));
  const { app } = makeTestApp({ apnsDelivery: fn });
  const res = await app.inject({
    method: "POST",
    url: "/admin/push-test",
    headers: HEADERS,
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    anyDevices: boolean;
    allAccepted: boolean;
    sent: { type: string; results: { status: number }[] }[];
  };
  // All five documented push types, each delivered and 200.
  expect(body.sent.map((s) => s.type)).toEqual([
    "session_started",
    "session_extended",
    "session_expiring",
    "payment_failed",
    "provider_relink",
  ]);
  expect(body.anyDevices).toBe(true);
  expect(body.allAccepted).toBe(true);
  expect(sent).toHaveLength(5);
});

test("push-test can send a subset, and surfaces a non-200 as not-accepted", async () => {
  const { fn } = fakeDelivery((type) => ({
    configured: true,
    deviceCount: 1,
    results: [
      {
        tokenPrefix: "abcd1234",
        environment: "production",
        status: type === "payment_failed" ? 410 : 200,
        reason: type === "payment_failed" ? "Unregistered" : null,
        deleted: type === "payment_failed",
      },
    ],
  }));
  const { app } = makeTestApp({ apnsDelivery: fn });
  const res = await app.inject({
    method: "POST",
    url: "/admin/push-test",
    headers: HEADERS,
    payload: { types: ["session_started", "payment_failed"] },
  });
  const body = res.json() as {
    allAccepted: boolean;
    sent: { type: string; results: { status: number; reason: string | null }[] }[];
  };
  expect(body.sent.map((s) => s.type)).toEqual(["session_started", "payment_failed"]);
  expect(body.allAccepted).toBe(false);
  expect(body.sent[1]!.results[0]!.reason).toBe("Unregistered");
});

test("push-test is admin-only and 503s without a delivery transport", async () => {
  // Non-admin key → 403.
  const withDelivery = makeTestApp({
    apnsDelivery: async () => ({ configured: true, deviceCount: 0, results: [] }),
  });
  const forbidden = await withDelivery.app.inject({
    method: "POST",
    url: "/admin/push-test",
    headers: NONADMIN,
    payload: {},
  });
  expect(forbidden.statusCode).toBe(403);

  // No transport wired → 503.
  const noApns = makeTestApp({});
  const unavailable = await noApns.app.inject({
    method: "POST",
    url: "/admin/push-test",
    headers: HEADERS,
    payload: {},
  });
  expect(unavailable.statusCode).toBe(503);
});
