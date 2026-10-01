/**
 * FR-43: searches read the request, and the server says no.
 *
 * quote_street and search_garages take no arguments any more: the place,
 * the window, the limits, and the ranking come from the conversation's
 * RequestState, so a constraint can't be dropped on the way into a search.
 * Each result says which options meet every limit (`satisfying`, already
 * ranked), which came close and what they break (`nearMisses`), and — when
 * nothing meets the request — what relaxing one limit a step would yield.
 * "Nothing meets this" is a card of its own (`none_meets`), decided by the
 * server; "we have no data here" is a different one (`no_data`).
 *
 * Decision 8 (docs/decisions/2026-09-29-v1-scope.md): with no ask, the
 * cheapest and the closest both lead; an explicit ask decides the first
 * option and the other axis is an alternative, never the recommendation.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse } from "../src/services/assistant/loop.js";
import type { GeocodeResult, GeocoderProvider } from "../src/services/assistant/geocoder.js";
import { orderForRequest, rankOptions } from "../src/services/assistant/streetOptions.js";
import { TOOL_DEFINITIONS } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import type { NearbyZone } from "../src/services/zoneLookup.js";
import { API_KEY, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

/** Cambridge Common: inside the Boston box. The test clock is Monday
 * 2026-01-05, 2 PM ET (helpers.ts), meters running. */
const COMMON = { lat: 42.3765, lng: -71.119 };
const MON_SAT_8_TO_8 = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];

function zone(zoneId: string, street: string, ratePerHour: number, distanceM: number): NearbyZone {
  return {
    zoneId,
    city: "bos",
    providerZoneNumber: "",
    street,
    rateFirstHourUsd: ratePerHour,
    rateAdditionalHourUsd: ratePerHour,
    maxStayMinutes: 240,
    hours: MON_SAT_8_TO_8,
    distanceM,
    containsPoint: false,
    centerline: [
      [
        [COMMON.lng, COMMON.lat + distanceM / 111_000],
        [COMMON.lng + 0.001, COMMON.lat + distanceM / 111_000],
      ],
    ],
  };
}

/** One hour: $4.15 + Boston's $0.35 fee = $4.50; $5.65 + $0.35 = $6.00. */
const MASS_AVE = zone("bos-mass-ave-1", "MASS AVE", 4.15, 300);
const GARDEN_ST = zone("bos-garden-st-1", "GARDEN ST", 5.65, 150);

function garageOption(overrides: Partial<GarageOption> & { id: string }): GarageOption {
  return {
    provider: "spothero",
    name: `Garage ${overrides.id}`,
    address: `${overrides.id} Test St`,
    priceUsd: 18,
    distanceM: 200,
    walkMinutes: 3,
    entryType: "self",
    deepLink: `https://spothero.com/checkout/${overrides.id}`,
    lat: COMMON.lat + 0.001,
    lng: COMMON.lng,
    ...overrides,
  };
}

function garages(options: GarageOption[]): GarageProvider & { searches: number } {
  const provider = {
    id: "spothero",
    canReserve: false,
    searches: 0,
    search: async () => {
      provider.searches += 1;
      return { ok: true as const, options, fromCache: false };
    },
    optionById: (id: string) => options.find((o) => o.id === id) ?? null,
    book: async (id: string) => {
      const option = options.find((o) => o.id === id);
      if (!option) throw new Error("unknown option");
      return { kind: "deeplink_handoff" as const, option, deepLink: option.deepLink };
    },
  };
  return provider;
}

/** A garage source that is down: thrown, or the adapters' typed failure. */
function brokenGarages(how: "throws" | "typed"): GarageProvider {
  return {
    id: "spothero+parkwhiz",
    canReserve: false,
    search: async () => {
      if (how === "throws") throw new Error("socket hang up");
      return { ok: false as const, error: "network" as const, detail: "ECONNRESET" };
    },
    optionById: () => null,
    book: async () => {
      throw new Error("unreachable");
    },
  };
}

function scriptedModel(responses: ModelResponse[]): ModelClient & { calls: number } {
  const model = {
    calls: 0,
    async create() {
      const response = responses[Math.min(model.calls, responses.length - 1)]!;
      model.calls += 1;
      return response;
    },
  };
  return model as ModelClient & { calls: number };
}

const use = (id: string, name: string, input: unknown = {}): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const say = (text: string): ModelResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

interface Violation {
  field: string;
  actual: unknown;
  limit: unknown;
}
interface Option {
  id: string;
  type: "street" | "garage";
  priceUsd: number;
  walkMinutes: number;
  axis?: string;
  secondary?: boolean;
  fetchedAt?: string;
}
interface Search {
  stateVersion: number;
  verdict: string;
  satisfying: Option[];
  nearMisses: { option: Option; violates: Violation[] }[];
  relaxSuggestions?: { field: string; to: unknown; wouldYield: number }[];
  error?: string;
}

