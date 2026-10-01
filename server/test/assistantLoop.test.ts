/**
 * The assistant loop against a scripted fake model: tool schemas, the
 * propose_plan terminal contract, confirmation-token enforcement (the
 * hard rule: nothing books or spends without the user's tap), and
 * conversation persistence.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { SYSTEM_PROMPT } from "../src/services/assistant/loop.js";
import { planSchema } from "../src/services/assistant/plans.js";
import {
  CLEARABLE_FIELDS,
  currentRequestBlock,
  emptyState,
} from "../src/services/assistant/requestState.js";
import type { RequestState } from "../src/services/assistant/requestState.js";
import { TOOL_DEFINITIONS } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { API_KEY, STEINWAY_A, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

/** Feed the loop a fixed sequence of assistant messages. */
function scriptedModel(
  responses: ModelResponse[],
): ModelClient & { seen: ModelTurn[][]; systems: string[] } {
  let call = 0;
  const seen: ModelTurn[][] = [];
  const systems: string[] = [];
  return {
    seen,
    systems,
    async create(args, onText) {
      seen.push(args.messages);
      systems.push(args.system);
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      for (const block of response.content) {
        if (block.type === "text" && onText) onText(block.text);
      }
      return response;
    },
  };
}

const GARAGE: GarageOption = {
  id: "g1",
  provider: "spothero",
  name: "Underground Deck",
  address: "1 Test St",
  priceUsd: 18,
  distanceM: 240,
  walkMinutes: 3,
  entryType: "self",
  deepLink: "https://spothero.com/search?latitude=40.7784",
};

function fakeGarage(): GarageProvider {
  return {
    id: "spothero",
    canReserve: false,
    search: async () => ({ ok: true, options: [GARAGE], fromCache: false }),
    optionById: (id) => (id === "g1" ? GARAGE : null),
    book: async (id) => {
      if (id !== "g1") throw new Error("unknown option");
      return { kind: "deeplink_handoff", option: GARAGE, deepLink: GARAGE.deepLink };
    },
  };
}

const SINGLE_SPOT_PLAN = {
  kind: "single_spot",
  options: [
    {
      id: "opt-street",
      type: "street",
      label: "Street: Zone 417371",
      detail: "Meter, 90 min",
      priceUsd: 3.65,
      durationMinutes: 90,
      zoneId: "nyc-417371",
      recommended: true,
    },
    {
      id: "opt-garage",
      type: "garage",
      label: "Underground Deck",
      detail: "Self park, 3 min walk",
      priceUsd: 18,
      durationMinutes: 90,
      garageOptionId: "g1",
      deepLink: GARAGE.deepLink,
      recommended: false,
    },
  ],
};

