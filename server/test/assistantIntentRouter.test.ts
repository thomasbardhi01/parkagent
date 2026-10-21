/**
 * FR-45: the request's intent decides what the assistant can do.
 *
 * The intent is the server's (requestState.ts derives it): park now, park
 * later, or a garage only. It decides
 *
 *  - which tools the model is offered, per model call: no itinerary for a
 *    request that isn't for later, no street quote for a garage-only one;
 *    a call to a tool that is off answers `tool_not_available_for_intent`;
 *  - the defaults: parking now with no stay assumes one hour and says so;
 *    a later or garage-only request with no stay isn't searched — the turn
 *    ends asking how long, with four tappable answers;
 *  - V7: a later request whose start has passed is refused with the ET now.
 *
 * And the card says what it answered: the request it was built for
 * (`requestSummary`, with what the server assumed), a `verdict`, which
 * options lead (`primary`), and `warn` on a price over the approval
 * threshold (`confirm_warn_usd`). A relax chip's tap is applied by the
 * server, so its words can't be misread as another field.
 */

import { describe, expect, test } from "vitest";

import { STAY_SUGGESTIONS } from "../src/services/assistant/clarify.js";
import type { GeocoderProvider } from "../src/services/assistant/geocoder.js";
import {
  intentOf,
  stayFor,
  toolAllowed,
  toolsForIntent,
} from "../src/services/assistant/intentRouter.js";
import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { emptyState, parsePatch } from "../src/services/assistant/requestState.js";
import { relaxationTapped } from "../src/services/assistant/search.js";
import type { SearchResult } from "../src/services/assistant/search.js";
import { TOOL_DEFINITIONS } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import type { NearbyZone } from "../src/services/zoneLookup.js";
import { API_KEY, DEFAULT_POLICY, MONDAY_2PM, makePolicyService, makeTestApp } from "./helpers.js";

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

/** One hour: $4.15 + Boston's $0.35 fee = $4.50, a 5-minute walk;
 * $5.65 + $0.35 = $6.00, a 2-minute walk. */
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

/** A scripted model that records what each call was given: the tools on
 * offer, the system prompt, and the messages as they stood (a copy — the
 * loop keeps appending to its own array). */
function recordingModel(responses: ModelResponse[]): ModelClient & {
  calls: number;
  offered: string[][];
  systems: string[];
  seen: ModelTurn[][];
} {
  const model = {
    calls: 0,
    offered: [] as string[][],
    systems: [] as string[],
    seen: [] as ModelTurn[][],
    async create(args: Parameters<ModelClient["create"]>[0]) {
      model.offered.push((args.tools ?? []).map((t) => t.name));
      model.systems.push(args.system);
      model.seen.push(structuredClone(args.messages));
      const response = responses[Math.min(model.calls, responses.length - 1)]!;
      model.calls += 1;
      return response;
    },
  };
  return model;
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
  primary?: boolean;
  warn?: boolean;
  nearMiss?: boolean;
  violates?: Violation[];
}
interface Search {
  stateVersion: number;
  verdict: string;
  searched: string[];
  window: { durationMinutes: number; durationSource: string; startsNow: boolean };
  satisfying: Option[];
  nearMisses: { option: Option; violates: Violation[] }[];
  relaxSuggestions?: { field: string; to: unknown; wouldYield: number; reply: string }[];
  instruction?: string;
  error?: string;
}
interface Card {
  kind: string;
  verdict?: string;
  assumptions?: string;
  options: Option[];
  nearMisses: Option[];
  requestSummary?: Record<string, unknown>;
}

/** A turn's context. `null` is a phone that sent no location. */
const ctxAt = (location: { lat: number; lng: number } | null = COMMON): ToolContext => ({
  userId: "u1",
  conversationId: "c1",
  ...(location ? { location } : {}),
});

const ALL_TOOLS = TOOL_DEFINITIONS.map((t) => t.name);
const without = (...names: string[]) => ALL_TOOLS.filter((n) => !names.includes(n));

/** The four answers to "how long?", as the server offers them. */
const STAY_CHIPS = [
  { label: "1 hour", reply: "For 1 hour" },
  { label: "2 hours", reply: "For 2 hours" },
  { label: "4 hours", reply: "For 4 hours" },
  { label: "All day", reply: "For 12 hours" },
];

const message = (
  t: ReturnType<typeof makeTestApp>,
  text: string,
  extra: Record<string, unknown> = {},
) =>
  t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: HEADERS,
    payload: { text, location: COMMON, ...extra },
  });