/** A turn's context. `null` is a phone that sent no location. */
const ctxAt = (location: { lat: number; lng: number } | null = COMMON): ToolContext => ({
  userId: "u1",
  conversationId: "c1",
  ...(location ? { location } : {}),
});

describe("the searches read the request, not arguments", () => {
  test("quote_street and search_garages are strict and take only an optional note", () => {
    for (const name of ["quote_street", "search_garages"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      expect(tool.strict, name).toBe(true);
      const schema = tool.input_schema as {
        additionalProperties: boolean;
        required?: string[];
        properties: Record<string, { type: string }>;
      };
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.required ?? [], name).toEqual([]);
      expect(Object.keys(schema.properties), name).toEqual(["note"]);
      expect(schema.properties["note"]!.type, name).toBe("string");
    }
  });

  test("arguments a model still sends change nothing: the search is the request's", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    // The old shape: another point, another stay, a budget. All ignored.
    const out = await tools.execute(ctx, "quote_street", {
      lat: 40.7,
      lng: -74,
      duration_minutes: 720,
      when: "2030-01-01T09:00:00-05:00",
    });
    const search = out.result as Search & { window: { durationMinutes: number } };
    expect(search.stateVersion).toBe(1);
    expect(search.window.durationMinutes).toBe(60);
    expect(search.satisfying.map((o) => [o.id, o.priceUsd])).toEqual([
      ["v1-bos-mass-ave-1", 4.5],
      ["v1-bos-garden-st-1", 6],
    ]);
  });
});