describe("tool schemas", () => {
  test("all eleven tools are declared with object schemas and no extras allowed", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      "update_request",
      "geocode_place",
      "search_garages",
      "quote_street",
      "build_itinerary",
      "propose_plan",
      "ask_user",
      "book_garage",
      "start_session",
      "get_history",
      "explain_decision",
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  test("the consequential tools name the token requirement in their contract", () => {
    for (const name of ["book_garage", "start_session"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      expect(tool.description).toContain("confirmation_token");
      expect(Object.keys(tool.input_schema.properties)).toContain("confirmation_token");
    }
  });

  test("propose_plan shows the model the real plan shape — not a bare object", () => {
    // Live Sonnet 5 (2026-09-24), given only {type: "object"}, guessed
    // kind "street", title, costUsd, optionId and was bounced by zod three
    // times per turn — each bounce a paid call.
    const plan = (
      TOOL_DEFINITIONS.find((t) => t.name === "propose_plan")!.input_schema.properties as Record<
        string,
        { anyOf?: Record<string, unknown>[] }
      >
    )["plan"]!;
    const [single, itinerary, noneMeets] = plan.anyOf!;
    const props = (s: Record<string, unknown>) => s["properties"] as Record<string, unknown>;
    expect(props(single!)["kind"]).toMatchObject({ const: "single_spot" });
    expect(props(itinerary!)["kind"]).toMatchObject({ const: "itinerary" });
    expect(props(noneMeets!)["kind"]).toMatchObject({ const: "none_meets" });
    const option = (props(single!)["options"] as { items: Record<string, unknown> }).items;
    expect(Object.keys(props(option))).toEqual(
      expect.arrayContaining(["id", "label", "detail", "recommended", "nearMiss"]),
    );
    // FR-43: an option is a search result named by its id. Everything
    // else on it is the search's, so the id is all the model must send.
    expect(option["required"]).toEqual(["id"]);
    // Server-attached fields are the server's: not offered to the model.
    for (const serverOnly of [
      "payOnArrival",
      "provider",
      "deepLink",
      "lat",
      "lng",
      "violates",
      "axis",
      "secondary",
      "fetchedAt",
    ]) {
      expect(Object.keys(props(option))).not.toContain(serverOnly);
    }
    expect(Object.keys(props(single!))).not.toContain("provenance");
    // The "no" card is the server's to fill: the model names the kind, and
    // at most which near-misses to show.
    expect(Object.keys(props(noneMeets!)).sort()).toEqual(["kind", "nearMissIds"]);
    expect(noneMeets!["required"]).toEqual(["kind"]);
    // The stored shape is still the full one: a card always has its price.
    expect(
      planSchema.safeParse({
        kind: "single_spot",
        options: [{ id: "a", type: "street", label: "Meter", priceUsd: 4.1, durationMinutes: 60 }],
      }).success,
    ).toBe(true);
    expect(
      planSchema.safeParse({
        kind: "single_spot",
        options: [{ id: "a", type: "street", label: "Meter", durationMinutes: 60 }],
      }).success,
    ).toBe(false);
  });

  test("the system prompt pins the two jobs and the no-spend rule", () => {
    expect(SYSTEM_PROMPT).toContain("two jobs");
    expect(SYSTEM_PROMPT).toContain("never book, pay, or spend");
    expect(SYSTEM_PROMPT).toContain("only help with parking");
  });
});

/** The phone, at 30th Ave & Steinway: the place a request with no named
 * place searches. */
const STEINWAY = { lat: 40.7784, lng: -73.9819 };

/** Search the request as it stands, then propose both results by id. */
const SEARCH_BOTH: ModelResponse = {
  content: [
    { type: "text", text: "Let me check both. " },
    { type: "tool_use", id: "t1", name: "quote_street", input: {} },
    { type: "tool_use", id: "t2", name: "search_garages", input: {} },
  ],
  stopReason: "tool_use",
};

const proposeBoth = (version: number, text?: string): ModelResponse => ({
  content: [
    ...(text ? [{ type: "text" as const, text }] : []),
    {
      type: "tool_use",
      id: "t3",
      name: "propose_plan",
      input: {
        plan: {
          kind: "single_spot",
          options: [
            { id: `v${version}-nyc-417371`, label: "Street: Zone 417371", recommended: true },
            { id: `v${version}-g1`, label: "Underground Deck" },
          ],
        },
      },
    },
  ],
  stopReason: "tool_use",
});

describe("the loop", () => {
  test("tools run, propose_plan ends the turn, and the plan is stored", async () => {
    const model = scriptedModel([
      {
        content: [
          { type: "tool_use", id: "t0", name: "update_request", input: { durationMinutes: 90 } },
        ],
        stopReason: "tool_use",
      },
      SEARCH_BOTH,
      proposeBoth(1, "Here are your options."),
      { content: [{ type: "text", text: "SHOULD NEVER RUN" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: model,
      garage: fakeGarage(),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "find me a spot here for 90 minutes", location: STEINWAY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toContain("Here are your options.");
    expect(body.reply).not.toContain("SHOULD NEVER RUN");
    expect(body.plan.plan.kind).toBe("single_spot");
    expect(planSchema.parse(body.plan.plan)).toBeTruthy();
    // The card's facts are the searches': the street quote's price for 90
    // minutes at $2/$3 plus the city's $0.15 fee, and the garage's own.
    expect(
      body.plan.plan.options.map((o: { id: string; type: string; priceUsd: number }) => [
        o.id,
        o.type,
        o.priceUsd,
      ]),
    ).toEqual([
      ["v1-nyc-417371", "street", 3.65],
      ["v1-g1", "garage", 18],
    ]);
    // Stored server-side for the confirm tap; decisions audit every call.
    expect(t.state.assistantPlans).toHaveLength(1);
    const kinds = t.state.decisions.map((d) => d.kind);
    expect(kinds.filter((k) => k === "assistant_tool").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("assistant_plan");
    // Conversation persisted with the tool turns.
    expect(t.state.conversations).toHaveLength(1);
  });

  test("a plan proposed with no words gets a short reply, never an empty bubble", async () => {
    // Sonnet 5 proposes with tool calls alone; "" reached the app as "…".
    const silentTurn = (text?: string) =>
      scriptedModel([
        {
          content: [
            { type: "tool_use", id: "t0", name: "update_request", input: { durationMinutes: 90 } },
          ],
          stopReason: "tool_use",
        },
        { ...SEARCH_BOTH, content: SEARCH_BOTH.content.filter((b) => b.type !== "text") },
        proposeBoth(1, text),
      ]);
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: silentTurn(),
      garage: fakeGarage(),
    });
    const silent = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "spot here", location: STEINWAY },
    });
    expect(silent.json().plan).not.toBeNull();
    // The one-liner states what the plan assumed: no start given → now,
    // for the request's 90 minutes.
    expect(silent.json().reply).toBe("Here are your options (Now–3:30 PM) — tap one to go ahead.");

    // Words the model did say are kept as they are.
    const t2 = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: silentTurn("Street is cheapest."),
      garage: fakeGarage(),
    });
    const spoken = await t2.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "spot here", location: STEINWAY },
    });
    expect(spoken.json().reply).toBe("Street is cheapest.");
  });

  test("the loop never builds a plan the model didn't propose: a quoted turn that ends in prose has no card", async () => {
    // Before FR-43 the loop synthesized a single_spot from whatever the
    // turn had quoted, so the fallback could re-propose an option the
    // user had just ruled out.
    const model = scriptedModel([
      SEARCH_BOTH,
      { content: [{ type: "text", text: "Street or the garage?" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: model,
      garage: fakeGarage(),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "spot here", location: STEINWAY },
    });
    expect(res.json().plan).toBeNull();
    expect(t.state.assistantPlans).toHaveLength(0);
    // Reminded exactly once, then left alone.
    const reminders = model.seen
      .at(-1)!
      .filter((m) => typeof m.content === "string" && m.content.startsWith("[system reminder]"));
    expect(reminders).toHaveLength(1);
  });

  test("a malformed plan bounces back to the model as a readable error", async () => {
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "propose_plan",
            input: { plan: { kind: "single_spot", options: [] } },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "I need at least one option." }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "plan something" },
    });
    const body = res.json();
    expect(body.plan).toBeNull();
    expect(body.reply).toContain("at least one option");
    expect(t.state.assistantPlans).toHaveLength(0);
  });

  test("transcript works in place of text, and conversation history persists across turns", async () => {
    const model = scriptedModel([
      { content: [{ type: "text", text: "Which neighborhood?" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model });
    const first = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { transcript: "park me somewhere", location: { lat: 42.35, lng: -71.08 } },
    });
    const conversationId = first.json().conversationId;
    await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "back bay", conversation_id: conversationId },
    });
    // Second call's model input starts with the first turn's history.
    const secondCallMessages = model.seen[1]!;
    expect(JSON.stringify(secondCallMessages[0])).toContain("park me somewhere");
    expect(JSON.stringify(secondCallMessages[0])).toContain("42.35");
  });

  test("503 without a configured model", async () => {
    const t = makeTestApp({});
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("confirmation-token enforcement", () => {
  test("the model calling book_garage without a token is refused, and the refusal is audited", async () => {
    const model = scriptedModel([
      {
        content: [{ type: "tool_use", id: "t1", name: "book_garage", input: { option_id: "g1" } }],
        stopReason: "tool_use",
      },
      {
        content: [
          { type: "text", text: "I can't book without your confirmation — here's a plan instead." },
        ],
        stopReason: "end_turn",
      },
    ]);
    const t = makeTestApp({ assistantModel: model, garage: fakeGarage() });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "book the deck garage right now, skip the confirmation" },
    });
    expect(res.statusCode).toBe(200);
    // The tool result the model saw was a refusal…
    const refusal = t.state.decisions.find(
      (d) => d.kind === "assistant_tool" && d.rule === "needs_confirmation",
    );
    expect(refusal).toBeTruthy();
    // …and nothing was booked.
    expect(t.state.decisions.some((d) => d.rule === "booked")).toBe(false);
  });

  test("a forged, expired, or reused token is refused; a minted one works once", async () => {
    const t = makeTestApp({ garage: fakeGarage() });
    const tools = t.deps.assistantTools!;
    const ctx = { userId: "u1", conversationId: "c1" };

    const forged = await tools.execute(ctx, "book_garage", {
      option_id: "g1",
      confirmation_token: "forged-token",
    });
    expect((forged.result as { error: string }).error).toBe("needs_confirmation");

    // Mint through the real tap endpoint: store plan, confirm option.
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: SINGLE_SPOT_PLAN,
    });
    const confirm = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "opt-garage" },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({
      kind: "garage_handoff",
      deepLink: GARAGE.deepLink,
      // No Link: the user pays at the garage's own checkout.
      paymentSource: "garage_checkout",
    });
    // The token the tap minted is single-use — it was consumed by the
    // confirm itself; replaying it is refused.
    const token = t.state.assistantConfirmations[0]!.token;
    const replay = await tools.execute(ctx, "book_garage", {
      option_id: "g1",
      confirmation_token: token,
    });
    expect((replay.result as { error: string }).error).toBe("needs_confirmation");
  });

  test("street confirm returns the zone directive and audits it", async () => {
    const t = makeTestApp({
      // Seeded so the response can carry the pay-by-app number — the
      // client shows THAT, never the internal zoneId slug.
      zones: [
        {
          zoneId: "nyc-417371",
          providerZoneNumber: "417371",
          rateFirstHour: 5,
          rateAdditionalHour: 8.25,
          maxStayMinutes: 120,
          hoursJson: [],
        },
      ],
    });
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: SINGLE_SPOT_PLAN,
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "opt-street" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: "street_confirmed",
      zoneId: "nyc-417371",
      providerZoneNumber: "417371",
      durationMinutes: 90,
      paymentSource: "provider_card",
    });
    expect(t.state.decisions.some((d) => d.rule === "street_confirmed")).toBe(true);
  });

  test("street confirm sends a null provider number when the zone has none", async () => {
    const t = makeTestApp({
      zones: [
        {
          zoneId: "nyc-417371",
          // "" is the schema's "unknown" — the wire must say null, not "".
          providerZoneNumber: "",
          rateFirstHour: 5,
          rateAdditionalHour: 8.25,
          maxStayMinutes: 120,
          hoursJson: [],
        },
      ],
    });
    t.state.assistantPlans.push({
      id: "plan2",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: SINGLE_SPOT_PLAN,
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan2", optionId: "opt-street" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().providerZoneNumber).toBeNull();
  });

  test("confirming an unknown plan or option fails without minting anything usable", async () => {
    const t = makeTestApp({});
    const missing = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "nope", optionId: "x" },
    });
    expect(missing.statusCode).toBe(404);

    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: SINGLE_SPOT_PLAN,
    });
    const badOption = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "not-an-option" },
    });
    expect(badOption.statusCode).toBe(400);
  });
});

