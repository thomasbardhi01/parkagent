/**
 * Places people actually name (2026-09-25 device test, Boston): "near
 * Lola 42" came back "couldn't find Lola 42", then "Boston or NYC?" from a
 * phone in Braintree; "Moo steakhouse in Seaport" fell back to "Seaport
 * center" without saying so. Pinned here, offline:
 *
 *  - the Apple Maps Server API adapter (token exchange, search params,
 *    result parsing, metro filter, 401 refresh) and the Apple → Nominatim
 *    fallback chain;
 *  - the "near a covered city" rule that turns a Braintree phone into a
 *    Boston search and a Boston line on the message;
 *  - what a search found: the name, only the closest thing, or several
 *    places (tappable choices);
 *  - ask_user, and the loop's suggestions.
 */

import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { beforeEach, describe, expect, test } from "vitest";

import { AppleMapsGeocoder, makeMapsAuthToken } from "../src/services/assistant/appleMaps.js";
import type {
  GeocodeQuery,
  GeocodeResult,
  GeocoderProvider,
} from "../src/services/assistant/geocoder.js";
import {
  FallbackGeocoder,
  homeMetroForPoint,
  metersBetween,
  metroForPoint,
} from "../src/services/assistant/geocoder.js";
import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { phoneLocationLine, runAssistantTurn } from "../src/services/assistant/loop.js";
import { choiceReply, classifyPlaceMatches } from "../src/services/assistant/placeMatch.js";
import { AssistantTools } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import { API_KEY, makeFakeDb, makePolicyService, makeTestApp } from "./helpers.js";

/** Braintree, MA — outside the Boston box, 15 km from its center. */
const BRAINTREE = { lat: 42.2206, lng: -71.0041 };