describe("nothing meets the request", () => {
  test("a $2 cap near $4.50 and $6.00 blocks: no satisfying option, two near-misses, and what relaxing would yield", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 2, durationMinutes: 60 });

    const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(search.stateVersion).toBe(1);
    expect(search.satisfying).toEqual([]);
    expect(search.nearMisses.map((n) => [n.option.id, n.option.priceUsd, n.violates])).toEqual([
      ["v1-bos-mass-ave-1", 4.5, [{ field: "maxPriceUsd", actual: 4.5, limit: 2 }]],
      ["v1-bos-garden-st-1", 6, [{ field: "maxPriceUsd", actual: 6, limit: 2 }]],
    ]);
    expect(search.relaxSuggestions).toContainEqual(
      expect.objectContaining({ field: "maxPriceUsd", to: 7, wouldYield: 2 }),
    );

    // A near-miss shown as a plain option is a hard-constraint violation…
    const plain = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1", recommended: true }] },
    });
    expect((plain.result as { error: string }).error).toBe("hard_constraint_violation");
    // …and flagged honestly it still isn't a plan: the server says no.
    const flagged = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v1-bos-mass-ave-1", nearMiss: true, recommended: true }],
      },
    });
    expect((flagged.result as { error: string }).error).toBe("must_say_no");
    expect(t.state.assistantPlans).toHaveLength(0);
    expect(t.state.decisions.map((d) => d.rule)).toEqual(
      expect.arrayContaining(["hard_constraint_violation", "must_say_no"]),
    );

    const no = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    expect(no.endTurn).toBeDefined();
    const plan = no.endTurn!.plan as unknown as {
      kind: string;
      constraintsFailed: { field: string; limit: number; nearestActual: number }[];
      nearMisses: (Option & { nearMiss: boolean; violates: Violation[]; zoneId: string })[];
      relaxSuggestions: { field: string; to: number; wouldYield: number; reply: string }[];
    };
    expect(plan.kind).toBe("none_meets");
    expect(plan.constraintsFailed).toEqual([
      { field: "maxPriceUsd", limit: 2, nearestActual: 4.5 },
    ]);
    expect(plan.nearMisses.map((o) => [o.zoneId, o.priceUsd, o.nearMiss, o.violates])).toEqual([
      ["bos-mass-ave-1", 4.5, true, [{ field: "maxPriceUsd", actual: 4.5, limit: 2 }]],
      ["bos-garden-st-1", 6, true, [{ field: "maxPriceUsd", actual: 6, limit: 2 }]],
    ]);
    expect(plan.relaxSuggestions).toContainEqual(
      expect.objectContaining({ field: "maxPriceUsd", to: 7, wouldYield: 2 }),
    );
    // Stored as its own kind, on the record under its own rule.
    expect(t.state.assistantPlans.map((p) => p.kind)).toEqual(["none_meets"]);
    expect(t.state.decisions.find((d) => d.kind === "assistant_plan")).toMatchObject({
      rule: "none_meets",
    });
  });

  test("the model's own violates are discarded: the card's are the server's", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 2, durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const no = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "none_meets",
        nearMissIds: ["v1-bos-mass-ave-1"],
        // Not in the schema; a model that sends them anyway changes nothing.
        constraintsFailed: [{ field: "maxPriceUsd", limit: 5, nearestActual: 4.5 }],
        nearMisses: [{ id: "v1-bos-mass-ave-1", priceUsd: 1.5, violates: [] }],
      },
    });
    const plan = no.endTurn!.plan as unknown as {
      constraintsFailed: unknown[];
      nearMisses: { priceUsd: number; violates: Violation[] }[];
    };
    expect(plan.constraintsFailed).toEqual([
      { field: "maxPriceUsd", limit: 2, nearestActual: 4.5 },
    ]);
    expect(plan.nearMisses).toHaveLength(1);
    expect(plan.nearMisses[0]).toMatchObject({
      priceUsd: 4.5,
      violates: [{ field: "maxPriceUsd", actual: 4.5, limit: 2 }],
    });
  });

  test("a none_meets while options exist is refused: options_available", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 5, durationMinutes: 60 });
    const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(search.satisfying.map((o) => o.id)).toEqual(["v1-bos-mass-ave-1"]);
    expect(search.nearMisses.map((n) => n.option.id)).toEqual(["v1-bos-garden-st-1"]);
    expect(search.relaxSuggestions).toBeUndefined();

    const no = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    expect(no.result).toMatchObject({ error: "options_available" });
    expect(no.endTurn).toBeUndefined();
    expect(t.state.assistantPlans).toHaveLength(0);
    expect(t.state.decisions.some((d) => d.rule === "options_available")).toBe(true);
  });

  test("the verdict is never taken on half a search: an unsearched garage that fits makes it options_available", async () => {
    const cheap = garageOption({ id: "g-cheap", priceUsd: 1.5 });
    const garage = garages([cheap]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], garage });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 2, durationMinutes: 60 });
    // Street only: nothing under $2 there.
    const street = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(street.satisfying).toEqual([]);
    expect(garage.searches).toBe(0);

    const no = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    expect(garage.searches).toBe(1);
    const refused = no.result as { error: string; satisfying: Option[] };
    expect(refused.error).toBe("options_available");
    expect(refused.satisfying.map((o) => o.id)).toEqual(["v1-g-cheap"]);
  });

  test("the loop itself says no when the model won't: after the one reminder, the none_meets card", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { maxPriceUsd: 2, durationMinutes: 60 }),
      use("q1", "quote_street"),
      say("There's a $4.50 meter on Mass Ave."),
      say("It's $4.50 on Mass Ave."),
      say("SHOULD NEVER RUN"),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "parking under $2 for an hour", location: COMMON },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // update, search, prose, reminded prose: four calls, no fifth.
    expect(model.calls).toBe(4);
    expect(body.plan.plan.kind).toBe("none_meets");
    expect(body.plan.plan.nearMisses).toHaveLength(2);
    // The reply is the server's sentence, not the model's quote.
    expect(body.reply).toContain("Nothing under $2.00");
    expect(body.reply).not.toContain("SHOULD NEVER RUN");
    // Relaxing is the user's to do: one tap each, in plain words.
    expect(body.suggestions).toContainEqual({
      label: "Allow up to $7.00",
      reply: "Allow up to $7.00",
    });
  });

  test("a reply that restates a near-miss as if it met the budget never reaches the user", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { maxPriceUsd: 2, durationMinutes: 60 }),
      use("q1", "quote_street"),
      {
        content: [
          { type: "text", text: "Great news: Mass Ave is $4.50, right within your budget!" },
          {
            type: "tool_use",
            id: "p1",
            name: "propose_plan",
            input: { plan: { kind: "none_meets" } },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "parking under $2 for an hour", location: COMMON },
    });
    const body = res.json();
    expect(body.plan.plan.kind).toBe("none_meets");
    expect(body.reply).not.toMatch(/within your budget|great news/i);
    expect(body.reply).toBe(body.plan.plan.headline);
    expect(body.reply).toContain("Nothing under $2.00");
    // The saved transcript shows what the user saw.
    const display = t.state.conversations[0]!.display as { role: string; text: string }[];
    expect(display.at(-1)!.text).toBe(body.reply);
  });

  test("the SSE plan event fires for a none_meets card", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { maxPriceUsd: 2, durationMinutes: 60 }),
      use("q1", "quote_street"),
      use("p1", "propose_plan", { plan: { kind: "none_meets" } }),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: { ...HEADERS, accept: "text/event-stream" },
      payload: { text: "parking under $2 for an hour", location: COMMON },
    });
    const events = res.body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event: "))
      .map((chunk) => {
        const [event, data] = chunk.split("\n");
        return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) };
      });
    const planEvent = events.find((e) => e.event === "plan");
    expect(planEvent?.data.plan.kind).toBe("none_meets");
    const done = events.find((e) => e.event === "done");
    expect(done?.data.plan.planId).toBe(planEvent?.data.planId);
  });

  test("there is nothing to confirm on a none_meets card: the tap is refused before any token is minted", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 2, durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const no = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    const planId = no.endTurn!.planId;
    for (const payload of [{ planId }, { planId, optionId: "v1-bos-mass-ave-1" }]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/assistant/confirm",
        headers: HEADERS,
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("nothing_to_confirm");
    }
    expect(t.state.assistantConfirmations).toHaveLength(0);
    expect(t.state.itineraries).toHaveLength(0);
    expect(t.state.assistantPlans[0]!.confirmedAt ?? null).toBeNull();
  });
});

