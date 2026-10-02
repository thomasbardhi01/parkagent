/**
 * FR-44 — place resolution end to end, offline: the Apple Maps adapter's
 * second and third endpoints, the chain around it, and what the tools do
 * with them.
 *
 *  - autocomplete, asked only when the search is weak ("lola42" is LoLa 42),
 *    one request per completion and never to anywhere a response names;
 *  - a 429 as the typed reason "quota": the next source answers, and the
 *    decisions row says why the first didn't;
 *  - walking times from /v1/etas, and the searches reading the request's
 *    walk limit and order off them, with every estimate marked;
 *  - geocode_place's scored resolution and its decisions row.
 *
 * The score and the classifier themselves are placeScore.test.ts.
 */

import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, test } from "vitest";

import {
  AppleMapsGeocoder,
  MAX_COMPLETIONS,
  MAX_ETA_DESTINATIONS,
} from "../src/services/assistant/appleMaps.js";
import type {
  GeocodeQuery,
  GeocodeResult,
  GeocoderProvider,
  WalkingEta,
} from "../src/services/assistant/geocoder.js";
import {
  FallbackGeocoder,
  METRO_CENTER,
  biasPointFor,
} from "../src/services/assistant/geocoder.js";
import { carriesTheName, classifyPlaceMatches } from "../src/services/assistant/placeMatch.js";
import { RESOLUTION_THRESHOLDS } from "../src/services/assistant/placeScore.js";
import type { SearchResult } from "../src/services/assistant/search.js";
import { AssistantTools, MAX_WALK_TIMED } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import { makeFakeDb, makePolicyService } from "./helpers.js";

const T = RESOLUTION_THRESHOLDS;

/** Braintree, MA — outside the Boston box, in Boston for a driver. */
const BRAINTREE = { lat: 42.2206, lng: -71.0041 };
const NOW = () => new Date("2026-09-23T14:00:00-04:00");

const LOLA_42: GeocodeResult = {
  lat: 42.35458,
  lng: -71.04526,
  displayName: "LoLa 42, 22 Liberty Dr, Seaport",
  city: "bos",
  name: "LoLa 42",
  address: "22 Liberty Dr",
  area: "Seaport",
  areaNames: ["Boston", "Seaport", "South Boston"],
  kind: "poi",
  category: "Restaurant",
};
const SEAPORT_AREA: GeocodeResult = {
  lat: 42.34627,
  lng: -71.04216,
  displayName: "Seaport, Boston, Suffolk County",
  city: "bos",
  name: "Seaport",
  areaNames: ["Boston", "Suffolk County"],
  kind: "area",
};
const UNRELATED: GeocodeResult = {
  lat: 42.3489,
  lng: -71.0379,
  displayName: "Yankee Lobster, 300 Northern Ave, Seaport",
  city: "bos",
  name: "Yankee Lobster",
  address: "300 Northern Ave",
  area: "Seaport",
  areaNames: ["Boston", "Seaport"],
  kind: "poi",
};

// ---------------------------------------------------------------------------
// A fake maps-api.apple.com
// ---------------------------------------------------------------------------

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const CONFIG = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

/** A /v1/search row, Apple's shape. */
function applePlace(p: GeocodeResult) {
  return {
    name: p.name,
    coordinate: { latitude: p.lat, longitude: p.lng },
    formattedAddressLines: [p.address ?? "", "Boston, MA 02210", "United States"],
    structuredAddress: {
      locality: "Boston",
      ...(p.kind === "area" ? {} : { subLocality: p.area, fullThoroughfare: p.address }),
      dependentLocalities: p.kind === "area" || !p.area ? [] : [p.area],
    },
    ...(p.kind === "poi" ? { poiCategory: p.category ?? "Restaurant" } : {}),
  };
}

/** A /v1/searchAutocomplete row for a place. */
function completionFor(p: GeocodeResult, id: string) {
  return {
    completionUrl: `/v1/search?q=${encodeURIComponent(p.name ?? "")}&metadata=${id}`,
    displayLines: [p.name, p.address],
    location: { latitude: p.lat, longitude: p.lng },
  };
}

type Answer = { status: number; body: unknown };
interface Routes {
  /** GET /v1/search with no `metadata`: the place search. */
  search?: (url: URL) => Answer;
  /** GET /v1/searchAutocomplete. */
  autocomplete?: (url: URL) => Answer;
  /** GET /v1/search with `metadata`: a completion's place. */
  completion?: (url: URL) => Answer;
  etas?: (url: URL) => Answer;
  token?: () => Answer;
}