describe("the intent decides which tools are on", () => {
  test("a garage-only request can't quote street: tool_not_available_for_intent, on the record", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { kinds: ["garage"], durationMinutes: 60 });
    expect(ctx.requestState!.intent).toBe("garage_or_lot");

    const out = await tools.execute(ctx, "quote_street", {});
    expect(out.result).toMatchObject({
      error: "tool_not_available_for_intent",
      intent: "garage_or_lot",
    });
    // Nothing was searched, so the turn owes no card for it.
    expect(ctx.lastSearch).toBeUndefined();
    expect(ctx.searchesThisTurn ?? 0).toBe(0);
    expect(t.state.decisions.find((d) => d.rule === "tool_not_available_for_intent")).toMatchObject(
      { kind: "assistant_tool", outcome: { intent: "garage_or_lot" } },
    );
  });

  test("build_itinerary is for a later request: off for parking now, on once the request starts later", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    const stops = [
      {
        label: "Lunch",
        lat: COMMON.lat,
        lng: COMMON.lng,
        arrival: "2026-01-05T17:00:00-05:00",
        duration_minutes: 60,
      },
    ];
    const now = await tools.execute(ctx, "build_itinerary", { stops });
    expect(now.result).toMatchObject({
      error: "tool_not_available_for_intent",
      intent: "park_now",
    });

    await tools.execute(ctx, "update_request", { startsAt: "2026-01-05T17:00:00-05:00" });
    expect(ctx.requestState!.intent).toBe("park_later");
    const later = (await tools.execute(ctx, "build_itinerary", { stops })).result as {
      error?: string;
      stops?: unknown[];
    };
    expect(later.error).toBeUndefined();
    expect(later.stops).toHaveLength(1);
  });

  test('"garage", then "or street is fine": the intent moves back and the street quote is on again', async () => {
    for (const reopen of [{ kinds: ["street", "garage"] }, { clear: ["hard.kinds"] }]) {
      const t = makeTestApp({ nearbyZones: [MASS_AVE] });
      const tools = t.deps.assistantTools!;
      const ctx = ctxAt();
      await tools.execute(ctx, "update_request", { kinds: ["garage"], durationMinutes: 60 });
      const refused = await tools.execute(ctx, "quote_street", {});
      expect((refused.result as Search).error).toBe("tool_not_available_for_intent");

      await tools.execute(ctx, "update_request", reopen);
      expect(ctx.requestState!.intent, JSON.stringify(reopen)).toBe("park_now");
      const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
      expect(search.error, JSON.stringify(reopen)).toBeUndefined();
      expect(search.satisfying.map((o) => o.id)).toEqual(["v2-bos-mass-ave-1"]);
    }
  });

  test("the model is offered the intent's tools, recomputed for every model call", async () => {
    const model = recordingModel([
      use("u1", "update_request", { kinds: ["garage"], durationMinutes: 120 }),
      use("u2", "update_request", {
        kinds: ["street", "garage"],
        startsAt: "2026-01-05T19:00:00-05:00",
      }),
      say("Anything else."),
    ]);
    const t = makeTestApp({ assistantModel: model });
    const res = await message(t, "a garage for two hours. or street is fine, tonight at 7");
    expect(res.statusCode).toBe(200);
    expect(model.calls).toBe(3);
    // A new conversation is for now: no day planner.
    expect(model.offered[0]).toEqual(without("build_itinerary"));
    // Garage only: no street quote either.
    expect(model.offered[1]).toEqual(without("quote_street", "build_itinerary"));
    // Tonight, street or garage: everything.
    expect(model.offered[2]).toEqual(ALL_TOOLS);
  });

  test("a tool that is off, called anyway, goes back to the model as a refusal and the turn carries on", async () => {
    const model = recordingModel([
      use("u1", "update_request", { kinds: ["garage"], durationMinutes: 60 }),
      use("q1", "quote_street"),
      use("g1", "search_garages"),
      use("p1", "propose_plan", { plan: { kind: "single_spot", options: [{ id: "v1-g-a" }] } }),
    ]);
    const t = makeTestApp({
      assistantModel: model,
      garage: garages([garageOption({ id: "g-a", priceUsd: 12 })]),
    });
    const res = await message(t, "a garage for an hour");
    const body = res.json();
    const refusal = model.seen[2]!.at(-1)!.content as { type: string; content: string }[];
    expect(JSON.parse(refusal[0]!.content)).toMatchObject({
      error: "tool_not_available_for_intent",
      intent: "garage_or_lot",
    });
    expect(body.plan.plan.kind).toBe("single_spot");
    expect((body.plan.plan as Card).options.map((o) => o.type)).toEqual(["garage"]);
  });

  test("the tools that aren't about what to search stay on under every intent", async () => {
    const t = makeTestApp({});
    const tools = t.deps.assistantTools!;
    for (const patch of [{}, { startsAt: "2026-01-05T19:00:00-05:00" }, { kinds: ["garage"] }]) {
      const ctx = ctxAt();
      if (Object.keys(patch).length > 0) await tools.execute(ctx, "update_request", patch);
      for (const name of ["get_history", "geocode_place", "ask_user", "book_garage"]) {
        const out = await tools.execute(ctx, name, { query: "Fenway", option_id: "x" });
        expect(
          (out.result as { error?: string }).error,
          `${name} ${JSON.stringify(patch)}`,
        ).not.toBe("tool_not_available_for_intent");
      }
    }
  });
});