describe("garage options", () => {
  test("a garage with no price is never offered, and is counted", async () => {
    const priced = garageOption({ id: "g-priced", priceUsd: 12 });
    const unpriced = garageOption({ id: "g-null", priceUsd: null as unknown as number });
    const t = makeTestApp({ garage: garages([unpriced, priced]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 20, durationMinutes: 60 });
    const search = (await tools.execute(ctx, "search_garages", {})).result as Search & {
      garage: { droppedNoPrice: number };
    };
    expect(search.satisfying.map((o) => o.id)).toEqual(["v1-g-priced"]);
    expect(search.nearMisses).toEqual([]);
    expect(search.garage.droppedNoPrice).toBe(1);
    // Not even by id: it was never in the search.
    const plan = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-g-null", recommended: true }] },
    });
    expect((plan.result as { error: string }).error).toBe("stale_or_unknown_option");
  });

  test("every garage option says when its price was fetched, on the search and on the card", async () => {
    const t = makeTestApp({ garage: garages([garageOption({ id: "g1", priceUsd: 12 })]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    const search = (await tools.execute(ctx, "search_garages", {})).result as Search;
    expect(search.satisfying[0]!.fetchedAt).toBe("2026-01-05T19:00:00.000Z");
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-g1", recommended: true }] },
    });
    const plan = out.endTurn!.plan as unknown as {
      options: { fetchedAt: string; deepLink: string }[];
      provenance: { provider: string; searchedAt: string };
    };
    expect(plan.options[0]).toMatchObject({
      fetchedAt: "2026-01-05T19:00:00.000Z",
      deepLink: "https://spothero.com/checkout/g1",
    });
    expect(plan.provenance).toMatchObject({
      provider: "spothero",
      searchedAt: "2026-01-05T19:00:00.000Z",
    });
  });
});

