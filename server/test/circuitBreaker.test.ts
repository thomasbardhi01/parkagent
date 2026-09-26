/**
 * The per-provider circuit breaker: repeated provider-side failures open
 * it; one user's own problems don't; a trial call after the cooldown
 * decides whether it closes; every change is reported.
 */

import { expect, test } from "vitest";

import { CircuitBreaker, verdictFor } from "../src/services/circuitBreaker.js";
import type { BreakerTransition } from "../src/services/circuitBreaker.js";

function breaker() {
  let now = 0;
  const transitions: BreakerTransition[] = [];
  const b = new CircuitBreaker({
    threshold: 3,
    cooldownMs: 60_000,
    now: () => now,
    onTransition: (t) => transitions.push(t),
  });
  return { b, transitions, advance: (ms: number) => (now += ms) };
}

test("three provider failures in a row open it; calls then fail fast", () => {
  const { b, transitions } = breaker();
  for (let i = 0; i < 3; i += 1) {
    expect(b.admit("passport").ok).toBe(true);
    b.record("passport", "provider_failure", "timeout");
  }
  expect(b.state("passport")).toBe("open");
  expect(b.admit("passport")).toMatchObject({ ok: false });
  expect(transitions).toEqual([
    expect.objectContaining({
      provider: "passport",
      from: "closed",
      to: "open",
      consecutiveFailures: 3,
      lastCode: "timeout",
    }),
  ]);
  // Per provider: ParkNYC is unaffected.
  expect(b.admit("parknyc").ok).toBe(true);
});

test("one user's own problems neither count nor reset the run", () => {
  const { b } = breaker();
  b.record("passport", "provider_failure", "network");
  b.record("passport", "provider_failure", "network");
  for (const code of [
    "auth_expired",
    "payment_declined",
    "zone_not_found",
    "parking_denied",
    "busy",
  ]) {
    b.record("passport", verdictFor(false, code), code);
  }
  expect(b.state("passport")).toBe("closed");
  b.record("passport", "provider_failure", "network");
  expect(b.state("passport")).toBe("open");
});

test("a success resets the count", () => {
  const { b } = breaker();
  b.record("passport", "provider_failure", "network");
  b.record("passport", "provider_failure", "network");
  b.record("passport", "success");
  b.record("passport", "provider_failure", "network");
  expect(b.state("passport")).toBe("closed");
});

test("after the cooldown one trial runs; its success closes, its failure waits twice as long", () => {
  const { b, advance } = breaker();
  for (let i = 0; i < 3; i += 1) b.record("passport", "provider_failure", "timeout");
  advance(60_000);
  expect(b.admit("passport")).toEqual({ ok: true, trial: true });
  // Only one trial at a time.
  expect(b.admit("passport").ok).toBe(false);
  b.record("passport", "provider_failure", "timeout", true);
  expect(b.state("passport")).toBe("open");
  advance(60_000);
  expect(b.admit("passport").ok).toBe(false); // 120 s now
  advance(60_000);
  expect(b.admit("passport")).toEqual({ ok: true, trial: true });
  b.record("passport", "success", null, true);
  expect(b.state("passport")).toBe("closed");
  expect(b.trips("passport")).toBe(2);
});

test("what counts as the provider's fault", () => {
  expect(verdictFor(true)).toBe("success");
  for (const code of ["network", "timeout", "ui_changed", "unknown"]) {
    expect(verdictFor(false, code)).toBe("provider_failure");
  }
  for (const code of [
    "auth_expired",
    "vehicle_missing",
    "free_period",
    "browser_crashed",
    "provider_unavailable",
  ]) {
    expect(verdictFor(false, code)).toBe("neutral");
  }
});

test("a slow call admitted before the trip can't end the trial or double the cooldown", () => {
  const { b, advance } = breaker();
  // Admitted while closed; still running when the breaker trips.
  const slow = b.admit("passport");
  expect(slow).toEqual({ ok: true, trial: false });
  for (let i = 0; i < 3; i += 1) b.record("passport", "provider_failure", "timeout");
  advance(60_000);
  expect(b.admit("passport")).toEqual({ ok: true, trial: true });

  // The old call fails now, mid-trial: counted, but the trial stands.
  b.record("passport", "provider_failure", "timeout", false);
  expect(b.state("passport")).toBe("half_open");
  expect(b.admit("passport").ok).toBe(false); // still one trial in flight

  // The trial's own success closes it at the base cooldown.
  b.record("passport", "success", null, true);
  expect(b.state("passport")).toBe("closed");
  expect(b.trips("passport")).toBe(1);
});
