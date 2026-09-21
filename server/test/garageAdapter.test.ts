/**
 * The SpotHero deep-link adapter against fixture JSON: defensive parsing
 * (bad rows drop, never throw), the prefilled deep link, caching, budget
 * filtering, and the deep-link-only booking contract.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  extractResults,
  makeSpotHeroProvider,
  parseSpotHeroResult,
  spotheroDeepLink,
} from "../src/services/garage/spotheroDeepLink.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/spothero-search.json", import.meta.url)), "utf8"),
) as unknown;

const QUERY = {
  lat: 42.3495,
  lng: -71.0798,
  startsAt: "2026-01-05T15:00:00-05:00",
  endsAt: "2026-01-05T17:00:00-05:00",
};

function providerOver(body: unknown, now?: () => number) {
  let fetches = 0;
  const provider = makeSpotHeroProvider({
    fetcher: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => body };
    },
    ...(now ? { now } : {}),
  });
  return { provider, count: () => fetches };
}

describe("fixture parsing", () => {
  test("well-formed rows parse; malformed rows drop without throwing", () => {
    const results = extractResults(fixture);
    expect(results).toHaveLength(5);
    const parsed = results.map((r) => parseSpotHeroResult(r, QUERY));
    expect(parsed.filter((p) => p !== null)).toHaveLength(2);

    const deck = parsed[0]!;
    expect(deck).toMatchObject({
      id: "40167",
      name: "Underground Deck - 1 Test St",
      address: "1 Test St",
      priceUsd: 18,
      distanceM: 240,
      walkMinutes: 3,
      entryType: "self",
    });

    const valet = parsed[1]!;
    expect(valet).toMatchObject({ name: "Valet Plaza", priceUsd: 24, entryType: "valet" });
    expect(valet.distanceM).toBeGreaterThan(1000); // haversine fallback
    expect(valet.address).toBe("9 Center Plaza");
  });

  test("the deep link prefills location and window", () => {
    const link = spotheroDeepLink(QUERY);
    expect(link).toContain("https://spothero.com/search?");
    expect(link).toContain("latitude=42.3495");
    expect(link).toContain(encodeURIComponent("2026-01-05T15:00:00-05:00"));
  });

  test("unrecognized envelopes and junk bodies yield zero options, not a crash", async () => {
    for (const body of [null, 42, "html error page", { totally: "different" }]) {
      const { provider } = providerOver(body);
      expect(await provider.search(QUERY)).toEqual([]);
    }
  });
});

describe("provider behavior", () => {
  test("search caches for 10 minutes and expires after", async () => {
    let at = 0;
    const { provider, count } = providerOver(fixture, () => at);
    await provider.search(QUERY);
    await provider.search(QUERY);
    expect(count()).toBe(1);
    at = 11 * 60_000;
    await provider.search(QUERY);
    expect(count()).toBe(2);
  });

  test("budget filters without refetching; options carry the deep link", async () => {
    const { provider, count } = providerOver(fixture);
    const all = await provider.search(QUERY);
    expect(all).toHaveLength(2);
    expect(all[0]!.deepLink).toContain("spothero.com/search");
    const cheap = await provider.search({ ...QUERY, budgetUsd: 20 });
    expect(cheap).toHaveLength(1);
    expect(cheap[0]!.priceUsd).toBe(18);
    expect(count()).toBe(1);
  });

  test("book is a deep-link handoff for cached options and refuses unknown ids", async () => {
    const { provider } = providerOver(fixture);
    await provider.search(QUERY);
    const booking = await provider.book("40167");
    expect(booking.kind).toBe("deeplink_handoff");
    expect(booking.deepLink).toContain("spothero.com/search");
    expect(provider.canReserve).toBe(false);
    await expect(provider.book("nope")).rejects.toThrow("unknown garage option");
  });

  test("a failing endpoint degrades to no results", async () => {
    const provider = makeSpotHeroProvider({
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await provider.search(QUERY)).toEqual([]);
  });
});
