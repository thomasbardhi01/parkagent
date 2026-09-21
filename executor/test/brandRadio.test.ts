/**
 * brandRadioPattern is the sole producer of unsupported_card_brand: an
 * unmapped Stripe brand fails every card setup with a typed error. Pin the
 * spellings Stripe actually sends (Issuing card `brand` is title-case:
 * "Visa", "Mastercard", "American Express", "Discover") and the form
 * labels each pattern must match.
 */

import { expect, test } from "vitest";

import { brandRadioPattern } from "../src/parknyc/selectors.js";

test.each([
  // [Stripe brand string, form label it must match]
  ["Visa", "Visa"],
  ["visa", "VISA"],
  ["Mastercard", "MasterCard"],
  ["mastercard", "Master Card"],
  ["American Express", "American Express"],
  ["amex", "AMEX"],
  ["American Express", "Amex"],
  ["Discover", "Discover"],
] as const)("brand %s matches form label %s", (brand, label) => {
  const pattern = brandRadioPattern(brand);
  expect(pattern).not.toBeNull();
  expect(pattern!.test(label)).toBe(true);
});

test.each(["", "JCB", "UnionPay", "Diners Club", "unknown"])(
  "unmapped brand %s is a typed refusal (null)",
  (brand) => {
    expect(brandRadioPattern(brand)).toBeNull();
  },
);

test("patterns don't cross-match other brands' labels", () => {
  expect(brandRadioPattern("Visa")!.test("MasterCard")).toBe(false);
  expect(brandRadioPattern("Mastercard")!.test("Visa")).toBe(false);
  expect(brandRadioPattern("Discover")!.test("American Express")).toBe(false);
});