describe("tool failures", () => {
  for (const how of ["throws", "typed"] as const) {
    test(`garage search down (${how}) on a garage-only request: an unavailable card, no street substitute`, async () => {
      const model = scriptedModel([
        use("u1", "update_request", { kinds: ["garage"], durationMinutes: 60 }),
        use("s1", "search_garages"),
        say("SHOULD NEVER RUN"),
      ]);
      const t = makeTestApp({
        nearbyZones: [MASS_AVE, GARDEN_ST],
        garage: brokenGarages(how),
        assistantModel: model,
      });
      const res = await t.app.inject({
        method: "POST",
        url: "/assistant/message",
        headers: HEADERS,
        payload: { text: "find me a garage for an hour", location: COMMON },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(model.calls).toBe(2);
      const plan = body.plan.plan;
      expect(plan.kind).toBe("none_meets");
      expect(plan.constraintsFailed).toEqual([{ field: "garageSearch", reason: "unavailable" }]);
      // Zero street options: not as near-misses, not anywhere.
      expect(plan.nearMisses).toEqual([]);
      expect(JSON.stringify(plan)).not.toContain("bos-mass-ave-1");
      expect(body.reply).toMatch(/couldn't check garages/i);
      expect(body.reply).not.toContain("SHOULD NEVER RUN");
      expect(body.suggestions).toEqual([{ label: "Try again", reply: "Search garages again" }]);
      expect(t.state.decisions.some((d) => d.rule === "garage_search_error")).toBe(true);
    });
  }

  test("garage search down on a park-now request: the street card, with provenance.garage unavailable", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { durationMinutes: 60 }),
      {
        content: [
          { type: "tool_use", id: "q1", name: "quote_street", input: {} },
          { type: "tool_use", id: "s1", name: "search_garages", input: {} },
        ],
        stopReason: "tool_use",
      },
      use("p1", "propose_plan", {
        plan: {
          kind: "single_spot",
          options: [{ id: "v1-bos-mass-ave-1", recommended: true }, { id: "v1-bos-garden-st-1" }],
        },
      }),
    ]);
    const t = makeTestApp({
      nearbyZones: [MASS_AVE, GARDEN_ST],
      garage: brokenGarages("throws"),
      assistantModel: model,
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "park me for an hour", location: COMMON },
    });
    const plan = res.json().plan.plan;
    expect(plan.kind).toBe("single_spot");
    expect(plan.options.map((o: Option) => o.type)).toEqual(["street", "street"]);
    expect(plan.provenance).toMatchObject({ garage: "unavailable" });
    // The failure reached the model as a failure, not as "no garages".
    const turns = JSON.stringify(t.state.conversations[0]!.turns);
    expect(turns).toContain("garage search is unavailable");
  });

  test("a place that matched several: quote_street answers place_unresolved and the turn ends asking which, with the candidates", async () => {
    const mooo = (address: string, area: string, lat: number, lng: number): GeocodeResult => ({
      lat,
      lng,
      displayName: `Mooo...., ${address}, ${area}`,
      city: "bos",
      name: "Mooo....",
      address,
      area,
      areaNames: [area, "Boston"],
      kind: "poi",
    });
    const geocoder: GeocoderProvider = {
      geocode: async () => ({
        ok: true,
        results: [
          mooo("15 Beacon St", "Beacon Hill", 42.35826, -71.06187),
          mooo("49 Melcher St", "Seaport", 42.34945, -71.05034),
        ],
      }),
    };
    const model = scriptedModel([
      use("u1", "update_request", { placeQuery: "Moo steakhouse", durationMinutes: 120 }),
      use("q1", "quote_street"),
      say("SHOULD NEVER RUN"),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], geocoder, assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      // The phone is right there, and must not stand in for the place.
      payload: { text: "parking near Moo steakhouse", location: COMMON },
    });
    const body = res.json();
    expect(model.calls).toBe(2);
    expect(body.plan).toBeNull();
    expect(body.reply).toMatch(/\?$/);
    expect(body.suggestions.map((s: { reply: string }) => s.reply)).toEqual([
      "Mooo...., 15 Beacon St",
      "Mooo...., 49 Melcher St",
    ]);
    // What the model was told, and what the request now holds.
    const turns = JSON.stringify(t.state.conversations[0]!.turns);
    expect(turns).toContain("place_unresolved");
    const stored = t.state.conversations[0]!.requestState as {
      place: { resolved: unknown; candidates: { reply: string }[] };
    };
    expect(stored.place.resolved).toBeNull();
    expect(stored.place.candidates.map((c) => c.reply)).toEqual([
      "Mooo...., 15 Beacon St",
      "Mooo...., 49 Melcher St",
    ]);
    expect(t.state.decisions.some((d) => d.rule === "place_unresolved")).toBe(true);
  });

  test("tapping one of the places answers the question for good: the next turn searches there, whatever the model does", async () => {
    const mooo = (address: string, area: string, lat: number, lng: number): GeocodeResult => ({
      lat,
      lng,
      displayName: `Mooo...., ${address}, ${area}`,
      city: "bos",
      name: "Mooo....",
      address,
      area,
      areaNames: [area, "Boston"],
      kind: "poi",
    });
    let lookups = 0;
    const geocoder: GeocoderProvider = {
      geocode: async () => {
        lookups += 1;
        return {
          ok: true,
          results: [
            mooo("15 Beacon St", "Beacon Hill", 42.35826, -71.06187),
            mooo("49 Melcher St", "Seaport", 42.34945, -71.05034),
          ],
        };
      },
    };
    const model = scriptedModel([
      use("u1", "update_request", { placeQuery: "Moo steakhouse", durationMinutes: 60 }),
      use("q1", "quote_street"),
      // Next turn the model does nothing about the tap: it just searches.
      use("q2", "quote_street"),
      use("p1", "propose_plan", {
        plan: { kind: "single_spot", options: [{ id: "v3-bos-mass-ave-1" }] },
      }),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], geocoder, assistantModel: model });
    const asked = (
      await t.app.inject({
        method: "POST",
        url: "/assistant/message",
        headers: HEADERS,
        payload: { text: "parking near Moo steakhouse", location: COMMON },
      })
    ).json();
    expect(lookups).toBe(1);
    const tap = asked.suggestions[1] as { label: string; reply: string };
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: tap.reply, conversation_id: asked.conversationId, location: COMMON },
    });
    // No second lookup: the place came from the request's own candidates.
    expect(lookups).toBe(1);
    const stored = t.state.conversations[0]!.requestState as {
      place: {
        query: string;
        resolved: { lat: number; lng: number; label: string };
        candidates: null;
      };
      log: { field: string; utterance: string }[];
    };
    expect(stored.place.resolved).toMatchObject({
      lat: 42.34945,
      lng: -71.05034,
      label: tap.label,
    });
    expect(stored.place.candidates).toBeNull();
    expect(stored.log.at(-1)).toMatchObject({ utterance: "Mooo...., 49 Melcher St" });
    // The search ran at the place tapped — not asked again, not at the phone.
    const plan = res.json().plan.plan;
    expect(plan.destination).toMatchObject({ lat: 42.34945, lng: -71.05034 });
    expect(res.json().suggestions ?? []).not.toContainEqual(tap);
  });

  test("the question a search asks is the server's own words: a place with a price in its name isn't scrubbed away", async () => {
    const geocoder: GeocoderProvider = { geocode: async () => ({ ok: true, results: [] }) };
    const model = scriptedModel([
      use("u1", "update_request", { placeQuery: "the $5 lot", durationMinutes: 60 }),
      use("q1", "quote_street"),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], geocoder, assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "park me at the $5 lot", location: COMMON },
    });
    expect(res.json().reply).toBe(
      "I couldn't find \"the $5 lot\". What's its address or a nearby cross street?",
    );
    expect(res.json().plan).toBeNull();
    expect(t.state.decisions.some((d) => d.rule === "ungrounded_number")).toBe(false);
  });

  test("no place and no phone location: place_unresolved, and the question asks where", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const out = await t.deps.assistantTools!.execute(ctxAt(null), "quote_street", {});
    expect(out.result).toMatchObject({ error: "place_unresolved" });
    expect(out.ask?.question).toMatch(/where/i);
    expect(out.ask?.suggestions).toEqual([]);
  });

  test("the geocoder is down on a park-now request with a phone location: the search goes ahead there, said as an assumption", async () => {
    const geocoder: GeocoderProvider = {
      geocode: async () => ({ ok: false, reason: "HTTP 500" }),
    };
    const t = makeTestApp({ nearbyZones: [MASS_AVE], geocoder });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { placeQuery: "Lola 42", durationMinutes: 60 });
    const out = await tools.execute(ctx, "quote_street", {});
    const search = out.result as Search & { place: { source: string }; instruction: string };
    expect(search.error).toBeUndefined();
    expect(search.place.source).toBe("default");
    expect(search.satisfying.map((o) => o.id)).toEqual([`v${search.stateVersion}-bos-mass-ave-1`]);
    expect(search.instruction).toMatch(/couldn't look up/i);
    // The request records nothing it didn't resolve.
    expect(ctx.requestState!.place.resolved).toBeNull();
  });

  test("the geocoder is down on a park-later request: no guess, the turn asks for the address", async () => {
    const geocoder: GeocoderProvider = {
      geocode: async () => ({ ok: false, reason: "HTTP 500" }),
    };
    const t = makeTestApp({ nearbyZones: [MASS_AVE], geocoder });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", {
      placeQuery: "Lola 42",
      startsAt: "2026-01-05T19:00:00-05:00",
      durationMinutes: 60,
    });
    const out = await tools.execute(ctx, "quote_street", {});
    expect(out.result).toMatchObject({ error: "place_unresolved" });
    expect(out.ask?.question).toMatch(/address|cross street/i);
  });
});

