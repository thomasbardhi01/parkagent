/**
 * The ParkWhiz read-only adapter against the LIVE quotes shape (fixture
 * recorded 2026-09-23 from a Seaport probe of the public, unauthenticated
 * /v4/quotes endpoint — rows trimmed to the fields we read), plus the
 * multi-provider merge: dedupe by facility address, cheaper listing wins,
 * and a failed provider degrades the search honestly instead of narrowing
 * it silently.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { makeMultiGarageProvider, normalizeAddress } from "../src/services/garage/multiProvider.js";
import { makeParkWhizProvider, parseParkWhizQuote } from "../src/services/garage/parkwhiz.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/parkwhiz-quotes-live.json", import.meta.url)),
    "utf8",
  ),
) as unknown[];

/** The recorded probe: Seaport, 6–10 the next evening. */
const QUERY = {
  lat: 42.3503,
  lng: -71.04,
  startsAt: "2026-09-24T18:00",
  endsAt: "2026-09-24T22:00",
};

function providerOver(
  responses: { ok: boolean; status: number; body?: unknown; throws?: boolean }[],
  now?: () => number,
) {
  let call = 0;
  const requests: { url: string; init?: { headers?: Record<string, string> } }[] = [];
  const provider = makeParkWhizProvider({
    fetcher: async (url, init) => {
      requests.push({ url, ...(init ? { init } : {}) });
      const r = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      if (r.throws) throw new Error("ECONNREFUSED");
      return { ok: r.ok, status: r.status, json: async () => r.body };
    },
    ...(now ? { now } : {}),
  });
  return { provider, requests, count: () => call };
}

describe("live quotes shape", () => {
  test("a full row parses: price.USD dollars (fees in), straight_line meters, entrance coords", () => {
    const parsed = parseParkWhizQuote(fixture[0], QUERY);
    expect(parsed).toMatchObject({
      id: "61989",
      provider: "parkwhiz",
      name: "Commonwealth Pier Garage",
      address: "1 Seaport Ln., Boston",
      priceUsd: 33.93,
      distanceM: 177,
      walkMinutes: 2,
      entryType: "unknown",
    });
    expect(parsed!.lat).toBeCloseTo(42.34993, 4);
    expect(parsed!.lng).toBeCloseTo(-71.04209, 4);
  });

  test("the deep link is the API's own site:purchase href — facility page, window prefilled", () => {
    const parsed = parseParkWhizQuote(fixture[0], QUERY)!;
    expect(parsed.deepLink).toBe(
      "https://www.parkwhiz.com/find_and_book/?location_id=61989&start_time=2026-09-24T18:00&end_time=2026-09-24T22:00",
    );
  });

  test("a row without _links still gets a hand-built find_and_book link", () => {
    const row = JSON.parse(JSON.stringify(fixture[1])) as {
      purchase_options: Record<string, unknown>[];
    };
    delete row.purchase_options[0]!["_links"];
    const parsed = parseParkWhizQuote(row, QUERY)!;
    expect(parsed.deepLink).toContain("https://www.parkwhiz.com/find_and_book/?location_id=11476");
    expect(parsed.deepLink).toContain(encodeURIComponent("2026-09-24T18:00"));
  });

  test("rows without purchase options or a location drop to null, never throw", () => {
    expect(parseParkWhizQuote(fixture[3], QUERY)).toBeNull(); // empty purchase_options
    expect(
      parseParkWhizQuote({ purchase_options: [{ price: { USD: "9.00" } }] }, QUERY),
    ).toBeNull();
    expect(parseParkWhizQuote(null, QUERY)).toBeNull();
    expect(parseParkWhizQuote("junk", QUERY)).toBeNull();
  });
});