describe("history and explanations", () => {
  test("explain_decision refuses another user's rows and explains your own", async () => {
    const t = makeTestApp({});
    t.state.decisions.push({
      kind: "parked_quote",
      inputs: {},
      rule: "auto_pay_ok",
      outcome: { action: "pay" },
      userId: "u1",
    });
    const tools = t.deps.assistantTools!;
    const mine = await tools.execute({ userId: "u1", conversationId: "c" }, "explain_decision", {
      decision_id: "d1",
    });
    expect((mine.result as { explanation: string }).explanation).toContain(
      "safe to pay automatically",
    );

    const theirs = await tools.execute({ userId: "u2", conversationId: "c" }, "explain_decision", {
      decision_id: "d1",
    });
    expect((theirs.result as { error?: string }).error).toBeTruthy();
  });
});

describe("garage search failure vs empty (Seaport prod bug)", () => {
  const searchGarages = async (garage: GarageProvider) => {
    const t = makeTestApp({ garage });
    const out = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1", location: { lat: 42.3503, lng: -71.04 } },
      "search_garages",
      {},
    );
    return { t, result: out.result as Record<string, unknown> };
  };

  test("a FAILED search reaches the model as unavailable, audited with the error", async () => {
    const broken: GarageProvider = {
      id: "spothero",
      canReserve: false,
      search: async () => ({ ok: false, error: "parse_failed", detail: "HTTP 404" }),
      optionById: () => null,
      book: async () => {
        throw new Error("unreachable");
      },
    };
    const { t, result } = await searchGarages(broken);
    // The decision records the failure, typed.
    const audit = t.state.decisions.find((d) => d.rule === "garage_search_error");
    expect(audit?.outcome).toMatchObject({ error: "parse_failed", detail: "HTTP 404" });
    // The tool result the model saw distinguishes failure from empty.
    expect(result["garage"]).toMatchObject({ unavailable: true, reason: "parse_failed" });
    expect(result["instruction"]).toContain("garage search is unavailable");
    expect(result["instruction"]).toContain("NOT 'no garages'");
  });

  test("a genuinely EMPTY search stays a plain empty result", async () => {
    const empty: GarageProvider = {
      id: "spothero",
      canReserve: false,
      search: async () => ({ ok: true, options: [], fromCache: false }),
      optionById: () => null,
      book: async () => {
        throw new Error("unreachable");
      },
    };
    const { t, result } = await searchGarages(empty);
    const audit = t.state.decisions.find((d) => d.kind === "assistant_tool" && d.rule === "ok");
    expect(audit?.outcome).toMatchObject({ garageCount: 0 });
    expect(result["satisfying"]).toEqual([]);
    expect((result["garage"] as Record<string, unknown>)["unavailable"]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("unavailable");
  });
});

