/**
 * The agent REST surface (WS-4 PR 2b): an agent key searches and plans
 * through the same capabilities as the app, and confirms through the one
 * mandate and the one money gate. Nothing pays: a street spot answers
 * pending_arrival and writes no park; arrival comes only from the phone.
 * Every refusal: no consent, wrong scope, expired, reused, plan changed,
 * over cap. Happy paths run under dry run.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { agentFunctionTools, agentOpenApi } from "../src/routes/agentOpenApi.js";
import type { GeocoderProvider } from "../src/services/assistant/geocoder.js";
import { planHashOf } from "../src/services/mandates.js";
import { BOYLSTON_BOS, MONDAY_2PM, NONADMIN_API_KEY, makeTestApp } from "./helpers.js";

/** Regenerate with `pnpm -C server exec tsx src/scripts/agent-tools.ts > examples/grok-tool.json`. */
const grokTools = JSON.parse(
  readFileSync(new URL("../../examples/grok-tool.json", import.meta.url), "utf8"),
) as { function: { name: string } }[];

const NOW = new Date(MONDAY_2PM);
const U2 = { "x-api-key": NONADMIN_API_KEY };
const NEWBURY = { lat: 42.3503, lng: -71.0811, displayName: "Newbury Street, Back Bay" };
const geocoder: GeocoderProvider = {
  async geocode() {
    return { ok: true, results: [{ ...NEWBURY, city: "bos" }] };
  },
};
const REQUEST = { place: "Newbury Street", durationMinutes: 60, kinds: ["street"] };

async function setup(opts: { scopes?: string[]; consent?: boolean; policy?: object } = {}) {
  const t = makeTestApp({
    candidates: [BOYLSTON_BOS],
    geocoder,
    now: () => NOW,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  const minted = await t.app.inject({
    method: "POST",
    url: "/me/agent-keys",
    headers: U2,
    payload: { label: "Grok", scopes: opts.scopes ?? ["read", "confirm"] },
  });
  const key = minted.json().key as string;
  if (opts.consent !== false) {
    await t.app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: U2,
      payload: { agentsMayAct: true },
    });
  }
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
      ...(payload ? { payload } : {}),
    });
  return { t, key, call };
}

const propose = async (call: Awaited<ReturnType<typeof setup>>["call"]) => {
  const res = await call("POST", "/agent/plans", { request: REQUEST });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    planId: string;
    plan: { kind: string; options: { id: string; zoneId: string; priceUsd: number }[] };
    confirmToken?: string;
    expiresAt?: string;
  };
};