describe("public read-only client behavior", () => {
  test("queries the public endpoint with honest headers and no auth", async () => {
    const { provider, requests } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const outcome = await provider.search(QUERY);
    expect(outcome).toMatchObject({ ok: true, fromCache: false });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.options).toHaveLength(3); // the malformed 4th row drops

    expect(requests[0]!.url).toContain("https://api.parkwhiz.com/v4/quotes/?");
    expect(requests[0]!.url).toContain(encodeURIComponent("coordinates:42.3503,-71.04"));
    expect(requests[0]!.init?.headers?.["Authorization"]).toBeUndefined();
    expect(requests[0]!.init?.headers?.["User-Agent"]).toBe("parkagent-prototype/1.0");
  });

  test("401/403/429 are blocked (their call, our stop); junk is parse_failed; thrown fetch is network", async () => {
    for (const status of [401, 403, 429]) {
      const { provider } = providerOver([{ ok: false, status }]);
      expect(await provider.search(QUERY)).toMatchObject({ ok: false, error: "blocked" });
    }
    const junk = providerOver([{ ok: true, status: 200, body: { not: "an array" } }]);
    expect(await junk.provider.search(QUERY)).toMatchObject({ ok: false, error: "parse_failed" });
    const unreadable = providerOver([
      { ok: true, status: 200, body: [{ new: "shape" }, { also: "new" }] },
    ]);
    expect(await unreadable.provider.search(QUERY)).toMatchObject({
      ok: false,
      error: "parse_failed",
      detail: "0 of 2 quotes parseable",
    });
    const dead = providerOver([{ ok: true, status: 200, throws: true }]);
    expect(await dead.provider.search(QUERY)).toMatchObject({ ok: false, error: "network" });
  });

  test("errors are never cached; good results are, and budget filters from cache", async () => {
    let at = 0;
    const { provider, count } = providerOver(
      [
        { ok: false, status: 500 },
        { ok: true, status: 200, body: fixture },
      ],
      () => at,
    );
    expect(await provider.search(QUERY)).toMatchObject({ ok: false });
    expect(await provider.search(QUERY)).toMatchObject({ ok: true, fromCache: false });
    at = 60_000;
    const cached = await provider.search({ ...QUERY, budgetUsd: 33 });
    expect(cached).toMatchObject({ ok: true, fromCache: true });
    if (!cached.ok) throw new Error("unreachable");
    expect(cached.options).toHaveLength(1); // $32.10 valet under the $33 cap
    expect(count()).toBe(2);
  });

  test("book is a deep-link handoff, canReserve false — same contract as SpotHero", async () => {
    const { provider } = providerOver([{ ok: true, status: 200, body: fixture }]);
    const searched = await provider.search(QUERY);
    if (!searched.ok) throw new Error("unreachable");
    expect(provider.canReserve).toBe(false);
    const option = searched.options.find((o) => o.id.startsWith("parkwhiz-61989-"))!;
    expect(option).toBeDefined();
    const booking = await provider.book(option.id);
    expect(booking.kind).toBe("deeplink_handoff");
    expect(booking.deepLink).toContain("parkwhiz.com/find_and_book");
    // Location ids share SpotHero's numeric space; only the scoped id books.
    await expect(provider.book("61989")).rejects.toThrow("unknown garage option");
    await expect(provider.book("nope")).rejects.toThrow("unknown garage option");
  });
});

function fakeProvider(id: string, options: GarageOption[], fail = false): GarageProvider {
  return {
    id,
    canReserve: false,
    search: async () =>
      fail
        ? { ok: false, error: "network", detail: "down" }
        : { ok: true, options, fromCache: false },
    optionById: (optionId) => options.find((o) => o.id === optionId) ?? null,
    book: async (optionId) => {
      const option = options.find((o) => o.id === optionId);
      if (!option) throw new Error("unknown");
      return { kind: "deeplink_handoff", option, deepLink: option.deepLink };
    },
  };
}

function option(partial: Partial<GarageOption> & { id: string; provider: string }): GarageOption {
  return {
    name: "Garage",
    address: "1 Test St",
    priceUsd: 20,
    distanceM: 100,
    walkMinutes: 2,
    entryType: "self",
    deepLink: `https://example.com/${partial.id}`,
    ...partial,
  };
}

describe("multi-provider merge and dedupe", () => {
  test("normalizeAddress matches provider spellings of the same facility", () => {
    expect(normalizeAddress("503 Congress Street, Boston")).toBe(
      normalizeAddress("503 Congress St."),
    );
    expect(normalizeAddress("120 N. LaSalle Avenue")).toBe(
      normalizeAddress("120 north lasalle ave"),
    );
    expect(normalizeAddress("10 Main St")).not.toBe(normalizeAddress("11 Main St"));
  });

  test("the same address from two providers collapses to the cheaper listing", async () => {
    const spothero = fakeProvider("spothero", [
      option({ id: "s1", provider: "spothero", address: "1 Seaport Lane", priceUsd: 30.74 }),
      option({
        id: "s2",
        provider: "spothero",
        address: "503 Congress Street",
        priceUsd: 27.13,
        distanceM: 400,
      }),
    ]);
    const parkwhiz = fakeProvider("parkwhiz", [
      option({
        id: "61989",
        provider: "parkwhiz",
        address: "1 Seaport Ln., Boston",
        priceUsd: 33.93,
      }),
    ]);
    const multi = makeMultiGarageProvider([spothero, parkwhiz]);
    const outcome = await multi.search({ ...QUERY });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.options).toHaveLength(2);
    const seaport = outcome.options.find((o) => o.address.toLowerCase().includes("seaport"))!;
    expect(seaport.provider).toBe("spothero");
    expect(seaport.priceUsd).toBe(30.74);
  });

  test("one provider failing degrades the search but keeps the other's options", async () => {
    const multi = makeMultiGarageProvider([
      fakeProvider("spothero", [option({ id: "s1", provider: "spothero" })]),
      fakeProvider("parkwhiz", [], true),
    ]);
    const outcome = await multi.search({ ...QUERY });
    expect(outcome).toMatchObject({
      ok: true,
      degraded: [{ provider: "parkwhiz", error: "network" }],
    });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.options).toHaveLength(1);
  });

  test("every provider failing is a search failure, never an empty result", async () => {
    const multi = makeMultiGarageProvider([
      fakeProvider("spothero", [], true),
      fakeProvider("parkwhiz", [], true),
    ]);
    expect(await multi.search({ ...QUERY })).toMatchObject({ ok: false, error: "network" });
  });

  test("book routes to whichever provider owns the option", async () => {
    const multi = makeMultiGarageProvider([
      fakeProvider("spothero", [option({ id: "s1", provider: "spothero" })]),
      fakeProvider("parkwhiz", [option({ id: "p1", provider: "parkwhiz" })]),
    ]);
    expect((await multi.book("p1")).option.provider).toBe("parkwhiz");
    expect((await multi.book("s1")).option.provider).toBe("spothero");
  });
});
