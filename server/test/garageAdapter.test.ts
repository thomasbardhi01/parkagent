/**
 * The SpotHero deep-link adapter against the LIVE transient-search shape
 * (fixture recorded 2026-09-21 from the Seaport probe that exposed the
 * prod bug): typed outcomes — error is never "no results" — defensive
 * parsing, the prefilled deep link, caching, budget filtering, and the
 * deep-link-only booking contract.
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
  readFileSync(
    fileURLToPath(new URL("./fixtures/spothero-transient-search.json", import.meta.url)),
    "utf8",
  ),
) as unknown;

/** The prod request: Seaport, 6–10 tonight. */
const QUERY = {
  lat: 42.3503,
  lng: -71.04,
  startsAt: "2026-09-21T18:00:00",
  endsAt: "2026-09-21T22:00:00",
};

function providerOver(
  responses: { ok: boolean; status: number; body?: unknown; throws?: boolean }[],
  now?: () => number,
) {
  let call = 0;
  const urls: string[] = [];
  const provider = makeSpotHeroProvider({
    fetcher: async (url) => {
      urls.push(url);
      const r = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      if (r.throws) throw new Error("ECONNREFUSED");
      return { ok: r.ok, status: r.status, json: async () => r.body };
    },
    ...(now ? { now } : {}),
  });
  return { provider, urls, count: () => call };
}

describe("live transient-search shape (Seaport fixture)", () => {
  test("the endpoint and params are the verified live ones", async () => {
    const { provider, urls } = providerOver([{ ok: true, status: 200, body: fixture }]);
    await provider.search(QUERY);
    expect(urls[0]).toContain("https://api.spothero.com/v2/search/transient?");
    // lat/lon, not latitude/longitude — the rename that broke prod.
    expect(urls[0]).toContain("lat=42.3503");
    expect(urls[0]).toContain("lon=-71.04");
  });

  test("well-formed rows parse (nested facility.common, cents quote, linear_meters); malformed rows drop", () => {
    const rows = extractResults(fixture)!;
    expect(rows).toHaveLength(5);
    const parsed = rows.map((r) => parseSpotHeroResult(r, QUERY));
    expect(parsed.filter((p) => p !== null)).toHaveLength(2);

    expect(parsed[0]).toMatchObject({
      id: "10607",
      name: "South Boston Waterfront Transportation Center Garage - 503 Congress Street",
      address: "503 Congress Street",
      priceUsd: 27.13,
      distanceM: 240,
      walkMinutes: 3,
      entryType: "self",
    });
    expect(parsed[1]).toMatchObject({
      name: "601 D St. (1 Seaport Ln.) - Seaport Hotel Garage",
      priceUsd: 30.74,
    });
  });

  test("the prod query yields a $27.13 option under the $30 budget — 'none available' was false", async () => {
    const { provider } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const outcome = await provider.search({ ...QUERY, budgetUsd: 30 });
    expect(outcome).toMatchObject({ ok: true, fromCache: false });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.options).toHaveLength(1);
    expect(outcome.options[0]!.priceUsd).toBe(27.13);
    // Facility checkout with the window prefilled (verified live
    // 2026-09-23) — not the area search page.
    expect(outcome.options[0]!.deepLink).toContain("spothero.com/checkout/10607");
    expect(outcome.options[0]!.deepLink).toContain(encodeURIComponent("2026-09-21T18:00:00"));
  });

  test("the deep link prefills location and window", () => {
    const link = spotheroDeepLink(QUERY);
    expect(link).toContain("latitude=42.3503");
    expect(link).toContain(encodeURIComponent("2026-09-21T18:00:00"));
  });
});

