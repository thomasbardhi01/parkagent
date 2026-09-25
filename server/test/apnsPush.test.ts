/**
 * The push-test samples: each of the five documented types builds the
 * matching push with the right `type` and a non-empty alert. Pure — no
 * network, no APNs.
 */

import { expect, test } from "vitest";

import { PUSH_TEST_TYPES, paymentFailedPush, samplePush } from "../src/services/apns.js";

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

// payment_failed may say "unpaid" only when the executor code can only
// happen before the provider charges; after the pay click it's "not
// confirmed", and an extend never talks about paying.
test("payment_failed copy: unpaid only when certain, extend says extended", () => {
  const push = (code: string, what: "pay" | "extend") =>
    paymentFailedPush({ zoneNumber: "456", what, code, providerName: "ParkBoston" });

  for (const code of ["payment_declined", "zone_not_found", "auth_expired"]) {
    expect(push(code, "pay")).toMatchObject({
      title: "Payment failed",
      body: "The meter for zone 456 is unpaid — pay in ParkBoston or at the meter.",
    });
    expect(push(code, "extend")).toMatchObject({
      title: "Extension failed",
      body: "Zone 456 wasn't extended. Extend in ParkAgent or ParkBoston before the meter runs out.",
    });
  }
  for (const code of ["ui_changed", "network", "browser_crashed", "unknown"]) {
    const pay = push(code, "pay");
    expect(pay.title).toBe("Payment not confirmed");
    expect(pay.body).toContain("so you don't pay twice");
    expect(pay.body).not.toContain("unpaid");
    expect(push(code, "extend").title).toBe("Extension not confirmed");
  }
  expect(push("payment_method_missing", "extend").body).toBe(
    "Zone 456 wasn't extended — ParkBoston has no card saved. Add one there, then extend in ParkAgent or ParkBoston.",
  );
  expect(push("vehicle_missing", "extend").body).toContain("wasn't extended");
  // The raw code never reaches the words a driver reads.
  for (const code of ["ui_changed", "payment_declined", "browser_crashed"]) {
    expect(push(code, "pay").body).not.toContain(code);
  }
});
