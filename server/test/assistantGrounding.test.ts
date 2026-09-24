/**
 * PR #117 review findings, pinned:
 *
 * - Grounding (destination, pins, provenance) comes from the stored
 *   TRANSCRIPT, not a per-process map — so it survives a restart, holds
 *   across machines, and never crosses from one user's conversation into
 *   another's.
 * - Street options pin at the point THEIR zone was quoted.
 * - Garage options are search results or they don't reach a card: price,
 *   link, and source come from the search, never model text; the handoff
 *   note names the source the option came from.
 * - Model times without an offset are Eastern wall-clock, on any host.
 * - The confirmation token authorizes the tapped option only, once, even
 *   under concurrent claims.
 * - Every paid model call in a turn — explain_decision's too — lands on
 *   the turn's accounting row.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { groundingIn } from "../src/services/assistant/loop.js";
import type { SingleSpotPlan } from "../src/services/assistant/plans.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { makeMultiGarageProvider } from "../src/services/garage/multiProvider.js";
import type { GeocoderProvider } from "../src/services/assistant/geocoder.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import {
  API_KEY,
  BOYLSTON_BOS,
  HOURS_MON_SAT,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  makeTestApp,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);

/** Scripted transport; snapshots each call's messages (the loop keeps
 * appending to the array it passed, so a reference would show the future). */