describe("no data is not a no", () => {
  /** Blocks our data has, but past the 800 m the search will walk. */
  const FAR = [
    zone("bos-far-1", "BRATTLE ST", 3.75, 900),
    zone("bos-far-2", "CHURCH ST", 3.75, 1100),
    zone("bos-far-3", "JFK ST", 3.75, 1300),
    zone("bos-far-4", "MT AUBURN ST", 3.75, 1700),
  ];

  test("empty results inside coverage with no limit set: a no_zone_here card naming the nearest three zones", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { durationMinutes: 60 }),
      {
        content: [
          { type: "tool_use", id: "q1", name: "quote_street", input: {} },
          { type: "tool_use", id: "s1", name: "search_garages", input: {} },
        ],
        stopReason: "tool_use",
      },
      use("p1", "propose_plan", { plan: { kind: "none_meets" } }),
    ]);
    const t = makeTestApp({ nearbyZones: FAR, assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "park me for an hour", location: COMMON },
    });
    const plan = res.json().plan.plan;
    // Never a none_meets: nothing was refused, there was nothing to refuse.
    expect(plan.kind).toBe("no_data");
    expect(plan.rule).toBe("no_zone_here");
    expect(plan.nearestZones.map((z: { zoneId: string }) => z.zoneId)).toEqual([
      "bos-far-1",
      "bos-far-2",
      "bos-far-3",
    ]);
    expect(plan.nearestZones[0]).toMatchObject({ street: "Brattle St", distanceM: 900 });
    expect(t.state.decisions.find((d) => d.kind === "assistant_plan")).toMatchObject({
      rule: "no_zone_here",
    });
    expect(t.state.assistantPlans.map((p) => p.kind)).toEqual(["no_data"]);
  });

  test("the same emptiness outside the covered cities is no card at all", async () => {
    const t = makeTestApp({});
    const tools = t.deps.assistantTools!;
    // Providence.
    const ctx = ctxAt({ lat: 41.824, lng: -71.4128 });
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(search.verdict).toBe("outside_coverage");
    const no = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    expect(no.result).toMatchObject({ error: "outside_coverage" });
    expect(no.endTurn).toBeUndefined();
    expect(t.state.assistantPlans).toHaveLength(0);
  });
});