describe("the stay: assumed for now, asked for later", () => {
  test("parking now with no stay searches one hour and says it assumed it", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(search.window).toMatchObject({
      durationMinutes: 60,
      durationSource: "default",
      startsNow: true,
    });
    // One hour's prices, not two.
    expect(search.satisfying.map((o) => [o.id, o.priceUsd])).toEqual([
      ["v0-bos-mass-ave-1", 4.5],
      ["v0-bos-garden-st-1", 6],
    ]);
    expect(search.instruction).toContain("assumed 1 hour");
    // The default is the search's: the stored request still names no stay.
    expect(ctx.requestState?.window.durationMinutes ?? null).toBeNull();
  });

  test("a later request with no stay isn't searched: the turn ends asking how long, with four answers", async () => {
    const model = recordingModel([
      use("u1", "update_request", { startsAt: "2026-01-05T19:00:00-05:00" }),
      use("q1", "quote_street"),
      say("SHOULD NEVER RUN"),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const res = await message(t, "parking here tonight at 7");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(model.calls).toBe(2);
    expect(body.plan).toBeNull();
    expect(body.reply).toBe("How long will you park?");
    expect(body.suggestions).toEqual(STAY_CHIPS);
    const asked = t.state.decisions.find((d) => d.rule === "duration_needed");
    expect(asked).toMatchObject({
      kind: "assistant_tool",
      outcome: { intent: "park_later", stateVersion: 1 },
    });
    // No search ran, so nothing was priced for a stay nobody named.
    expect(
      t.state.decisions.some(
        (d) => (d.inputs as { tool?: string }).tool === "quote_street" && d.rule === "ok",
      ),
    ).toBe(false);
    // The request is saved as the user left it: a start, and no stay.
    const saved = t.state.conversations[0]!.requestState as {
      window: { startsAt: string; durationMinutes: number | null };
    };
    expect(saved.window).toMatchObject({
      startsAt: "2026-01-05T19:00:00-05:00",
      durationMinutes: null,
    });
  });

  test("a garage-only request with no stay asks too, before any garage source is called", async () => {
    const garage = garages([garageOption({ id: "g-a" })]);
    const t = makeTestApp({ garage });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { kinds: ["garage"] });
    const out = await tools.execute(ctx, "search_garages", {});
    expect(out.result).toMatchObject({ error: "duration_needed", intent: "garage_or_lot" });
    expect(out.ask).toMatchObject({ question: "How long will you park?", suggestions: STAY_CHIPS });
    expect(garage.searches).toBe(0);

    // The answer is the user's: once the stay is on the request, it searches.
    await tools.execute(ctx, "update_request", { durationMinutes: 120 });
    const search = (await tools.execute(ctx, "search_garages", {})).result as Search;
    expect(search.error).toBeUndefined();
    expect(search.window).toMatchObject({ durationMinutes: 120, durationSource: "user" });
    expect(garage.searches).toBe(1);
  });

  test('"how long?" asked by the model itself still gets the server\'s wording and its four answers, once', async () => {
    // What the live model did (local run, 2026-10-04): it asked in prose
    // AND with ask_user, with chips of its own ("All game, ~3.5 hours").
    const model = recordingModel([
      use("u1", "update_request", { startsAt: "2026-01-05T19:00:00-05:00" }),
      {
        content: [
          {
            type: "text",
            text: "Tonight at 7 is set. How long do you plan to stay?",
          },
          {
            type: "tool_use",
            id: "a1",
            name: "ask_user",
            input: {
              question: "How long do you need parking for?",
              suggestions: [
                { label: "3 hours", reply: "3 hours" },
                { label: "All game, ~3.5 hours", reply: "About 3.5 hours" },
              ],
            },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const body = (await message(t, "parking here tonight at 7")).json();
    expect(body.suggestions).toEqual(STAY_CHIPS);
    // One question, the server's; what the model stated is kept.
    expect(body.reply).toBe("Tonight at 7 is set. How long will you park?");
    expect(body.plan).toBeNull();
    // "How long a walk?" is about the walk — the question a tap on the
    // walk chip gets — and keeps the answers the model gave it.
    const walk = recordingModel([
      use("a1", "ask_user", {
        question: "How long a walk is OK?",
        suggestions: [
          { label: "5 minutes", reply: "Within a 5 minute walk" },
          { label: "10 minutes", reply: "Within a 10 minute walk" },
          { label: "No limit", reply: "Any walk is fine" },
        ],
      }),
    ]);
    const tWalk = makeTestApp({ assistantModel: walk });
    const aboutWalk = (await message(tWalk, "Change the walking distance")).json();
    expect(aboutWalk.reply).toBe("How long a walk is OK?");
    expect(aboutWalk.suggestions.map((s: { label: string }) => s.label)).toEqual([
      "5 minutes",
      "10 minutes",
      "No limit",
    ]);
    // A question about anything else is the model's own, as before.
    const other = recordingModel([
      use("a1", "ask_user", {
        question: "Which entrance are you using?",
        suggestions: [
          { label: "Gate A", reply: "Gate A" },
          { label: "Gate D", reply: "Gate D" },
        ],
      }),
    ]);
    const t2 = makeTestApp({ assistantModel: other });
    const asked = (await message(t2, "parking for the game")).json();
    expect(asked.reply).toBe("Which entrance are you using?");
    expect(asked.suggestions.map((s: { label: string }) => s.label)).toEqual(["Gate A", "Gate D"]);
  });

  test("the one-hour default never follows the request into a later time", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    const now = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(now.window.durationMinutes).toBe(60);

    await tools.execute(ctx, "update_request", { startsAt: "2026-01-05T19:00:00-05:00" });
    const later = await tools.execute(ctx, "quote_street", {});
    expect(later.result).toMatchObject({ error: "duration_needed", intent: "park_later" });
  });

  test("a place that isn't resolved is asked about before the stay", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    // No phone location and no place named: where comes first.
    const ctx = ctxAt(null);
    await tools.execute(ctx, "update_request", { startsAt: "2026-01-05T19:00:00-05:00" });
    const out = await tools.execute(ctx, "quote_street", {});
    expect(out.result).toMatchObject({ error: "place_unresolved", reason: "no_place" });
  });
});

describe("V7: a later request whose start has passed", () => {
  test("more than five minutes past: time_in_past, with the ET now; within five, it searches", async () => {
    let clock = new Date(MONDAY_2PM);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], now: () => clock });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", {
      startsAt: "2026-01-05T15:00:00-05:00",
      durationMinutes: 60,
    });
    expect(ctx.requestState!.intent).toBe("park_later");

    // The conversation is picked up four minutes after the start…
    clock = new Date("2026-01-05T15:04:00-05:00");
    const close = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(close.error).toBeUndefined();

    // …and six minutes after it.
    clock = new Date("2026-01-05T15:06:00-05:00");
    const out = await tools.execute(ctx, "quote_street", {});
    expect(out.result).toMatchObject({
      error: "time_in_past",
      startsAt: "2026-01-05T15:00:00-05:00",
      nowEastern: "2026-01-05T15:06:00-05:00",
    });
    expect(t.state.decisions.some((d) => d.rule === "time_in_past")).toBe(true);
  });

  test("a garage-only request is held to it too", async () => {
    const garage = garages([garageOption({ id: "g-a" })]);
    const t = makeTestApp({ garage });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", {
      kinds: ["garage"],
      startsAt: "2026-01-05T13:50:00-05:00",
      durationMinutes: 60,
    });
    expect(ctx.requestState!.intent).toBe("garage_or_lot");
    const out = await tools.execute(ctx, "search_garages", {});
    expect(out.result).toMatchObject({
      error: "time_in_past",
      nowEastern: "2026-01-05T14:00:00-05:00",
    });
    expect(garage.searches).toBe(0);
  });

  test("parking now isn't: a start a few minutes back still searches", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", {
      startsAt: "2026-01-05T13:50:00-05:00",
      durationMinutes: 60,
    });
    expect(ctx.requestState!.intent).toBe("park_now");
    const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
    expect(search.error).toBeUndefined();
  });
});

