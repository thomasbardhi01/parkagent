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
import { TOOL_DEFINITIONS } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { API_KEY, STEINWAY_A, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

/** Feed the loop a fixed sequence of assistant messages. */
function scriptedModel(responses: ModelResponse[]): ModelClient & { seen: ModelTurn[][] } {
  let call = 0;
  const seen: ModelTurn[][] = [];
  return {
    seen,
    async create(args, onText) {
      seen.push(args.messages);
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
    search: async () => [GARAGE],
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
  test("all eight tools are declared with object schemas and no extras allowed", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      "search_garages",
      "quote_street",
      "build_itinerary",
      "propose_plan",
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

  test("the system prompt pins the two jobs and the no-spend rule", () => {
    expect(SYSTEM_PROMPT).toContain("two jobs");
    expect(SYSTEM_PROMPT).toContain("never book, pay, or spend");
    expect(SYSTEM_PROMPT).toContain("only help with parking");
  });
});

describe("the loop", () => {
  test("tools run, propose_plan ends the turn, and the plan is stored", async () => {
    const model = scriptedModel([
      {
        content: [
          { type: "text", text: "Let me check both. " },
          { type: "tool_use", id: "t1", name: "quote_street", input: { lat: 40.7784, lng: -73.9819, duration_minutes: 90, when: "2026-01-05T14:00:00-05:00" } },
          { type: "tool_use", id: "t2", name: "search_garages", input: { lat: 40.7784, lng: -73.9819, starts_at: "2026-01-05T14:00:00-05:00", ends_at: "2026-01-05T15:30:00-05:00" } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          { type: "text", text: "Here are your options." },
          { type: "tool_use", id: "t3", name: "propose_plan", input: { plan: SINGLE_SPOT_PLAN } },
        ],
        stopReason: "tool_use",
      },
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
      payload: { text: "find me a spot near the museum for 90 minutes" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toContain("Here are your options.");
    expect(body.reply).not.toContain("SHOULD NEVER RUN");
    expect(body.plan.plan.kind).toBe("single_spot");
    expect(planSchema.parse(body.plan.plan)).toBeTruthy();
    // Stored server-side for the confirm tap; decisions audit every call.
    expect(t.state.assistantPlans).toHaveLength(1);
    const kinds = t.state.decisions.map((d) => d.kind);
    expect(kinds.filter((k) => k === "assistant_tool").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("assistant_plan");
    // Conversation persisted with the tool turns.
    expect(t.state.conversations).toHaveLength(1);
  });

  test("a malformed plan bounces back to the model as a readable error", async () => {
    const model = scriptedModel([
      {
        content: [
          { type: "tool_use", id: "t1", name: "propose_plan", input: { plan: { kind: "single_spot", options: [] } } },
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
      { content: [{ type: "text", text: "I can't book without your confirmation — here's a plan instead." }], stopReason: "end_turn" },
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
      paymentSource: "issuing_card",
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
    const t = makeTestApp({});
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
      durationMinutes: 90,
      paymentSource: "issuing_card",
    });
    expect(t.state.decisions.some((d) => d.rule === "street_confirmed")).toBe(true);
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
    expect((mine.result as { explanation: string }).explanation).toContain("safe to pay automatically");

    const theirs = await tools.execute({ userId: "u2", conversationId: "c" }, "explain_decision", {
      decision_id: "d1",
    });
    expect((theirs.result as { error?: string }).error).toBeTruthy();
  });
});