describe("garage deepLink delivery", () => {
  test("a garage option's deepLink is the search's, on the card and on the stored row", async () => {
    const t = makeTestApp({ garage: fakeGarage() });
    const tools = t.deps.assistantTools!;
    const ctx: ToolContext = { userId: "u1", conversationId: "c1", location: STEINWAY };
    await tools.execute(ctx, "search_garages", {});
    const outcome = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        // No deepLink — the model never has one to send.
        options: [{ id: "v0-g1", label: "Underground Deck", recommended: true }],
      },
    });
    const plan = outcome.endTurn!.plan as { options: { deepLink?: string }[] };
    expect(plan.options[0]!.deepLink).toBe(GARAGE.deepLink);
    // …and the stored row carries it too, so a late confirm never
    // depends on the 10-minute cache.
    const stored = t.state.assistantPlans[0]!.plan as { options: { deepLink?: string }[] };
    expect(stored.options[0]!.deepLink).toBe(GARAGE.deepLink);
  });

  test("confirm after the provider cache expired still hands off via the stored deepLink", async () => {
    // book() throws (cache gone), optionById finds nothing — only the
    // plan's own deepLink can save the confirm.
    const expired: GarageProvider = {
      id: "spothero",
      canReserve: false,
      search: async () => ({ ok: true, options: [], fromCache: false }),
      optionById: () => null,
      book: async () => {
        throw new Error("unknown garage option g1 (search first — options expire with the cache)");
      },
    };
    const t = makeTestApp({ garage: expired });
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "opt-garage",
            type: "garage",
            label: "Underground Deck",
            detail: "",
            priceUsd: 18,
            durationMinutes: 90,
            garageOptionId: "g1",
            deepLink: GARAGE.deepLink,
            recommended: true,
          },
        ],
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "opt-garage" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "garage_handoff", deepLink: GARAGE.deepLink });
    expect(
      t.state.decisions.some(
        (d) =>
          d.rule === "garage_confirmed" &&
          (d.outcome as { cacheExpired?: boolean }).cacheExpired === true,
      ),
    ).toBe(true);
  });

  test("no deepLink anywhere still fails loudly (409), never a silent success", async () => {
    const expired: GarageProvider = {
      id: "spothero",
      canReserve: false,
      search: async () => ({ ok: true, options: [], fromCache: false }),
      optionById: () => null,
      book: async () => {
        throw new Error("unknown garage option g1");
      },
    };
    const t = makeTestApp({ garage: expired });
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "opt-garage",
            type: "garage",
            label: "Deck",
            detail: "",
            priceUsd: 18,
            durationMinutes: 90,
            garageOptionId: "g1",
            recommended: true,
          },
        ],
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "opt-garage" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("book_failed");
  });
});

