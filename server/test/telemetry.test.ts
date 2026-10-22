/**
 * Tracing on (G): the SDK started with an in-memory exporter. One request
 * is one server span; an assistant turn under it is invoke_agent → chat
 * and execute_tool, with token counts and cost and never a word anyone
 * wrote; the money gate has its span; and a decision's trace_id is the
 * request span's trace, which continues the caller's traceparent.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import type { ModelClient, ModelResponse } from "../src/services/assistant/loop.js";
import type { Telemetry } from "../src/services/telemetry.js";
import { GEN_AI, startTelemetry } from "../src/services/telemetry.js";
import { API_KEY, STEINWAY_A, makeTestApp, parkedBody } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const HERE = { lat: 40.7784, lng: -73.9819 };
const USER_WORDS = "spot near the museum for 90 minutes";
const MODEL_WORDS = "Here you go, a meter on 30th Ave.";

const exporter = new InMemorySpanExporter();
let telemetry: Telemetry | null = null;
beforeAll(async () => {
  telemetry = await startTelemetry({}, exporter);
});
afterAll(() => telemetry?.shutdown());
beforeEach(() => exporter.reset());

/** The spans that have ended, once the request's own span is among them. */
async function spans(): Promise<ReadableSpan[]> {
  for (let i = 0; i < 50; i += 1) {
    const done = exporter.getFinishedSpans() as ReadableSpan[];
    if (done.some((s) => s.kind === 1)) return done;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no server span ended");
}
const named = (all: ReadableSpan[], prefix: string) => all.filter((s) => s.name.startsWith(prefix));
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

function scriptedModel(responses: ModelResponse[]): ModelClient {
  let call = 0;
  return {
    model: "claude-sonnet-5",
    async create() {
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return response;
    },
  };
}

const QUOTE_THEN_PROPOSE: ModelResponse[] = [
  {
    content: [{ type: "tool_use", id: "t1", name: "quote_street", input: {} }],
    stopReason: "tool_use",
    model: "claude-sonnet-5",
    usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 700, cacheCreationTokens: 50 },
  },
  {
    content: [
      { type: "text", text: MODEL_WORDS },
      {
        type: "tool_use",
        id: "t2",
        name: "propose_plan",
        input: {
          plan: {
            kind: "single_spot",
            options: [{ id: "v0-nyc-417371", label: "Street: Zone 417371", detail: "Meter" }],
          },
        },
      },
    ],
    stopReason: "tool_use",
    model: "claude-sonnet-5",
    usage: { inputTokens: 1100, outputTokens: 200 },
  },
];

test("one request is one server span, and the money gate it passes has its own under it", async () => {
  const t = makeTestApp({ candidates: [STEINWAY_A] });
  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: HEADERS,
    payload: parkedBody(),
  });
  expect(res.statusCode).toBe(200);
  const all = await spans();
  const requests = all.filter((s) => s.kind === 1);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.name).toBe("POST /parked");
  expect(request.attributes).toMatchObject({
    "http.request.method": "POST",
    "http.route": "/parked",
    "http.response.status_code": 200,
  });
  const gate = named(all, "money_gate");
  expect(gate.length).toBeGreaterThanOrEqual(1);
  expect(parentOf(gate[0]!)).toBe(request.spanContext().spanId);
  expect(gate[0]!.attributes).toMatchObject({
    "parkagent.gate.intent": "quote",
    "parkagent.gate.actor": "admin",
    "parkagent.gate.ok": true,
    "parkagent.gate.rule": "allowed",
  });
  expect(typeof gate[0]!.attributes["parkagent.gate.amount_usd"]).toBe("number");
});

