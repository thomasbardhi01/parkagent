/**
 * Agent keys and the mandate (WS-4 PR 2a). A person mints a `pak_` key,
 * shown once; it resolves in the one auth hook to an external-agent
 * principal with the key's scopes; it reaches the agent surfaces and
 * nothing else, and they take nothing else. Consent is the person's
 * (PATCH /me/settings). The mandate — the one confirm token — is stored
 * hashed, bound to the plan, single-use, and refused to anyone else.
 */

import { describe, expect, test } from "vitest";

import { proposePlan } from "../src/services/capabilities/proposePlan.js";
import { bookGarage } from "../src/services/capabilities/confirmPlan.js";
import { hashApiKey } from "../src/services/apiKeys.js";
import { signAccessToken } from "../src/services/authTokens.js";
import { claimMandate, mintMandate, planHashOf, readMandate } from "../src/services/mandates.js";
import type { Principal } from "../src/services/principal.js";
import { agentPrincipal, isAgentSurface, runAs, userPrincipal } from "../src/services/principal.js";
import {
  API_KEY,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  TEST_JWT_SECRET,
  TEST_PEPPER,
  makeTestApp,
  seedMandate,
} from "./helpers.js";

const AT = new Date(MONDAY_2PM);
const U2 = { "x-api-key": NONADMIN_API_KEY };

