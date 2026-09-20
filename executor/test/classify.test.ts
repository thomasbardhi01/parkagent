/**
 * Error classification unit tests. Pure functions only — no browser is
 * launched and ParkNYC is never touched (repo rule: tests never hit
 * ParkNYC). Inline snippets cover the taxonomy; recorded real pages live in
 * test/fixtures/pages/ and run through fixtures.test.ts.
 */

import { expect, test } from "vitest";

import { classifyFailure, classifyPageText, visibleTextFromHtml } from "../src/parknyc/classify.js";

test("transport errors classify as network regardless of page text", () => {
  for (const msg of [
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://parknyc.org/",
    "connect ECONNREFUSED 127.0.0.1:443",
    "page.goto: Navigation timeout of 15000 ms exceeded",
  ]) {
    expect(classifyFailure(new Error(msg), "Please sign in to continue")).toBe("network");
  }
});

test("sign-in wording on the page classifies as auth_expired", () => {
  const text = "Welcome back. Please sign in to your account. Forgot your password?";
  expect(classifyPageText(text)).toBe("auth_expired");
  expect(classifyFailure(new Error("locator.click: Timeout 15000ms exceeded"), text)).toBe(
    "auth_expired",
  );
});

test("zone rejection wording classifies as zone_not_found", () => {
  expect(classifyPageText("Zone number not found. Check the zone number and try again.")).toBe(
    "zone_not_found",
  );
  expect(classifyPageText("The zone you entered is invalid")).toBe("zone_not_found");
});

test("payment rejection wording classifies as payment_declined", () => {
  expect(classifyPageText("Your card was declined. Try a different payment method.")).toBe(
    "payment_declined",
  );
  expect(classifyPageText("Payment could not be processed")).toBe("payment_declined");
});

test("a 'Log out' header link is not mistaken for a sign-in screen", () => {
  expect(classifyPageText("Home  Sessions  Wallet  Log out  Zone 110436  2 hr max")).toBeNull();
});

test("a selector timeout with unremarkable page text is ui_changed", () => {
  const err = new Error("locator.click: Timeout 15000ms exceeded");
  err.name = "TimeoutError";
  expect(classifyFailure(err, "Some brand new screen we have never seen")).toBe("ui_changed");
});

test("anything else is unknown", () => {
  expect(classifyFailure(new Error("kaboom"), "ordinary page text")).toBe("unknown");
  expect(classifyFailure("string throw", null)).toBe("unknown");
});

test("visibleTextFromHtml strips markup, scripts, and entities", () => {
  const html = `<html><head><style>.x{color:red}</style><script>var declined = true;</script></head>
    <body><h1>Zone&nbsp;110436</h1><p>Rate: $5.00 &amp; up</p></body></html>`;
  const text = visibleTextFromHtml(html);
  expect(text).toBe("Zone 110436 Rate: $5.00 & up");
  // script content must not leak into classification
  expect(classifyPageText(text)).toBeNull();
});