function fakeApple(routes: Routes) {
  const calls: { kind: keyof Routes | "other"; url: URL; auth: string | null }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const kind: keyof Routes | "other" =
      url.host !== "maps-api.apple.com"
        ? "other"
        : url.pathname === "/v1/token"
          ? "token"
          : url.pathname === "/v1/searchAutocomplete"
            ? "autocomplete"
            : url.pathname === "/v1/etas"
              ? "etas"
              : url.pathname === "/v1/search"
                ? url.searchParams.has("metadata")
                  ? "completion"
                  : "search"
                : "other";
    calls.push({ kind, url, auth });
    // Apple's own refusal (#152), on every place endpoint.
    if (url.searchParams.has("searchLocation") && url.searchParams.has("searchRegion")) {
      return new Response(JSON.stringify({ error: { message: "both" } }), { status: 400 });
    }
    const answer: Answer =
      kind === "token"
        ? (routes.token?.() ?? {
            status: 200,
            body: { accessToken: "access-1", expiresInSeconds: 1800 },
          })
        : kind === "other"
          ? { status: 404, body: {} }
          : (routes[kind]?.(url) ?? { status: 200, body: { results: [] } });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const count = (kind: keyof Routes | "other") => calls.filter((c) => c.kind === kind).length;
  return { fetchFn, calls, count };
}

const ok = (body: unknown): Answer => ({ status: 200, body });

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

