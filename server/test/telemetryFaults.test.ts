/**
 * Tracing that fails (G): a tracer whose spans throw on every call, or
 * that throws instead of starting one. Spans are evidence and never on
 * the money path: the money gate answers the same, an assistant turn
 * still writes the assistant_turn row its daily cap reads, and code run
 * in a span runs exactly once. (Its own file: the tracer provider is
 * global.)
 */

import type { Context, Span, SpanContext, Tracer, TracerProvider } from "@opentelemetry/api";
import { INVALID_SPAN_CONTEXT, context, trace } from "@opentelemetry/api";
import { afterEach, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import type { ModelClient, ModelResponse } from "../src/services/assistant/modelClient.js";
import { summarize } from "../src/services/audit/summary.js";
import { explainDecision } from "../src/services/capabilities/explainDecision.js";
import { interpretSigns } from "../src/services/capabilities/readSigns.js";
import { userPrincipal } from "../src/services/principal.js";
import { inSpan } from "../src/services/telemetry.js";
import { API_KEY, HOURS_MON_SAT, MONDAY_2PM, STEINWAY_A, makeTestApp } from "./helpers.js";

const fault = { spans: false, start: "none" as "none" | "before" | "after" };
afterEach(() => {
  fault.spans = false;
  fault.start = "none";
});

const boom = () => {
  if (fault.spans) throw new Error("tracing failed");
};

class FailingSpan implements Span {
  spanContext(): SpanContext {
    return INVALID_SPAN_CONTEXT;
  }
  setAttribute(): this {
    boom();
    return this;
  }
  setAttributes(): this {
    boom();
    return this;
  }
  addEvent(): this {
    boom();
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(): this {
    boom();
    return this;
  }
  updateName(): this {
    boom();
    return this;
  }
  end(): void {
    boom();
  }
  isRecording(): boolean {
    return true;
  }
  recordException(): void {
    boom();
  }
}

const tracer: Tracer = {
  startSpan: () => new FailingSpan(),
  startActiveSpan(...args: unknown[]) {
    if (fault.start === "before") throw new Error("tracer failed");
    const fn = args.at(-1) as (span: Span) => unknown;
    const span = new FailingSpan();
    const result = context.with(trace.setSpan(context.active() as Context, span), () => fn(span));
    if (fault.start === "after") throw new Error("tracer failed after starting");
    return result;
  },
} as Tracer;
const provider: TracerProvider = { getTracer: () => tracer };
trace.setGlobalTracerProvider(provider);

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

/** A dry-run start through the gate: what it answered and what it wrote. */
async function startThroughGate() {
  const now = new Date(MONDAY_2PM);
  const t = makeTestApp({ zones: [STEINWAY_ZONE], now: () => now });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 40.7702,
    lng: -73.9077,
    accuracyM: 12,
    ts: now,
    signals: ["motion_stop"],
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/session/start",
    headers: HEADERS,
    payload: { parkedEventId: "pe1", zoneId: "nyc-417371", minutes: 90 },
  });
  return {
    statusCode: res.statusCode,
    sessions: t.state.sessions.map((s) => ({ status: s.status, minutes: s.purchasedMinutes })),
    decisions: t.state.decisions.map((d) => [d.kind, d.rule]),
  };
}

test("spans that throw on every call: the gate answers and writes exactly what it would", async () => {
  const healthy = await startThroughGate();
  expect(healthy.statusCode).toBe(200);
  expect(healthy.sessions).toHaveLength(1);
  fault.spans = true;
  expect(await startThroughGate()).toEqual(healthy);
});

const RESPONSES: ModelResponse[] = [
  {
    content: [{ type: "tool_use", id: "t1", name: "quote_street", input: {} }],
    stopReason: "tool_use",
    model: "claude-sonnet-5",
    usage: { inputTokens: 900, outputTokens: 100 },
  },
  {
    content: [{ type: "text", text: "A meter nearby." }],
    stopReason: "end_turn",
    model: "claude-sonnet-5",
    usage: { inputTokens: 1100, outputTokens: 200 },
  },
];

function scriptedModel(): ModelClient {
  let call = 0;
  return {
    model: "claude-sonnet-5",
    async create() {
      return RESPONSES[Math.min(call++, RESPONSES.length - 1)]!;
    },
  };
}