describe("ranking (a pure function of the options and the request)", () => {
  const A = { id: "a", type: "street" as const, priceUsd: 2, walkMinutes: 20 };
  const B = { id: "b", type: "garage" as const, priceUsd: 12, walkMinutes: 2, entryType: "valet" };
  const C = { id: "c", type: "garage" as const, priceUsd: 6, walkMinutes: 4, entryType: "self" };
  const D = { id: "d", type: "street" as const, priceUsd: 2, walkMinutes: 5 };
  const ALL = [A, B, C, D];
  const ids = (options: { id: string }[]) => options.map((o) => o.id);

  test("cheapest: price, then walk", () => {
    expect(ids(rankOptions(ALL, { rank: "cheapest", prefer: null }))).toEqual(["d", "a", "c", "b"]);
  });

  test("closest: walk, then price", () => {
    expect(ids(rankOptions(ALL, { rank: "closest", prefer: null }))).toEqual(["b", "c", "d", "a"]);
  });

  test("balanced: price plus $0.50 a minute of walk", () => {
    // d 4.50, c 8.00, a 12.00, b 13.00
    expect(ids(rankOptions(ALL, { rank: "balanced", prefer: null }))).toEqual(["d", "c", "a", "b"]);
  });

  test("a preference is a fixed $1.00 off the score: it reorders, it never filters", () => {
    // Valet b scores 12.00 on balanced, level with a; the tie goes to the cheaper.
    expect(ids(rankOptions(ALL, { rank: "balanced", prefer: ["valet"] }))).toEqual([
      "d",
      "c",
      "a",
      "b",
    ]);
    const E = { id: "e", type: "garage" as const, priceUsd: 2.5, walkMinutes: 5 };
    expect(ids(rankOptions([...ALL, E], { rank: "cheapest", prefer: null }))).toEqual([
      "d",
      "a",
      "e",
      "c",
      "b",
    ]);
    // A garage preferred: e scores 1.50 and leads; nothing is dropped.
    expect(ids(rankOptions([...ALL, E], { rank: "cheapest", prefer: ["garage"] }))).toEqual([
      "e",
      "d",
      "a",
      "c",
      "b",
    ]);
  });

  test("the input is not mutated, and equal options keep a stable order", () => {
    const input = [A, B, C, D];
    rankOptions(input, { rank: "closest", prefer: null });
    expect(ids(input)).toEqual(["a", "b", "c", "d"]);
    const twins = [
      { id: "y", type: "street" as const, priceUsd: 3, walkMinutes: 3 },
      { id: "x", type: "street" as const, priceUsd: 3, walkMinutes: 3 },
    ];
    expect(ids(rankOptions(twins, { rank: "cheapest", prefer: null }))).toEqual(["x", "y"]);
  });

  const NO_ASK = { rank: null, prefer: null, priceLimited: false, walkLimited: false };

  test("no ask: the cheapest and the closest both lead, each labeled", () => {
    const ordered = orderForRequest(ALL, NO_ASK);
    expect(ordered.map((o) => [o.id, o.axis ?? null, o.secondary ?? false])).toEqual([
      ["d", "cheapest", false],
      ["b", "closest", false],
      // The rest by balanced score.
      ["c", null, false],
      ["a", null, false],
    ]);
  });

  test("no ask, and one option is both: one entry, not two", () => {
    const best = { id: "z", type: "street" as const, priceUsd: 1, walkMinutes: 1 };
    const ordered = orderForRequest([A, best, C], NO_ASK);
    expect(ordered.map((o) => [o.id, o.axis ?? null])).toEqual([
      ["z", "both"],
      ["c", null],
      ["a", null],
    ]);
  });

  test("'cheapest': the cheapest is first, and the closest rides along as a secondary alternative", () => {
    const ordered = orderForRequest(ALL, { ...NO_ASK, rank: "cheapest" });
    expect(ordered.map((o) => [o.id, o.axis ?? null, o.secondary ?? false])).toEqual([
      ["d", "cheapest", false],
      ["b", "closest", true],
      ["a", null, false],
      ["c", null, false],
    ]);
  });

  test("'closest': the closest is first, and the cheapest is the secondary", () => {
    const ordered = orderForRequest(ALL, { ...NO_ASK, rank: "closest" });
    expect(ordered.map((o) => [o.id, o.axis ?? null, o.secondary ?? false])).toEqual([
      ["b", "closest", false],
      ["d", "cheapest", true],
      ["c", null, false],
      ["a", null, false],
    ]);
  });

  test("a price limit with no rank is an ask about price; a walk limit, about the walk", () => {
    expect(orderForRequest(ALL, { ...NO_ASK, priceLimited: true })[0]).toMatchObject({
      id: "d",
      axis: "cheapest",
    });
    expect(orderForRequest(ALL, { ...NO_ASK, priceLimited: true })[1]).toMatchObject({
      id: "b",
      secondary: true,
    });
    expect(orderForRequest(ALL, { ...NO_ASK, walkLimited: true })[0]).toMatchObject({
      id: "b",
      axis: "closest",
    });
  });
});