describe("warn: a price over the approval threshold", () => {
  async function cardWith(policy: Record<string, number>, garagePriceUsd: number) {
    const t = makeTestApp({
      nearbyZones: [MASS_AVE],
      garage: garages([garageOption({ id: "g-a", priceUsd: garagePriceUsd })]),
      policy,
    });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1" }, { id: "v1-g-a" }] },
    });
    const card = out.endTurn!.plan as unknown as Card;
    return {
      street: card.options.find((o) => o.type === "street")!,
      garage: card.options.find((o) => o.type === "garage")!,
    };
  }

  test("an $18.00 option with confirm_warn_usd 15 carries warn: true; a $4.50 one doesn't", async () => {
    const { street, garage } = await cardWith({ confirm_warn_usd: 15 }, 18);
    expect(garage.priceUsd).toBe(18);
    expect(garage.warn).toBe(true);
    expect(street.priceUsd).toBe(4.5);
    expect("warn" in street).toBe(false);
  });

  test("the threshold defaults to $15.00, and a price AT it doesn't warn", async () => {
    expect((await cardWith({}, 18)).garage.warn).toBe(true);
    expect("warn" in (await cardWith({}, 15)).garage).toBe(false);
    expect((await cardWith({}, 15.01)).garage.warn).toBe(true);
  });

  test("it is the policy's: a higher threshold warns on less", async () => {
    expect("warn" in (await cardWith({ confirm_warn_usd: 20 }, 18)).garage).toBe(false);
    expect((await cardWith({ confirm_warn_usd: 4 }, 18)).street.warn).toBe(true);
  });

  test("a near-miss on a none_meets card carries it as well", async () => {
    const t = makeTestApp({
      garage: garages([garageOption({ id: "g-a", priceUsd: 18 })]),
    });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 10, durationMinutes: 60 });
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    const card = out.endTurn!.plan as unknown as Card;
    expect(card.nearMisses.map((o) => [o.priceUsd, o.warn])).toEqual([[18, true]]);
  });

  test("confirm_warn_usd is validated: a number, zero or more; PUT /policy takes it", async () => {
    expect(makePolicyService({ confirm_warn_usd: 25 }).get().confirm_warn_usd).toBe(25);
    expect(makePolicyService({ confirm_warn_usd: 0 }).get().confirm_warn_usd).toBe(0);
    expect(() => makePolicyService({ confirm_warn_usd: -1 })).toThrowError(/confirm_warn_usd/);
    expect(() => makePolicyService({ confirm_warn_usd: "15" } as never)).toThrowError(
      /confirm_warn_usd/,
    );

    const { app } = makeTestApp({});
    const put = (confirm_warn_usd: unknown) =>
      app.inject({
        method: "PUT",
        url: "/policy",
        headers: HEADERS,
        payload: { ...DEFAULT_POLICY, confirm_warn_usd },
      });
    const ok = await put(25);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().policy.confirm_warn_usd).toBe(25);
    expect((await put(-5)).statusCode).toBe(400);
    const read = await app.inject({ method: "GET", url: "/policy", headers: HEADERS });
    expect(read.json().policy.confirm_warn_usd).toBe(25);
  });
});

