/**
 * /admin/summary's provider section: p50/p95 per stage from link jobs and
 * session decisions, and the timeouts, retries, and breaker trips.
 */

import { expect, test } from "vitest";

import type { LinkJobRow } from "../src/db.js";
import { percentile, providerReliability } from "../src/services/providerMetrics.js";

function job(overrides: Partial<LinkJobRow>): LinkJobRow {
  return {
    id: "j",
    userId: "u1",
    provider: "passport",
    phase: "done",
    reason: null,
    retrySafe: null,
    dryRun: null,
    createdAt: new Date(),
    stateSealed: null,
    setUpCard: false,
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    lockedUntil: null,
    startedAt: null,
    finishedAt: new Date(),
    deadAt: null,
    lastError: null,
    queuePosition: null,
    stages: {},
    notify: false,
    notifiedAt: null,
    ...overrides,
  };
}

test("nearest-rank percentiles", () => {
  expect(percentile([], 50)).toBe(0);
  expect(percentile([10], 95)).toBe(10);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(percentile(hundred, 50)).toBe(50);
  expect(percentile(hundred, 95)).toBe(95);
});

test("stage timings, timeouts, retries, dead letters, and trips per provider", () => {
  const summary = providerReliability({
    linkJobs: [
      job({ stages: { queueMs: 100, verifyMs: 4_000, cardMs: 2_000, totalMs: 6_500 } }),
      job({ stages: { queueMs: 300, verifyMs: 8_000, cardMs: 3_000, totalMs: 12_000 } }),
      job({
        phase: "failed",
        reason: "timeout",
        attempts: 3,
        deadAt: new Date(),
        stages: { verifyMs: 45_000 },
      }),
      job({ provider: "parknyc", stages: { verifyMs: 2_000 } }),
    ],
    decisions: [
      {
        kind: "session_start",
        rule: "start_ok",
        inputs: {},
        outcome: {
          executor: { queueMs: 50, runMs: 20_000, retries: 1 },
          quote: { zoneId: "bos-x-1" },
        },
      },
      {
        kind: "session_start",
        rule: "executor_failed",
        inputs: {},
        outcome: {
          code: "busy",
          executor: { queueMs: 45_000, runMs: 0 },
          quote: { zoneId: "bos-x-1" },
        },
      },
      // Dry-run calls carry no executor meta and don't count.
      {
        kind: "session_start",
        rule: "start_ok",
        inputs: {},
        outcome: { quote: { zoneId: "bos-x-1" }, durationMs: 1 },
      },
      { kind: "circuit_breaker", rule: "open", inputs: { provider: "passport" }, outcome: {} },
      { kind: "circuit_breaker", rule: "closed", inputs: { provider: "passport" }, outcome: {} },
    ],
    sessionCity: new Map(),
    decisionSession: () => null,
    breakerState: (p) => (p === "passport" ? "half_open" : "closed"),
  });

  const passport = summary.passport!;
  expect(passport.stages.verify).toEqual({ n: 3, p50Ms: 8_000, p95Ms: 45_000 });
  expect(passport.stages.card).toEqual({ n: 2, p50Ms: 2_000, p95Ms: 3_000 });
  expect(passport.stages.link).toEqual({ n: 2, p50Ms: 6_500, p95Ms: 12_000 });
  expect(passport.stages.start).toEqual({ n: 2, p50Ms: 0, p95Ms: 20_000 });
  expect(passport.stages.queue!.n).toBe(4); // two link jobs + two real starts
  expect(passport.timeouts).toBe(2); // the dead link job + the busy start
  expect(passport.retries).toBe(3); // two link retries + one navigation retry
  expect(passport.breakerTrips).toBe(1);
  expect(passport.breakerState).toBe("half_open");
  expect(passport.links).toEqual({ started: 3, done: 2, failed: 1, retrying: 0, deadLettered: 1 });
  expect(summary.parknyc!.stages.verify!.n).toBe(1);
});