describe("decision 8 through the search", () => {
  const CHEAP_FAR = garageOption({ id: "g-cheap", priceUsd: 18, walkMinutes: 10, distanceM: 550 });
  const MID = garageOption({ id: "g-mid", priceUsd: 19, walkMinutes: 6, distanceM: 400 });
  const NEAR_PRICEY = garageOption({ id: "g-near", priceUsd: 25, walkMinutes: 2, distanceM: 120 });

  test("no constraint: the search leads with both axes", async () => {
    const t = makeTestApp({ garage: garages([CHEAP_FAR, MID, NEAR_PRICEY]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    const search = (await tools.execute(ctx, "search_garages", {})).result as Search;
    expect(search.satisfying.map((o) => [o.id, o.axis ?? null, o.secondary ?? false])).toEqual([
      ["v1-g-cheap", "cheapest", false],
      ["v1-g-near", "closest", false],
      ["v1-g-mid", null, false],
    ]);
  });

  test("'under $20': a secondary option over $20 is never in satisfying", async () => {
    const t = makeTestApp({ garage: garages([CHEAP_FAR, MID, NEAR_PRICEY]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 20, durationMinutes: 60 });
    const search = (await tools.execute(ctx, "search_garages", {})).result as Search;
    // The closest overall costs $25: it is a near-miss, and the closest
    // that fits the budget is the alternative.
    expect(search.satisfying.map((o) => [o.id, o.axis ?? null, o.secondary ?? false])).toEqual([
      ["v1-g-cheap", "cheapest", false],
      ["v1-g-mid", "closest", true],
    ]);
    expect(search.satisfying.every((o) => o.priceUsd <= 20)).toBe(true);
    expect(search.nearMisses.map((n) => [n.option.id, n.violates])).toEqual([
      ["v1-g-near", [{ field: "maxPriceUsd", actual: 25, limit: 20 }]],
    ]);
  });

  test("the plan leads with the ask whatever the model picks: the primary is added, kept first, and holds the badge", async () => {
    const t = makeTestApp({ garage: garages([CHEAP_FAR, MID, NEAR_PRICEY]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { rank: "cheapest", durationMinutes: 60 });
    await tools.execute(ctx, "search_garages", {});
    // The model leaves the cheapest out and recommends the closest.
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v1-g-near", recommended: true }, { id: "v1-g-mid" }],
      },
    });
    const plan = out.endTurn!.plan as unknown as {
      options: (Option & { recommended: boolean })[];
    };
    expect(plan.options.map((o) => [o.id, o.recommended, o.secondary ?? false])).toEqual([
      ["v1-g-cheap", true, false],
      ["v1-g-near", false, true],
      ["v1-g-mid", false, false],
    ]);
  });

  test("no ask: the plan offers both, whichever the model sent", async () => {
    const t = makeTestApp({ garage: garages([CHEAP_FAR, MID, NEAR_PRICEY]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-g-mid", recommended: true }] },
    });
    const plan = out.endTurn!.plan as unknown as { options: (Option & { recommended: boolean })[] };
    expect(plan.options.map((o) => [o.id, o.axis ?? null])).toEqual([
      ["v1-g-cheap", "cheapest"],
      ["v1-g-near", "closest"],
      ["v1-g-mid", null],
    ]);
    expect(plan.options.filter((o) => o.recommended).map((o) => o.id)).toEqual(["v1-g-cheap"]);
  });
});
