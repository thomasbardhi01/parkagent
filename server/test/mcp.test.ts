/**
 * The MCP surface (WS-4 PR 3): `/mcp`, protocol revision 2026-07-28 through
 * the real SDK handler, with raw JSON-RPC the way a client sends it. The
 * tools are the agent REST calls, as the key's principal, through the same
 * mandate and money gate: a refusal is a tool error with REST's code, and a
 * street confirm answers pending_arrival with nothing paid. Only an agent
 * key gets in. 2025-era clients are served statelessly.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { CONFIRM_CARD_MIME, CONFIRM_CARD_URI } from "../src/routes/mcpConfirmCard.js";
import type { GeocoderProvider } from "../src/services/assistant/geocoder.js";
import type { ModelClient } from "../src/services/assistant/modelClient.js";
import { signAccessToken } from "../src/services/authTokens.js";
import { planHashOf } from "../src/services/mandates.js";
import { isAgentSurface } from "../src/services/principal.js";
import {
  API_KEY,
  BOYLSTON_BOS,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  TEST_JWT_SECRET,
  makeTestApp,
} from "./helpers.js";

/** A refusal the gate might add later, forced through the real confirm
 * path; null leaves the sequence as it is. */
const forced = vi.hoisted(() => ({ refusal: null as null | { why: string; rule?: string } }));
vi.mock("../src/services/capabilities/confirmPlan.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/capabilities/confirmPlan.js")>();
  const consumeConfirmation: typeof real.consumeConfirmation = (...args) =>
    forced.refusal
      ? Promise.resolve({ ok: false, refusal: forced.refusal as never, result: {} })
      : real.consumeConfirmation(...args);
  return { ...real, consumeConfirmation };
});

const NOW = new Date(MONDAY_2PM);
const U2 = { "x-api-key": NONADMIN_API_KEY };
const NEWBURY = { lat: 42.3503, lng: -71.0811, displayName: "Newbury Street, Back Bay" };
const geocoder: GeocoderProvider = {
  async geocode() {
    return { ok: true, results: [{ ...NEWBURY, city: "bos" }] };
  },
};
const REQUEST = { place: "Newbury Street", durationMinutes: 60, kinds: ["street"] };
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const MODERN = "2026-07-28";
/** tools/list, in order: written out, not read from the list it checks. */
const TOOL_NAMES = [
  "geocode_place",
  "quote_street",
  "search_garages",
  "build_itinerary",
  "propose_plan",
  "confirm_plan",
  "explain_decision",
];

/** The per-request envelope a 2026-07-28 client puts on every request. */
const envelope = (extra: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
  ...extra,
});

