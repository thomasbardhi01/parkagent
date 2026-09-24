/**
 * The ParkWhiz (Arrive) v4 adapter against DOC-SHAPED fixtures (the
 * public v4 docs' quote model — no live credentials exist yet, so the
 * shape is the docs', recorded 2026-09-23), plus the multi-provider
 * merge: dedupe by facility address, cheaper listing wins, and a failed
 * provider degrades the search honestly instead of narrowing it silently.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { makeMultiGarageProvider, normalizeAddress } from "../src/services/garage/multiProvider.js";
import { makeParkWhizProvider, parseParkWhizQuote } from "../src/services/garage/parkwhiz.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/parkwhiz-quotes.json", import.meta.url)), "utf8"),
) as unknown[];

const QUERY = {
  lat: 42.3503,
  lng: -71.04,
  startsAt: "2026-09-24T18:00:00-04:00",
  endsAt: "2026-09-24T22:00:00-04:00",
};

const TOKEN_BODY = { access_token: "tok_test", token_type: "bearer", expires_in: 31557600 };

function providerOver(
  responses: { ok: boolean; status: number; body?: unknown; throws?: boolean }[],
  now?: () => number,
) {
  let call = 0;
  const requests: {
    url: string;
    init?: { method?: string; headers?: Record<string, string>; body?: string };
  }[] = [];
  const provider = makeParkWhizProvider({
    clientId: "cid",
    clientSecret: "secret",
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

describe("doc-shaped v4 quote parsing", () => {
  test("a full quote parses: price.USD dollars, pw:location embed, miles→metres", () => {
    const parsed = parseParkWhizQuote(fixture[0]);
    expect(parsed).toMatchObject({
      id: "2504",
      provider: "parkwhiz",
      name: "503 Congress St Garage",
      address: "503 Congress Street, Boston",
      priceUsd: 26,
      lat: 42.3484855,
      lng: -71.0415821,
    });
    // 0.15 mi ≈ 241 m, walkable in ~3 min.
    expect(parsed!.distanceM).toBe(241);
    expect(parsed!.walkMinutes).toBe(3);
  });

  test("rows without purchase options or without a location drop to null, never throw", () => {
    expect(parseParkWhizQuote(fixture[2])).toBeNull(); // empty purchase_options
    expect(parseParkWhizQuote(fixture[3])).toBeNull(); // no pw:location embed
    expect(parseParkWhizQuote(null)).toBeNull();
    expect(parseParkWhizQuote("junk")).toBeNull();
  });
});

describe("v4 client behavior", () => {
  test("authenticates with client_credentials once, then queries quotes with the bearer", async () => {
    const { provider, requests } = providerOver([
      { ok: true, status: 200, body: TOKEN_BODY },
      { ok: true, status: 200, body: fixture },
    ]);
    const outcome = await provider.search(QUERY);
    expect(outcome).toMatchObject({ ok: true, fromCache: false });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.options).toHaveLength(2);

    expect(requests[0]!.url).toContain("/oauth/token");
    expect(requests[0]!.init?.body).toContain("grant_type=client_credentials");
    expect(requests[0]!.init?.body).toContain("scope=public");
    expect(requests[1]!.url).toContain("/quotes/?");
    // q=coordinates:LAT,LNG distance:MILES per the docs.
    expect(requests[1]!.url).toContain(encodeURIComponent("coordinates:42.3503,-71.04"));
    expect(requests[1]!.init?.headers?.["Authorization"]).toBe("Bearer tok_test");
  });

  test("the token is reused across searches within its lifetime", async () => {
    let at = 0;
    const { provider, requests } = providerOver(
      [
        { ok: true, status: 200, body: TOKEN_BODY },
        { ok: true, status: 200, body: fixture },
        { ok: true, status: 200, body: fixture },
      ],
      () => at,
    );
    await provider.search(QUERY);
    at = 11 * 60_000; // past the search cache, well inside token life
    await provider.search(QUERY);
    const tokenCalls = requests.filter((r) => r.url.includes("/oauth/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  test("401/403/429 are blocked (and drop the token); junk is parse_failed; a thrown fetch is network", async () => {
    for (const status of [401, 403, 429]) {
      const { provider } = providerOver([
        { ok: true, status: 200, body: TOKEN_BODY },
        { ok: false, status },
      ]);
      expect(await provider.search(QUERY)).toMatchObject({ ok: false, error: "blocked" });
    }
    const junk = providerOver([
      { ok: true, status: 200, body: TOKEN_BODY },
      { ok: true, status: 200, body: { not: "an array" } },
    ]);
    expect(await junk.provider.search(QUERY)).toMatchObject({ ok: false, error: "parse_failed" });
    const dead = providerOver([{ ok: true, status: 200, throws: true }]);
    expect(await dead.provider.search(QUERY)).toMatchObject({ ok: false, error: "network" });
  });

  test("book is a deep-link handoff, canReserve false — same contract as SpotHero", async () => {
    const { provider } = providerOver([
      { ok: true, status: 200, body: TOKEN_BODY },
      { ok: true, status: 200, body: fixture },
    ]);
    await provider.search(QUERY);
    expect(provider.canReserve).toBe(false);
    const booking = await provider.book("2504");
    expect(booking.kind).toBe("deeplink_handoff");
    expect(booking.deepLink).toContain("parkwhiz.com");
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
      option({ id: "s1", provider: "spothero", address: "503 Congress Street", priceUsd: 27.13 }),
      option({
        id: "s2",
        provider: "spothero",
        address: "1 Seaport Ln",
        priceUsd: 30.74,
        distanceM: 400,
      }),
    ]);
    const parkwhiz = fakeProvider("parkwhiz", [
      option({ id: "p1", provider: "parkwhiz", address: "503 Congress St, Boston", priceUsd: 26 }),
    ]);
    const multi = makeMultiGarageProvider([spothero, parkwhiz]);
    const outcome = await multi.search({ ...QUERY });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.options).toHaveLength(2);
    const congress = outcome.options.find((o) => o.address.includes("Congress"))!;
    expect(congress.provider).toBe("parkwhiz");
    expect(congress.priceUsd).toBe(26);
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
