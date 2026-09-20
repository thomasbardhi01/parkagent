/**
 * Registry resolution per city: zone id → city → provider, and the cookie
 * domain filter each provider's link endpoint applies.
 */

import { expect, test } from "vitest";

import {
  cityForZone,
  cookieDomainAllowed,
  providerById,
  providerForCity,
} from "../src/providers/registry.js";

test("nyc zones resolve to ParkNYC", () => {
  expect(cityForZone("nyc-110436")).toBe("nyc");
  const provider = providerForCity("nyc");
  expect(provider).toMatchObject({ id: "parknyc", displayName: "ParkNYC" });
});

test("bos zones resolve to ParkBoston (Passport)", () => {
  expect(cityForZone("bos-boylston-st-e-d-819305")).toBe("bos");
  const provider = providerForCity("bos");
  expect(provider).toMatchObject({ id: "passport", city: "bos", displayName: "ParkBoston" });
  // The verified Passport web app for Boston — not the marketing site, not
  // the unbranded multi-city entry.
  expect(provider!.loginUrl).toContain("bostonma.ppprk.com");
});

test("unknown cities and unprefixed ids have no provider", () => {
  expect(cityForZone("garbage")).toBeNull();
  expect(providerForCity("atlantis")).toBeNull();
  expect(providerForCity(null)).toBeNull();
});

test("passport cookie filter: ppprk.com and paywithpassport.com survive, rest drop", () => {
  const passport = providerById("passport")!;
  expect(cookieDomainAllowed(passport, ".bostonma.ppprk.com")).toBe(true);
  expect(cookieDomainAllowed(passport, "bostonma.ppprk.com")).toBe(true);
  expect(cookieDomainAllowed(passport, "parkboston.paywithpassport.com")).toBe(true);
  expect(cookieDomainAllowed(passport, "nyc.flowbirdapp.com")).toBe(false);
  expect(cookieDomainAllowed(passport, "evil.com")).toBe(false);
  // Suffix matching must not accept lookalike registrable domains.
  expect(cookieDomainAllowed(passport, "notppprk.com")).toBe(false);
});