/** u2 mints a key with these scopes and gets the key string back. */
async function mint(t: ReturnType<typeof makeTestApp>, scopes: string[] = ["read", "confirm"]) {
  const res = await t.app.inject({
    method: "POST",
    url: "/me/agent-keys",
    headers: U2,
    payload: { label: "Grok", scopes },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { key: string; id: string; prefix: string };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("keys", () => {
  test("a key is shown once, kept as its hash, and listed by prefix", async () => {
    const t = makeTestApp({});
    const { key, id, prefix } = await mint(t);
    expect(key).toMatch(new RegExp(`^pak_${prefix}_[A-Za-z0-9_-]{20,}$`));
    const row = t.state.agentKeys.find((k) => k.id === id)!;
    expect(row.hash).toBe(hashApiKey(TEST_PEPPER, key));
    expect(JSON.stringify(t.state.agentKeys)).not.toContain(key);
    const list = await t.app.inject({ method: "GET", url: "/me/agent-keys", headers: U2 });
    expect(list.json().keys).toEqual([
      expect.objectContaining({ id, prefix, label: "Grok", scopes: ["read", "confirm"] }),
    ]);
    expect(JSON.stringify(list.json())).not.toContain(key);
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "agent_key", rule: "created" });
  });

  test("scopes are a subset of read and confirm, and at least one", async () => {
    const t = makeTestApp({});
    for (const scopes of [[], ["admin"], ["read", "read"]]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/me/agent-keys",
        headers: U2,
        payload: { label: "x", scopes },
      });
      expect(res.statusCode, JSON.stringify(scopes)).toBe(400);
    }
  });

  test("a key resolves to an external agent with its own scopes, never the person's admin", async () => {
    const t = makeTestApp({});
    // u1 is the admin: their agent is still only its key.
    const res = await t.app.inject({
      method: "POST",
      url: "/me/agent-keys",
      headers: { "x-api-key": API_KEY },
      payload: { label: "Claude", scopes: ["read"] },
    });
    const me = await t.app.inject({
      method: "GET",
      url: "/agent/me",
      headers: bearer(res.json().key),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: "u1", scopes: ["read"], agentsMayAct: false });
    const policy = await t.app.inject({
      method: "PUT",
      url: "/policy",
      headers: bearer(res.json().key),
      payload: { dry_run: false },
    });
    expect(policy.statusCode).toBe(403);
  });

  test("a revoked key, or one nobody minted, is 401; revoking keeps the row", async () => {
    const t = makeTestApp({});
    const { key, id } = await mint(t);
    const del = await t.app.inject({ method: "DELETE", url: `/me/agent-keys/${id}`, headers: U2 });
    expect(del.statusCode).toBe(200);
    expect(t.state.agentKeys.find((k) => k.id === id)!.revokedAt).not.toBeNull();
    for (const k of [key, "pak_abcdefgh_notakeyanybodyminted123456"]) {
      const res = await t.app.inject({ method: "GET", url: "/agent/me", headers: bearer(k) });
      expect(res.statusCode).toBe(401);
    }
  });

  test("another person's key can't be revoked", async () => {
    const t = makeTestApp({});
    const { id } = await mint(t);
    const res = await t.app.inject({
      method: "DELETE",
      url: `/me/agent-keys/${id}`,
      headers: { "x-api-key": API_KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(t.state.agentKeys.find((k) => k.id === id)!.revokedAt).toBeNull();
  });
});

describe("one surface per principal kind", () => {
  test("an agent key reaches the agent surface and nothing else", async () => {
    const t = makeTestApp({});
    const { key } = await mint(t);
    for (const url of ["/me", "/me/limits", "/me/agent-keys", "/wallet"]) {
      const res = await t.app.inject({ method: "GET", url, headers: bearer(key) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ error: "agent_key_not_allowed_here" });
    }
    // An agent can't turn consent on for itself, or mint itself more keys.
    for (const [method, url, payload] of [
      ["PATCH", "/me/settings", { agentsMayAct: true }],
      ["POST", "/me/agent-keys", { label: "more", scopes: ["confirm"] }],
      ["POST", "/assistant/message", { text: "hi", location: { lat: 42.35, lng: -71.06 } }],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: bearer(key), payload });
      expect(res.statusCode, url).toBe(403);
    }
    expect(t.state.users.find((u) => u.id === "u2")!.agentsMayAct).toBe(false);
  });

  test("a user's API key, the admin key, or a session JWT on the agent surface is 403", async () => {
    const t = makeTestApp({});
    const jwt = signAccessToken(TEST_JWT_SECRET, { id: "u2", name: "Ana", isAdmin: false }, AT);
    for (const headers of [U2, { "x-api-key": API_KEY }, bearer(jwt.token)]) {
      const res = await t.app.inject({ method: "GET", url: "/agent/me", headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "agent_surface_needs_agent_key" });
    }
  });

  test("a percent-encoded path is judged as the route it reaches (#255 review)", async () => {
    const t = makeTestApp({});
    const { key } = await mint(t);
    // The admin key on an encoded /agent/me: still the agent surface.
    for (const url of ["/%61gent/me", "/%61%67ent/me"]) {
      const res = await t.app.inject({ method: "GET", url, headers: { "x-api-key": API_KEY } });
      expect(res.statusCode, url).toBe(403);
    }
    // An agent key on an encoded /me: still not the agent surface.
    for (const url of ["/%6De", "/%6De/limits"]) {
      const res = await t.app.inject({ method: "GET", url, headers: bearer(key) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  test("the surfaces are a list F extends", () => {
    expect(isAgentSurface("/agent/me")).toBe(true);
    expect(isAgentSurface("/agent")).toBe(true);
    expect(isAgentSurface("/agentx")).toBe(false);
    expect(isAgentSurface("/me")).toBe(false);
  });
});

describe("consent and the rate limit", () => {
  test("PATCH /me/settings sets consent, on the record, and GET /me reports it", async () => {
    const t = makeTestApp({});
    const res = await t.app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: U2,
      payload: { agentsMayAct: true },
    });
    expect(res.statusCode).toBe(200);
    expect(t.state.users.find((u) => u.id === "u2")!.agentsMayAct).toBe(true);
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "agent_consent",
      rule: "agents_may_act",
    });
    const me = await t.app.inject({ method: "GET", url: "/me", headers: U2 });
    expect(me.json()).toMatchObject({ agentsMayAct: true });
  });

  test("60 calls a minute per key; another key has its own minute", async () => {
    const t = makeTestApp({});
    const a = await mint(t);
    const b = await mint(t);
    for (let i = 0; i < 60; i += 1) {
      const res = await t.app.inject({ method: "GET", url: "/agent/me", headers: bearer(a.key) });
      expect(res.statusCode).toBe(200);
    }
    const over = await t.app.inject({ method: "GET", url: "/agent/me", headers: bearer(a.key) });
    expect(over.statusCode).toBe(429);
    const other = await t.app.inject({ method: "GET", url: "/agent/me", headers: bearer(b.key) });
    expect(other.statusCode).toBe(200);
  });

  test("an agent key's use is stamped", async () => {
    const t = makeTestApp({});
    const { key, id } = await mint(t);
    await t.app.inject({ method: "GET", url: "/agent/me", headers: bearer(key) });
    expect(t.state.agentKeys.find((k) => k.id === id)!.lastUsedAt).not.toBeNull();
  });

  test("a decision written as an agent says so, with its key", async () => {
    const t = makeTestApp({});
    const agent = agentPrincipal({ userId: "u2", id: "ak9", scopes: ["read"] });
    await runAs(agent, () =>
      t.deps.db.decision.create({
        data: {
          kind: "agent_confirm",
          inputs: {},
          rule: "pending_arrival",
          outcome: {},
          userId: "u2",
        },
      }),
    );
    expect(t.state.decisions.at(-1)).toMatchObject({ actor: "external_agent", agentKeyId: "ak9" });
  });

  test("a minted key never sits in the idempotency table (#255 review)", async () => {
    const t = makeTestApp({});
    const res = await t.app.inject({
      method: "POST",
      url: "/me/agent-keys",
      headers: { ...U2, "idempotency-key": "11111111-2222-3333-4444-555555555555" },
      payload: { label: "Grok", scopes: ["read"] },
    });
    expect(res.statusCode).toBe(201);
    const key = res.json().key as string;
    expect(t.state.idempotencyKeys).toHaveLength(0);
    expect(JSON.stringify(t.state.idempotencyKeys)).not.toContain(key);
  });
});

describe("the mandate", () => {
  const plan = { kind: "single_spot", options: [{ id: "o1" }] };
  const agent = (scopes: string[] = ["read", "confirm"]): Principal =>
    agentPrincipal({ userId: "u2", id: "ak1", scopes });
  const deps = (t: ReturnType<typeof makeTestApp>) => ({ db: t.deps.db, pepper: TEST_PEPPER });
  const mintFor = (t: ReturnType<typeof makeTestApp>, p: Principal, scopes = ["confirm"]) =>
    mintMandate(
      deps(t),
      p,
      { planId: "plan1", optionId: "o1", planHash: planHashOf(plan), scopes, capsSnapshot: null },
      AT,
    );

  test("stored as its hash, held by the key that asked, claimed once", async () => {
    const t = makeTestApp({});
    const { token, expiresAt } = await mintFor(t, agent());
    expect(expiresAt.getTime() - AT.getTime()).toBe(10 * 60_000);
    const row = t.state.mandates[0]!;
    expect(row.token).toBe(hashApiKey(TEST_PEPPER, token));
    expect(row).toMatchObject({ agentKeyId: "ak1", planHash: planHashOf(plan) });
    const read = await readMandate(deps(t), agent(), token, AT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(await claimMandate(deps(t), read.row, AT)).toMatchObject({ ok: true, planId: "plan1" });
    expect(await readMandate(deps(t), agent(), token, AT)).toEqual({ ok: false, reason: "used" });
  });

  test("refused to the person's app, to another key, after expiry, and without confirm", async () => {
    const t = makeTestApp({});
    const { token } = await mintFor(t, agent());
    const person = userPrincipal({ id: "u2", isAdmin: false });
    expect(await readMandate(deps(t), person, token, AT)).toEqual({
      ok: false,
      reason: "not_valid",
    });
    const otherKey = agentPrincipal({ userId: "u2", id: "ak2", scopes: ["confirm"] });
    expect(await readMandate(deps(t), otherKey, token, AT)).toEqual({
      ok: false,
      reason: "not_valid",
    });
    const later = new Date(AT.getTime() + 10 * 60_000);
    expect(await readMandate(deps(t), agent(), token, later)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await readMandate(deps(t), agent(["read"]), token, AT)).toEqual({
      ok: false,
      reason: "scope",
    });
    const readOnly = await mintFor(t, agent(), ["read"]);
    expect(await readMandate(deps(t), agent(), readOnly.token, AT)).toEqual({
      ok: false,
      reason: "scope",
    });
  });

  test("a plan's hash is its canonical JSON: key order doesn't change it, a value does", () => {
    expect(planHashOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      planHashOf({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(planHashOf({ a: 1 })).not.toBe(planHashOf({ a: 2 }));
    // A key holding undefined is no key, as after a JSON column round trip.
    expect(planHashOf({ a: 1, b: undefined })).toBe(planHashOf({ a: 1 }));
    const plan = { kind: "single_spot", options: [{ id: "o1", note: undefined }] };
    expect(planHashOf(plan)).toBe(planHashOf(JSON.parse(JSON.stringify(plan))));
  });

  describe("refused through the real consume path (bookGarage)", () => {
    const ctx = { conversationId: "c1" };
    const seedPlan = (t: ReturnType<typeof makeTestApp>) => {
      const plan = {
        kind: "single_spot",
        options: [{ id: "o1", type: "garage", garageOptionId: "g1", priceUsd: 9 }],
      };
      t.state.assistantPlans.push({
        id: "plan1",
        userId: "u2",
        conversationId: "agent:ak1",
        kind: "single_spot",
        plan,
        createdAt: AT,
        confirmedAt: null,
        confirmedOptionId: null,
      });
      t.state.users.find((u) => u.id === "u2")!.agentsMayAct = true;
      return plan;
    };
    const book = (t: ReturnType<typeof makeTestApp>, p: Principal, token: string) =>
      bookGarage(t.deps.assistantTools!["deps"], p, ctx, {
        option_id: "g1",
        confirmation_token: token,
      });
    const message = (out: { result: unknown }) =>
      (out.result as { message?: string }).message ?? "";

    test("a plan changed since the mandate was minted", async () => {
      const t = makeTestApp({});
      const plan = seedPlan(t);
      const token = seedMandate(t.state, "tok-changed", {
        userId: "u2",
        planId: "plan1",
        optionId: "o1",
        agentKeyId: "ak1",
        planHash: planHashOf({ ...plan, extra: true }),
        expiresAt: new Date(AT.getTime() + 60_000),
      });
      const out = await book(t, agent(), token);
      expect(message(out)).toContain("the plan changed");
      expect(t.state.mandates[0]!.consumedAt).toBeNull();
    });

    test("a read-only key", async () => {
      const t = makeTestApp({});
      seedPlan(t);
      const token = seedMandate(t.state, "tok-read", {
        userId: "u2",
        planId: "plan1",
        optionId: "o1",
        agentKeyId: "ak1",
        expiresAt: new Date(AT.getTime() + 60_000),
      });
      const out = await book(t, agent(["read"]), token);
      expect(message(out)).toContain("may not confirm");
    });

    test("a mandate already used", async () => {
      const t = makeTestApp({});
      seedPlan(t);
      const token = seedMandate(t.state, "tok-used", {
        userId: "u2",
        planId: "plan1",
        optionId: "o1",
        agentKeyId: "ak1",
        expiresAt: new Date(AT.getTime() + 60_000),
        consumedAt: AT,
      });
      const out = await book(t, agent(), token);
      expect(message(out)).toContain("already used");
    });
  });
});

describe("capabilities judge the principal they are given (#250 review)", () => {
  // Called directly, outside any request scope, as REST and MCP will.
  const agent = agentPrincipal({ userId: "u2", id: "ak1", scopes: ["read", "confirm"] });

  test("proposePlan refuses an agent its person never let act", async () => {
    const t = makeTestApp({});
    const out = await proposePlan(
      t.deps.assistantTools!["deps"],
      agent,
      {
        conversationId: "c1",
      },
      {
        plan: {
          kind: "itinerary",
          date: "2026-01-05",
          stops: [
            {
              id: "s1",
              label: "A",
              address: "1 Main St",
              lat: 42.35,
              lng: -71.06,
              arrival: "2026-01-05T15:00:00-05:00",
              durationMinutes: 60,
              choice: "street",
              costUsd: 2,
            },
          ],
          totalUsd: 2,
          capUsd: 60,
        },
      },
    );
    expect(out.result).toEqual({ error: "agents_not_allowed" });
  });

  test("confirmPlan refuses it before the token is even read", async () => {
    const t = makeTestApp({});
    const reads: unknown[] = [];
    const real = t.deps.db.mandate.findUnique.bind(t.deps.db.mandate);
    t.deps.db.mandate.findUnique = async (args) => {
      reads.push(args);
      return real(args);
    };
    const out = await bookGarage(
      t.deps.assistantTools!["deps"],
      agent,
      {
        conversationId: "c1",
      },
      { option_id: "g1", confirmation_token: "anything" },
    );
    expect(out.result).toEqual({ error: "agents_not_allowed" });
    expect(reads).toHaveLength(0);
  });
});