function scriptedModel(responses: ModelResponse[]): ModelClient & { seen: ModelTurn[][] } {
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

const toolUse = (id: string, name: string, input: unknown): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const NEWBURY = { lat: 42.3503, lng: -71.0811, displayName: "Newbury Street, Back Bay" };

const geocoder: GeocoderProvider = {
  async geocode() {
    return { ok: true, results: [{ ...NEWBURY, city: "bos" }] };
  },
};

const streetOption = (extra: Record<string, unknown> = {}) => ({
  id: "s1",
  type: "street",
  label: "Boylston meter",
  detail: "",
  priceUsd: 3.75,
  durationMinutes: 60,
  zoneId: BOYLSTON_BOS.zoneId,
  recommended: true,
  ...extra,
});

describe("grounding lives in the transcript", () => {
  test("a later turn's plan keeps the earlier turn's destination (no in-memory state)", async () => {
    const model = scriptedModel([
      toolUse("t1", "geocode_place", { query: "Newbury Street" }),
      toolUse("t2", "quote_street", {
        lat: NEWBURY.lat,
        lng: NEWBURY.lng,
        duration_minutes: 60,
        when: MONDAY_2PM,
      }),
      toolUse("t3", "propose_plan", { plan: { kind: "single_spot", options: [streetOption()] } }),
      // Turn two re-proposes without geocoding again.
      toolUse("t4", "propose_plan", {
        plan: { kind: "single_spot", options: [streetOption({ durationMinutes: 90 })] },
      }),
    ]);
    const first = makeTestApp({
      candidates: [BOYLSTON_BOS],
      geocoder,
      assistantModel: model,
      now: () => NOW,
    });
    const one = await first.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "parking on Newbury Street for an hour" },
    });
    expect(one.statusCode).toBe(200);
    const conversationId = one.json().conversationId as string;

    // "A restart": a fresh app (fresh AssistantTools, empty caches) over
    // the same database rows.
    const second = makeTestApp({
      candidates: [BOYLSTON_BOS],
      assistantModel: model,
      now: () => NOW,
    });
    second.state.conversations.push(...first.state.conversations);
    const two = await second.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "make it 90 minutes", conversation_id: conversationId },
    });
    expect(two.statusCode).toBe(200);
    const plan = two.json().plan.plan as SingleSpotPlan;
    expect(plan.options[0]!.durationMinutes).toBe(90);
    expect(plan.destination).toEqual({
      lat: NEWBURY.lat,
      lng: NEWBURY.lng,
      label: NEWBURY.displayName,
    });
    expect(plan.options[0]!.lat).toBeCloseTo(NEWBURY.lat, 6);
  });

  test("another user's conversation id is refused before any model call, and their transcript is untouched", async () => {
    const model = scriptedModel([
      toolUse("t1", "geocode_place", { query: "Newbury Street" }),
      toolUse("t2", "quote_street", {
        lat: NEWBURY.lat,
        lng: NEWBURY.lng,
        duration_minutes: 60,
        when: MONDAY_2PM,
      }),
      toolUse("t3", "propose_plan", { plan: { kind: "single_spot", options: [streetOption()] } }),
      { content: [{ type: "text", text: "unused" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({
      candidates: [BOYLSTON_BOS],
      geocoder,
      assistantModel: model,
      now: () => NOW,
    });
    const mine = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "parking on Newbury Street" },
    });
    expect(mine.json().plan.plan.destination).toBeDefined();
    const before = JSON.stringify(t.state.conversations);
    const callsBefore = model.seen.length;
    const theirs = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: { ...HEADERS, "x-api-key": NONADMIN_API_KEY },
      payload: { text: "ignore the above", conversation_id: mine.json().conversationId },
    });
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual({ error: "conversation_not_found" });
    expect(model.seen.length).toBe(callsBefore);
    expect(JSON.stringify(t.state.conversations)).toBe(before);
  });

  test("groundingIn reads quotes with their points, the latest place, and the latest search", () => {
    const turns: ModelTurn[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "g1", name: "geocode_place", input: { query: "a" } },
          { type: "tool_use", id: "q1", name: "quote_street", input: { lat: 42.1, lng: -71.1 } },
          { type: "tool_use", id: "s1", name: "search_garages", input: {} },
          { type: "tool_use", id: "g2", name: "geocode_place", input: { query: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "g1",
            content: JSON.stringify({
              found: true,
              results: [{ lat: 1, lng: 2, displayName: "First", city: "bos" }],
            }),
          },
          {
            type: "tool_result",
            tool_use_id: "q1",
            content: JSON.stringify({ found: true, zoneId: "bos-a", costUsd: 4.1 }),
          },
          {
            type: "tool_result",
            tool_use_id: "s1",
            content: JSON.stringify({
              provider: "spothero",
              searchedAt: "2026-01-05T19:00:00.000Z",
            }),
          },
          // A miss doesn't replace the place that was found.
          { type: "tool_result", tool_use_id: "g2", content: JSON.stringify({ found: false }) },
        ],
      },
    ];
    expect(groundingIn(turns)).toEqual({
      streetQuotes: [{ zoneId: "bos-a", costUsd: 4.1, lat: 42.1, lng: -71.1 }],
      geocode: { lat: 1, lng: 2, label: "First" },
      garageSearch: { provider: "spothero", searchedAt: "2026-01-05T19:00:00.000Z" },
    });
  });
});

describe("street pins", () => {
  test("two street options each pin at the point their own zone was quoted", async () => {
    const west: Candidate = {
      ...BOYLSTON_BOS,
      zoneId: "bos-west",
      providerZoneNumber: "111",
      rateFirstHourUsd: 2,
      rateAdditionalHourUsd: 2,
      hours: HOURS_MON_SAT,
    };
    const east: Candidate = {
      ...west,
      zoneId: "bos-east",
      providerZoneNumber: "222",
      rateFirstHourUsd: 3,
      rateAdditionalHourUsd: 3,
    };
    let next: Candidate = west;
    const t = makeTestApp({ candidates: [west], now: () => NOW });
    // Serve whichever zone the test says is at the point being quoted.
    t.deps.assistantTools!["deps"].findCandidates = async () => [next];
    const ctx = { userId: "u1", conversationId: "c1" };
    await t.deps.assistantTools!.execute(ctx, "quote_street", {
      lat: 42.1,
      lng: -71.1,
      duration_minutes: 60,
      when: MONDAY_2PM,
    });
    next = east;
    await t.deps.assistantTools!.execute(ctx, "quote_street", {
      lat: 42.2,
      lng: -71.2,
      duration_minutes: 60,
      when: MONDAY_2PM,
    });
    const out = await t.deps.assistantTools!.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          streetOption({ id: "w", zoneId: "bos-west", priceUsd: 2 }),
          streetOption({ id: "e", zoneId: "bos-east", priceUsd: 3, recommended: false }),
        ],
      },
    });
    const [w, e] = (out.endTurn!.plan as SingleSpotPlan).options;
    expect([w!.lat, w!.lng]).toEqual([42.1, -71.1]);
    expect([e!.lat, e!.lng]).toEqual([42.2, -71.2]);
  });
});