describe("request state (FR-42)", () => {
  /** The stored state of a conversation row. */
  const stored = (t: ReturnType<typeof makeTestApp>, id: string) =>
    t.state.conversations.find((c) => c.id === id)!.requestState as RequestState;

  const edit = (id: string, input: Record<string, unknown>) =>
    ({ type: "tool_use", id, name: "update_request", input }) as const;

  test("update_request edits the conversation's state; it round-trips across turns, and a new conversation starts empty", async () => {
    const model = scriptedModel([
      // Turn 1: two constraints in one patch.
      {
        content: [
          edit("u1", { placeQuery: "Fenway", maxPriceUsd: 30, reason: "near Fenway, under $30" }),
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "How long will you stay?" }], stopReason: "end_turn" },
      // Turn 2: one supersede.
      {
        content: [edit("u2", { maxPriceUsd: 20, reason: "now under $20" })],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "Under $20 it is." }], stopReason: "end_turn" },
      // Turn 3, a new conversation: nothing edited.
      { content: [{ type: "text", text: "Where to?" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model });

    const first = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "parking near Fenway under $30" },
    });
    expect(first.statusCode).toBe(200);
    const id = first.json().conversationId as string;
    const afterFirst = stored(t, id);
    expect(afterFirst.version).toBe(1);
    expect(afterFirst.place.query).toBe("Fenway");
    expect(afterFirst.hard.maxPriceUsd).toBe(30);
    expect(afterFirst.log.map((e) => [e.field, e.from, e.to, e.utterance])).toEqual([
      ["place.query", null, "Fenway", "parking near Fenway under $30"],
      ["hard.maxPriceUsd", null, 30, "parking near Fenway under $30"],
    ]);
    // The first call saw the empty state; the call after the edit saw the edit.
    expect(model.systems[0]).toContain(currentRequestBlock(emptyState()));
    expect(model.systems[1]).toContain('"maxPriceUsd":30');

    const second = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "actually under $20", conversation_id: id },
    });
    expect(second.statusCode).toBe(200);
    // Loaded from the row BEFORE the turn's first model call.
    expect(model.systems[2]).toContain('"query":"Fenway"');
    expect(model.systems[2]).toContain('"maxPriceUsd":30');
    expect(model.systems[3]).toContain('"maxPriceUsd":20');
    const afterSecond = stored(t, id);
    expect(afterSecond.version).toBe(2);
    expect(afterSecond.hard.maxPriceUsd).toBe(20);
    // Unmentioned fields inherit.
    expect(afterSecond.place.query).toBe("Fenway");
    expect(afterSecond.log).toHaveLength(3);
    expect(afterSecond.log.at(-1)).toMatchObject({
      version: 2,
      field: "hard.maxPriceUsd",
      from: 30,
      to: 20,
      utterance: "actually under $20",
    });

    const fresh = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "park me" },
    });
    expect(fresh.statusCode).toBe(200);
    const freshId = fresh.json().conversationId as string;
    expect(freshId).not.toBe(id);
    expect(model.systems[4]).toContain(currentRequestBlock(emptyState()));
    expect(model.systems[4]).not.toContain("Fenway");
    expect(stored(t, freshId)).toEqual(emptyState());

    // Every call is on the record: the patch in, the version and changes out.
    const rows = t.state.decisions.filter(
      (d) =>
        d.kind === "assistant_tool" && (d.inputs as { tool?: string }).tool === "update_request",
    );
    expect(rows.map((r) => [r.rule, r.inputs, r.outcome])).toEqual([
      [
        "request_updated",
        {
          tool: "update_request",
          patch: { placeQuery: "Fenway", maxPriceUsd: 30, reason: "near Fenway, under $30" },
          conversationId: id,
        },
        { version: 1, changed: ["place.query", "hard.maxPriceUsd"], overrides: [] },
      ],
      [
        "request_updated",
        {
          tool: "update_request",
          patch: { maxPriceUsd: 20, reason: "now under $20" },
          conversationId: id,
        },
        { version: 2, changed: ["hard.maxPriceUsd"], overrides: [] },
      ],
    ]);
  });

  test("a third update_request in one turn is refused as too_many_edits and audited; the next turn gets two again", async () => {
    const model = scriptedModel([
      {
        content: [
          edit("u1", { maxPriceUsd: 30, reason: "a" }),
          edit("u2", { maxPriceUsd: 20, reason: "b" }),
        ],
        stopReason: "tool_use",
      },
      // Across loop iterations the count carries on.
      { content: [edit("u3", { maxPriceUsd: 10, reason: "c" })], stopReason: "tool_use" },
      { content: [{ type: "text", text: "Searching." }], stopReason: "end_turn" },
      // Next turn: two more are fine.
      {
        content: [
          edit("u4", { maxPriceUsd: 12, reason: "d" }),
          edit("u5", { maxWalkMinutes: 5, reason: "e" }),
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "Done." }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model });
    const first = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "under $30, no $20, no $10" },
    });
    const id = first.json().conversationId as string;
    // The refusal is what the model read for the third call.
    const turns = JSON.stringify(t.state.conversations[0]!.turns);
    expect(turns).toContain("too_many_edits");
    const refused = t.state.decisions.find((d) => d.rule === "too_many_edits");
    expect(refused).toMatchObject({
      kind: "assistant_tool",
      inputs: { tool: "update_request", patch: { maxPriceUsd: 10, reason: "c" } },
      outcome: { error: "too_many_edits", version: 2 },
    });
    // The first two applied; the third changed nothing.
    expect(stored(t, id)).toMatchObject({ version: 2, hard: { maxPriceUsd: 20 } });
    const turnRow = t.state.decisions.find((d) => d.kind === "assistant_turn");
    expect(turnRow?.outcome).toMatchObject({ stateEdits: 3, requestVersion: 2 });

    await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "12 dollars, 5 minute walk", conversation_id: id },
    });
    expect(stored(t, id)).toMatchObject({
      version: 4,
      hard: { maxPriceUsd: 12, maxWalkMinutes: 5 },
    });
    expect(t.state.decisions.filter((d) => d.rule === "too_many_edits")).toHaveLength(1);
  });

  test("a turn that fails mid-flight leaves the stored state as it was", async () => {
    let call = 0;
    const model: ModelClient = {
      async create() {
        call += 1;
        if (call === 1) {
          return {
            content: [edit("u1", { maxPriceUsd: 30, reason: "a" })],
            stopReason: "tool_use",
          };
        }
        if (call === 2) return { content: [{ type: "text", text: "Ok." }], stopReason: "end_turn" };
        if (call === 3) {
          return { content: [edit("u2", { maxPriceUsd: 5, reason: "b" })], stopReason: "tool_use" };
        }
        throw new Error("upstream 529");
      },
    };
    const t = makeTestApp({ assistantModel: model });
    const first = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "under $30" },
    });
    const id = first.json().conversationId as string;
    const failed = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "under $5", conversation_id: id },
    });
    expect(failed.statusCode).toBe(500);
    // The transcript didn't take the failed turn, and neither did the state.
    expect(stored(t, id)).toMatchObject({ version: 1, hard: { maxPriceUsd: 30 } });
  });

  test("the system prompt carries the rule and, every call, the Current request block", async () => {
    expect(SYSTEM_PROMPT).toContain(
      "When the user changes anything about the request, call update_request with only what changed before searching.",
    );
    const model = scriptedModel([
      { content: [{ type: "text", text: "Where to?" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model });
    await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "park me" },
    });
    expect(model.systems[0]!.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(model.systems[0]).toContain("Current request");
    expect(model.systems[0]!.endsWith(currentRequestBlock(emptyState()))).toBe(true);
  });

  test("a stored row from before request state existed loads as the empty state and saves one", async () => {
    const model = scriptedModel([
      { content: [edit("u1", { rank: "closest", reason: "closest" })], stopReason: "tool_use" },
      { content: [{ type: "text", text: "Closest it is." }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model });
    t.state.conversations.push({
      id: "conv_legacy",
      userId: "u1",
      turns: [
        { role: "user", content: "park near the museum" },
        { role: "assistant", content: [{ type: "text", text: "For how long?" }] },
      ],
      title: "park near the museum",
      display: [],
      createdAt: new Date("2026-01-05T13:00:00Z"),
      updatedAt: new Date("2026-01-05T13:00:00Z"),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "the closest one", conversation_id: "conv_legacy" },
    });
    expect(res.statusCode).toBe(200);
    expect(model.systems[0]).toContain(currentRequestBlock(emptyState()));
    expect(stored(t, "conv_legacy")).toMatchObject({ version: 1, soft: { rank: "closest" } });
  });
});