interface RpcResult {
  result?: Record<string, unknown> & {
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
}

async function setup(
  opts: {
    scopes?: string[];
    consent?: boolean;
    mcpApps?: boolean;
    policy?: object;
    garage?: Parameters<typeof makeTestApp>[0]["garage"];
    explainModel?: ModelClient;
  } = {},
) {
  const t = makeTestApp({
    candidates: [BOYLSTON_BOS],
    geocoder,
    now: () => NOW,
    ...(opts.explainModel ? { explainModel: opts.explainModel } : {}),
    ...(opts.mcpApps !== undefined ? { mcpApps: opts.mcpApps } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.garage ? { garage: opts.garage } : {}),
  });
  const key = (
    await t.app.inject({
      method: "POST",
      url: "/me/agent-keys",
      headers: U2,
      payload: { label: "Claude", scopes: opts.scopes ?? ["read", "confirm"] },
    })
  ).json().key as string;
  if (opts.consent !== false) {
    await t.app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: U2,
      payload: { agentsMayAct: true },
    });
  }
  let id = 0;
  /** One 2026-07-28 request, its headers agreeing with its body. */
  const post = (
    method: string,
    params: Record<string, unknown> = {},
    opts2: { meta?: object; headers?: object; name?: string } = {},
  ) =>
    t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(opts2.name ? { "mcp-name": opts2.name } : {}),
        ...opts2.headers,
      },
      payload: {
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: { ...params, _meta: envelope(opts2.meta as Record<string, unknown>) },
      },
    });
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    name?: string,
    meta?: object,
  ) => {
    const res = await post(method, params, {
      ...(name ? { name } : {}),
      ...(meta ? { meta } : {}),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as RpcResult;
  };
  const tool = async (name: string, args: Record<string, unknown>, meta?: object) => {
    const out = await rpc("tools/call", { name, arguments: args }, name, meta);
    expect(out.error, JSON.stringify(out)).toBeUndefined();
    return out.result!;
  };
  return { t, key, post, rpc, tool };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A session-cap refusal on the ledger, the user's; its id. */
const seedDecision = (t: Setup["t"], userId: string) => {
  t.state.decisions.push({
    kind: "session_start",
    rule: "session_cap_exceeded",
    inputs: { quote: { totalUsd: 5.4 }, sessionCapUsd: 5 },
    outcome: { allowed: false },
    userId,
    createdAt: NOW,
  });
  return `d${t.state.decisions.length}`;
};

const proposeOver = async (tool: Setup["tool"]) => {
  const result = await tool("propose_plan", { request: REQUEST });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.structuredContent as {
    planId: string;
    plan: { kind: string; options: { id: string; zoneId: string }[] };
    confirmToken?: string;
    expiresAt?: string;
  };
};

describe("discovery", () => {
  test("server/discover: the 2026-07-28 revision, tools and resources only", async () => {
    const { rpc } = await setup();
    const { result } = await rpc("server/discover");
    expect(result!["supportedVersions"]).toContain(MODERN);
    expect(result!["resultType"]).toBe("complete");
    const capabilities = Object.keys(result!["capabilities"] as object).sort();
    expect(
      capabilities.every((c) => c === "tools" || c === "resources"),
      capabilities.join(),
    ).toBe(true);
    for (const absent of ["roots", "sampling", "logging"])
      expect(capabilities).not.toContain(absent);
  });

  test("tools/list: the seven tools in their declared order, cacheable for five minutes, this key only", async () => {
    const { rpc } = await setup();
    const { result } = await rpc("tools/list");
    const tools = result!["tools"] as { name: string; description: string; _meta?: object }[];
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(result).toMatchObject({ ttlMs: 300_000, cacheScope: "private", resultType: "complete" });
    for (const name of ["propose_plan", "confirm_plan"]) {
      const description = tools.find((t) => t.name === name)!.description;
      expect(description).toContain("only source of arrival");
      expect(description).toContain("pending_arrival");
      expect(description).toContain("consent");
    }
    // explain_decision reads; the plan-and-confirm rules aren't its.
    const explain = tools.find((t) => t.name === "explain_decision")!.description;
    expect(explain).toContain("Read-only");
    expect(explain).not.toContain("only source of arrival");
    // Without MCP_APPS, no card.
    expect(tools.find((t) => t.name === "propose_plan")!._meta).toBeUndefined();
  });

  test("an Idempotency-Key is not kept for /mcp: the same key twice is two answers, never stuck", async () => {
    const { post } = await setup();
    const headers = { "idempotency-key": "mcp-retry-0001" };
    for (let i = 0; i < 2; i++) {
      const res = await post("tools/list", {}, { headers });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().result.tools).toHaveLength(7);
    }
  });

  test("the request headers must agree with the body", async () => {
    const { post } = await setup();
    const res = await post(
      "tools/call",
      { name: "quote_street", arguments: { request: REQUEST } },
      { name: "confirm_plan" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(-32020);
  });
});

describe("the tools, under dry run", () => {
  test("each capability answers as REST does", async () => {
    const { t, key, tool } = await setup();
    const geocoded = await tool("geocode_place", { query: "Newbury Street" });
    expect(geocoded.isError).toBeFalsy();
    expect(geocoded.structuredContent).toMatchObject({ found: true });

    const quote = await tool("quote_street", { request: REQUEST });
    expect(quote.isError).toBeFalsy();
    const rest = await t.app.inject({
      method: "POST",
      url: "/agent/quote-street",
      headers: { authorization: `Bearer ${key}` },
      payload: { request: REQUEST },
    });
    expect(quote.structuredContent).toEqual(rest.json());
    expect(JSON.parse((quote["content"] as { text: string }[])[0]!.text)).toEqual(rest.json());

    const garages = await tool("search_garages", { request: { ...REQUEST, kinds: ["garage"] } });
    expect(garages.isError).toBeFalsy();

    const day = await tool("build_itinerary", {
      stops: [{ place: "Newbury Street", arrival: MONDAY_2PM, durationMinutes: 60 }],
    });
    expect(day.isError, JSON.stringify(day.structuredContent)).toBeFalsy();

    const proposed = await proposeOver(tool);
    expect(proposed.plan.kind).toBe("single_spot");
    expect(proposed.confirmToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The capabilities' own audit rows say an agent asked, with its key.
    const rows = t.state.decisions.filter((d) => d.kind === "assistant_tool");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((d) => d.actor === "external_agent" && d.agentKeyId)).toBe(true);
  });

  test("a street confirm is consent and a cap, never a park: pending_arrival, nothing paid", async () => {
    const { t, tool } = await setup();
    const proposed = await proposeOver(tool);
    const confirmed = await tool("confirm_plan", {
      planId: proposed.planId,
      confirmToken: proposed.confirmToken,
    });
    expect(confirmed.isError).toBeFalsy();
    expect(confirmed.structuredContent).toMatchObject({
      status: "pending_arrival",
      zoneId: BOYLSTON_BOS.zoneId,
      expiresAt: proposed.expiresAt,
    });
    expect(t.state.pendingParks).toHaveLength(0);
    expect(t.state.sessions).toHaveLength(0);
    expect(t.executorCalls).toHaveLength(0);
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "agent_confirm",
      rule: "pending_arrival",
      actor: "external_agent",
    });
  });

  test("the call's traceparent is the decision's trace id", async () => {
    const { t, tool } = await setup();
    const proposed = await proposeOver(tool);
    await tool(
      "confirm_plan",
      { planId: proposed.planId, confirmToken: proposed.confirmToken },
      { traceparent: TRACEPARENT },
    );
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "agent_confirm",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
  });

  test("explain_decision: the person's own decision, as REST's why answers it; another's is not there", async () => {
    const { t, key, tool } = await setup();
    const mine = seedDecision(t, "u2");
    const theirs = seedDecision(t, "u1");
    const why = await tool("explain_decision", { decisionId: mine });
    expect(why.isError, JSON.stringify(why)).toBeFalsy();
    // The whole body, written out: REST's why is the same call, so
    // comparing the two alone could never fail.
    const body = {
      decisionId: mine,
      kind: "session_start",
      rule: "session_cap_exceeded",
      reason: {
        subject: "Session start",
        what: "the price would pass the per-stop cap",
        because: [
          { name: "price", label: "the price", value: "$5.40" },
          { name: "sessionCap", label: "the per-stop cap", value: "$5.00" },
        ],
        youCan: "You can raise your per-stop cap in Limits.",
      },
      text: `Session start: The price would pass the per-stop cap (the price was $5.40; the per-stop cap was $5.00). You can raise your per-stop cap in Limits. (2026-01-05 19:00 UTC; decision ${mine} has the full record.)`,
      phrased: false,
    };
    expect(why.structuredContent).toEqual(body);
    const rest = await t.app.inject({
      method: "GET",
      url: `/agent/decisions/${mine}/why`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(rest.json()).toEqual(body);
    const other = await tool("explain_decision", { decisionId: theirs });
    expect(other.isError).toBe(true);
    expect(other.structuredContent).toEqual({ error: "decision_not_found" });
  });

  test("a call that throws is logged and answers internal, never the error's own text", async () => {
    const { t, tool } = await setup();
    const mine = seedDecision(t, "u2");
    vi.spyOn(t.deps.db.decision, "findUnique").mockRejectedValue(
      new Error(
        "Invalid `prisma.decision.findUnique()` invocation in /app/server/dist/services/capabilities/explainDecision.js",
      ),
    );
    const logged = vi.spyOn(t.app.log, "error");
    const out = await tool("explain_decision", { decisionId: mine });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toEqual({ error: "internal" });
    expect(JSON.stringify(out)).not.toMatch(/prisma/i);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  test("a decisionId that isn't an id is refused before the database", async () => {
    const { t, tool } = await setup();
    const read = vi.spyOn(t.deps.db.decision, "findUnique");
    // The SDK's own answer to arguments its schema refuses: a tool error
    // (not a -32602), naming the field.
    const out = await tool("explain_decision", { decisionId: "\u0000" });
    expect(out.isError).toBe(true);
    expect(out["content"]).toEqual([
      {
        type: "text",
        text: "Input validation error: Invalid arguments for tool explain_decision: decisionId: Invalid string: must match pattern /^[A-Za-z0-9_-]+$/",
      },
    ]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("refusals are tool errors with REST's codes", () => {
  const confirmOnce = async (s: Setup, proposed: { planId: string; confirmToken?: string }) =>
    s.tool("confirm_plan", { planId: proposed.planId, confirmToken: proposed.confirmToken });
  const errorOf = (result: { isError?: boolean; structuredContent?: Record<string, unknown> }) => {
    expect(result.isError).toBe(true);
    return result.structuredContent!["error"];
  };

  test("no consent: agents_not_allowed, mandate unspent", async () => {
    const s = await setup({ consent: false });
    const proposed = await proposeOver(s.tool);
    expect(errorOf(await confirmOnce(s, proposed))).toBe("agents_not_allowed");
    expect(s.t.state.mandates[0]!.consumedAt).toBeNull();
  });

  test("used once: mandate_used", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    expect((await confirmOnce(s, proposed)).isError).toBeFalsy();
    expect(errorOf(await confirmOnce(s, proposed))).toBe("mandate_used");
  });

  test("after ten minutes: mandate_expired", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    s.t.state.mandates[0]!.expiresAt = new Date(NOW.getTime() - 1);
    expect(errorOf(await confirmOnce(s, proposed))).toBe("mandate_expired");
  });

  test("a plan changed since it was proposed: plan_hash_mismatch", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    const row = s.t.state.assistantPlans.find((p) => p.id === proposed.planId)!;
    (row.plan as { options: { priceUsd: number }[] }).options[0]!.priceUsd = 0.01;
    expect(errorOf(await confirmOnce(s, proposed))).toBe("plan_hash_mismatch");
  });

  test("over the per-stop cap: policy_violation, mandate unspent", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    s.t.state.userLimits.push({
      userId: "u2",
      sessionCapUsd: 0.5,
      dailyCapUsd: null,
      defaultStayMinutes: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const result = await confirmOnce(s, proposed);
    expect(errorOf(result)).toBe("policy_violation");
    expect(result.structuredContent!["rule"]).toBe("session_cap_exceeded");
    expect(s.t.state.mandates[0]!.consumedAt).toBeNull();
  });

  test("an option with no price: a policy_violation refusal (amount_invalid), mandate unspent", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    // The stored option loses its price; the mandate names the plan as it
    // now is, so plan_hash_mismatch doesn't answer first.
    const row = s.t.state.assistantPlans.find((p) => p.id === proposed.planId)!;
    for (const o of (row.plan as { options: Record<string, unknown>[] }).options)
      delete o["priceUsd"];
    s.t.state.mandates[0]!.planHash = planHashOf(row.plan);
    const result = await confirmOnce(s, proposed);
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toBe("policy_violation");
    expect(result.structuredContent!["rule"]).toBe("amount_invalid");
    expect(s.t.state.mandates[0]!.consumedAt).toBeNull();
    expect(s.t.state.sessions).toHaveLength(0);
  });

  test("a refusal rule with no case yet: a policy_violation refusal carrying the rule, not a crash", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    forced.refusal = { why: "some_new_rule" };
    try {
      const result = await confirmOnce(s, proposed);
      expect(errorOf(result)).toBe("policy_violation");
      expect(result.structuredContent!["rule"]).toBe("some_new_rule");
      expect(result.structuredContent!["decisionId"]).toEqual(expect.any(String));
    } finally {
      forced.refusal = null;
    }
    expect(s.t.state.mandates[0]!.consumedAt).toBeNull();
    expect(s.t.state.sessions).toHaveLength(0);
  });

  test("a read-only key: scope_required", async () => {
    const s = await setup({ scopes: ["read"] });
    const proposed = await proposeOver(s.tool);
    expect(proposed.confirmToken).toBeUndefined();
    const result = await s.tool("confirm_plan", {
      planId: proposed.planId,
      confirmToken: "x".repeat(32),
    });
    expect(errorOf(result)).toBe("scope_required");
  });

  test("a confirm-only key can't ask why: scope_required, before any model call", async () => {
    const create = vi.fn<ModelClient["create"]>();
    const s = await setup({ scopes: ["confirm"], explainModel: { create } });
    const mine = seedDecision(s.t, "u2");
    expect(errorOf(await s.tool("explain_decision", { decisionId: mine }))).toBe("scope_required");
    expect(create).not.toHaveBeenCalled();
  });

  test("one budget per key across REST and MCP: rate_limited", async () => {
    const s = await setup();
    for (let i = 0; i < 60; i++) {
      await s.t.app.inject({
        method: "GET",
        url: "/agent/me",
        headers: { authorization: `Bearer ${s.key}` },
      });
    }
    expect(errorOf(await s.tool("quote_street", { request: REQUEST }))).toBe("rate_limited");
  });

  test("the dry run shown rides on the mandate: dry_run_changed, mandate unspent", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    s.t.deps.policy.effectiveDryRun = () => false;
    const result = await confirmOnce(s, proposed);
    expect(errorOf(result)).toBe("dry_run_changed");
    expect(result.structuredContent).toMatchObject({ shownDryRun: true, dryRun: false });
    expect(s.t.state.mandates[0]!.consumedAt).toBeNull();
  });

  test("a garage offer expired with the search: garage_option_expired, mandate unspent, never a 500", async () => {
    const GARAGE = {
      id: "g1",
      provider: "spothero",
      name: "Deck",
      address: "1 Test St",
      priceUsd: 18,
      distanceM: 240,
      walkMinutes: 3,
      entryType: "self" as const,
      deepLink: "https://spothero.com/search?latitude=42.35",
      lat: NEWBURY.lat,
      lng: NEWBURY.lng,
    };
    let cached = true;
    const s = await setup({
      garage: {
        id: "spothero",
        canReserve: false,
        search: async () => ({ ok: true, options: [GARAGE], fromCache: false }),
        optionById: (id) => (cached && id === "g1" ? GARAGE : null),
        book: async () => {
          throw new Error(
            "unknown garage option g1 (search first — options expire with the cache)",
          );
        },
      },
    });
    const proposed = (await s.tool("propose_plan", { request: { ...REQUEST, kinds: ["garage"] } }))
      .structuredContent as { planId: string; confirmToken: string };
    cached = false; // the provider's ten-minute cache lapses
    const result = await confirmOnce(s, proposed);
    expect(errorOf(result)).toBe("garage_option_expired");
    expect(s.t.state.mandates.at(-1)!.consumedAt).toBeNull();
    expect(s.t.state.assistantPlans.find((p) => p.id === proposed.planId)!.confirmedAt).toBeNull();
  });

  test("a rate-limited resource read says so, with when to retry", async () => {
    const s = await setup();
    const proposed = await proposeOver(s.tool);
    for (let i = 0; i < 60; i++) {
      await s.t.app.inject({
        method: "GET",
        url: "/agent/me",
        headers: { authorization: `Bearer ${s.key}` },
      });
    }
    const uri = `parkagent://plans/${proposed.planId}`;
    const out = await s.rpc("resources/read", { uri }, uri);
    expect(out.error).toMatchObject({ code: -32029, data: { error: "rate_limited" } });
    expect((out.error as { data: { retryAfterS: number } }).data.retryAfterS).toBeGreaterThan(0);
  });
});

describe("the transport", () => {
  test("subscriptions/listen is refused: nothing to listen to, no stream held open", async () => {
    const { post } = await setup();
    const res = await post("subscriptions/listen", { notifications: {} });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error.code).toBe(-32601);
  });

  test("every request to /mcp counts against a ceiling of its own: 600 a minute per key", async () => {
    const { post } = await setup();
    for (let i = 0; i < 600; i++) {
      const res = await post("tools/list");
      expect(res.statusCode).toBe(200);
    }
    const over = await post("tools/list");
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: "rate_limited" });
  });
});

describe("who gets in", () => {
  test("/mcp is an agent surface", () => {
    expect(isAgentSurface("/mcp")).toBe(true);
    expect(isAgentSurface("/mcpx")).toBe(false);
  });

  test("without an agent key nothing runs: 401 or 403 at the transport", async () => {
    const { t, key } = await setup();
    const rowsBefore = t.state.decisions.length;
    const jwt = signAccessToken(
      TEST_JWT_SECRET,
      { id: "u2", name: "Two", isAdmin: false },
      NOW,
    ).token;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "quote_street", arguments: { request: REQUEST }, _meta: envelope() },
    };
    for (const [headers, status] of [
      [{}, 403],
      [{ authorization: `Bearer ${jwt}` }, 403],
      [{ "x-api-key": API_KEY }, 403],
      [U2, 403],
      [{ authorization: `Bearer ${key.slice(0, -2)}xx` }, 401],
    ] as const) {
      const res = await t.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(headers)).toBe(status);
    }
    expect(t.state.decisions.length).toBe(rowsBefore);
  });
});