describe("Apple autocomplete, when the search is weak", () => {
  const lola42 = (): Routes => ({
    // The search reads "lola42" literally and finds only the neighborhood.
    search: () => ok({ results: [applePlace(SEAPORT_AREA)] }),
    autocomplete: () => ok({ results: [completionFor(LOLA_42, "lola")] }),
    completion: () => ok({ results: [applePlace(LOLA_42)] }),
  });
  const QUERY: GeocodeQuery = { query: "lola42", city: "bos", userLocation: BRAINTREE };

  test("'lola42': the search finds the neighborhood, autocomplete finds LoLa 42 — one request each", async () => {
    const apple = fakeApple(lola42());
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).geocode(QUERY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const match = classifyPlaceMatches("lola42", outcome.results, biasPointFor(QUERY));
    expect(match).toMatchObject({
      kind: "found",
      nameMatched: true,
      place: { name: "LoLa 42", address: "22 Liberty Dr", source: "apple_autocomplete" },
    });
    expect(match.kind === "found" && match.confidence).toBeGreaterThanOrEqual(T.found);
    // Exactly one search, one autocomplete, one completion.
    expect(apple.count("search")).toBe(1);
    expect(apple.count("autocomplete")).toBe(1);
    expect(apple.count("completion")).toBe(1);
    expect(apple.count("other")).toBe(0);
    // What the search found is still there, behind it, as the search's.
    expect(outcome.results.map((r) => [r.name, r.source])).toEqual([
      ["LoLa 42", "apple_autocomplete"],
      ["Seaport", "apple_search"],
    ]);
  });

  test("autocomplete carries the search's own bias — a point or a region, never both — and the completion is fetched authorized, in English", async () => {
    const apple = fakeApple(lola42());
    await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).geocode(QUERY);
    const search = apple.calls.find((c) => c.kind === "search")!.url.searchParams;
    const auto = apple.calls.find((c) => c.kind === "autocomplete")!.url.searchParams;
    for (const name of ["q", "limitToCountries", "lang", "searchRegion", "userLocation"]) {
      expect(auto.get(name), name).toBe(search.get(name));
    }
    expect(auto.get("q")).toBe("lola42");
    expect(auto.get("searchRegion")).toBe("42.43,-70.98,42.29,-71.19");
    expect(auto.has("searchLocation")).toBe(false);
    const completion = apple.calls.find((c) => c.kind === "completion")!;
    expect(completion.auth).toBe("Bearer access-1");
    expect(completion.url.searchParams.get("metadata")).toBe("lola");
    expect(completion.url.searchParams.get("lang")).toBe("en-US");

    // Inside the city, the phone is the point — for both.
    const inside = fakeApple(lola42());
    const seaport = { lat: 42.3519, lng: -71.0446 };
    await new AppleMapsGeocoder(CONFIG, { fetchFn: inside.fetchFn }).geocode({
      ...QUERY,
      near: seaport,
    });
    const nearAuto = inside.calls.find((c) => c.kind === "autocomplete")!.url.searchParams;
    expect(nearAuto.get("searchLocation")).toBe("42.3519,-71.0446");
    expect(nearAuto.has("searchRegion")).toBe(false);
  });

  test("a search that found the place asks autocomplete nothing", async () => {
    const apple = fakeApple({
      search: () => ok({ results: [applePlace(LOLA_42)] }),
      autocomplete: () => ok({ results: [completionFor(SEAPORT_AREA, "x")] }),
    });
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).geocode({
      ...QUERY,
      query: "Lola 42",
    });
    expect(outcome.ok && outcome.results.map((r) => r.source)).toEqual(["apple_search"]);
    expect(apple.count("autocomplete")).toBe(0);
    expect(apple.count("completion")).toBe(0);
  });

  test("at most three completions are fetched, only ones in a covered city, and only Apple's own /v1/search", async () => {
    const elsewhere = { ...LOLA_42, lat: 41.2835, lng: -70.0995, name: "LoLa 41" };
    const others = [1, 2, 3, 4].map((n) => ({
      ...LOLA_42,
      name: `LoLa 42 #${n}`,
      lat: LOLA_42.lat + n * 0.004,
    }));
    const apple = fakeApple({
      search: () => ok({ results: [] }),
      autocomplete: () =>
        ok({
          results: [
            // Says where it is: Nantucket. Not worth a request.
            completionFor(elsewhere, "nantucket"),
            // A response doesn't get to send the token anywhere else.
            { completionUrl: "https://evil.example/v1/search?q=x&metadata=1" },
            { completionUrl: "//evil.example/v1/search?q=x&metadata=2" },
            { completionUrl: "/v1/token?metadata=3" },
            { displayLines: ["no url at all"] },
            ...others.map((p, i) => completionFor(p, `ok-${i}`)),
          ],
        }),
      completion: (url) => {
        const index = Number(url.searchParams.get("metadata")!.split("-")[1]);
        return ok({ results: [applePlace(others[index]!)] });
      },
    });
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).geocode({
      query: "lola42",
      city: "bos",
    });
    expect(apple.count("completion")).toBe(MAX_COMPLETIONS);
    expect(
      apple.calls
        .filter((c) => c.kind === "completion")
        .map((c) => c.url.searchParams.get("metadata")),
    ).toEqual(["ok-0", "ok-1", "ok-2"]);
    // Nothing went to another host or another endpoint.
    expect(apple.count("other")).toBe(0);
    expect(apple.count("token")).toBe(1);
    expect(apple.calls.every((c) => c.url.host === "maps-api.apple.com")).toBe(true);
    expect(outcome.ok && outcome.results.map((r) => [r.name, r.rank])).toEqual([
      ["LoLa 42 #1", 0],
      ["LoLa 42 #2", 1],
      ["LoLa 42 #3", 2],
    ]);
  });

  test("autocomplete out of quota leaves the search's answer standing, says so, and isn't cached", async () => {
    let quota = true;
    const apple = fakeApple({
      search: () => ok({ results: [applePlace(SEAPORT_AREA)] }),
      autocomplete: () =>
        quota
          ? { status: 429, body: { error: { message: "quota" } } }
          : ok({ results: [completionFor(LOLA_42, "lola")] }),
      completion: () => ok({ results: [applePlace(LOLA_42)] }),
    });
    const geocoder = new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn });
    const first = await geocoder.geocode(QUERY);
    expect(first).toMatchObject({
      ok: true,
      results: [{ name: "Seaport", source: "apple_search" }],
      failures: [{ provider: "apple_autocomplete", reason: "quota" }],
    });
    // The next lookup tries again rather than serving the weaker answer.
    quota = false;
    const second = await geocoder.geocode(QUERY);
    expect(second.ok && second.results[0]).toMatchObject({ name: "LoLa 42" });
    expect(second.ok && second.failures).toBeUndefined();
    // And that one is cached: a third makes no request at all.
    const before = apple.calls.length;
    const third = await geocoder.geocode(QUERY);
    expect(third.ok && third.results[0]).toMatchObject({ name: "LoLa 42" });
    expect(apple.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** A second source that counts how often it is asked. */
function nominatimWith(results: GeocodeResult[]) {
  const source = {
    id: "nominatim",
    asked: 0,
    geocode: async () => {
      source.asked += 1;
      return { ok: true as const, results: results.map((r) => ({ ...r, source: "nominatim" })) };
    },
  };
  return source;
}

function toolsWith(deps: {
  geocoder: GeocoderProvider;
  garage?: GarageProvider;
  candidates?: Candidate[];
}) {
  const { db, state } = makeFakeDb();
  const tools = new AssistantTools({
    db,
    policy: makePolicyService(),
    findCandidates: async () => deps.candidates ?? [],
    garage: deps.garage ?? garages([]),
    geocoder: deps.geocoder,
    now: NOW,
  });
  const rows = (tool: string) =>
    state.decisions.filter((d) => d.kind === "assistant_tool" && d.inputs["tool"] === tool);
  return { tools, state, rows };
}

function garages(options: GarageOption[]): GarageProvider {
  return {
    id: "spothero",
    canReserve: false,
    search: async () => ({ ok: true, options, fromCache: false }),
    optionById: (id) => options.find((o) => o.id === id) ?? null,
    book: async () => {
      throw new Error("not used");
    },
  };
}

let ctx: ToolContext;
beforeEach(() => {
  ctx = { userId: "u1", conversationId: "c1", location: BRAINTREE };
});

describe("Apple's daily quota (429)", () => {
  const exhausted = (): Routes => ({
    search: () => ({ status: 429, body: { error: { message: "Too Many Requests" } } }),
  });

  test("a 429 is the typed reason 'quota'", async () => {
    const apple = fakeApple(exhausted());
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).geocode({
      query: "Lola 42",
      city: "bos",
    });
    expect(outcome).toEqual({ ok: false, reason: "quota" });
    // The token exchange refusing the same way is the same reason.
    const noToken = fakeApple({ token: () => ({ status: 429, body: {} }) });
    expect(
      await new AppleMapsGeocoder(CONFIG, { fetchFn: noToken.fetchFn }).geocode({
        query: "Lola 42",
        city: "bos",
      }),
    ).toEqual({ ok: false, reason: "quota" });
  });

  test("the chain asks the next source, and the answer says why the first didn't give it", async () => {
    const apple = fakeApple(exhausted());
    const nominatim = nominatimWith([LOLA_42]);
    const chain = new FallbackGeocoder(
      [new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }), nominatim],
      carriesTheName,
    );
    const outcome = await chain.geocode({ query: "Lola 42", city: "bos" });
    expect(nominatim.asked).toBe(1);
    expect(outcome).toMatchObject({
      ok: true,
      results: [{ name: "LoLa 42", source: "nominatim" }],
      failures: [{ provider: "apple_maps", reason: "quota" }],
    });
  });

  test("geocode_place still finds the place, and its decisions row records the quota", async () => {
    const apple = fakeApple(exhausted());
    const nominatim = nominatimWith([LOLA_42]);
    const { tools, rows } = toolsWith({
      geocoder: new FallbackGeocoder(
        [new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }), nominatim],
        carriesTheName,
      ),
    });
    const out = await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    expect(out.result).toMatchObject({ found: true, match: "exact", resolution: "found" });
    expect(nominatim.asked).toBe(1);
    const [row] = rows("geocode_place");
    expect(row!.rule).toBe("ok");
    expect(row!.outcome).toMatchObject({
      query: "Lola 42",
      source: "nominatim",
      failures: [{ provider: "apple_maps", reason: "quota" }],
    });
  });

  test("with every source out, the row's reason is the quota", async () => {
    const apple = fakeApple(exhausted());
    const { tools, rows } = toolsWith({
      geocoder: new FallbackGeocoder([new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn })]),
    });
    const out = await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    expect(out.result).toMatchObject({ error: "geocode_failed" });
    const [row] = rows("geocode_place");
    expect(row).toMatchObject({ rule: "geocode_error", outcome: { reason: "quota" } });
    // Asked for, never found: the request names the place, with no point.
    expect(ctx.requestState?.place).toMatchObject({ query: "Lola 42", resolved: null });
  });
});