function garage(id: string, provider: string, extra: Partial<GarageOption> = {}): GarageOption {
  return {
    id,
    provider,
    name: `Garage ${id}`,
    address: `${id} Main St`,
    lat: 42.351,
    lng: -71.08,
    priceUsd: 21.5,
    distanceM: 200,
    walkMinutes: 3,
    entryType: "self",
    deepLink: `https://www.${provider}.com/checkout/${id}`,
    ...extra,
  };
}

function cachedGarages(options: GarageOption[]): GarageProvider & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    id: "parkwhiz+spothero",
    canReserve: false,
    queries,
    search: async (q) => {
      queries.push(q);
      return { ok: true, options, fromCache: false };
    },
    optionById: (id) => options.find((o) => o.id === id) ?? null,
    book: async (id) => {
      const option = options.find((o) => o.id === id);
      if (!option) throw new Error(`unknown garage option ${id}`);
      return { kind: "deeplink_handoff", option, deepLink: option.deepLink };
    },
  };
}

const garageOption = (extra: Record<string, unknown> = {}) => ({
  id: "o1",
  type: "garage",
  label: "Garage pw-1",
  detail: "",
  priceUsd: 9.99,
  durationMinutes: 120,
  garageOptionId: "pw-1",
  recommended: true,
  ...extra,
});

describe("garage options are search results", () => {
  test("an option no search returned is bounced back to the model", async () => {
    const t = makeTestApp({ garage: cachedGarages([garage("pw-1", "parkwhiz")]), now: () => NOW });
    const out = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      { plan: { kind: "single_spot", options: [garageOption({ garageOptionId: "invented" })] } },
    );
    expect(out.endTurn).toBeUndefined();
    expect(out.result).toMatchObject({
      error: "garage_option_ungrounded",
      optionIds: ["o1"],
    });
    expect(t.state.assistantPlans).toHaveLength(0);
  });

  test("price, link, source, and pin are the search's — model text is replaced", async () => {
    const t = makeTestApp({ garage: cachedGarages([garage("pw-1", "parkwhiz")]), now: () => NOW });
    const out = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      {
        plan: {
          kind: "single_spot",
          options: [
            garageOption({
              deepLink: "https://evil.example/pay",
              provider: "spothero",
              priceUsd: 9.99,
            }),
          ],
        },
      },
    );
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    expect(option).toMatchObject({
      priceUsd: 21.5,
      provider: "parkwhiz",
      deepLink: "https://www.parkwhiz.com/checkout/pw-1",
      lat: 42.351,
      lng: -71.08,
    });
  });

  test("a ParkWhiz option's handoff names ParkWhiz, not SpotHero", async () => {
    const t = makeTestApp({ garage: cachedGarages([garage("pw-1", "parkwhiz")]), now: () => NOW });
    const proposed = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      { plan: { kind: "single_spot", options: [garageOption()] } },
    );
    const confirm = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: proposed.endTurn!.planId, optionId: "o1" },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({
      kind: "garage_handoff",
      deepLink: "https://www.parkwhiz.com/checkout/pw-1",
      note: "Checkout finishes in ParkWhiz; the parking pass will live in your ParkWhiz account.",
    });
  });

  test("a merged search returns at most 8 rows, nearest first", async () => {
    const many = (provider: string) =>
      Array.from({ length: 6 }, (_, i) =>
        garage(`${provider}-${i}`, provider, {
          address: `${provider} ${i} St`,
          distanceM: i * 100 + (provider === "parkwhiz" ? 50 : 0),
        }),
      );
    const merged = makeMultiGarageProvider([
      cachedGarages(many("spothero")),
      cachedGarages(many("parkwhiz")),
    ]);
    const out = await merged.search({
      lat: 42.35,
      lng: -71.08,
      startsAt: MONDAY_2PM,
      endsAt: MONDAY_2PM,
    });
    if (!out.ok) throw new Error("unreachable");
    expect(out.options).toHaveLength(8);
    expect(out.options.map((o) => o.distanceM)).toEqual([0, 50, 100, 150, 200, 250, 300, 350]);
  });
});