describe("a 2025-era client", () => {
  test("initialize, then tools, statelessly", async () => {
    const { t, key } = await setup();
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    /** The one JSON-RPC message in an SSE body. */
    const message = (body: string) =>
      JSON.parse(
        body
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ) as RpcResult;
    const init = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "old", version: "1" },
        },
      },
    });
    expect(init.statusCode, init.body).toBe(200);
    expect(message(init.body).result).toMatchObject({ serverInfo: { name: "parkagent" } });
    const listed = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "mcp-protocol-version": "2025-06-18" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    const tools = message(listed.body).result!["tools"] as { name: string }[];
    expect(tools.map((x) => x.name)).toEqual(TOOL_NAMES);
    const called = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "mcp-protocol-version": "2025-06-18" },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "quote_street", arguments: { request: REQUEST } },
      },
    });
    expect(message(called.body).result).toMatchObject({ structuredContent: { verdict: "meets" } });
  });
});

describe("resources", () => {
  test("the person's own plan by parkagent:// URI; an unknown one is not found", async () => {
    const { rpc, tool } = await setup();
    const proposed = await proposeOver(tool);
    const uri = `parkagent://plans/${proposed.planId}`;
    const read = await rpc("resources/read", { uri }, uri);
    const contents = read.result!["contents"] as { uri: string; text: string }[];
    expect(JSON.parse(contents[0]!.text)).toMatchObject({
      planId: proposed.planId,
      status: "proposed",
      confirmedAt: null,
      boundAt: null,
    });
    for (const missing of ["parkagent://plans/nope", "parkagent://parks/nope"]) {
      const out = await rpc("resources/read", { uri: missing }, missing);
      expect(out.error, missing).toBeDefined();
    }
  });
});