// ---------------------------------------------------------------------------
// Walking times
// ---------------------------------------------------------------------------

describe("Apple walking times (/v1/etas)", () => {
  const ORIGIN = { lat: LOLA_42.lat, lng: LOLA_42.lng };
  const pins = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ lat: ORIGIN.lat + (i + 1) * 0.001, lng: ORIGIN.lng }));
  const echo = (url: URL, seconds: (index: number) => number | null) => {
    const destinations = url.searchParams.get("destinations")!.split("|");
    return ok({
      etas: destinations.flatMap((pair, index) => {
        const s = seconds(index);
        const [latitude, longitude] = pair.split(",").map(Number);
        return s === null
          ? []
          : [
              {
                destination: { latitude, longitude },
                transportType: "Walking",
                distanceMeters: Math.round(s * 1.3),
                expectedTravelTimeSeconds: s,
              },
            ];
      }),
    });
  };

  test("one request: the origin, the destinations bar-separated, walking — answered in the order asked", async () => {
    const apple = fakeApple({ etas: (url) => echo(url, (i) => [420, 95][i]!) });
    const etas = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).walkingEtas(
      ORIGIN,
      pins(2),
    );
    expect(etas).toEqual([
      { seconds: 420, meters: 546 },
      { seconds: 95, meters: 124 },
    ]);
    expect(apple.count("etas")).toBe(1);
    const sent = apple.calls.find((c) => c.kind === "etas")!;
    expect(sent.auth).toBe("Bearer access-1");
    expect(sent.url.searchParams.get("origin")).toBe("42.35458,-71.04526");
    expect(sent.url.searchParams.get("destinations")).toBe("42.35558,-71.04526|42.35658,-71.04526");
    expect(sent.url.searchParams.get("transportType")).toBe("Walking");
  });

  test("a destination Apple has no route to is null, and the rest keep their own", async () => {
    // Apple leaves the second of three out: the third's time must not
    // slide into its place.
    const apple = fakeApple({ etas: (url) => echo(url, (i) => [300, null, 600][i]!) });
    const etas = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).walkingEtas(
      ORIGIN,
      pins(3),
    );
    expect(etas).toEqual([{ seconds: 300, meters: 390 }, null, { seconds: 600, meters: 780 }]);
  });

  test("no more than ten destinations a request", async () => {
    const apple = fakeApple({ etas: (url) => echo(url, () => 60) });
    const etas = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).walkingEtas(
      ORIGIN,
      pins(MAX_ETA_DESTINATIONS + 3),
    );
    expect(etas).toHaveLength(MAX_ETA_DESTINATIONS + 3);
    expect(etas!.every((eta) => eta?.seconds === 60)).toBe(true);
    const sizes = apple.calls
      .filter((c) => c.kind === "etas")
      .map((c) => c.url.searchParams.get("destinations")!.split("|").length);
    expect(sizes).toEqual([MAX_ETA_DESTINATIONS, 3]);
  });

  test.each([
    ["out of quota", { status: 429, body: {} }],
    ["a server error", { status: 500, body: {} }],
    ["a bad request", { status: 400, body: { error: { message: "no" } } }],
  ])("%s is null, never a throw", async (_what, answer) => {
    const apple = fakeApple({ etas: () => answer });
    const etas = await new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }).walkingEtas(
      ORIGIN,
      pins(2),
    );
    expect(etas).toBeNull();
  });

  test("a dead connection is null too", async () => {
    const fetchFn = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    expect(
      await new AppleMapsGeocoder(CONFIG, { fetchFn }).walkingEtas(ORIGIN, pins(1)),
    ).toBeNull();
  });

  test("the chain forwards to the first source that has walking times, and has none without one", async () => {
    const seen: unknown[] = [];
    const plain: GeocoderProvider = { geocode: async () => ({ ok: true, results: [] }) };
    const walks: GeocoderProvider = {
      geocode: async () => ({ ok: true, results: [] }),
      walkingEtas: async (origin, destinations) => {
        seen.push({ origin, destinations });
        return destinations.map(() => ({ seconds: 120, meters: 150 }));
      },
    };
    const chain = new FallbackGeocoder([plain, walks]);
    expect(await chain.walkingEtas(ORIGIN, pins(2))).toEqual([
      { seconds: 120, meters: 150 },
      { seconds: 120, meters: 150 },
    ]);
    expect(seen).toEqual([{ origin: ORIGIN, destinations: pins(2) }]);
    expect(await new FallbackGeocoder([plain]).walkingEtas(ORIGIN, pins(2))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// geocode_place: the scored resolution
// ---------------------------------------------------------------------------

/** A geocoder answering from a table keyed by the lowercased query. */
function tableGeocoder(
  table: Record<string, GeocodeResult[]>,
  walkingEtas?: GeocoderProvider["walkingEtas"],
): GeocoderProvider {
  return {
    geocode: async (q) => ({ ok: true, results: table[q.query.trim().toLowerCase()] ?? [] }),
    ...(walkingEtas ? { walkingEtas } : {}),
  };
}

describe("geocode_place returns a scored resolution, and records how it was scored", () => {
  test("found: the resolution, its confidence, and a row with the source and the candidates", async () => {
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({
        "lola 42 seaport": [
          { ...SEAPORT_AREA, source: "apple_search" },
          { ...LOLA_42, source: "apple_search" },
          { ...UNRELATED, source: "apple_search" },
        ],
      }),
    });
    const out = await tools.execute(ctx, "geocode_place", { query: "Lola 42 Seaport" });
    const result = out.result as { resolution: string; confidence: number; match: string };
    expect(result).toMatchObject({ found: true, match: "exact", resolution: "found" });
    expect(result.confidence).toBeGreaterThanOrEqual(T.found);
    const [row] = rows("geocode_place");
    expect(row!.rule).toBe("ok");
    expect(row!.outcome).toMatchObject({
      query: "Lola 42 Seaport",
      source: "apple_search",
      confidence: result.confidence,
    });
    // Best first, each with its own score; the winner's is the confidence.
    const candidates = row!.outcome["candidates"] as { name: string; score: number }[];
    expect(candidates.map((c) => c.name)).toEqual(["LoLa 42", "Yankee Lobster", "Seaport"]);
    expect(candidates[0]).toEqual({
      name: "LoLa 42",
      lat: LOLA_42.lat,
      lng: LOLA_42.lng,
      score: result.confidence,
    });
    expect(candidates.map((c) => c.score)).toEqual(
      [...candidates.map((c) => c.score)].sort((a, b) => b - a),
    );
  });

  test("the row keeps at most five candidates", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...UNRELATED,
      name: `Place ${i}`,
      lat: UNRELATED.lat + i * 0.003,
    }));
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [...many, LOLA_42] }),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    const candidates = rows("geocode_place")[0]!.outcome["candidates"] as { name: string }[];
    expect(candidates).toHaveLength(5);
    expect(candidates[0]!.name).toBe("LoLa 42");
  });

  test("through the real adapter: 'lola42' is found by autocomplete, and the row says so", async () => {
    const apple = fakeApple({
      search: () => ok({ results: [applePlace(SEAPORT_AREA)] }),
      autocomplete: () => ok({ results: [completionFor(LOLA_42, "lola")] }),
      completion: () => ok({ results: [applePlace(LOLA_42)] }),
    });
    const nominatim = nominatimWith([]);
    const { tools, rows } = toolsWith({
      geocoder: new FallbackGeocoder(
        [new AppleMapsGeocoder(CONFIG, { fetchFn: apple.fetchFn }), nominatim],
        carriesTheName,
      ),
    });
    const out = await tools.execute(ctx, "geocode_place", { query: "lola42" });
    expect(out.result).toMatchObject({
      found: true,
      match: "exact",
      resolution: "found",
      place: { name: "LoLa 42", address: "22 Liberty Dr" },
    });
    expect(rows("geocode_place")[0]!.outcome).toMatchObject({ source: "apple_autocomplete" });
    // Apple carried the name: the second source was never asked.
    expect(nominatim.asked).toBe(0);
    expect(ctx.requestState?.place.resolved).toMatchObject({
      lat: LOLA_42.lat,
      lng: LOLA_42.lng,
      label: "LoLa 42, Seaport",
    });
  });

  test("closest only: said as that, with a confidence under the line for a match", async () => {
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({ "lola 42 seaport": [SEAPORT_AREA] }),
    });
    const out = await tools.execute(ctx, "geocode_place", { query: "Lola 42 Seaport" });
    const result = out.result as { confidence: number; instruction: string };
    expect(result).toMatchObject({ found: true, match: "closest", resolution: "closest_only" });
    expect(result.confidence).toBeGreaterThanOrEqual(T.closestFloor);
    expect(result.confidence).toBeLessThan(T.ambiguousFloor);
    expect(result.instruction).toContain("Never present Seaport as the place they named");
    expect(rows("geocode_place")[0]).toMatchObject({
      rule: "closest_only",
      outcome: { confidence: result.confidence },
    });
  });

  test("ambiguous: the choices and each one's score", async () => {
    const beaconHill: GeocodeResult = {
      ...LOLA_42,
      name: "Mooo....",
      address: "15 Beacon St",
      area: "Beacon Hill",
      areaNames: ["Boston", "Beacon Hill"],
      lat: 42.35829,
      lng: -71.06198,
    };
    const seaport: GeocodeResult = {
      ...LOLA_42,
      name: "Mooo....",
      address: "49 Melcher St",
      lat: 42.34945,
      lng: -71.05034,
    };
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({ "moo steakhouse": [beaconHill, seaport] }),
    });
    const out = await tools.execute(ctx, "geocode_place", { query: "Moo steakhouse" });
    expect(out.result).toMatchObject({ found: true, ambiguous: true, resolution: "ambiguous" });
    const outcome = rows("geocode_place")[0]!.outcome as {
      scores: number[];
      choices: unknown[];
      confidence: number;
    };
    expect(outcome.choices).toHaveLength(2);
    expect(outcome.scores).toHaveLength(2);
    expect(Math.abs(outcome.scores[0]! - outcome.scores[1]!)).toBeLessThanOrEqual(T.ambiguousGap);
    expect(outcome.confidence).toBe(Math.max(...outcome.scores));
  });

  test("'xyzzy restaurant': nothing — and nothing of the phone's location in the answer", async () => {
    const phone = { lat: 42.3519, lng: -71.0446 };
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({ "xyzzy restaurant": [UNRELATED] }),
    });
    const at: ToolContext = { ...ctx, location: phone };
    const out = await tools.execute(at, "geocode_place", { query: "xyzzy restaurant" });
    expect(out.result).toMatchObject({ found: false, resolution: "none" });
    const sent = JSON.stringify(out.result);
    for (const coordinate of [phone.lat, phone.lng, UNRELATED.lat, UNRELATED.lng]) {
      expect(sent).not.toContain(String(coordinate));
    }
    expect(sent).not.toContain("Yankee Lobster");
    // The request names the place and holds no point: the next search
    // asks for it, and never searches around the phone.
    expect(at.requestState?.place).toEqual({
      query: "xyzzy restaurant",
      resolved: null,
      candidates: null,
    });
    const search = await tools.execute(at, "quote_street", {});
    expect(search.result).toMatchObject({ error: "place_unresolved" });
    expect(search.ask?.question).toContain("xyzzy restaurant");
    // What was turned down, and how it scored, is on the record.
    expect(rows("geocode_place")[0]).toMatchObject({
      rule: "no_match",
      outcome: { confidence: null, candidates: [{ name: "Yankee Lobster" }] },
    });
  });
});

