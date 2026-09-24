/**
 * Model routing, per-turn accounting, and the daily spend cap:
 * ASSISTANT_MODEL (→ ANTHROPIC_MODEL → sonnet) runs the loop while
 * EXPLAIN_MODEL phrases explanations; every turn logs model, tokens, and
 * latency on an assistant_turn decision row; and a user over the daily
 * estimated-spend cap gets 429, not a quiet model call. Plus the SSE
 * `plan` event (the card renders before the reply settles) and
 * multi-turn plan edits over persisted conversation state.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import {
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_EXPLAIN_MODEL,
  estimateCostUsd,
  resolveAssistantModels,
} from "../src/services/assistant/loop.js";
import { API_KEY, STEINWAY_A, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

function scriptedModel(
  responses: ModelResponse[],
): ModelClient & { seen: ModelTurn[][]; calls: () => number } {
  let call = 0;
  const seen: ModelTurn[][] = [];
  return {
    seen,
    calls: () => call,
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

const PLAN = {
  kind: "single_spot",
  options: [
    {
      id: "opt-street",
      type: "street",
      label: "Street: Zone 417371",
      detail: "Meter",
      priceUsd: 3.65,
      durationMinutes: 90,
      zoneId: "nyc-417371",
      recommended: true,
    },
  ],
};

function quoteThenPropose(overrides: Partial<ModelResponse> = {}): ModelResponse[] {
  return [
    {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "quote_street",
          input: {
            lat: 40.7784,
            lng: -73.9819,
            duration_minutes: 90,
            when: "2026-01-05T14:00:00-05:00",
          },
        },
      ],
      stopReason: "tool_use",
      model: "claude-sonnet-5",
      usage: { inputTokens: 900, outputTokens: 100 },
      ...overrides,
    },
    {
      content: [
        { type: "text", text: "Here you go." },
        { type: "tool_use", id: "t2", name: "propose_plan", input: { plan: PLAN } },
      ],
      stopReason: "tool_use",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1100, outputTokens: 200 },
      ...overrides,
    },
  ];
}

describe("model resolution and pricing", () => {
  test("ASSISTANT_MODEL wins; ANTHROPIC_MODEL is the legacy fallback; sonnet is the floor", () => {
    expect(resolveAssistantModels({ ASSISTANT_MODEL: "claude-opus-5" }).assistant).toBe(
      "claude-opus-5",
    );
    expect(resolveAssistantModels({ ANTHROPIC_MODEL: "claude-haiku-4-5-20251001" }).assistant).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveAssistantModels({}).assistant).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(DEFAULT_ASSISTANT_MODEL).toBe("claude-sonnet-5");
  });

  test("explanations always route to EXPLAIN_MODEL (haiku default)", () => {
    expect(resolveAssistantModels({}).explain).toBe(DEFAULT_EXPLAIN_MODEL);
    expect(DEFAULT_EXPLAIN_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(resolveAssistantModels({ EXPLAIN_MODEL: "claude-sonnet-5" }).explain).toBe(
      "claude-sonnet-5",
    );
  });

  test("cost estimates use per-model list prices; unknown models price at the top tier", () => {
    // Sonnet: $3/M in, $15/M out.
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBe(3);
    expect(estimateCostUsd("claude-sonnet-5", 0, 1_000_000)).toBe(15);
    // Haiku: $1/$5.
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(6);
    // Unknown model: assume the priciest tier so the cap errs safe.
    expect(estimateCostUsd("mystery-model", 1_000_000, 0)).toBe(10);
  });
});

describe("per-turn accounting on the decisions table", () => {
  test("a turn logs model, summed tokens, latency, and the cost estimate", async () => {
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: scriptedModel(quoteThenPropose()),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "spot near the museum for 90 minutes" },
    });
    expect(res.statusCode).toBe(200);
    const turn = t.state.decisions.find((d) => d.kind === "assistant_turn")!;
    expect(turn).toBeDefined();
    const outcome = turn.outcome as Record<string, unknown>;
    expect(outcome["model"]).toBe("claude-sonnet-5");
    expect(outcome["inputTokens"]).toBe(2000);
    expect(outcome["outputTokens"]).toBe(300);
    expect(outcome["modelCalls"]).toBe(2);
    expect(typeof outcome["latencyMs"]).toBe("number");
    // 2000 in + 300 out on sonnet: 2000*3/1M + 300*15/1M = 0.0105.
    expect(outcome["estimatedCostUsd"]).toBeCloseTo(0.0105, 4);
    expect(outcome["proposedPlan"]).toBe(true);
  });

  test("a turn that dies mid-flight still bills what it already spent", async () => {
    // One good call, then the provider blows up. Those tokens are spent
    // either way and must count against the cap, not escape it.
    let call = 0;
    const flaky: ModelClient = {
      async create() {
        call += 1;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "quote_street",
                input: {
                  lat: 40.7784,
                  lng: -73.9819,
                  duration_minutes: 90,
                  when: "2026-01-05T14:00:00-05:00",
                },
              },
            ],
            stopReason: "tool_use",
            model: "claude-sonnet-5",
            usage: { inputTokens: 900, outputTokens: 100 },
          };
        }
        throw new Error("upstream 529");
      },
    };
    const t = makeTestApp({ candidates: [STEINWAY_A], assistantModel: flaky });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: { ...HEADERS, accept: "text/event-stream" },
      payload: { text: "spot near the museum" },
    });
    // The client is told the turn failed…
    expect(res.body).toContain("assistant_failed");
    // …and the spend is still on the record.
    const turn = t.state.decisions.find((d) => d.kind === "assistant_turn")!;
    expect(turn).toBeDefined();
    const outcome = turn.outcome as Record<string, unknown>;
    expect(outcome["inputTokens"]).toBe(900);
    expect(outcome["outputTokens"]).toBe(100);
    expect(outcome["estimatedCostUsd"]).toBeGreaterThan(0);
    expect(outcome["proposedPlan"]).toBe(false);
  });

  test("over the daily cap the turn is refused 429 before any model call", async () => {
    const model = scriptedModel(quoteThenPropose());
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: model,
      assistantDailySpendCapUsd: 0.005,
    });
    const send = () =>
      t.app.inject({
        method: "POST",
        url: "/assistant/message",
        headers: HEADERS,
        payload: { text: "spot near the museum" },
      });
    // First turn runs (0 spent so far) and logs ~$0.0105 — over the cap.
    expect((await send()).statusCode).toBe(200);
    const callsAfterFirst = model.calls();
    const refused = await send();
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "assistant_budget_exhausted", capUsd: 0.005 });
    // No model call was bought for the refused turn.
    expect(model.calls()).toBe(callsAfterFirst);
    // The refusal itself is on the record.
    const rows = t.state.decisions.filter((d) => d.kind === "assistant_turn");
    expect(rows.some((d) => d.rule === "daily_spend_cap")).toBe(true);
  });
});

describe("explain_decision routes through EXPLAIN_MODEL", () => {
  function explainScenario(explainModel?: ModelClient) {
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: scriptedModel([
        {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "explain_decision",
              input: { decision_id: "d1" },
            },
          ],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "Explained." }], stopReason: "end_turn" },
      ]),
      ...(explainModel ? { explainModel } : {}),
    });
    // A decision row for u1 the tool can explain.
    t.state.decisions.push({
      kind: "session_start",
      rule: "start_ok",
      inputs: {},
      outcome: { action: "paid" },
      userId: "u1",
    });
    return t;
  }

  test("with an explain client the template is rephrased by the cheap model, not the loop model", async () => {
    let explainCalls = 0;
    let sawTools = false;
    const explainModel: ModelClient = {
      async create(args) {
        explainCalls += 1;
        sawTools = args.tools !== undefined;
        expect(args.messages[0]!.content).toContain("Session start");
        return {
          content: [{ type: "text", text: "You parked and it was paid automatically." }],
          stopReason: "end_turn",
          model: "claude-haiku-4-5-20251001",
        };
      },
    };
    const t = explainScenario(explainModel);
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "why did you pay that?" },
    });
    expect(res.statusCode).toBe(200);
    expect(explainCalls).toBe(1);
    expect(sawTools).toBe(false); // phrasing is a plain call, no tool loop
    const audit = t.state.decisions.find(
      (d) =>
        d.kind === "assistant_tool" && (d.inputs as { tool?: string }).tool === "explain_decision",
    )!;
    expect((audit.outcome as { phrased?: boolean }).phrased).toBe(true);
  });

  test("without an explain client (or when it throws) the template text still answers", async () => {
    const broken: ModelClient = {
      async create() {
        throw new Error("model down");
      },
    };
    for (const explainModel of [undefined, broken]) {
      const t = explainScenario(explainModel);
      const res = await t.app.inject({
        method: "POST",
        url: "/assistant/message",
        headers: HEADERS,
        payload: { text: "why did you pay that?" },
      });
      expect(res.statusCode).toBe(200);
      const audit = t.state.decisions.find(
        (d) =>
          d.kind === "assistant_tool" &&
          (d.inputs as { tool?: string }).tool === "explain_decision",
      )!;
      expect((audit.outcome as { phrased?: boolean }).phrased).toBe(false);
    }
  });
});

describe("SSE: the plan is its own event", () => {
  test("`plan` arrives as a separate event before `done`, carrying the full plan", async () => {
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: scriptedModel(quoteThenPropose()),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: { ...HEADERS, accept: "text/event-stream" },
      payload: { text: "spot near the museum for 90 minutes" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    const planAt = body.indexOf("event: plan");
    const doneAt = body.indexOf("event: done");
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThan(planAt);
    const planData = JSON.parse(
      body
        .slice(planAt)
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6),
    );
    expect(planData.plan.kind).toBe("single_spot");
    expect(planData.planId).toBeTruthy();
  });
});

describe("multi-turn plan edits", () => {
  test("a follow-up ('make it 5 instead') sees the prior turn's history and proposes a revised plan", async () => {
    const revised = {
      ...PLAN,
      options: [{ ...PLAN.options[0]!, id: "opt-street-2", durationMinutes: 300, priceUsd: 12.15 }],
    };
    const model = scriptedModel([
      ...quoteThenPropose(),
      {
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "quote_street",
            input: {
              lat: 40.7784,
              lng: -73.9819,
              duration_minutes: 300,
              when: "2026-01-05T14:00:00-05:00",
            },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          { type: "text", text: "Five hours it is." },
          { type: "tool_use", id: "t4", name: "propose_plan", input: { plan: revised } },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ candidates: [STEINWAY_A], assistantModel: model });
    const first = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "spot near the museum for 90 minutes" },
    });
    const conversationId = first.json().conversationId as string;
    const second = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "make it 5 instead", conversation_id: conversationId },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.plan.plan.options[0].durationMinutes).toBe(300);
    // The third model call (first of turn two) saw the full first turn:
    // the user ask, the quote round-trip, and the propose_plan call.
    const historySeen = model.seen[2]!;
    const flat = JSON.stringify(historySeen);
    expect(flat).toContain("90");
    expect(flat).toContain("propose_plan");
    expect(flat).toContain("make it 5 instead");
    // The system prompt pins the edit rule.
    const { SYSTEM_PROMPT } = await import("../src/services/assistant/loop.js");
    expect(SYSTEM_PROMPT).toContain("edits the CURRENT plan");
  });
});