test("an assistant turn is invoke_agent → chat and execute_tool, with tokens and cost, and no words", async () => {
  const t = makeTestApp({
    candidates: [STEINWAY_A],
    assistantModel: scriptedModel(QUOTE_THEN_PROPOSE),
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: HEADERS,
    payload: { text: USER_WORDS, location: HERE },
  });
  expect(res.statusCode).toBe(200);
  const all = await spans();
  const request = all.find((s) => s.kind === 1)!;
  const [agent, ...moreAgents] = named(all, "invoke_agent");
  expect(moreAgents).toEqual([]);
  expect(parentOf(agent!)).toBe(request.spanContext().spanId);
  expect(agent!.attributes).toMatchObject({
    [GEN_AI.operation]: "invoke_agent",
    [GEN_AI.agentName]: "parkagent",
    [GEN_AI.inputTokens]: 2000,
    [GEN_AI.outputTokens]: 300,
    [GEN_AI.responseModel]: "claude-sonnet-5",
    "parkagent.model_calls": 2,
  });
  expect(agent!.attributes[GEN_AI.conversationId]).toEqual(expect.any(String));
  // What the turn cost, from the price table: 2000 in, 300 out at $2/$10.
  expect(agent!.attributes["parkagent.cost_usd"]).toBeCloseTo(0.007);

  const chats = named(all, "chat ");
  expect(chats.map((s) => s.name)).toEqual(["chat claude-sonnet-5", "chat claude-sonnet-5"]);
  expect(chats.every((s) => parentOf(s) === agent!.spanContext().spanId)).toBe(true);
  expect(chats[0]!.attributes).toMatchObject({
    [GEN_AI.operation]: "chat",
    [GEN_AI.provider]: "anthropic",
    [GEN_AI.requestModel]: "claude-sonnet-5",
    [GEN_AI.inputTokens]: 900,
    [GEN_AI.outputTokens]: 100,
    [GEN_AI.cacheReadTokens]: 700,
    [GEN_AI.cacheCreationTokens]: 50,
  });
  expect(chats[1]!.attributes[GEN_AI.cacheReadTokens]).toBeUndefined();

  const tools = named(all, "execute_tool ");
  expect(tools.map((s) => s.attributes[GEN_AI.toolName])).toEqual(["quote_street", "propose_plan"]);
  expect(tools.every((s) => parentOf(s) === agent!.spanContext().spanId)).toBe(true);

  // No span says what anyone wrote: not the person, not the model.
  const said = JSON.stringify(
    all.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
  );
  expect(said).not.toContain("museum");
  expect(said).not.toContain("30th Ave");
  expect(said).not.toMatch(/gen_ai\.(prompt|completion|input\.messages|output\.messages)/);
});

test("a decision's trace_id is the request span's trace, which continues the caller's traceparent", async () => {
  const t = makeTestApp({ candidates: [STEINWAY_A] });
  // No traceparent: the request span starts a trace, and decisions carry it.
  await t.app.inject({ method: "POST", url: "/parked", headers: HEADERS, payload: parkedBody() });
  const own = (await spans()).find((s) => s.kind === 1)!;
  const stamped = t.state.decisions.map((d) => (d as { traceId?: string | null }).traceId);
  expect(stamped.length).toBeGreaterThan(0);
  expect(new Set(stamped)).toEqual(new Set([own.spanContext().traceId]));

  // With one: the span is the caller's child, and decisions carry its trace.
  exporter.reset();
  const caller = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
  const before = t.state.decisions.length;
  await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: { ...HEADERS, traceparent: `00-${caller.traceId}-${caller.spanId}-01` },
    payload: parkedBody(),
  });
  const child = (await spans()).find((s) => s.kind === 1)!;
  expect(child.spanContext().traceId).toBe(caller.traceId);
  expect(parentOf(child)).toBe(caller.spanId);
  const later = t.state.decisions
    .slice(before)
    .map((d) => (d as { traceId?: string | null }).traceId);
  expect(later.length).toBeGreaterThan(0);
  expect(new Set(later)).toEqual(new Set([caller.traceId]));
});

test("a caller's unsampled traceparent (-00) still gets the request's spans, on its trace", async () => {
  const t = makeTestApp({ candidates: [STEINWAY_A] });
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: { ...HEADERS, traceparent: `00-${traceId}-b7ad6b7169203331-00` },
    payload: parkedBody(),
  });
  const all = await spans();
  const request = all.find((s) => s.kind === 1)!;
  expect(request.spanContext().traceId).toBe(traceId);
  expect(named(all, "money_gate").length).toBeGreaterThanOrEqual(1);
  const stamped = t.state.decisions.map((d) => (d as { traceId?: string | null }).traceId);
  expect(new Set(stamped)).toEqual(new Set([traceId]));
});

test("a tool name the model made up is not put on a span", async () => {
  const t = makeTestApp({
    candidates: [STEINWAY_A],
    assistantModel: scriptedModel([
      {
        content: [{ type: "tool_use", id: "t1", name: "book me the museum garage", input: {} }],
        stopReason: "tool_use",
        model: "claude-sonnet-5",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "text", text: "Sorry." }],
        stopReason: "end_turn",
        model: "claude-sonnet-5",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]),
  });
  await t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: HEADERS,
    payload: { text: "hello", location: HERE },
  });
  const tools = named(await spans(), "execute_tool ");
  expect(tools.map((s) => s.name)).toEqual(["execute_tool unknown"]);
  expect(tools[0]!.attributes[GEN_AI.toolName]).toBe("unknown");
});