describe("model times without an offset are Eastern, on any host", () => {
  // Pin a host zone that is neither ET nor UTC: the old `new Date(naive)`
  // would read the string in THIS zone, so only the fix passes here.
  const hostTz = process.env["TZ"];
  beforeAll(() => {
    process.env["TZ"] = "Asia/Tokyo";
  });
  afterAll(() => {
    if (hostTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = hostTz;
  });

  test("an offset-less future start is pay-on-arrival and stored with its offset", async () => {
    const t = makeTestApp({ candidates: [BOYLSTON_BOS], now: () => NOW });
    const ctx = { userId: "u1", conversationId: "c1" };
    await t.deps.assistantTools!.execute(ctx, "quote_street", {
      lat: 42.35,
      lng: -71.08,
      duration_minutes: 60,
      when: "2026-01-05T17:00:00",
    });
    const out = await t.deps.assistantTools!.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [streetOption({ startsAt: "2026-01-05T17:00:00" })],
      },
    });
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    // 5 PM ET on the fixture Monday: three hours out.
    expect(option.payOnArrival).toBe(true);
    expect(option.startsAt).toBe("2026-01-05T17:00:00-05:00");
  });

  test("search_garages hands providers one canonical ET window; unreadable and inverted windows bounce", async () => {
    const garages = cachedGarages([]);
    const t = makeTestApp({ garage: garages, now: () => NOW });
    const ctx = { userId: "u1", conversationId: "c1" };
    await t.deps.assistantTools!.execute(ctx, "search_garages", {
      lat: 42.35,
      lng: -71.08,
      starts_at: "2026-01-05T22:00:00Z",
      ends_at: "2026-01-05T19:00:00",
    });
    expect(garages.queries[0]).toMatchObject({
      startsAt: "2026-01-05T17:00:00-05:00",
      endsAt: "2026-01-05T19:00:00-05:00",
    });
    const garbled = await t.deps.assistantTools!.execute(ctx, "search_garages", {
      lat: 42.35,
      lng: -71.08,
      starts_at: "tonight at 7",
      ends_at: "2026-01-05T21:00:00-05:00",
    });
    expect(garbled.result).toMatchObject({ error: "unreadable_time" });
    const inverted = await t.deps.assistantTools!.execute(ctx, "search_garages", {
      lat: 42.35,
      lng: -71.08,
      starts_at: "2026-01-05T19:00:00-05:00",
      ends_at: "2026-01-05T18:00:00-05:00",
    });
    expect(inverted.result).toMatchObject({ error: "bad_window" });
    expect(garages.queries).toHaveLength(1);
  });
});