describe("error vs empty — never the same fact", () => {
  test("HTTP 404 (the endpoint moving, as in prod) is parse_failed, not an empty result", async () => {
    const { provider } = providerOver([{ ok: false, status: 404, body: "page not found" }]);
    const outcome = await provider.search(QUERY);
    expect(outcome).toEqual({ ok: false, error: "parse_failed", detail: "HTTP 404" });
  });

  test("403 and 429 are blocked; a thrown fetch is network", async () => {
    for (const status of [403, 429]) {
      const { provider } = providerOver([{ ok: false, status }]);
      expect(await provider.search(QUERY)).toMatchObject({ ok: false, error: "blocked" });
    }
    const { provider } = providerOver([{ ok: true, status: 200, throws: true }]);
    expect(await provider.search(QUERY)).toMatchObject({ ok: false, error: "network" });
  });

  test("a 200 with an unrecognizable envelope, or rows that all fail to parse, is parse_failed", async () => {
    const junk = providerOver([{ ok: true, status: 200, body: { totally: "different" } }]);
    expect(await junk.provider.search(QUERY)).toMatchObject({ ok: false, error: "parse_failed" });

    const unreadable = providerOver([
      { ok: true, status: 200, body: { results: [{ new: "shape" }, { also: "new" }] } },
    ]);
    expect(await unreadable.provider.search(QUERY)).toMatchObject({
      ok: false,
      error: "parse_failed",
      detail: "0 of 2 rows parseable",
    });
  });

  test("a genuinely empty results list IS ok — that's 'none found'", async () => {
    const { provider } = providerOver([{ ok: true, status: 200, body: { results: [] } }]);
    expect(await provider.search(QUERY)).toEqual({ ok: true, options: [], fromCache: false });
  });

  test("errors are never cached: the next call retries; good results are cached", async () => {
    let at = 0;
    const { provider, count } = providerOver(
      [
        { ok: false, status: 404 },
        { ok: true, status: 200, body: fixture },
      ],
      () => at,
    );
    expect(await provider.search(QUERY)).toMatchObject({ ok: false });
    const second = await provider.search(QUERY);
    expect(second).toMatchObject({ ok: true, fromCache: false });
    expect(count()).toBe(2);
    // Now cached.
    at = 60_000;
    expect(await provider.search(QUERY)).toMatchObject({ ok: true, fromCache: true });
    expect(count()).toBe(2);
  });
});

describe("provider behavior", () => {
  test("budget filters from cache without refetching", async () => {
    const { provider, count } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const all = await provider.search(QUERY);
    if (!all.ok) throw new Error("unreachable");
    expect(all.options).toHaveLength(2);
    const cheap = await provider.search({ ...QUERY, budgetUsd: 30 });
    if (!cheap.ok) throw new Error("unreachable");
    expect(cheap.options).toHaveLength(1);
    expect(count()).toBe(1);
  });

  test("book is a deep-link handoff for cached options and refuses unknown ids", async () => {
    const { provider } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const searched = await provider.search(QUERY);
    if (!searched.ok) throw new Error("unreachable");
    const booking = await provider.book(searched.options[0]!.id);
    expect(booking.kind).toBe("deeplink_handoff");
    expect(booking.deepLink).toContain("spothero.com/checkout/10607");
    expect(provider.canReserve).toBe(false);
    // A bare facility id is not an option id — options are per window.
    await expect(provider.book("10607")).rejects.toThrow("unknown garage option");
    await expect(provider.book("nope")).rejects.toThrow("unknown garage option");
  });

  test("the same facility for two windows is two offers — each id books its own window", async () => {
    // "make it 5 instead": the facility-only id let the cache hand back
    // the FIRST window's checkout link for the second window's card.
    const { provider } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const six = await provider.search(QUERY);
    const later = { ...QUERY, startsAt: "2026-09-21T19:00:00", endsAt: "2026-09-21T23:00:00" };
    const seven = await provider.search(later);
    if (!six.ok || !seven.ok) throw new Error("unreachable");
    const sixId = six.options[0]!.id;
    const sevenId = seven.options[0]!.id;
    expect(sixId).not.toBe(sevenId);
    expect(sixId).toMatch(/^spothero-10607-/);
    expect((await provider.book(sevenId)).deepLink).toContain(
      encodeURIComponent("2026-09-21T19:00:00"),
    );
    expect((await provider.book(sixId)).deepLink).toContain(
      encodeURIComponent("2026-09-21T18:00:00"),
    );
    expect(provider.optionById(sevenId)?.deepLink).toContain(
      encodeURIComponent("2026-09-21T23:00:00"),
    );
  });

  test("windows go to SpotHero as NYC wall-clock time, whatever offset they came with", async () => {
    // Verified live 2026-09-24: SpotHero reads the digits and drops the
    // offset, so 22:00Z (6 PM ET) rendered a 10 PM checkout.
    const { provider, urls } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const utc = await provider.search({
      ...QUERY,
      startsAt: "2026-09-21T22:00:00.000Z",
      endsAt: "2026-09-22T02:00:00.000Z",
    });
    if (!utc.ok) throw new Error("unreachable");
    const search = new URL(urls[0]!);
    expect(search.searchParams.get("starts")).toBe("2026-09-21T18:00:00");
    expect(search.searchParams.get("ends")).toBe("2026-09-21T22:00:00");
    const link = new URL(utc.options[0]!.deepLink);
    expect(link.searchParams.get("starts")).toBe("2026-09-21T18:00:00");
    expect(link.searchParams.get("ends")).toBe("2026-09-21T22:00:00");
  });
});