describe("a garage-only request and the cheaper meter", () => {
  async function garageOnly(options: {
    zones: NearbyZone[];
    garages: GarageOption[];
    patch?: Record<string, unknown>;
  }) {
    const garage = garages(options.garages);
    const t = makeTestApp({ nearbyZones: options.zones, garage });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", {
      kinds: ["garage"],
      durationMinutes: 60,
      ...options.patch,
    });
    const search = (await tools.execute(ctx, "search_garages", {})).result as Search;
    return { t, tools, ctx, search };
  }

  test("a street option cheaper than every garage appears once, as a near-miss that breaks only the kind", async () => {
    const { search, tools, ctx } = await garageOnly({
      zones: [MASS_AVE, GARDEN_ST],
      garages: [
        garageOption({ id: "g-a", priceUsd: 18 }),
        garageOption({ id: "g-b", priceUsd: 22 }),
      ],
    });
    expect(search.verdict).toBe("meets");
    // What meets a garage-only request is garages.
    expect(search.satisfying.map((o) => o.type)).toEqual(["garage", "garage"]);
    // The cheaper meter: one, the cheapest, flagged with what it breaks.
    expect(search.nearMisses.map((n) => [n.option.id, n.option.type, n.violates])).toEqual([
      ["v1-bos-mass-ave-1", "street", [{ field: "kinds", actual: "street", limit: ["garage"] }]],
    ]);

    // The card carries it whether or not the model named it — once, and
    // never as an option that meets the request.
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-g-a" }] },
    });
    const card = out.endTurn!.plan as unknown as Card;
    const street = card.options.filter((o) => o.type === "street");
    expect(street).toHaveLength(1);
    expect(street[0]).toMatchObject({
      id: "v1-bos-mass-ave-1",
      nearMiss: true,
      violates: [{ field: "kinds", actual: "street", limit: ["garage"] }],
      recommended: false,
    });
    expect(card.options[0]).toMatchObject({ id: "v1-g-a", type: "garage", recommended: true });
    expect(card.options.at(-1)!.type).toBe("street");
  });

  test("no cheaper meter, no street on the result: a garage that costs less than every block", async () => {
    const { search } = await garageOnly({
      zones: [MASS_AVE, GARDEN_ST],
      garages: [garageOption({ id: "g-cheap", priceUsd: 3 })],
    });
    expect(search.satisfying.map((o) => o.id)).toEqual(["v1-g-cheap"]);
    expect(search.nearMisses).toEqual([]);
  });

  test("a meter that breaks another limit as well isn't offered at all", async () => {
    // Under $4: the $4.50 block breaks the price too, so it is no
    // alternative — and the garages are the near-misses.
    const { search } = await garageOnly({
      zones: [MASS_AVE],
      garages: [garageOption({ id: "g-a", priceUsd: 18 })],
      patch: { maxPriceUsd: 4 },
    });
    expect(search.verdict).toBe("none_meets");
    expect(search.nearMisses.map((n) => n.option.type)).toEqual(["garage"]);
  });

  test("when no garage meets the budget, the cheaper meter is still one near-miss among the garages", async () => {
    const { search, tools, ctx } = await garageOnly({
      zones: [MASS_AVE, GARDEN_ST],
      garages: [
        garageOption({ id: "g-a", priceUsd: 18 }),
        garageOption({ id: "g-b", priceUsd: 22 }),
        garageOption({ id: "g-c", priceUsd: 26 }),
      ],
      patch: { maxPriceUsd: 10 },
    });
    expect(search.verdict).toBe("none_meets");
    expect(search.nearMisses).toHaveLength(3);
    expect(search.nearMisses.filter((n) => n.option.type === "street")).toHaveLength(1);
    // Relaxing the kind counts every block that meets the other limits.
    expect(search.relaxSuggestions).toContainEqual(
      expect.objectContaining({ field: "kinds", wouldYield: 2 }),
    );
    const out = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    const card = out.endTurn!.plan as unknown as Card;
    expect(card.nearMisses.filter((o) => o.type === "street")).toHaveLength(1);
  });

  test("the street quote the server ran for it isn't one the model can propose from as a fit", async () => {
    const { tools, ctx } = await garageOnly({
      zones: [MASS_AVE],
      garages: [garageOption({ id: "g-a", priceUsd: 18 })],
    });
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1" }] },
    });
    expect(out.result).toMatchObject({ error: "hard_constraint_violation" });
  });
});

describe("the card says what it answered", () => {
  test("a card for right here: the verdict, the request, and what the server assumed", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v0-bos-mass-ave-1" }] },
    });
    const card = out.endTurn!.plan as unknown as Card;
    expect(card.verdict).toBe("meets");
    expect(card.requestSummary).toEqual({
      version: 0,
      intent: "park_now",
      place: { query: null, resolved: null, candidates: null },
      window: { startsAt: null, durationMinutes: null, source: "default" },
      hard: {
        maxPriceUsd: null,
        maxWalkMinutes: null,
        kinds: null,
        entryType: null,
        covered: null,
      },
      soft: { rank: null, prefer: null },
      // Nothing the server filled in is silent: the phone's location as
      // the place, and the hour's stay.
      assumed: { place: "phone_location", durationMinutes: 60 },
    });
    expect(card.assumptions).toBe("Now–3:00 PM, near you");
    // No ask: the cheapest and the closest both lead (decision 8).
    expect(card.options.map((o) => [o.id, o.axis, o.primary])).toEqual([
      ["v0-bos-mass-ave-1", "cheapest", true],
      ["v0-bos-garden-st-1", "closest", true],
    ]);
  });

  test("with an ask, one option leads and the other axis is a secondary alternative", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { rank: "closest", durationMinutes: 90 });
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-garden-st-1" }] },
    });
    const card = out.endTurn!.plan as unknown as Card;
    expect(card.options.map((o) => [o.id, o.primary, o.secondary])).toEqual([
      ["v1-bos-garden-st-1", true, undefined],
      ["v1-bos-mass-ave-1", undefined, true],
    ]);
    expect(card.requestSummary).toMatchObject({
      version: 1,
      soft: { rank: "closest" },
      window: { durationMinutes: 90, source: "user" },
      // The stay is the user's now: only the place was assumed.
      assumed: { place: "phone_location" },
    });
    expect(card.requestSummary!["assumed"] as object).not.toHaveProperty("durationMinutes");
  });

  test("a none_meets card carries its verdict and the limits it was held to", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 2, durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    const card = out.endTurn!.plan as unknown as Card;
    expect(card.verdict).toBe("none_meets");
    expect(card.requestSummary).toMatchObject({
      intent: "park_now",
      hard: { maxPriceUsd: 2 },
      window: { durationMinutes: 60 },
    });
    // No near-miss leads anything.
    expect(card.nearMisses.every((o) => !("primary" in o))).toBe(true);
  });

  test("without the phone's location, parking now never defaults a place: it asks", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt(null);
    const out = await tools.execute(ctx, "quote_street", {});
    expect(out.result).toMatchObject({ error: "place_unresolved", reason: "no_place" });
    expect(out.ask?.question).toContain("Where do you want to park?");
    expect(t.state.assistantPlans).toHaveLength(0);
  });
});