/** The real places (OSM/Apple points, rounded). */
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
const MOOO_SEAPORT: GeocodeResult = {
  lat: 42.34945,
  lng: -71.05034,
  displayName: "Mooo...., 49 Melcher St, Seaport",
  city: "bos",
  name: "Mooo....",
  address: "49 Melcher St",
  area: "Seaport",
  areaNames: ["Boston", "Seaport", "Fort Point"],
  kind: "poi",
};
const MOOO_BEACON_HILL: GeocodeResult = {
  lat: 42.35829,
  lng: -71.06198,
  displayName: "Mooo...., 15 Beacon St, Beacon Hill",
  city: "bos",
  name: "Mooo....",
  address: "15 Beacon St",
  area: "Beacon Hill",
  areaNames: ["Boston", "Beacon Hill"],
  kind: "poi",
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
const SEAPORT_HOTEL: GeocodeResult = {
  lat: 42.3487,
  lng: -71.0415,
  displayName: "Seaport Hotel, 1 Seaport Ln, Seaport",
  city: "bos",
  name: "Seaport Hotel",
  address: "1 Seaport Ln",
  area: "Seaport",
  areaNames: ["Boston", "Seaport"],
  kind: "poi",
};

describe("near a covered city", () => {
  test("a Braintree phone is outside the Boston box but in Boston for a driver", () => {
    // The bug: the tool biased only on the box, so Braintree searched both
    // cities and "Seaport" came back as Boston's AND Manhattan's.
    expect(metroForPoint(BRAINTREE.lat, BRAINTREE.lng)).toBeNull();
    expect(homeMetroForPoint(BRAINTREE.lat, BRAINTREE.lng)).toBe("bos");
  });

  test("a phone far from both cities is in neither", () => {
    // Albany, NY: ~210 km from one, ~230 km from the other.
    expect(homeMetroForPoint(42.6526, -73.7562)).toBeNull();
  });

  test("the message's location line names the city, so the model never has to ask", () => {
    expect(phoneLocationLine(BRAINTREE)).toBe(
      "[phone location: 42.22060, -71.00410 — in or near Boston]",
    );
    expect(phoneLocationLine({ lat: 42.6526, lng: -73.7562 })).toContain(
      "outside the cities we cover",
    );
  });
});

describe("what a place search found", () => {
  test("the named restaurant, among near-misses and the area it's in", () => {
    const match = classifyPlaceMatches("Lola 42 Seaport", [SEAPORT_AREA, LOLA_42, SEAPORT_HOTEL]);
    expect(match).toEqual({ kind: "found", place: LOLA_42, nameMatched: true });
  });

  test("a stretched spelling is the same name, and the named area picks the location", () => {
    const match = classifyPlaceMatches("Moo steakhouse in Seaport Boston", [
      MOOO_BEACON_HILL,
      MOOO_SEAPORT,
    ]);
    expect(match).toEqual({ kind: "found", place: MOOO_SEAPORT, nameMatched: true });
  });

  test("a tapped choice resolves to exactly that location (its reply round-trips)", () => {
    // Review finding: the address words were read as part of the name, so
    // "Mooo...., 15 Beacon St" came back as the OTHER branch, "closest".
    for (const [picked, other] of [
      [MOOO_BEACON_HILL, MOOO_SEAPORT],
      [MOOO_SEAPORT, MOOO_BEACON_HILL],
    ] as const) {
      expect(classifyPlaceMatches(choiceReply(picked), [other, picked])).toEqual({
        kind: "found",
        place: picked,
        nameMatched: true,
      });
    }
  });

  test("two locations and no area to tell them apart → choices, not a guess", () => {
    const match = classifyPlaceMatches("Moo steakhouse", [MOOO_BEACON_HILL, MOOO_SEAPORT]);
    expect(match.kind).toBe("ambiguous");
    expect(match.kind === "ambiguous" && match.choices).toEqual([MOOO_BEACON_HILL, MOOO_SEAPORT]);
  });

  test("an area name is the area, not a hotel that contains it", () => {
    const match = classifyPlaceMatches("Seaport", [SEAPORT_HOTEL, SEAPORT_AREA]);
    expect(match).toEqual({ kind: "found", place: SEAPORT_AREA, nameMatched: true });
  });

  test("a search that only found the neighborhood says so (the silent 'Seaport center' fallback)", () => {
    const match = classifyPlaceMatches("Lola 42 Seaport", [SEAPORT_AREA]);
    expect(match).toEqual({ kind: "found", place: SEAPORT_AREA, nameMatched: false });
  });

  test("the same place listed twice is one place", () => {
    const dup = { ...LOLA_42, lat: LOLA_42.lat + 0.0005 };
    expect(metersBetween(LOLA_42.lat, LOLA_42.lng, dup.lat, dup.lng)).toBeLessThan(250);
    expect(classifyPlaceMatches("Lola 42", [LOLA_42, dup])).toEqual({
      kind: "found",
      place: LOLA_42,
      nameMatched: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Apple Maps Server API adapter
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CONFIG = { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: P8 };

/** A /v1/search result row, Apple's shape. */
function applePlace(p: GeocodeResult) {
  return {
    name: p.name,
    coordinate: { latitude: p.lat, longitude: p.lng },
    formattedAddressLines: [p.address ?? "", "Boston, MA 02210", "United States"],
    structuredAddress: {
      locality: "Boston",
      subLocality: p.area,
      fullThoroughfare: p.address,
      dependentLocalities: p.area ? [p.area] : [],
    },
    ...(p.kind === "poi" ? { poiCategory: p.category ?? "Restaurant" } : {}),
    country: "United States",
    countryCode: "US",
  };
}

interface Recorded {
  url: URL;
  auth: string | null;
}

function fakeApple(searchBodies: (url: URL, call: number) => { status: number; body: unknown }): {
  fetchFn: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let searches = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    if (url.pathname === "/v1/token") {
      return new Response(
        JSON.stringify({ accessToken: `access-${calls.length}`, expiresInSeconds: 1800 }),
        {
          status: 200,
        },
      );
    }
    const { status, body } = searchBodies(url, searches);
    searches += 1;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("Apple Maps Server API adapter", () => {
  test("the Maps auth token is ES256-signed with the key and carries the server_api scope", () => {
    const token = makeMapsAuthToken(CONFIG, Date.UTC(2026, 8, 25, 23, 0, 0));
    const [h, p, sig] = token.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(claims.iss).toBe("TEAM123456");
    expect(claims.scope).toBe("server_api");
    expect(claims.exp).toBeGreaterThan(claims.iat);
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      {
        key: createPublicKey(publicKey.export({ type: "spki", format: "pem" })),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(sig!, "base64url"),
    );
    expect(ok).toBe(true);
  });

  test("trades the token once, then searches the biased city around the given point", async () => {
    const { fetchFn, calls } = fakeApple(() => ({
      status: 200,
      body: { results: [applePlace(LOLA_42)] },
    }));
    const apple = new AppleMapsGeocoder(CONFIG, { fetchFn });
    const q: GeocodeQuery = {
      query: "Lola 42 Seaport",
      city: "bos",
      userLocation: BRAINTREE,
    };
    const first = await apple.geocode(q);
    const second = await apple.geocode({ ...q, query: "Lola 42" });
    expect(first.ok && first.results[0]).toMatchObject({
      name: "LoLa 42",
      address: "22 Liberty Dr",
      area: "Seaport",
      kind: "poi",
      city: "bos",
      source: "apple_maps",
    });
    expect(second.ok).toBe(true);
    // One token exchange serves both searches.
    expect(calls.filter((c) => c.url.pathname === "/v1/token")).toHaveLength(1);
    const token = calls.find((c) => c.url.pathname === "/v1/token")!;
    expect(token.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const search = calls.find((c) => c.url.pathname === "/v1/search")!;
    expect(search.auth).toBe("Bearer access-1");
    expect(search.url.searchParams.get("q")).toBe("Lola 42 Seaport");
    expect(search.url.searchParams.get("limitToCountries")).toBe("US");
    expect(search.url.searchParams.get("resultTypeFilter")).toBe("Poi,Address");
    // A Braintree phone searches around the city, with the phone as a hint.
    expect(search.url.searchParams.get("searchLocation")).toBe("42.3555,-71.0655");
    expect(search.url.searchParams.get("searchRegion")).toBe("42.43,-70.98,42.29,-71.19");
    expect(search.url.searchParams.get("userLocation")).toBe("42.2206,-71.0041");
  });

  test("drops results outside the covered metros", async () => {
    const elsewhere = { ...LOLA_42, lat: 41.2, lng: -70.1, name: "LoLa 41 Nantucket" };
    const { fetchFn } = fakeApple(() => ({
      status: 200,
      body: { results: [applePlace(elsewhere), applePlace(LOLA_42)] },
    }));
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn }).geocode({
      query: "Lola",
      city: "bos",
    });
    expect(outcome.ok && outcome.results.map((r) => r.name)).toEqual(["LoLa 42"]);
  });

  test("a 401 on search refreshes the access token once and retries", async () => {
    const { fetchFn, calls } = fakeApple((_url, call) =>
      call === 0
        ? { status: 401, body: {} }
        : { status: 200, body: { results: [applePlace(LOLA_42)] } },
    );
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn }).geocode({
      query: "Lola 42",
      city: "bos",
    });
    expect(outcome.ok && outcome.results).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname === "/v1/token")).toHaveLength(2);
  });

  test("a failure is a typed ok:false, never a throw", async () => {
    const { fetchFn } = fakeApple(() => ({ status: 429, body: { error: { message: "quota" } } }));
    const outcome = await new AppleMapsGeocoder(CONFIG, { fetchFn }).geocode({
      query: "Lola 42",
      city: "bos",
    });
    expect(outcome).toEqual({ ok: false, reason: "apple maps 429" });
  });
});

describe("the geocoder chain", () => {
  const answers = (results: GeocodeResult[]): GeocoderProvider => ({
    geocode: async () => ({ ok: true, results }),
  });
  const fails: GeocoderProvider = { geocode: async () => ({ ok: false, reason: "down" }) };

  test("Apple down → Nominatim answers", async () => {
    const outcome = await new FallbackGeocoder([fails, answers([SEAPORT_AREA])]).geocode({
      query: "Seaport",
    });
    expect(outcome).toEqual({ ok: true, results: [SEAPORT_AREA] });
  });

  test("Apple found nothing → Nominatim is still asked", async () => {
    const outcome = await new FallbackGeocoder([answers([]), answers([SEAPORT_AREA])]).geocode({
      query: "Seaport",
    });
    expect(outcome).toEqual({ ok: true, results: [SEAPORT_AREA] });
  });

  test("only every source failing is a failure", async () => {
    expect(await new FallbackGeocoder([fails, fails]).geocode({ query: "x" })).toEqual({
      ok: false,
      reason: "down; down",
    });
    expect(await new FallbackGeocoder([fails, answers([])]).geocode({ query: "x" })).toEqual({
      ok: true,
      results: [],
    });
  });
});

// ---------------------------------------------------------------------------
// geocode_place and ask_user
// ---------------------------------------------------------------------------

/** A geocoder that records each query and answers from a table keyed by
 * (city bias, lowercased query) — what a biased search would find. */
function recordingGeocoder(table: Record<string, GeocodeResult[]>) {
  const queries: GeocodeQuery[] = [];
  const geocoder: GeocoderProvider = {
    async geocode(q) {
      queries.push(q);
      const key = `${q.city ?? "any"}:${q.query.trim().toLowerCase()}`;
      return { ok: true, results: table[key] ?? [] };
    },
  };
  return { geocoder, queries };
}

function tools(geocoder: GeocoderProvider) {
  return new AssistantTools({
    db: makeFakeDb().db,
    policy: makePolicyService(),
    findCandidates: async () => [],
    garage: {
      id: "none",
      canReserve: false,
      search: async () => ({ ok: true, options: [], fromCache: false }),
      optionById: () => null,
      book: async () => {
        throw new Error("no");
      },
    },
    geocoder,
  });
}

let ctx: ToolContext;
beforeEach(() => {
  ctx = { userId: "u1", conversationId: "c1", location: BRAINTREE };
});

describe("geocode_place", () => {
  test("from Braintree, 'Seaport' is Boston's — one place, no city question", async () => {
    const { geocoder, queries } = recordingGeocoder({
      "bos:seaport": [SEAPORT_AREA],
      // Unbiased, it's two cities' Seaports: the device test's question.
      "any:seaport": [SEAPORT_AREA, { ...SEAPORT_AREA, lat: 40.7072, lng: -74.0027, city: "nyc" }],
    });
    const out = await tools(geocoder).execute(ctx, "geocode_place", { query: "Seaport" });
    expect(queries[0]).toMatchObject({ query: "Seaport", city: "bos", userLocation: BRAINTREE });
    // Outside the box: search around the city, not around Braintree.
    expect(queries[0]!.near).toBeUndefined();
    expect(out.result).toMatchObject({ found: true, match: "exact", place: { city: "bos" } });
    expect(ctx.geocode).toEqual({ lat: SEAPORT_AREA.lat, lng: SEAPORT_AREA.lng, label: "Seaport" });
  });

  test("a phone inside the city searches around the phone", async () => {
    const inside = { lat: 42.3505, lng: -71.0495 };
    const { geocoder, queries } = recordingGeocoder({ "bos:lola 42": [LOLA_42] });
    await tools(geocoder).execute({ ...ctx, location: inside }, "geocode_place", {
      query: "Lola 42",
    });
    expect(queries[0]).toMatchObject({ city: "bos", near: inside });
  });

  test("a POI resolves to the place, labelled with its neighborhood", async () => {
    const { geocoder } = recordingGeocoder({ "bos:lola 42 seaport": [SEAPORT_AREA, LOLA_42] });
    const out = await tools(geocoder).execute(ctx, "geocode_place", { query: "Lola 42 Seaport" });
    expect(out.result).toMatchObject({
      found: true,
      match: "exact",
      place: { name: "LoLa 42", address: "22 Liberty Dr", area: "Seaport", kind: "poi" },
    });
    expect(ctx.geocode?.label).toBe("LoLa 42, Seaport");
  });

  test("several matches → choices to tap, remembered for the loop", async () => {
    const { geocoder } = recordingGeocoder({
      "bos:moo steakhouse": [MOOO_BEACON_HILL, MOOO_SEAPORT],
    });
    const out = await tools(geocoder).execute(ctx, "geocode_place", { query: "Moo steakhouse" });
    const result = out.result as {
      ambiguous: boolean;
      choices: { label: string; reply: string }[];
    };
    expect(result.ambiguous).toBe(true);
    expect(result.choices.map((c) => c.label)).toEqual([
      "Mooo.... · 15 Beacon St, Beacon Hill",
      "Mooo.... · 49 Melcher St, Seaport",
    ]);
    expect(result.choices.map((c) => c.reply)).toEqual([
      "Mooo...., 15 Beacon St",
      "Mooo...., 49 Melcher St",
    ]);
    expect(ctx.placeChoices).toHaveLength(2);
    // Nothing grounded yet: the card must not pin a guess.
    expect(ctx.geocode).toBeUndefined();
  });

  test("only the neighborhood found → match 'closest' and an instruction to say so", async () => {
    const { geocoder } = recordingGeocoder({ "bos:moo steakhouse seaport": [SEAPORT_AREA] });
    const out = await tools(geocoder).execute(ctx, "geocode_place", {
      query: "Moo steakhouse Seaport",
    });
    const result = out.result as { match: string; instruction: string };
    expect(result.match).toBe("closest");
    expect(result.instruction).toContain('couldn\'t find "Moo steakhouse Seaport"');
    expect(result.instruction).toContain("Never present Seaport as the place they named");
  });

  test("nothing found → ask for the address; no 'isn't in our cities', no city question", async () => {
    const { geocoder } = recordingGeocoder({});
    const out = await tools(geocoder).execute(ctx, "geocode_place", { query: "Lola 42" });
    const result = out.result as { found: boolean; instruction: string };
    expect(result.found).toBe(false);
    expect(result.instruction).toContain("street address or a cross street");
    expect(result.instruction).toContain("don't ask which city — the phone is in or near Boston");
    expect(result.instruction).not.toContain("isn't in");
  });
});

describe("ask_user", () => {
  test("a valid question ends the turn with its suggestions", async () => {
    const out = await tools(recordingGeocoder({}).geocoder).execute(ctx, "ask_user", {
      question: "Which Mooo?",
      suggestions: [
        { label: "Beacon Hill", reply: "Mooo...., 15 Beacon St" },
        { label: "Seaport", reply: "Mooo...., 49 Melcher St" },
      ],
    });
    expect(out.ask).toEqual({
      question: "Which Mooo?",
      suggestions: [
        { label: "Beacon Hill", reply: "Mooo...., 15 Beacon St" },
        { label: "Seaport", reply: "Mooo...., 49 Melcher St" },
      ],
    });
  });

  test("a question with one suggestion bounces back to the model", async () => {
    const out = await tools(recordingGeocoder({}).geocoder).execute(ctx, "ask_user", {
      question: "When?",
      suggestions: [{ label: "Now", reply: "now" }],
    });
    expect(out.ask).toBeUndefined();
    expect(out.result).toMatchObject({ error: "invalid ask" });
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function scripted(responses: ModelResponse[]): ModelClient & { seen: ModelTurn[][] } {
  let call = 0;
  const seen: ModelTurn[][] = [];
  return {
    seen,
    async create(args) {
      seen.push(structuredClone(args.messages));
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return response;
    },
  };
}

const tool = (id: string, name: string, input: unknown): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

describe("the loop", () => {
  test("the user's message carries the city the phone is in or near", async () => {
    const model = scripted([
      { content: [{ type: "text", text: "On it." }], stopReason: "end_turn" },
    ]);
    const { db } = makeFakeDb();
    await runAssistantTurn({
      db,
      model,
      tools: tools(recordingGeocoder({}).geocoder),
      userId: "u1",
      conversationId: "c-city",
      text: "Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours",
      location: BRAINTREE,
    });
    const first = model.seen[0]![0]!.content as string;
    expect(first).toContain("[phone location: 42.22060, -71.00410 — in or near Boston]");
  });

  test("ask_user ends the turn: the question is the reply, the chips ride along", async () => {
    const model = scripted([
      tool("t1", "ask_user", {
        question: "Which Mooo — Beacon Hill or Seaport?",
        suggestions: [
          { label: "Beacon Hill", reply: "Mooo...., 15 Beacon St" },
          { label: "Seaport", reply: "Mooo...., 49 Melcher St" },
        ],
      }),
      // Never reached: ask_user is terminal.
      { content: [{ type: "text", text: "SHOULD NOT APPEAR" }], stopReason: "end_turn" },
    ]);
    const { db } = makeFakeDb();
    const result = await runAssistantTurn({
      db,
      model,
      tools: tools(recordingGeocoder({}).geocoder),
      userId: "u1",
      conversationId: "c-ask",
      text: "near Moo steakhouse",
      location: BRAINTREE,
    });
    expect(model.seen).toHaveLength(1);
    expect(result.reply).toBe("Which Mooo — Beacon Hill or Seaport?");
    expect(result.suggestions).toEqual([
      { label: "Beacon Hill", reply: "Mooo...., 15 Beacon St" },
      { label: "Seaport", reply: "Mooo...., 49 Melcher St" },
    ]);
    expect(result.plan).toBeNull();
  });

  test("a model that asks in prose after an ambiguous search still gets the places as chips", async () => {
    const { geocoder } = recordingGeocoder({
      "bos:moo steakhouse": [MOOO_BEACON_HILL, MOOO_SEAPORT],
    });
    const model = scripted([
      tool("t1", "geocode_place", { query: "Moo steakhouse" }),
      { content: [{ type: "text", text: "There are two — which one?" }], stopReason: "end_turn" },
    ]);
    const { db } = makeFakeDb();
    const result = await runAssistantTurn({
      db,
      model,
      tools: tools(geocoder),
      userId: "u1",
      conversationId: "c-prose",
      text: "near Moo steakhouse",
      location: BRAINTREE,
    });
    expect(result.suggestions?.map((s) => s.reply)).toEqual([
      "Mooo...., 15 Beacon St",
      "Mooo...., 49 Melcher St",
    ]);
  });

  test("a plain answer carries no suggestions", async () => {
    const model = scripted([
      { content: [{ type: "text", text: "I only help with parking." }], stopReason: "end_turn" },
    ]);
    const { db } = makeFakeDb();
    const result = await runAssistantTurn({
      db,
      model,
      tools: tools(recordingGeocoder({}).geocoder),
      userId: "u1",
      conversationId: "c-plain",
      text: "what's the weather",
    });
    expect(result.suggestions).toBeNull();
  });
});

describe("POST /assistant/message", () => {
  test("the JSON answer carries the suggestions", async () => {
    const { app } = makeTestApp({
      assistantModel: scripted([
        tool("t1", "ask_user", {
          question: "How long will you stay?",
          suggestions: [
            { label: "1 hour", reply: "1 hour" },
            { label: "2 hours", reply: "2 hours" },
          ],
        }),
      ]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: { "x-api-key": API_KEY, "content-type": "application/json" },
      payload: { text: "park me near Fenway", location: BRAINTREE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestions).toEqual([
      { label: "1 hour", reply: "1 hour" },
      { label: "2 hours", reply: "2 hours" },
    ]);
  });
});

describe("review fixes: names people type", () => {
  const NEWBURY: GeocodeResult = {
    lat: 42.3503,
    lng: -71.0811,
    displayName: "Newbury Street, Back Bay",
    city: "bos",
    name: "Newbury Street",
    areaNames: ["Back Bay", "Boston"],
    kind: "area",
  };

  test("an abbreviation is the same street ('Newbury St' is Newbury Street)", () => {
    expect(classifyPlaceMatches("Newbury St", [NEWBURY])).toEqual({
      kind: "found",
      place: NEWBURY,
      nameMatched: true,
    });
  });

  test("a neighborhood and a road of the same name in one city: the best-ranked, no question", () => {
    const neighborhood: GeocodeResult = {
      lat: 42.3429,
      lng: -71.1003,
      displayName: "Fenway, Fenway-Kenmore",
      city: "bos",
      name: "Fenway",
      area: "Fenway-Kenmore",
      kind: "area",
    };
    const road: GeocodeResult = {
      ...neighborhood,
      lat: 42.3401,
      lng: -71.1049,
      area: "Audubon Circle",
    };
    expect(classifyPlaceMatches("Fenway", [neighborhood, road])).toEqual({
      kind: "found",
      place: neighborhood,
      nameMatched: true,
    });
    // The same name in two cities is still a question.
    const elsewhere = {
      ...neighborhood,
      lat: 40.75,
      lng: -73.99,
      city: "nyc" as const,
      area: "Midtown",
    };
    expect(classifyPlaceMatches("Fenway", [neighborhood, elsewhere]).kind).toBe("ambiguous");
  });

  test("a long street's segments are one place, not three identical choices", () => {
    // Nominatim, live 2026-09-25: "Newbury St" came back as three Back Bay
    // segments more than 250 m apart.
    const segments = [0, 0.004, 0.008].map((d) => ({ ...NEWBURY, lng: NEWBURY.lng + d }));
    expect(classifyPlaceMatches("Newbury St", segments)).toEqual({
      kind: "found",
      place: segments[0],
      nameMatched: true,
    });
  });

  test("a name with a neighborhood in it keeps it ('Fenway Park', not any park in Fenway)", () => {
    const park: GeocodeResult = {
      lat: 42.3467,
      lng: -71.0972,
      displayName: "Fenway Park, 4 Jersey St, Fenway",
      city: "bos",
      name: "Fenway Park",
      address: "4 Jersey St",
      area: "Fenway",
      areaNames: ["Boston", "Fenway"],
      kind: "poi",
    };
    const garage: GeocodeResult = {
      ...park,
      lat: 42.3441,
      lng: -71.1003,
      name: "Park Drive Garage",
      displayName: "Park Drive Garage, Fenway",
      address: "100 Park Dr",
    };
    expect(classifyPlaceMatches("Fenway Park", [garage, park])).toEqual({
      kind: "found",
      place: park,
      nameMatched: true,
    });
  });
});

describe("independent review fixes: the chain", () => {
  test("a first source whose results don't carry the name hands over to the next", async () => {
    const fuzzy: GeocodeResult = { ...SEAPORT_HOTEL };
    const chain = new FallbackGeocoder(
      [
        { geocode: async () => ({ ok: true, results: [fuzzy] }) },
        { geocode: async () => ({ ok: true, results: [LOLA_42] }) },
      ],
      (query, results) => {
        const match = classifyPlaceMatches(query, results);
        return match.kind !== "found" || match.nameMatched;
      },
    );
    const outcome = await chain.geocode({ query: "Lola 42" });
    expect(outcome.ok && outcome.results).toEqual([fuzzy, LOLA_42]);
    expect(outcome.ok && classifyPlaceMatches("Lola 42", outcome.results)).toEqual({
      kind: "found",
      place: LOLA_42,
      nameMatched: true,
    });
  });

  test("a later search that found the place clears an earlier search's choices", async () => {
    const { geocoder } = recordingGeocoder({
      "bos:moo steakhouse": [MOOO_BEACON_HILL, MOOO_SEAPORT],
      "bos:mooo...., 49 melcher st": [MOOO_SEAPORT],
    });
    const t = tools(geocoder);
    await t.execute(ctx, "geocode_place", { query: "Moo steakhouse" });
    expect(ctx.placeChoices).toHaveLength(2);
    await t.execute(ctx, "geocode_place", { query: "Mooo...., 49 Melcher St" });
    expect(ctx.placeChoices).toBeUndefined();
  });
});