describe("reading", () => {
  test("a street quote and a plan, as the person's agent, on the record", async () => {
    const { t, call } = await setup();
    const quote = await call("POST", "/agent/quote-street", { request: REQUEST });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ verdict: "meets" });
    const proposed = await propose(call);
    expect(proposed.plan.kind).toBe("single_spot");
    expect(proposed.plan.options[0]!.zoneId).toBe(BOYLSTON_BOS.zoneId);
    expect(proposed.confirmToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The capabilities' own audit rows say an agent asked, with its key.
    const rows = t.state.decisions.filter((d) => d.kind === "assistant_tool");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((d) => d.actor === "external_agent" && d.agentKeyId)).toBe(true);
    const plan = await call("GET", `/agent/plans/${proposed.planId}`);
    expect(plan.json()).toMatchObject({
      planId: proposed.planId,
      status: "proposed",
      confirmedAt: null,
      boundAt: null,
    });
  });

  test("a read-only key plans but gets no token, and can't confirm", async () => {
    const { call } = await setup({ scopes: ["read"] });
    const proposed = await propose(call);
    expect(proposed.confirmToken).toBeUndefined();
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: "x".repeat(32),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "scope_required", scope: "confirm" });
  });

  test("a confirm-only key can't search", async () => {
    const { call } = await setup({ scopes: ["confirm"] });
    const res = await call("POST", "/agent/quote-street", { request: REQUEST });
    expect(res.statusCode).toBe(403);
  });

  test("a place is named, never given as coordinates", async () => {
    const { call } = await setup();
    const res = await call("POST", "/agent/quote-street", {
      request: { ...REQUEST, lat: 42.35, lng: -71.08 },
    });
    expect(res.statusCode).toBe(400);
  });

  test("why: the person's own decision as its reason; another's is not there (Issue M)", async () => {
    const { t, call } = await setup();
    const seed = (userId: string) => {
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
    const mine = seed("u2");
    const theirs = seed("u1");
    const res = await call("GET", `/agent/decisions/${mine}/why`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      decisionId: mine,
      rule: "session_cap_exceeded",
      phrased: false,
      reason: {
        because: [
          { name: "price", value: "$5.40" },
          { name: "sessionCap", value: "$5.00" },
        ],
      },
    });
    expect(res.json().text).toContain("per-stop cap");
    expect((await call("GET", `/agent/decisions/${theirs}/why`)).statusCode).toBe(404);
  });

  test("why needs the read scope", async () => {
    const { call } = await setup({ scopes: ["confirm"] });
    expect((await call("GET", "/agent/decisions/d1/why")).statusCode).toBe(403);
  });

  test("why with an id that isn't one: 400 before the database, as MCP refuses it", async () => {
    const { t, call } = await setup();
    const read = vi.spyOn(t.deps.db.decision, "findUnique");
    for (const id of ["%00", "d1%3B", "a%20b"]) {
      const res = await call("GET", `/agent/decisions/${id}/why`);
      expect(res.statusCode, id).toBe(400);
      expect(res.json().error, id).toBeDefined();
    }
    expect(read).not.toHaveBeenCalled();
    // A key without the scope is refused whatever it sent, as before.
    const confirmOnly = await setup({ scopes: ["confirm"] });
    expect((await confirmOnly.call("GET", "/agent/decisions/%00/why")).json()).toEqual({
      error: "scope_required",
      scope: "read",
    });
  });

  test("geocode: the place named, or the closest one said as such", async () => {
    const { call } = await setup();
    const exact = await call("POST", "/agent/geocode", { query: "Newbury Street" });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ found: true, match: "exact" });
    const closest = await call("POST", "/agent/geocode", { query: "Newbury lounge downstairs" });
    expect(closest.json()).toMatchObject({ found: true, match: "closest" });
    expect(typeof closest.json().instruction).toBe("string");
  });

  test("itinerary: each stop looked up by name; a closest match is carried through", async () => {
    const { call } = await setup();
    const stop = { arrival: "2026-09-21T14:30:00-04:00", durationMinutes: 60 };
    const res = await call("POST", "/agent/itinerary", {
      stops: [
        { place: "Newbury Street", ...stop },
        { place: "Newbury lounge downstairs", ...stop, arrival: "2026-09-21T16:00:00-04:00" },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { closestMatches?: { stop: number; instruction?: string }[] };
    expect(body.closestMatches).toHaveLength(1);
    expect(body.closestMatches![0]).toMatchObject({ stop: 1 });
    expect(typeof body.closestMatches![0]!.instruction).toBe("string");
    // Coordinates are not a place.
    const coords = await call("POST", "/agent/itinerary", {
      stops: [{ place: "Newbury Street", lat: 42.35, lng: -71.08, ...stop }],
    });
    expect(coords.statusCode).toBe(400);
  });

  test("a plan's answer, which carries its mandate, is never kept by idempotency", async () => {
    const { t, key } = await setup();
    const res = await t.app.inject({
      method: "POST",
      url: "/agent/plans",
      headers: {
        authorization: `Bearer ${key}`,
        "idempotency-key": "11111111-2222-3333-4444-555555555555",
      },
      payload: { request: REQUEST },
    });
    expect(res.statusCode, res.body).toBe(200);
    const token = res.json().confirmToken as string;
    expect(token).toBeTruthy();
    expect(t.state.idempotencyKeys).toHaveLength(0);
    expect(JSON.stringify(t.state.idempotencyKeys)).not.toContain(token);
  });
});

describe("confirming", () => {
  test("a street spot is consent and a cap, never a park: pending_arrival, nothing paid", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
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
    const plan = await call("GET", `/agent/plans/${proposed.planId}`);
    expect(plan.json()).toMatchObject({
      status: "confirmed",
      confirmedOptionId: proposed.plan.options[0]!.id,
      boundAt: null,
    });
    // The phone's park bound it (agentArrival.test.ts pins when): the
    // agent reads it as bound (MCP's plan resource reads the same getPlan).
    const row = t.state.assistantPlans.find((p) => p.id === proposed.planId)!;
    row.boundParkedEventId = "pe-1";
    row.boundAt = NOW;
    const after = await call("GET", `/agent/plans/${proposed.planId}`);
    expect(after.json()).toMatchObject({ status: "bound", boundAt: NOW.toISOString() });
  });

  test("no consent: 403 before the mandate is read", async () => {
    const { t, call } = await setup({ consent: false });
    const proposed = await propose(call);
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "agents_not_allowed" });
    expect(t.state.mandates[0]!.consumedAt).toBeNull();
  });

  test("used once: a second confirm is 409 mandate_used", async () => {
    const { call } = await setup();
    const proposed = await propose(call);
    const confirm = () =>
      call("POST", `/agent/plans/${proposed.planId}/confirm`, {
        confirmToken: proposed.confirmToken,
      });
    expect((await confirm()).statusCode).toBe(200);
    const again = await confirm();
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "mandate_used" });
  });

  test("after ten minutes: 410 mandate_expired", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    t.state.mandates[0]!.expiresAt = new Date(NOW.getTime() - 1);
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: "mandate_expired" });
  });

  test("a plan changed since it was proposed: 409 plan_hash_mismatch", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    const row = t.state.assistantPlans.find((p) => p.id === proposed.planId)!;
    (row.plan as { options: { priceUsd: number }[] }).options[0]!.priceUsd = 0.01;
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "plan_hash_mismatch" });
  });

  test("a token for another plan, or a made-up one: 404", async () => {
    const { call } = await setup();
    const a = await propose(call);
    const b = await propose(call);
    for (const token of [b.confirmToken, "y".repeat(32)]) {
      const res = await call("POST", `/agent/plans/${a.planId}/confirm`, { confirmToken: token });
      expect(res.statusCode).toBe(404);
    }
  });

  test("a garage answers with its own checkout link; nothing is booked or paid here", async () => {
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
    const t = makeTestApp({
      candidates: [BOYLSTON_BOS],
      geocoder,
      now: () => NOW,
      garage: {
        id: "spothero",
        canReserve: false,
        search: async () => ({ ok: true, options: [GARAGE], fromCache: false }),
        optionById: (id) => (id === "g1" ? GARAGE : null),
        book: async () => ({ kind: "deeplink_handoff", option: GARAGE, deepLink: GARAGE.deepLink }),
      },
    });
    const key = (
      await t.app.inject({
        method: "POST",
        url: "/me/agent-keys",
        headers: U2,
        payload: { label: "Grok", scopes: ["read", "confirm"] },
      })
    ).json().key as string;
    await t.app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: U2,
      payload: { agentsMayAct: true },
    });
    const auth = { authorization: `Bearer ${key}` };
    const proposed = (
      await t.app.inject({
        method: "POST",
        url: "/agent/plans",
        headers: auth,
        payload: { request: { ...REQUEST, kinds: ["garage"] } },
      })
    ).json();
    expect(proposed.plan.options[0].type).toBe("garage");
    const res = await t.app.inject({
      method: "POST",
      url: `/agent/plans/${proposed.planId}/confirm`,
      headers: auth,
      payload: { confirmToken: proposed.confirmToken },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "garage_handoff", deepLink: GARAGE.deepLink });
    expect(t.state.sessions).toHaveLength(0);
  });

  test("over the person's per-stop cap: 409 policy_violation, mandate unspent", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    // The person lowers their cap after the plan was proposed.
    t.state.userLimits.push({
      userId: "u2",
      sessionCapUsd: 0.5,
      dailyCapUsd: null,
      defaultStayMinutes: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "policy_violation", rule: "session_cap_exceeded" });
    expect(t.state.mandates[0]!.consumedAt).toBeNull();
  });

  test("a street option with no price: 409 policy_violation amount_invalid, mandate unspent", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    // The stored option loses its price (and the mandate names the plan as
    // it now is, so plan_changed doesn't answer first).
    const row = t.state.assistantPlans.find((p) => p.id === proposed.planId)!;
    const plan = row.plan as { options: Record<string, unknown>[] };
    for (const o of plan.options) delete o["priceUsd"];
    t.state.mandates[0]!.planHash = planHashOf(row.plan);
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "policy_violation", rule: "amount_invalid" });
    expect(t.state.mandates[0]!.consumedAt).toBeNull();
    expect(t.state.sessions).toHaveLength(0);
  });

  test("the dry run shown rides on the mandate; a confirm under another is refused", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    expect(proposed).toMatchObject({ dryRun: true });
    // Dry run is switched off between the proposal and the confirm.
    t.deps.policy.effectiveDryRun = () => false;
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "dry_run_changed",
      shownDryRun: true,
      dryRun: false,
    });
    expect(t.state.mandates[0]!.consumedAt).toBeNull();
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "agent_confirm",
      rule: "dry_run_changed",
    });
  });

  test("a plan with nothing to confirm is refused on the record", async () => {
    const { t, call } = await setup();
    const proposed = await propose(call);
    // The plan behind the mandate is a "no" card now (the mandate has no
    // plan hash, so only the kind decides).
    const row = t.state.assistantPlans.find((p) => p.id === proposed.planId)!;
    row.kind = "none_meets";
    t.state.mandates[0]!.planHash = null;
    const res = await call("POST", `/agent/plans/${proposed.planId}/confirm`, {
      confirmToken: proposed.confirmToken,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "nothing_to_confirm" });
    expect(res.json().decisionId).toBeTruthy();
    expect(t.state.mandates[0]!.consumedAt).toBeNull();
  });

  test("a garage offer expired with the search: 409, mandate unspent, on the record", async () => {
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
    const t = makeTestApp({
      candidates: [BOYLSTON_BOS],
      geocoder,
      now: () => NOW,
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
    const key = (
      await t.app.inject({
        method: "POST",
        url: "/me/agent-keys",
        headers: U2,
        payload: { label: "Grok", scopes: ["read", "confirm"] },
      })
    ).json().key as string;
    await t.app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: U2,
      payload: { agentsMayAct: true },
    });
    const auth = { authorization: `Bearer ${key}` };
    const proposed = (
      await t.app.inject({
        method: "POST",
        url: "/agent/plans",
        headers: auth,
        payload: { request: { ...REQUEST, kinds: ["garage"] } },
      })
    ).json();
    cached = false; // the provider's ten-minute cache lapses
    const res = await t.app.inject({
      method: "POST",
      url: `/agent/plans/${proposed.planId}/confirm`,
      headers: auth,
      payload: { confirmToken: proposed.confirmToken },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "garage_option_expired" });
    expect(t.state.mandates.at(-1)!.consumedAt).toBeNull();
    expect(t.state.assistantPlans.find((p) => p.id === proposed.planId)!.confirmedAt).toBeNull();
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "agent_confirm",
      rule: "garage_option_expired",
    });
  });
});