describe("a relax chip is the user's tap, applied by the server", () => {
  /** Turn one: nothing under $2 for an hour — the "no" card and its chip. */
  function noThenTap(
    tap: ModelResponse[],
    patch: Record<string, unknown> = {},
    search: "quote_street" | "search_garages" = "quote_street",
  ) {
    const model = recordingModel([
      use("u1", "update_request", { maxPriceUsd: 2, durationMinutes: 60, ...patch }),
      use("q1", search),
      use("p1", "propose_plan", { plan: { kind: "none_meets" } }),
      ...tap,
    ]);
    const garage = garages([garageOption({ id: "g-a", priceUsd: 18 })]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST], garage, assistantModel: model });
    return { model, t };
  }

  test('"Allow up to $7.00" raises the budget before the model runs — and nothing else changes that turn', async () => {
    const { model, t } = noThenTap([
      // The misreading: the chip's number taken for the stay.
      use("u2", "update_request", { durationMinutes: 7 }),
      use("q2", "quote_street"),
      use("p2", "propose_plan", {
        plan: {
          kind: "single_spot",
          options: [{ id: "v2-bos-mass-ave-1" }, { id: "v2-bos-garden-st-1" }],
        },
      }),
    ]);
    const first = (await message(t, "parking under $2 for an hour")).json();
    expect(first.plan.plan.kind).toBe("none_meets");
    expect(first.suggestions).toContainEqual({
      label: "Allow up to $7.00",
      reply: "Allow up to $7.00",
    });

    const second = (
      await message(t, "Allow up to $7.00", { conversation_id: first.conversationId })
    ).json();
    // The model's first call of the turn already sees the new budget…
    expect(model.systems[3]).toContain('"maxPriceUsd":7');
    // …and is told the tap did it.
    const userTurn = model.seen[3]!.at(-1)!.content as string;
    expect(userTurn).toContain("[request updated by this tap: hard.maxPriceUsd");
    // Its own edit — the wrong field — is refused.
    const refused = model.seen[4]!.at(-1)!.content as { content: string }[];
    expect(JSON.parse(refused[0]!.content)).toMatchObject({ error: "request_already_updated" });

    const saved = t.state.conversations[0]!.requestState as {
      version: number;
      hard: { maxPriceUsd: number };
      window: { durationMinutes: number };
    };
    expect(saved).toMatchObject({
      version: 2,
      hard: { maxPriceUsd: 7 },
      window: { durationMinutes: 60 },
    });
    expect(t.state.decisions.find((d) => d.rule === "relax_applied")).toMatchObject({
      kind: "assistant_tool",
      outcome: { version: 2, changed: ["hard.maxPriceUsd"] },
    });
    // The $4.50 and $6.00 blocks meet $7.00.
    expect(second.plan.plan.kind).toBe("single_spot");
    expect((second.plan.plan as Card).options.map((o) => o.priceUsd)).toEqual([4.5, 6]);
  });

  test('"Walk up to 6 min" moves the walk limit, never the stay', async () => {
    const { model, t } = noThenTap([say("Done.")], { maxPriceUsd: 20, maxWalkMinutes: 1 });
    const first = (await message(t, "within a minute's walk, for an hour")).json();
    expect(first.suggestions).toContainEqual({
      label: "Walk up to 6 min",
      reply: "Walk up to 6 min",
    });
    await message(t, "Walk up to 6 min", { conversation_id: first.conversationId });
    expect(model.systems[3]).toContain('"maxWalkMinutes":6');
    const saved = t.state.conversations[0]!.requestState as {
      hard: { maxWalkMinutes: number; maxPriceUsd: number };
      window: { durationMinutes: number };
    };
    expect(saved.hard).toMatchObject({ maxWalkMinutes: 6, maxPriceUsd: 20 });
    expect(saved.window.durationMinutes).toBe(60);
  });

  test('"Street or garage is fine" clears the kind, and the intent moves back', async () => {
    const { model, t } = noThenTap(
      [say("Done.")],
      { kinds: ["garage"], maxPriceUsd: 10 },
      "search_garages",
    );
    const first = (await message(t, "a garage under $10 for an hour")).json();
    expect(first.plan.plan.kind).toBe("none_meets");
    expect(first.suggestions).toContainEqual({
      label: "Street or garage is fine",
      reply: "Street or garage is fine",
    });
    await message(t, "street or garage is fine", { conversation_id: first.conversationId });
    const saved = t.state.conversations[0]!.requestState as {
      intent: string;
      hard: { kinds: string[] | null };
    };
    expect(saved).toMatchObject({ intent: "park_now", hard: { kinds: null } });
    // The street quote is on offer again in that same turn.
    expect(model.offered[3]).toContain("quote_street");
  });

  test("words that only resemble a chip are the model's to read: nothing is applied", async () => {
    const { model, t } = noThenTap([say("Sure.")]);
    const first = (await message(t, "parking under $2 for an hour")).json();
    await message(t, "allow up to $7.00 and make it two hours", {
      conversation_id: first.conversationId,
    });
    expect(model.systems[3]).toContain('"maxPriceUsd":2');
    expect(t.state.decisions.some((d) => d.rule === "relax_applied")).toBe(false);
  });

  test("a chip from before the request changed applies nothing", async () => {
    const { model, t } = noThenTap([
      use("u2", "update_request", { maxPriceUsd: 3 }),
      say("Changed."),
      say("Sure."),
    ]);
    const first = (await message(t, "parking under $2 for an hour")).json();
    // The request moves on (version 2): the old card's chip is stale.
    await message(t, "make it under $3", { conversation_id: first.conversationId });
    await message(t, "Allow up to $7.00", { conversation_id: first.conversationId });
    expect(model.systems.at(-1)).toContain('"maxPriceUsd":3');
    expect(t.state.decisions.some((d) => d.rule === "relax_applied")).toBe(false);
  });

  test("no chip or card mentions a per-trip cap (decision 9)", async () => {
    const { t } = noThenTap([]);
    const body = (await message(t, "parking under $2 for an hour")).json();
    const words = JSON.stringify([body.reply, body.suggestions, body.plan.plan.headline]);
    expect(words).not.toMatch(/\bcap\b/i);
  });
});