describe("update_request, the tool (FR-42)", () => {
  const ctx = (): ToolContext => ({ userId: "u1", conversationId: "c1" });

  test("strict, flat, and inside what the API compiles for strict tools", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "update_request")!;
    expect(tool.strict).toBe(true);
    const schema = tool.input_schema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    // Strict tool use generates REQUIRED properties first. With `reason`
    // required, live Sonnet 5 wrote the whole request into it and closed
    // the object: 17 of 17 calls set no field (local FR run, 2026-09-30).
    // So no free-text field may be required, and the note comes last.
    for (const name of schema.required) {
      expect(schema.properties[name]!["enum"], `required free text: ${name}`).toBeDefined();
    }
    expect(Object.keys(schema.properties).at(-1)).toBe("reason");
    // Flat: every field is a scalar or an array of scalars — no nested
    // object for the model to fill with the whole state.
    for (const [name, prop] of Object.entries(schema.properties)) {
      expect(["string", "number", "integer", "boolean", "array"], name).toContain(prop["type"]);
      if (prop["type"] === "array") {
        expect((prop["items"] as { type: string }).type, name).toBe("string");
      }
    }
    expect((schema.properties["clear"]!["items"] as { enum: string[] }).enum).toEqual([
      ...CLEARABLE_FIELDS,
    ]);
    // Strict tool use rejects (400s) these keywords, and every turn would
    // fail with it: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
    const unsupported = [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "maxItems",
      "pattern",
      "oneOf",
      "anyOf",
      "not",
    ];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      for (const key of unsupported) expect(key in record, `${path}.${key}`).toBe(false);
      if ("minItems" in record) expect([0, 1], `${path}.minItems`).toContain(record["minItems"]);
      // A type array is a union: the API budgets 16 across strict tools.
      if ("type" in record) expect(typeof record["type"], `${path}.type`).toBe("string");
      if (record["type"] === "object") expect(record["additionalProperties"], path).toBe(false);
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    walk(schema, "update_request");
    // The searches are strict too (FR-43): held to the same subset.
    for (const name of ["quote_street", "search_garages"]) {
      walk(TOOL_DEFINITIONS.find((t) => t.name === name)!.input_schema, name);
    }
    // The API's budgets across all strict tools: 20 tools, 24 optional
    // parameters.
    const strictTools = TOOL_DEFINITIONS.filter((t) => t.strict === true);
    expect(strictTools.length).toBeLessThanOrEqual(20);
    const optional = strictTools.reduce((sum, t) => {
      const s = t.input_schema as { properties: object; required?: string[] };
      return sum + Object.keys(s.properties).length - (s.required?.length ?? 0);
    }, 0);
    expect(optional).toBeLessThanOrEqual(24);
    // Strict: the request's editor and the two searches that read it.
    expect(strictTools.map((t) => t.name)).toEqual([
      "update_request",
      "search_garages",
      "quote_street",
    ]);
  });

  test("an unreadable time bounces with the time format and the current time", async () => {
    const t = makeTestApp({});
    const out = await t.deps.assistantTools!.execute(ctx(), "update_request", {
      startsAt: "tonight",
      reason: "tonight",
    });
    const result = out.result as { error: string; value: string; instruction: string };
    expect(result.error).toBe("unreadable_time");
    expect(result.value).toBe("tonight");
    expect(result.instruction).toContain("2026-09-26T18:00:00-04:00");
    expect(result.instruction).toContain("[current time: Mon 2026-01-05 14:00 ET]");
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "assistant_tool",
      rule: "unreadable_time",
      inputs: { tool: "update_request", patch: { startsAt: "tonight", reason: "tonight" } },
    });
  });

  test("the whole state instead of a patch is refused, audited, and changes nothing", async () => {
    const t = makeTestApp({});
    const c = ctx();
    const out = await t.deps.assistantTools!.execute(c, "update_request", {
      version: 0,
      intent: "park_now",
      place: { query: "Fenway" },
      window: { source: "default" },
      reason: "everything",
    });
    const result = out.result as { error: string; issues: string[]; instruction: string };
    expect(result.error).toBe("invalid_patch");
    expect(result.issues.join(" ")).toMatch(/only the fields that changed/);
    expect(result.instruction).toContain("maxPriceUsd");
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "invalid_patch" });
    expect(c.requestState ?? emptyState()).toEqual(emptyState());
  });

  test("a clear naming a field that doesn't exist is refused with the real names", async () => {
    const t = makeTestApp({});
    const out = await t.deps.assistantTools!.execute(ctx(), "update_request", {
      clear: ["budget"],
      reason: "forget the budget",
    });
    const result = out.result as { error: string; issues: string[] };
    expect(result.error).toBe("invalid_patch");
    expect(result.issues.join(" ")).toContain("hard.maxPriceUsd");
  });

  test("a patch that changes nothing says so, keeps the version, and is audited as unchanged", async () => {
    const t = makeTestApp({});
    const c = ctx();
    const tools = t.deps.assistantTools!;
    await tools.execute(c, "update_request", { maxPriceUsd: 20, reason: "a" });
    const again = await tools.execute(c, "update_request", {
      maxPriceUsd: 20,
      reason: "again",
    });
    const result = again.result as { version: number; changed: string[]; instruction: string };
    expect(result.version).toBe(1);
    expect(result.changed).toEqual([]);
    expect(result.instruction).toMatch(/Nothing changed/);
    expect(t.state.decisions.at(-1)).toMatchObject({
      rule: "request_unchanged",
      outcome: { version: 1, changed: [], overrides: [] },
    });
  });

  test("a patch that sets no field (only a note) says so — not just 'nothing changed'", async () => {
    // The live failure: the request written into reason, no fields set,
    // and the model re-sent it until too_many_edits.
    const t = makeTestApp({});
    const out = await t.deps.assistantTools!.execute(ctx(), "update_request", {
      reason: "Newbury St, Tue Oct 6 2pm, 2h",
    });
    const result = out.result as { version: number; changed: string[]; instruction: string };
    expect(result.version).toBe(0);
    expect(result.changed).toEqual([]);
    expect(result.instruction).toMatch(/set no field/);
    expect(result.instruction).toContain("placeQuery");
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "empty_patch" });
  });

  test("a refused call still counts toward the turn's two: a malformed call is a call", async () => {
    const t = makeTestApp({});
    const c = ctx();
    const tools = t.deps.assistantTools!;
    const bad = await tools.execute(c, "update_request", { durationMinutes: 0, reason: "a" });
    expect((bad.result as { error: string }).error).toBe("invalid_patch");
    const good = await tools.execute(c, "update_request", { maxPriceUsd: 20, reason: "b" });
    expect((good.result as { version: number }).version).toBe(1);
    const third = await tools.execute(c, "update_request", { maxPriceUsd: 10, reason: "c" });
    expect((third.result as { error: string }).error).toBe("too_many_edits");
    expect(c.requestState?.hard.maxPriceUsd).toBe(20);
    expect(c.requestEdits).toBe(3);
  });

  test("the model's contradicting intent is overridden in the result and on the record", async () => {
    const t = makeTestApp({});
    const out = await t.deps.assistantTools!.execute(ctx(), "update_request", {
      intent: "park_now",
      startsAt: "2026-01-05T17:00:00-05:00",
      reason: "at 5",
    });
    const result = out.result as {
      state: RequestState;
      overrides: { requested: string; applied: string }[];
    };
    expect(result.state.intent).toBe("park_later");
    expect(result.overrides).toMatchObject([{ requested: "park_now", applied: "park_later" }]);
    // The model is handed the state without its audit log.
    expect("log" in result.state).toBe(false);
    expect(t.state.decisions.at(-1)!.outcome).toMatchObject({
      version: 1,
      overrides: [{ field: "intent", requested: "park_now", applied: "park_later" }],
    });
  });
});
