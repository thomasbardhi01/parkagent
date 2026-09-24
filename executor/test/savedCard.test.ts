/**
 * Saved-card row parsing (provider_card display info). Passport rows read
 * "<Name> (<last4>)" (VERIFIED live 2026-09-23); the ParkNYC shapes are
 * the drafted masked forms. Nothing here ever sees a full PAN.
 */

import { describe, expect, test } from "vitest";

import { parseSavedCardLabel } from "../src/savedCard.js";

describe("parseSavedCardLabel", () => {
  test.each([
    ["Visa (4242)", "Visa", "4242"],
    ["MasterCard (7788)", "Mastercard", "7788"],
    ["Visa •••• 4242", "Visa", "4242"],
    ["Amex ending in 1005", "American Express", "1005"],
    ["DISCOVER ****9424", "Discover", "9424"],
  ])("%s → brand + last4", (text, brand, last4) => {
    expect(parseSavedCardLabel(text)).toEqual({ brand, last4 });
  });

  test("a nicknamed card still yields the last4", () => {
    // Passport rows carry the user's own label, which may name no brand.
    expect(parseSavedCardLabel("Main card (4242)")).toEqual({ brand: null, last4: "4242" });
  });

  test("an expiry year is not mistaken for a last4", () => {
    expect(parseSavedCardLabel("Visa •••• 4242 exp 08/2030")).toEqual({
      brand: "Visa",
      last4: "4242",
    });
  });

  test("an unreadable row yields nulls rather than a guess", () => {
    expect(parseSavedCardLabel("Add Card")).toEqual({ brand: null, last4: null });
  });
});