describe("review: what a hostile reader would try", () => {
  test("the rules themselves: which tools an intent leaves on, and the stay it assumes", () => {
    const names = (intent: "park_now" | "park_later" | "garage_or_lot") =>
      toolsForIntent(TOOL_DEFINITIONS, intent).map((t) => t.name);
    expect(names("park_now")).toEqual(without("build_itinerary"));
    expect(names("park_later")).toEqual(ALL_TOOLS);
    expect(names("garage_or_lot")).toEqual(without("quote_street", "build_itinerary"));
    // What ends a turn or changes the request is never off: a model can
    // always ask, always propose, always fix the request.
    for (const intent of ["park_now", "park_later", "garage_or_lot"] as const) {
      for (const tool of ["update_request", "ask_user", "propose_plan", "search_garages"]) {
        expect(toolAllowed(intent, tool), `${intent} ${tool}`).toBe(true);
      }
    }
    // A stored intent that couldn't be read is the empty request's.
    expect(intentOf({ intent: null })).toBe("park_now");
    const state = emptyState();
    expect(stayFor(state)).toEqual({ minutes: 60, source: "default" });
    expect(stayFor({ ...state, intent: "park_later" })).toBeNull();
    expect(stayFor({ ...state, intent: "garage_or_lot" })).toBeNull();
    expect(
      stayFor({ ...state, intent: "park_later", window: { ...state.window, durationMinutes: 45 } }),
    ).toEqual({ minutes: 45, source: "user" });
  });

  test('every answer to "how long" is a stay a request can hold: "All day" is the longest', () => {
    expect(STAY_SUGGESTIONS.map((s) => s.label)).toEqual(STAY_CHIPS.map((s) => s.label));
    for (const { reply } of STAY_SUGGESTIONS) {
      const hours = Number(/^For (\d+) hours?$/.exec(reply)?.[1]);
      expect(Number.isInteger(hours), reply).toBe(true);
      expect(parsePatch({ durationMinutes: hours * 60 }).ok, reply).toBe(true);
    }
    expect(parsePatch({ durationMinutes: 12 * 60 + 1 }).ok).toBe(false);
  });

  test("the answer to the stay question reaches the request and the search then runs for later", async () => {
    const model = recordingModel([
      use("u1", "update_request", { startsAt: "2026-01-05T19:00:00-05:00" }),
      use("q1", "quote_street"),
      use("u2", "update_request", { durationMinutes: 120 }),
      use("q2", "quote_street"),
      use("p2", "propose_plan", {
        plan: { kind: "single_spot", options: [{ id: "v2-bos-mass-ave-1" }] },
      }),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const asked = (await message(t, "parking here tonight at 7")).json();
    expect(asked.suggestions).toEqual(STAY_CHIPS);
    const answered = (
      await message(t, "For 2 hours", { conversation_id: asked.conversationId })
    ).json();
    const card = answered.plan.plan as Card & {
      options: (Option & { startsAt: string; payOnArrival: boolean; durationMinutes: number })[];
    };
    expect(card.kind).toBe("single_spot");
    expect(card.options[0]).toMatchObject({
      startsAt: "2026-01-05T19:00:00-05:00",
      durationMinutes: 120,
      payOnArrival: true,
    });
    expect(card.requestSummary).toMatchObject({
      intent: "park_later",
      window: { durationMinutes: 120 },
      // The stay is the user's now; only the place was assumed.
      assumed: { place: "phone_location" },
    });
    expect(card.assumptions).toBe("7:00–9:00 PM, near you");
  });

  test("a request picked up after its start has passed: the model is told the ET now and must ask or fix it", async () => {
    let clock = new Date(MONDAY_2PM);
    const model = recordingModel([
      use("u1", "update_request", {
        startsAt: "2026-01-05T15:00:00-05:00",
        durationMinutes: 60,
      }),
      say("Anything else."),
      use("q2", "quote_street"),
      use("a2", "ask_user", {
        question: "3 PM has passed — park now, or tomorrow at 3?",
        suggestions: [
          { label: "Now", reply: "Now" },
          { label: "Tomorrow at 3 PM", reply: "Tomorrow at 3 PM" },
        ],
      }),
    ]);
    const t = makeTestApp({
      nearbyZones: [MASS_AVE],
      assistantModel: model,
      now: () => clock,
    });
    const first = (await message(t, "park here at 3 for an hour")).json();
    clock = new Date("2026-01-05T15:10:00-05:00");
    const later = (
      await message(t, "ok find it", { conversation_id: first.conversationId })
    ).json();
    const refusal = model.seen[3]!.at(-1)!.content as { content: string }[];
    expect(JSON.parse(refusal[0]!.content)).toMatchObject({
      error: "time_in_past",
      nowEastern: "2026-01-05T15:10:00-05:00",
    });
    // Nothing was searched or proposed for a start that had gone by.
    expect(later.plan).toBeNull();
    expect(later.suggestions).toEqual([
      { label: "Now", reply: "Now" },
      { label: "Tomorrow at 3 PM", reply: "Tomorrow at 3 PM" },
    ]);
    expect(t.state.assistantPlans).toHaveLength(0);
  });

  test("a place looked up while the lookup is down, parking now: the card says the place was assumed, never the name", async () => {
    const geocoder: GeocoderProvider = {
      geocode: async () => ({ ok: false, reason: "HTTP 500" }),
    };
    const t = makeTestApp({ nearbyZones: [MASS_AVE], geocoder });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { placeQuery: "Lola 42" });
    const search = (await tools.execute(ctx, "quote_street", {})).result as Search;
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: search.satisfying[0]!.id }] },
    });
    const card = out.endTurn!.plan as unknown as Card & { destination?: unknown };
    // No pin and no "near Lola 42": the search was at the phone.
    expect(card.destination).toBeUndefined();
    expect(card.assumptions).toBe("Now–3:00 PM, near you");
    expect(card.requestSummary).toMatchObject({
      place: { query: "Lola 42", resolved: null },
      assumed: { place: "phone_location", durationMinutes: 60 },
    });
  });

  test('a garage-only request with no garage that fits: the loop\'s own "no" still shows the cheaper meter once', async () => {
    const model = recordingModel([
      use("u1", "update_request", { kinds: ["garage"], maxPriceUsd: 10, durationMinutes: 60 }),
      use("g1", "search_garages"),
      say("There's a garage for $18.00."),
      say("It's $18.00."),
      say("SHOULD NEVER RUN"),
    ]);
    const t = makeTestApp({
      nearbyZones: [MASS_AVE, GARDEN_ST],
      garage: garages([garageOption({ id: "g-a", priceUsd: 18 })]),
      assistantModel: model,
    });
    const body = (await message(t, "a garage under $10 for an hour")).json();
    expect(model.calls).toBe(4);
    const card = body.plan.plan as Card;
    expect(card.kind).toBe("none_meets");
    expect(card.nearMisses.map((o) => o.type).sort()).toEqual(["garage", "street"]);
    // The model was never offered the street quote, and never needed it.
    expect(model.offered.slice(1).every((tools) => !tools.includes("quote_street"))).toBe(true);
    expect(body.reply).toBe((body.plan.plan as { headline: string }).headline);
    expect(body.reply).toContain("No garage under $10.00");
  });

  test("the edit lock is the tap's turn only: the next message edits the request as usual", async () => {
    const model = recordingModel([
      use("u1", "update_request", { maxPriceUsd: 2, durationMinutes: 60 }),
      use("q1", "quote_street"),
      use("p1", "propose_plan", { plan: { kind: "none_meets" } }),
      say("Done."),
      use("u3", "update_request", { durationMinutes: 90 }),
      say("Changed."),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const first = (await message(t, "parking under $2 for an hour")).json();
    await message(t, "Allow up to $7.00", { conversation_id: first.conversationId });
    await message(t, "make it 90 minutes", { conversation_id: first.conversationId });
    const saved = t.state.conversations[0]!.requestState as {
      hard: { maxPriceUsd: number };
      window: { durationMinutes: number };
    };
    expect(saved).toMatchObject({ hard: { maxPriceUsd: 7 }, window: { durationMinutes: 90 } });
  });

  test("a relaxation read back from a transcript is trusted for its shape only", () => {
    const search = (relaxSuggestions: unknown[]) =>
      ({ relaxSuggestions }) as unknown as SearchResult;
    const chip = (extra: Record<string, unknown>) =>
      search([{ label: "Allow up to $7.00", reply: "Allow up to $7.00", wouldYield: 1, ...extra }]);
    expect(relaxationTapped(chip({ field: "maxPriceUsd", to: 7 }), " allow  up to $7.00 ")).toEqual(
      {
        field: "maxPriceUsd",
        patch: { maxPriceUsd: 7 },
      },
    );
    // A value that isn't one a patch could carry applies nothing.
    expect(
      relaxationTapped(chip({ field: "maxPriceUsd", to: -3 }), "Allow up to $7.00"),
    ).toBeNull();
    expect(
      relaxationTapped(chip({ field: "maxPriceUsd", to: "7" }), "Allow up to $7.00"),
    ).toBeNull();
    expect(
      relaxationTapped(chip({ field: "maxWalkMinutes", to: 2.5 }), "Allow up to $7.00"),
    ).toBeNull();
    // A field no relaxation has is nothing: the stay is never a chip's to set.
    expect(
      relaxationTapped(chip({ field: "durationMinutes", to: 7 }), "Allow up to $7.00"),
    ).toBeNull();
    expect(relaxationTapped(search([]), "Allow up to $7.00")).toBeNull();
    expect(relaxationTapped(null, "Allow up to $7.00")).toBeNull();
    expect(relaxationTapped(chip({ field: "maxPriceUsd", to: 7 }), "")).toBeNull();
  });

  test("every turn's record says which intent it ended in", async () => {
    const model = recordingModel([
      use("u1", "update_request", { kinds: ["garage"], durationMinutes: 60 }),
      say("Anything else."),
    ]);
    const t = makeTestApp({ assistantModel: model });
    await message(t, "a garage for an hour");
    expect(t.state.decisions.find((d) => d.kind === "assistant_turn")).toMatchObject({
      outcome: { intent: "garage_or_lot", requestVersion: 1 },
    });
  });
});