describe("the documents", () => {
  test("openapi.json is public, OpenAPI 3.1, and covers every route", async () => {
    const { t } = await setup();
    const res = await t.app.inject({ method: "GET", url: "/agent/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc).toEqual(agentOpenApi());
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: expect.any(String), version: expect.any(String) });
    for (const route of [
      "/agent/me",
      "/agent/geocode",
      "/agent/quote-street",
      "/agent/garages/search",
      "/agent/itinerary",
      "/agent/plans",
      "/agent/plans/{planId}",
      "/agent/plans/{planId}/confirm",
      "/agent/parks/{parkId}",
      "/agent/decisions/{decisionId}/why",
    ]) {
      expect(Object.keys(doc.paths), route).toContain(route);
    }
    // Every operation names its responses; every body schema is an object
    // JSON Schema with no dialect marker inside the document.
    for (const [route, item] of Object.entries(doc.paths as Record<string, object>)) {
      for (const op of Object.values(item as Record<string, { responses: object }>)) {
        expect(Object.keys(op.responses).length, route).toBeGreaterThan(0);
      }
    }
    expect(JSON.stringify(doc)).not.toContain("$schema");
  });

  test("examples/grok-tool.json is the six tools, as generated", () => {
    expect(grokTools).toEqual(agentFunctionTools());
    expect(grokTools.map((t) => t.function.name)).toEqual([
      "geocode_place",
      "quote_street",
      "search_garages",
      "build_itinerary",
      "propose_plan",
      "confirm_plan",
    ]);
  });
});