// ---------------------------------------------------------------------------
// Walking times in the searches and on the card
// ---------------------------------------------------------------------------

/** A garage `metres` due north of LoLa 42, with a pin. */
function garageNorth(id: string, metres: number, extra: Partial<GarageOption> = {}): GarageOption {
  return {
    id,
    provider: "spothero",
    name: `Garage ${id}`,
    address: `${id} Test St`,
    priceUsd: 15,
    distanceM: metres,
    walkMinutes: Math.round(metres / 80),
    entryType: "self",
    deepLink: `https://spothero.com/checkout/${id}`,
    lat: LOLA_42.lat + metres / 111_195,
    lng: LOLA_42.lng,
    ...extra,
  };
}

/** Walking times by the pin's distance north of LoLa 42, to the metre. */
function etasByDistance(seconds: Record<number, number>) {
  const calls: {
    origin: { lat: number; lng: number };
    destinations: { lat: number; lng: number }[];
  }[] = [];
  const walkingEtas: NonNullable<GeocoderProvider["walkingEtas"]> = async (
    origin,
    destinations,
  ) => {
    calls.push({ origin, destinations: [...destinations] });
    return destinations.map((d): WalkingEta | null => {
      const metres = Math.round((d.lat - LOLA_42.lat) * 111_195);
      const s = seconds[metres];
      return s === undefined ? null : { seconds: s, meters: Math.round(metres * 1.4) };
    });
  };
  return { walkingEtas, calls };
}

