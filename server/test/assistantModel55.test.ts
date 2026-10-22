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
import { API_KEY, STEINWAY_A, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const HERE = { lat: 40.7784, lng: -73.9819 };
const THINKING = { type: "thinking" as const, thinking: "", signature: "sig-abc" };

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
