/**
 * Claude Sonnet 5.5 / Haiku 5.5 (D-1c): thinking is on by default, so the
 * model's thinking blocks ride through ModelContentBlock and go back to it
 * unchanged on the next call; a turn its safeguards decline
 * (stop_reason "refusal") is read before its content and ends with the
 * server's own sentence, on the record.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";

import { toModelResponse } from "../src/services/assistant/anthropicClient.js";
import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { applyPatch, emptyState, parsePatch } from "../src/services/assistant/requestState.js";
import { API_KEY, MONDAY_2PM, STEINWAY_A, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const HERE = { lat: 40.7784, lng: -73.9819 };
const THINKING = { type: "thinking" as const, thinking: "", signature: "sig-abc" };

function scriptedModel(responses: ModelResponse[]): ModelClient & {
  seen: ModelTurn[][];
  requests: { system: string; tools: string }[];
} {
  let call = 0;
  const seen: ModelTurn[][] = [];
  const requests: { system: string; tools: string }[] = [];
  return {
    seen,
    requests,
    async create(args) {
      seen.push(structuredClone(args.messages));
      requests.push({ system: args.system, tools: JSON.stringify(args.tools ?? null) });
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return response;
    },
  };
}

describe("the SDK's message as the loop's response", () => {
  const base = {
    id: "msg_1",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-5-5",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  test("thinking blocks are carried through, signature and all", () => {
    const out = toModelResponse({
      ...base,
      stop_reason: "tool_use",
      stop_details: null,
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "quote_street", input: {} },
      ],
    } as unknown as Anthropic.Message);
    expect(out.content).toEqual([
      THINKING,
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "t1", name: "quote_street", input: {} },
    ]);
    expect(out).toMatchObject({ stopReason: "tool_use", model: "claude-sonnet-5-5" });
    expect(out.stopDetails).toBeUndefined();
  });

  test("a refusal carries its category", () => {
    const out = toModelResponse({
      ...base,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      content: [],
    } as unknown as Anthropic.Message);
    expect(out).toMatchObject({
      stopReason: "refusal",
      stopDetails: { category: "cyber", explanation: "declined" },
    });
  });
});

describe("the loop on a thinking model", () => {
  test("a thinking block goes back to the model unchanged on the next call", async () => {
    const model = scriptedModel([
      {
        content: [THINKING, { type: "tool_use", id: "t1", name: "quote_street", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "Nothing more." }],
        stopReason: "end_turn",
      },
    ]);
    const t = makeTestApp({ candidates: [STEINWAY_A], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "a spot near here for an hour", location: HERE },
    });
    expect(res.statusCode).toBe(200);
    // The second call's history holds the first answer as it came, the
    // thinking block first: the API checks its signature against the rest.
    const assistant = model.seen[1]!.find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual(THINKING);
  });

  test("a refused turn ends with the server's sentence, on the record", async () => {
    const model = scriptedModel([
      {
        content: [],
        stopReason: "refusal",
        stopDetails: { category: "cyber" },
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 40, outputTokens: 0 },
      },
    ]);
    const t = makeTestApp({ candidates: [STEINWAY_A], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "something the safeguards decline", location: HERE },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("I can't help with that one");
    expect(model.seen).toHaveLength(1);
    const turn = t.state.decisions.find((d) => d.kind === "assistant_turn")!;
    expect(turn.outcome).toMatchObject({ refused: "cyber", proposedPlan: false, modelCalls: 1 });
  });
});

describe("append-only for preserved thinking", () => {
  test("a turn that edits the request replays the same system, tools and history", async () => {
    const model = scriptedModel([
      {
        content: [
          THINKING,
          { type: "tool_use", id: "t1", name: "update_request", input: { maxPriceUsd: 20 } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "Noted." }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ candidates: [STEINWAY_A], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "under $20 please", location: HERE },
    });
    expect(res.statusCode).toBe(200);
    expect(model.requests).toHaveLength(2);
    // Byte-identical: the thinking block from call 1 is signed over them.
    expect(model.requests[1]!.system).toBe(model.requests[0]!.system);
    expect(model.requests[1]!.tools).toBe(model.requests[0]!.tools);
    // Call 2's history begins with call 1's, unedited…
    const [first, second] = model.seen;
    expect(second!.slice(0, first!.length)).toEqual(first);
    // …and the edited request comes after the tool result, appended.
    const blocks = second!.at(-1)!.content as { type: string; text?: string }[];
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks.at(-1)).toMatchObject({ type: "text" });
    expect(blocks.at(-1)!.text).toContain('"maxPriceUsd":20');
    // The request is never in the system prompt.
    expect(model.requests[0]!.system).not.toContain("Current request (");
  });
});

describe("bounds the strict schemas can't say", () => {
  const ctx = { userId: "u1", conversationId: "c1" };
  /** A request that starts later: build_itinerary is on for it. */
  const later = () => {
    const patch = parsePatch({ startsAt: "2026-01-05T15:00:00-05:00" });
    if (!patch.ok) throw new Error("patch");
    const applied = applyPatch(emptyState(), patch.patch, "", new Date(MONDAY_2PM));
    if (!applied.ok) throw new Error("state");
    return { ...ctx, requestState: applied.state };
  };
  const stop = (minutes: number) => ({
    label: "A",
    lat: 40.7702,
    lng: -73.9077,
    arrival: "2026-01-05T15:00:00-05:00",
    duration_minutes: minutes,
  });

  test("explain keeps the template when the phrasing stops short", async () => {
    for (const stopReason of ["max_tokens", "refusal"]) {
      const explainModel = scriptedModel([
        { content: [{ type: "text", text: "A half-finished sen" }], stopReason },
      ]);
      const t = makeTestApp({ explainModel });
      t.state.decisions.push({
        kind: "parked_quote",
        inputs: {},
        rule: "auto_pay_ok",
        outcome: { action: "pay" },
        userId: "u1",
      });
      const out = await t.deps.assistantTools!.execute(ctx, "explain_decision", {
        decision_id: "d1",
      });
      const text = (out.result as { explanation: string }).explanation;
      expect(text, stopReason).not.toContain("half-finished");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("build_itinerary takes 1 to 12 stops", async () => {
    const t = makeTestApp({});
    for (const count of [0, 13]) {
      const out = await t.deps.assistantTools!.execute(later(), "build_itinerary", {
        stops: Array.from({ length: count }, () => stop(60)),
      });
      expect(out.result, String(count)).toMatchObject({ error: "stops_out_of_range" });
    }
  });

  test("a stop's stay is held to 1–720 minutes", async () => {
    const t = makeTestApp({});
    const out = await t.deps.assistantTools!.execute(later(), "build_itinerary", {
      stops: [stop(5000)],
    });
    const stops = (out.result as { stops: { durationMinutes: number }[] }).stops;
    expect(stops[0]!.durationMinutes).toBe(720);
  });

  test("get_history looks back 1 to 90 days whatever it's asked", async () => {
    const t = makeTestApp({});
    const day = 24 * 60 * 60_000;
    const now = t.deps.now!().getTime();
    seedSession(t.state, { userId: "u1", createdAt: new Date(now - 10 * day) });
    seedSession(t.state, { userId: "u1", createdAt: new Date(now - 100 * day) });
    const ask = async (days: number) =>
      (
        (await t.deps.assistantTools!.execute(ctx, "get_history", { days })).result as {
          sessions: unknown[];
        }
      ).sessions.length;
    expect(await ask(500)).toBe(1);
    expect(await ask(0)).toBe(0);
  });
});