/** One assistant turn: its answer and the assistant_turn row it wrote. */
async function assistantTurn() {
  const t = makeTestApp({ candidates: [STEINWAY_A], assistantModel: scriptedModel() });
  const res = await t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: HEADERS,
    payload: { text: "a spot for an hour", location: { lat: 40.7784, lng: -73.9819 } },
  });
  const turns = t.state.decisions
    .filter((d) => d.kind === "assistant_turn")
    .map((d) => ({ ...(d.outcome as Record<string, unknown>), latencyMs: "any" }));
  return { statusCode: res.statusCode, turns };
}

test("spans that throw on every call: an assistant turn still writes the row its cap reads", async () => {
  const healthy = await assistantTurn();
  expect(healthy.statusCode).toBe(200);
  expect(healthy.turns).toHaveLength(1);
  expect(healthy.turns[0]).toMatchObject({ model: "claude-sonnet-5", inputTokens: 900 + 1100 * 2 });
  fault.spans = true;
  expect(await assistantTurn()).toEqual(healthy);
});

/** A model that answers `text`, counting how often it was asked. */
function answering(text: string) {
  const asked = { count: 0 };
  const client: ModelClient = {
    model: "claude-haiku-5-5",
    async create() {
      asked.count += 1;
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        model: "claude-haiku-5-5",
        usage: { inputTokens: 120, outputTokens: 30 },
      };
    },
  };
  return { client, asked };
}

const NOW = new Date(MONDAY_2PM);
const rowsOf = (t: ReturnType<typeof makeTestApp>) =>
  t.state.decisions.map((d) => [d.kind, d.rule, d.outcome]);

/** The other places that ask a model, each in its chat span: what each
 * came out as, what it wrote, and how often it asked. */
const MODEL_SITES: Record<string, () => Promise<{ out: unknown; rows: unknown; asked: number }>> = {
  async explain_decision() {
    const { client, asked } = answering(JSON.stringify({ answer: "It was over your cap." }));
    const t = makeTestApp({ now: () => NOW });
    t.state.decisions.push({
      kind: "session_start",
      rule: "session_cap_exceeded",
      inputs: { quote: { totalUsd: 5.4, stayMinutes: 90 }, sessionCapUsd: 5 },
      outcome: { allowed: false },
      userId: "u1",
      createdAt: NOW,
    });
    const out = await explainDecision(
      { db: t.deps.db, now: () => NOW, explainModel: client },
      userPrincipal({ id: "u1", isAdmin: false }),
      { decisionId: "d1" },
    );
    return { out, rows: rowsOf(t), asked: asked.count };
  },
  async audit_summary() {
    const lines = ["No invariant fired (0 checked).", "Quiet.", "Quiet.", "Quiet.", "Quiet."];
    const { client, asked } = answering(JSON.stringify({ lines }));
    const t = makeTestApp({ now: () => NOW });
    const out = await summarize(
      { db: t.deps.db, model: client, capUsd: 1, now: NOW },
      { window: { from: "2026-01-04T14:00:00.000Z", to: "2026-01-05T14:00:00.000Z" }, findings: [] },
    );
    return { out, rows: rowsOf(t), asked: asked.count };
  },
  async sign_reader() {
    const { client, asked } = answering("{}");
    const out = await interpretSigns(client, "NO PARKING 8AM-6PM MON-FRI");
    return { out, rows: [], asked: asked.count };
  },
};

test.each(Object.keys(MODEL_SITES))(
  "spans that throw on every call: %s comes out, writes and asks exactly as it would",
  async (name) => {
    const healthy = await MODEL_SITES[name]!();
    expect(healthy.asked).toBe(1);
    fault.spans = true;
    expect(await MODEL_SITES[name]!()).toEqual(healthy);
  },
);

test.each(
  Object.keys(MODEL_SITES).flatMap((name) => [
    [name, "before" as const],
    [name, "after" as const],
  ]),
)("%s: a tracer that throws %s starting the span: the model is asked once", async (name, when) => {
  const healthy = await MODEL_SITES[name]!();
  fault.start = when;
  expect(await MODEL_SITES[name]!()).toEqual(healthy);
});

test("a tracer that throws instead of starting a span: the work runs once, unspanned", async () => {
  fault.start = "before";
  let runs = 0;
  const answer = await inSpan("money_gate", {}, async (span) => {
    runs += 1;
    span.setAttributes({ "parkagent.gate.ok": true });
    return "allowed";
  });
  expect(answer).toBe("allowed");
  expect(runs).toBe(1);
});

test("a tracer that throws after starting the work: it is never started twice", async () => {
  fault.start = "after";
  let runs = 0;
  const answer = await inSpan("money_gate", {}, async () => {
    runs += 1;
    return "allowed";
  });
  expect(answer).toBe("allowed");
  expect(runs).toBe(1);
});