describe("the MCP Apps card (MCP_APPS)", () => {
  test("off: no ui:// resource and no pointer to one", async () => {
    const { rpc, tool } = await setup();
    const out = await rpc("resources/read", { uri: CONFIRM_CARD_URI }, CONFIRM_CARD_URI);
    expect(out.error).toBeDefined();
    const proposed = await tool("propose_plan", { request: REQUEST });
    expect(proposed._meta?.["ui"]).toBeUndefined();
  });

  test("on: the card is served, and propose_plan points at it with the caps", async () => {
    const { rpc, tool } = await setup({ mcpApps: true });
    const listed = await rpc("tools/list");
    const propose = (listed.result!["tools"] as { name: string; _meta?: object }[]).find(
      (t) => t.name === "propose_plan",
    )!;
    expect(propose._meta).toEqual({ ui: { resourceUri: CONFIRM_CARD_URI } });
    const read = await rpc("resources/read", { uri: CONFIRM_CARD_URI }, CONFIRM_CARD_URI);
    const card = (read.result!["contents"] as { mimeType: string; text: string }[])[0]!;
    expect(card.mimeType).toBe(CONFIRM_CARD_MIME);
    expect(card.text).toContain("confirm_plan");
    expect(card.text).toContain("Nothing is paid until your phone reports the car parked");
    const proposed = await tool("propose_plan", { request: REQUEST });
    expect(proposed._meta).toMatchObject({
      ui: { resourceUri: CONFIRM_CARD_URI },
      "io.parkagent/caps": { sessionCapUsd: expect.any(Number), dailyCapUsd: expect.any(Number) },
    });
  });
});

describe("the example configs", () => {
  test("both point a client at /mcp with an agent key", () => {
    const read = (name: string) =>
      readFileSync(new URL(`../../examples/${name}`, import.meta.url), "utf8");
    const claude = JSON.parse(read("mcp-config.json")) as {
      mcpServers: { parkagent: { type: string; url: string; headers: Record<string, string> } };
    };
    expect(claude.mcpServers.parkagent).toMatchObject({ type: "http" });
    const generic = JSON.parse(read("mcp-config.generic.json")) as {
      url: string;
      protocolVersion: string;
      headers: Record<string, string>;
    };
    expect(generic.protocolVersion).toBe(MODERN);
    for (const server of [claude.mcpServers.parkagent, generic]) {
      expect(new URL(server.url).pathname).toBe("/mcp");
      expect(server.headers["Authorization"]).toMatch(/^Bearer (\$\{PARKAGENT_AGENT_KEY\}|pak_)/);
    }
  });
});
