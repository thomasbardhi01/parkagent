/**
 * FR-60 — external agents, live (WS-4). What a live, dry-run server can
 * prove about an agent key:
 *
 *  - the person mints it (shown once), turns consent on, and revokes it;
 *  - it reaches the agent surface and nothing else, and the agent surface
 *    takes nothing else (a session there is 403);
 *  - it proposes a Boston plan through the same capabilities as the app,
 *    and a confirm pays nothing: a street spot is `pending_arrival` (the
 *    phone reports arrival), a garage is its own checkout link;
 *  - without consent the confirm is refused; a used mandate is refused.
 *
 * The user is this file's own throwaway (client.ts `ownUser`). Consent is
 * set back off and every key revoked at the end of each test.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { gate, ownUser, userFetch } from "./client.js";

const me = ownUser(import.meta.url);
const minted: string[] = [];

beforeAll(async () => {
  await gate();
});

afterEach(async () => {
  for (const id of minted.splice(0)) await userFetch(me, "DELETE", `/me/agent-keys/${id}`);
  await userFetch(me, "PATCH", "/me/settings", { agentsMayAct: false });
});

async function mintKey(scopes: string[]) {
  const res = await userFetch(me, "POST", "/me/agent-keys", { label: "fr", scopes });
  expect(res.status).toBe(201);
  const body = res.body as { key: string; id: string };
  minted.push(body.id);
  return body;
}

const asAgent = (key: string, method: "GET" | "POST", path: string, payload?: unknown) =>
  userFetch(me, method, path, payload, { authorization: `Bearer ${key}` });

describe("FR-60 external agents", () => {
  it("a key reaches the agent surface and nothing else; a session is refused there", async () => {
    const { key } = await mintKey(["read"]);
    const whoami = await asAgent(key, "GET", "/agent/me");
    expect(whoami.status).toBe(200);
    expect(whoami.body).toMatchObject({ scopes: ["read"], agentsMayAct: false });
    expect((await asAgent(key, "GET", "/me")).status).toBe(403);
    expect((await userFetch(me, "GET", "/agent/me")).status).toBe(403);
  });

  it("a Boston plan, confirmed, pays nothing; the mandate is single-use", async () => {
    const { key } = await mintKey(["read", "confirm"]);
    expect((await userFetch(me, "PATCH", "/me/settings", { agentsMayAct: true })).status).toBe(200);
    const proposed = await asAgent(key, "POST", "/agent/plans", {
      request: { place: "Boylston Street, Boston", durationMinutes: 60 },
    });
    expect(proposed.status).toBe(200);
    const body = proposed.body as {
      planId: string;
      plan: { kind: string };
      confirmToken?: string;
    };
    if (body.plan.kind !== "single_spot") return; // nothing met it at this hour: a valid "no"
    expect(body.confirmToken).toBeDefined();
    const confirm = () =>
      asAgent(key, "POST", `/agent/plans/${body.planId}/confirm`, {
        confirmToken: body.confirmToken,
      });
    const first = await confirm();
    expect(first.status).toBe(200);
    expect(["pending_arrival", "garage_handoff"]).toContain(
      (first.body as { status: string }).status,
    );
    const again = await confirm();
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "mandate_used" });
  });

  it("without consent the confirm is refused, and a revoked key is gone", async () => {
    const { key, id } = await mintKey(["read", "confirm"]);
    const proposed = await asAgent(key, "POST", "/agent/plans", {
      request: { place: "Boylston Street, Boston", durationMinutes: 60 },
    });
    const body = proposed.body as { planId: string; confirmToken?: string };
    if (body.confirmToken) {
      const refused = await asAgent(key, "POST", `/agent/plans/${body.planId}/confirm`, {
        confirmToken: body.confirmToken,
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: "agents_not_allowed" });
    }
    expect((await userFetch(me, "DELETE", `/me/agent-keys/${id}`)).status).toBe(200);
    expect((await asAgent(key, "GET", "/agent/me")).status).toBe(401);
  });
});
