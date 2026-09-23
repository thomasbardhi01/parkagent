/**
 * The push-test samples: each of the five documented types builds the
 * matching push with the right `type` and a non-empty alert. Pure — no
 * network, no APNs.
 */

import { expect, test } from "vitest";

import { PUSH_TEST_TYPES, samplePush } from "../src/services/apns.js";

const NOW = new Date("2026-09-23T14:00:00-04:00");

test("samplePush covers exactly the five user-facing types with real alerts", () => {
  expect([...PUSH_TEST_TYPES]).toEqual([
    "session_started",
    "session_extended",
    "session_expiring",
    "payment_failed",
    "provider_relink",
  ]);
  for (const type of PUSH_TEST_TYPES) {
    const push = samplePush(type, NOW);
    expect(push.type).toBe(type);
    expect(push.title.length).toBeGreaterThan(0);
    expect(push.body.length).toBeGreaterThan(0);
  }
});

test("the expiring sample carries its reason and the failed sample a code", () => {
  expect(samplePush("session_expiring", NOW).extra).toMatchObject({ reason: "max_stay" });
  expect(samplePush("payment_failed", NOW).extra).toMatchObject({ code: "payment_declined" });
  expect(samplePush("provider_relink", NOW).extra).toMatchObject({ provider: "passport" });
});