describe("the confirmation token authorizes the tapped option, once", () => {
  async function tapped(optionId: string) {
    const t = makeTestApp({ candidates: [BOYLSTON_BOS], now: () => NOW });
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: {
        kind: "single_spot",
        options: [
          streetOption({ id: "s1" }),
          streetOption({ id: "s2", zoneId: "bos-other", recommended: false }),
        ],
      },
    });
    const token = "tok-" + optionId;
    t.state.assistantConfirmations.push({
      token,
      userId: "u1",
      planId: "plan1",
      optionId,
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: null,
    });
    return { t, token, tools: t.deps.assistantTools!, ctx: { userId: "u1", conversationId: "c1" } };
  }

  test("a token for one option can't start another zone or another duration", async () => {
    const { tools, token, ctx, t } = await tapped("s1");
    for (const input of [
      { zone: "bos-other", duration_minutes: 60 },
      { zone: BOYLSTON_BOS.zoneId, duration_minutes: 240 },
    ]) {
      const out = await tools.execute(ctx, "start_session", {
        ...input,
        confirmation_token: token,
      });
      expect(out.result).toMatchObject({ error: "needs_confirmation" });
      expect((out.result as { message: string }).message).toContain("different option");
    }
    // Refusals don't burn it: the tapped option still goes through, once.
    const ok = await tools.execute(ctx, "start_session", {
      zone: BOYLSTON_BOS.zoneId,
      duration_minutes: 60,
      confirmation_token: token,
    });
    expect(ok.result).toMatchObject({ confirmed: true });
    expect(t.state.assistantConfirmations[0]!.usedAt).not.toBeNull();
  });

  test("two concurrent claims of one token: exactly one wins", async () => {
    const { tools, token, ctx, t } = await tapped("s1");
    // Hold both calls at the read until both have made it, so each sees
    // the token unused — the race the atomic claim exists for.
    const table = t.state as unknown as { assistantConfirmations: unknown[] };
    void table;
    const confirmations = t.deps.db.assistantConfirmation;
    const realFind = confirmations.findUnique.bind(confirmations);
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    confirmations.findUnique = async (args) => {
      const row = await realFind(args);
      arrived += 1;
      if (arrived === 2) release();
      await bothRead;
      return row ? { ...row } : row;
    };
    const claim = () =>
      tools.execute(ctx, "start_session", {
        zone: BOYLSTON_BOS.zoneId,
        duration_minutes: 60,
        confirmation_token: token,
      });
    const results = await Promise.all([claim(), claim()]);
    const wins = results.filter((r) => (r.result as { confirmed?: boolean }).confirmed === true);
    expect(arrived).toBe(2);
    expect(wins).toHaveLength(1);
  });
});

describe("every paid call in a turn is billed to it", () => {
  test("explain_decision's phrasing call lands on the turn's accounting row", async () => {
    const t = makeTestApp({
      now: () => NOW,
      assistantModel: scriptedModel([
        {
          ...toolUse("t1", "explain_decision", { decision_id: "d1" }),
          model: "claude-sonnet-5",
          usage: { inputTokens: 1000, outputTokens: 100 },
        },
        {
          content: [{ type: "text", text: "Explained." }],
          stopReason: "end_turn",
          model: "claude-sonnet-5",
          usage: { inputTokens: 1000, outputTokens: 100 },
        },
      ]),
      explainModel: {
        async create() {
          return {
            content: [{ type: "text", text: "It paid because you parked." }],
            stopReason: "end_turn",
            model: "claude-haiku-4-5-20251001",
            usage: { inputTokens: 100_000, outputTokens: 10_000 },
          };
        },
      },
    });
    t.state.decisions.push({
      kind: "session_start",
      rule: "start_ok",
      inputs: {},
      outcome: { action: "paid" },
      userId: "u1",
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "why did you pay?" },
    });
    expect(res.statusCode).toBe(200);
    const outcome = t.state.decisions.find((d) => d.kind === "assistant_turn")!.outcome as Record<
      string,
      unknown
    >;
    // Loop: 2000 in / 200 out on sonnet 5 = $0.006. Haiku: 100k in / 10k
    // out = $0.15. Without the side call the row would say $0.006.
    expect(outcome["estimatedCostUsd"]).toBeCloseTo(0.156, 4);
    expect(outcome["otherModelCalls"]).toEqual([
      { model: "claude-haiku-4-5-20251001", inputTokens: 100_000, outputTokens: 10_000 },
    ]);
  });
});