interface CardOption {
  id: string;
  walkMinutes: number;
  walkEstimate?: boolean;
  streetSummary?: string;
  detail?: string;
  nearMiss?: boolean;
}

const window3pm = { startsAt: "2026-09-23T15:00:00-04:00", durationMinutes: 120 };

describe("walking times in the searches and on the card", () => {
  test("a 420-second walk is 7 minutes and not an estimate; the option with no time keeps its estimate, marked", async () => {
    const etas = etasByDistance({ 300: 420 });
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }, etas.walkingEtas),
      garage: garages([garageNorth("far", 500), garageNorth("near", 300)]),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", window3pm);
    const search = (await tools.execute(ctx, "search_garages", {})).result as SearchResult;
    const version = search.stateVersion;
    // One request for the search, from the place the user named, nearest
    // pin first.
    expect(etas.calls).toHaveLength(1);
    expect(etas.calls[0]!.origin).toEqual({ lat: LOLA_42.lat, lng: LOLA_42.lng });
    expect(
      etas.calls[0]!.destinations.map((d) => Math.round((d.lat - LOLA_42.lat) * 111_195)),
    ).toEqual([300, 500]);
    expect(rows("search_garages")[0]!.outcome).toMatchObject({ walksTimed: 1 });

    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: `v${version}-near` }, { id: `v${version}-far` }],
      },
    });
    const options = (out.endTurn!.plan as { options: CardOption[] }).options;
    const near = options.find((o) => o.id === `v${version}-near`)!;
    const far = options.find((o) => o.id === `v${version}-far`)!;
    expect(near.walkMinutes).toBe(7);
    expect(near.walkEstimate).toBe(false);
    // The source's own figure for 500 m, and said to be an estimate.
    expect(far.walkMinutes).toBe(6);
    expect(far.walkEstimate).toBe(true);
    // Proposing asked Apple nothing more: the card's walks are the search's.
    expect(etas.calls).toHaveLength(1);
  });

  test("the walk limit and the order are read off the real walk, both ways", async () => {
    // By the estimates "near" (4 min) meets a 5-minute limit and "far"
    // (6 min) breaks it. By the walk itself it is the other way round.
    const etas = etasByDistance({ 300: 420, 500: 240 });
    const { tools } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }, etas.walkingEtas),
      garage: garages([garageNorth("near", 300), garageNorth("far", 500)]),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", { ...window3pm, maxWalkMinutes: 5 });
    const search = (await tools.execute(ctx, "search_garages", {})).result as SearchResult;
    const v = search.stateVersion;
    expect(search.satisfying.map((o) => [o.id, o.walkMinutes, o.walkEstimate])).toEqual([
      [`v${v}-far`, 4, false],
    ]);
    expect(search.nearMisses).toHaveLength(1);
    expect(search.nearMisses[0]).toMatchObject({
      option: { id: `v${v}-near`, walkMinutes: 7, walkEstimate: false },
      violates: [{ field: "maxWalkMinutes", actual: 7, limit: 5 }],
    });
    // The option the estimate would have passed can't be dressed as a fit.
    const dressed = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: `v${v}-near` }] },
    });
    expect(dressed.result).toMatchObject({ error: "hard_constraint_violation" });
  });

  test("a street option's line states the walk it carries", async () => {
    const etas = etasByDistance({ 0: 185 });
    const block: Candidate = {
      zoneId: "bos-liberty-dr-1",
      city: "bos",
      providerZoneNumber: "789",
      rateFirstHourUsd: 3.75,
      rateAdditionalHourUsd: 3.75,
      maxStayMinutes: 240,
      hours: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }],
      distanceM: 300,
      containsPoint: false,
    };
    const { tools } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }, etas.walkingEtas),
      candidates: [block],
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", window3pm);
    const search = (await tools.execute(ctx, "quote_street", {})).result as SearchResult;
    const [option] = search.satisfying;
    // 300 m straight-line is a 5-minute estimate; the walk is 185 s.
    expect(option).toMatchObject({ walkMinutes: 4, walkEstimate: false });
    expect(option!.summary).toMatch(/ — 4 min walk$/);
    expect(option!.facts).toMatchObject({ walkMinutes: 4, summary: option!.summary });
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: option!.id }] },
    });
    const [card] = (out.endTurn!.plan as { options: CardOption[]; recommendedReason: string })
      .options;
    expect(card).toMatchObject({ walkMinutes: 4, walkEstimate: false });
    expect(card!.streetSummary).toBe(option!.summary);
    expect(card!.detail).toBe(option!.summary);
    expect((out.endTurn!.plan as { recommendedReason: string }).recommendedReason).toContain(
      "4 min walk",
    );
  });

  test("a walk is never under a minute, like the estimate", async () => {
    const etas = etasByDistance({ 300: 0 });
    const { tools } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }, etas.walkingEtas),
      garage: garages([garageNorth("near", 300)]),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", window3pm);
    const search = (await tools.execute(ctx, "search_garages", {})).result as SearchResult;
    expect(search.satisfying[0]).toMatchObject({ walkMinutes: 1, walkEstimate: false });
  });

  test("with no place named there is no destination to walk to: nothing is asked, every walk is an estimate", async () => {
    const etas = etasByDistance({ 300: 420 });
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({}, etas.walkingEtas),
      garage: garages([garageNorth("near", 300)]),
    });
    const here: ToolContext = { ...ctx, location: { lat: LOLA_42.lat, lng: LOLA_42.lng } };
    await tools.execute(here, "update_request", window3pm);
    const search = (await tools.execute(here, "search_garages", {})).result as SearchResult;
    expect(etas.calls).toHaveLength(0);
    expect(search.satisfying[0]).toMatchObject({ walkMinutes: 4, walkEstimate: true });
    expect(rows("search_garages")[0]!.outcome).toMatchObject({ walksTimed: 0 });
    const out = await tools.execute(here, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: search.satisfying[0]!.id }] },
    });
    const plan = out.endTurn!.plan as { options: CardOption[]; destination?: unknown };
    expect(plan.destination).toBeUndefined();
    expect(plan.options[0]).toMatchObject({ walkMinutes: 4, walkEstimate: true });
  });

  test("walking times unavailable (quota, an outage): the search still answers, on estimates", async () => {
    let asked = 0;
    const { tools } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }, async () => {
        asked += 1;
        return null;
      }),
      garage: garages([garageNorth("near", 300)]),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", window3pm);
    const search = (await tools.execute(ctx, "search_garages", {})).result as SearchResult;
    expect(asked).toBe(1);
    expect(search.verdict).toBe("meets");
    expect(search.satisfying[0]).toMatchObject({ walkMinutes: 4, walkEstimate: true });
  });

  test("a source with no walking times at all: every card walk is marked an estimate", async () => {
    const { tools } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }),
      garage: garages([garageNorth("near", 300)]),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", window3pm);
    const search = (await tools.execute(ctx, "search_garages", {})).result as SearchResult;
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: search.satisfying[0]!.id }] },
    });
    expect((out.endTurn!.plan as { options: CardOption[] }).options[0]).toMatchObject({
      walkMinutes: 4,
      walkEstimate: true,
    });
  });

  test("only the nearest options of a search are timed: one request, however many there are", async () => {
    const etas = etasByDistance(
      Object.fromEntries(Array.from({ length: 14 }, (_, i) => [100 + i * 30, 60 * (i + 2)])),
    );
    const { tools } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [LOLA_42] }, etas.walkingEtas),
      // Fourteen garages, 100 m to 490 m out, listed farthest first.
      garage: garages(
        Array.from({ length: 14 }, (_, i) => garageNorth(`g${i}`, 100 + i * 30)).reverse(),
      ),
    });
    await tools.execute(ctx, "geocode_place", { query: "Lola 42" });
    await tools.execute(ctx, "update_request", window3pm);
    await tools.execute(ctx, "search_garages", {});
    expect(etas.calls).toHaveLength(1);
    const asked = etas.calls[0]!.destinations.map((d) =>
      Math.round((d.lat - LOLA_42.lat) * 111_195),
    );
    expect(asked).toHaveLength(MAX_WALK_TIMED);
    expect(asked).toEqual(Array.from({ length: MAX_WALK_TIMED }, (_, i) => 100 + i * 30));
  });
});

describe("a search that looks the place up itself", () => {
  test("leaves the same record geocode_place does, under its own name", async () => {
    const { tools, rows } = toolsWith({
      geocoder: tableGeocoder({ "lola 42": [{ ...LOLA_42, source: "apple_search" }] }),
      garage: garages([garageNorth("near", 300)]),
    });
    // The model set the place by name and never called geocode_place.
    await tools.execute(ctx, "update_request", { ...window3pm, placeQuery: "Lola 42" });
    const search = (await tools.execute(ctx, "search_garages", {})).result as SearchResult;
    expect(search.place).toMatchObject({ lat: LOLA_42.lat, lng: LOLA_42.lng, source: "user" });
    const lookup = rows("search_garages").find((d) => d.rule === "place_lookup");
    expect(lookup!.outcome).toMatchObject({
      query: "Lola 42",
      resolution: "found",
      source: "apple_search",
      candidates: [{ name: "LoLa 42" }],
    });
    expect(lookup!.outcome["confidence"]).toBeGreaterThanOrEqual(T.found);
    // Scored from where the search looked: a Braintree phone's is the
    // city's center.
    expect(biasPointFor({ query: "Lola 42", city: "bos" })).toEqual(METRO_CENTER.bos);
  });
});
