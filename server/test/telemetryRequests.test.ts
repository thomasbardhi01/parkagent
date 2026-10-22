/**
 * Tracing never changes what is asked of the model (G). Each of the four
 * places that call one — the assistant loop, explain_decision's phrasing,
 * the nightly audit's summary, and the sign reader — hands the SDK the
 * same request with tracing off and on (effort, output schema and image
 * included), comes out the same, and, on, is one `chat {model}` span with
 * the usage it reported. (Its own file: the SDK, once started, is global.)
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({ requests: [] as unknown[], reply: "" }));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class Anthropic {
    static APIError = APIError;
    messages = {
      stream(params: unknown) {
        sdk.requests.push(params);
        return {
          on() {},
          finalMessage: async () => ({
            content: [{ type: "text", text: sdk.reply }],
            stop_reason: "end_turn",
            model: (params as { model: string }).model,
            usage: { input_tokens: 120, output_tokens: 30 },
          }),
        };
      },
    };
  }
  return { default: Anthropic };
});

import { makeAnthropicModelClient } from "../src/services/assistant/anthropicClient.js";
import {
  DEFAULT_EXPLAIN_MODEL,
  SIGN_READER_MODEL,
} from "../src/services/assistant/modelClient.js";
import { AUDIT_MODEL, summarize } from "../src/services/audit/summary.js";
import { explainDecision } from "../src/services/capabilities/explainDecision.js";
import { interpretSigns } from "../src/services/capabilities/readSigns.js";
import { userPrincipal } from "../src/services/principal.js";
import type { Telemetry } from "../src/services/telemetry.js";
import { GEN_AI, startTelemetry } from "../src/services/telemetry.js";
import { API_KEY, MONDAY_2PM, STEINWAY_A, makeTestApp } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const ASSISTANT_MODEL = "claude-sonnet-5-5";

/** One call site: what it sets the model to answer, which model it asks,
 * and what it came out as. */
const SITES: Record<string, { model: string; run: () => Promise<unknown> }> = {
  assistant_loop: {
    model: ASSISTANT_MODEL,
    async run() {
      sdk.reply = "A meter nearby.";
      const t = makeTestApp({
        candidates: [STEINWAY_A],
        now: () => NOW,
        assistantModel: makeAnthropicModelClient("k", ASSISTANT_MODEL),
      });
      const res = await t.app.inject({
        method: "POST",
        url: "/assistant/message",
        headers: { "x-api-key": API_KEY, "content-type": "application/json" },
        payload: { text: "a spot for an hour", location: { lat: 40.7784, lng: -73.9819 } },
      });
      const turn = t.state.decisions.find((d) => d.kind === "assistant_turn");
      const { latencyMs: _latency, ...outcome } = turn!.outcome as Record<string, unknown>;
      return { statusCode: res.statusCode, outcome };
    },
  },
  explain_decision: {
    model: DEFAULT_EXPLAIN_MODEL,
    async run() {
      sdk.reply = JSON.stringify({ answer: "The stop was over your per-stop cap." });
      const t = makeTestApp({ now: () => NOW });
      t.state.decisions.push({
        kind: "session_start",
        rule: "session_cap_exceeded",
        inputs: { quote: { totalUsd: 5.4, stayMinutes: 90 }, sessionCapUsd: 5 },
        outcome: { allowed: false },
        userId: "u1",
        createdAt: NOW,
      });
      return explainDecision(
        {
          db: t.deps.db,
          now: () => NOW,
          explainModel: makeAnthropicModelClient("k", DEFAULT_EXPLAIN_MODEL),
        },
        userPrincipal({ id: "u1", isAdmin: false }),
        { decisionId: "d1" },
      );
    },
  },
  audit_summary: {
    model: AUDIT_MODEL,
    async run() {
      sdk.reply = JSON.stringify({
        lines: ["No invariant fired (0 checked).", "Quiet.", "Quiet.", "Quiet.", "Quiet."],
      });
      const t = makeTestApp({ now: () => NOW });
      return summarize(
        {
          db: t.deps.db,
          model: makeAnthropicModelClient("k", AUDIT_MODEL),
          capUsd: 1,
          now: NOW,
        },
        { window: { from: "2026-01-04T14:00:00.000Z", to: "2026-01-05T14:00:00.000Z" }, findings: [] },
      );
    },
  },
  sign_reader: {
    model: SIGN_READER_MODEL,
    async run() {
      sdk.reply = "{}";
      return interpretSigns(
        makeAnthropicModelClient("k", SIGN_READER_MODEL),
        "NO PARKING 8AM-6PM MON-FRI",
        { mediaType: "image/jpeg", data: "c2lnbg==" },
      );
    },
  },
};

/** The site's requests to the SDK, as sent, and what it came out as. */
async function capture(name: string) {
  sdk.requests = [];
  const outcome = await SITES[name]!.run();
  return { requests: JSON.stringify(sdk.requests), count: sdk.requests.length, outcome };
}

const exporter = new InMemorySpanExporter();
const off: Record<string, Awaited<ReturnType<typeof capture>>> = {};
let telemetry: Telemetry | null = null;
beforeAll(async () => {
  for (const name of Object.keys(SITES)) off[name] = await capture(name);
  telemetry = await startTelemetry({}, exporter);
});
afterAll(() => telemetry?.shutdown());

test("off, each site asks the model once, with what the site sets", () => {
  for (const { count } of Object.values(off)) expect(count).toBe(1);
  // Each took the model's answer, so the same outcome on is the same path.
  expect(off.assistant_loop!.outcome).toMatchObject({ statusCode: 200 });
  expect(off.explain_decision!.outcome).toMatchObject({ ok: true, phrased: true });
  expect(off.audit_summary!.outcome).toMatchObject({ source: "model" });
  expect(off.sign_reader!.outcome).toMatchObject({ reading: null, fallback: "off_schema" });
  const request = (name: string) => JSON.parse(off[name]!.requests)[0] as Record<string, unknown>;
  expect(request("explain_decision")).toMatchObject({
    output_config: { effort: "low", format: { type: "json_schema" } },
  });
  expect(request("audit_summary").output_config).toEqual({
    format: { type: "json_schema", schema: expect.any(Object) },
  });
  expect(request("sign_reader")).toMatchObject({
    output_config: { effort: "low", format: { type: "json_schema" } },
    messages: [
      {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "c2lnbg==" } },
          { type: "text" },
        ],
      },
    ],
  });
});

test.each(Object.keys(SITES))(
  "%s: the same request with tracing on, the same outcome, and one chat span",
  async (name) => {
    exporter.reset();
    const on = await capture(name);
    expect(on.requests).toBe(off[name]!.requests);
    expect(on.outcome).toEqual(off[name]!.outcome);
    const chats = (exporter.getFinishedSpans() as ReadableSpan[]).filter((s) =>
      s.name.startsWith("chat "),
    );
    const model = SITES[name]!.model;
    expect(chats.map((s) => s.name)).toEqual([`chat ${model}`]);
    expect(chats[0]!.attributes).toMatchObject({
      [GEN_AI.operation]: "chat",
      [GEN_AI.requestModel]: model,
      [GEN_AI.responseModel]: model,
      [GEN_AI.inputTokens]: 120,
      [GEN_AI.outputTokens]: 30,
    });
  },
);
