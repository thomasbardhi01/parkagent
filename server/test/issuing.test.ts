/**
 * cardholderName: what issuing-setup sends Stripe as the Issuing cardholder
 * name. Stripe hard-rejects names over 24 chars, so truncation has to be
 * clean and the result never empty.
 */

import { expect, test } from "vitest";

import {
  FALLBACK_CARDHOLDER_NAME,
  STRIPE_CARDHOLDER_NAME_MAX,
  cardholderName,
} from "../src/services/issuing.js";

test("short names pass through untouched", () => {
  expect(cardholderName("Thomas")).toBe("Thomas");
  expect(cardholderName("Thomas Bardhi")).toBe("Thomas Bardhi");
});

test("whitespace is trimmed and collapsed", () => {
  expect(cardholderName("  Thomas   Bardhi  ")).toBe("Thomas Bardhi");
});

test("a rotated prod-style name over 24 chars truncates cleanly", () => {
  // 25 chars, no spaces: cut at the limit, no dangling separator.
  expect(cardholderName("thomas-rotated-2026-09-20")).toBe("thomas-rotated-2026-09-2");
});

test("truncation prefers a word boundary and drops dangling separators", () => {
  expect(cardholderName("Bartholomew Maximiliano Cardholder")).toBe("Bartholomew Maximiliano");
  expect(cardholderName("Bartholomew Maxim-., Xavierson")).toBe("Bartholomew Maxim");
});

test("never exceeds the Stripe limit", () => {
  for (const name of [
    "thomas-rotated-2026-09-20",
    "a".repeat(100),
    "one two three four five six seven",
    "x".repeat(23) + " " + "y".repeat(30),
  ]) {
    expect(cardholderName(name).length).toBeLessThanOrEqual(STRIPE_CARDHOLDER_NAME_MAX);
  }
});

test("empty or separator-only names fall back", () => {
  expect(cardholderName("")).toBe(FALLBACK_CARDHOLDER_NAME);
  expect(cardholderName("   ")).toBe(FALLBACK_CARDHOLDER_NAME);
});
