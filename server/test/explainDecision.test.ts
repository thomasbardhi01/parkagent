/**
 * explainDecision (Issue M): the owner's (or an admin's) decision as the
 * deterministic reason, phrased by EXPLAIN_MODEL only when it is on. The
 * model gets the structured reason and nothing else, answers in a strict
 * schema, and any amount it writes that isn't on the row goes. Every
 * failure — refusal, cut-off, unreadable, thrown, budget spent — is the
 * template. Its spend counts toward the assistant's daily cap.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse } from "../src/services/assistant/modelClient.js";
import {
  EXPLAIN_MAX_TOKENS,
  EXPLAIN_SCHEMA,
  explainDecision,
} from "../src/services/capabilities/explainDecision.js";
import { agentPrincipal, userPrincipal } from "../src/services/principal.js";
import { MONDAY_2PM, makeTestApp } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const U1 = userPrincipal({ id: "u1", isAdmin: false });
const ROW = {
  kind: "session_start",
  rule: "session_cap_exceeded",
  inputs: { quote: { totalUsd: 5.4, stayMinutes: 90 }, sessionCapUsd: 5 },
  outcome: { allowed: false },
  userId: "u1",
  createdAt: NOW,
};

/** A model that answers `answer` (or the given response) and records
 * what it was asked. */
function model(reply: string | Partial<ModelResponse> | Error) {
  const calls: Parameters<ModelClient["create"]>[0][] = [];
  const client: ModelClient = {
    async create(args) {
      calls.push(args);
      if (reply instanceof Error) throw reply;
      const base: ModelResponse = {
        content: [{ type: "text", text: JSON.stringify({ answer: reply }) }],
        stopReason: "end_turn",
        model: "claude-haiku-5-5",
        usage: { inputTokens: 300, outputTokens: 60 },
      };
      return typeof reply === "string" ? base : { ...base, ...reply };
    },
  };
  return { client, calls };
}

function setup(explainModel?: ModelClient, cap?: number) {
  const t = makeTestApp({ now: () => NOW });
  t.state.decisions.push({ ...ROW });
  const deps = {
    db: t.deps.db,
    now: () => NOW,
    ...(explainModel ? { explainModel } : {}),
    ...(cap !== undefined ? { assistantDailySpendCapUsd: cap } : {}),
  };
  return { t, deps };
}

describe("who may read it", () => {
  test("the owner, or an admin; anyone else reads it as not there", async () => {
    const { deps } = setup();
    expect((await explainDecision(deps, U1, { decisionId: "d1" })).ok).toBe(true);
    const other = userPrincipal({ id: "u2", isAdmin: false });
    expect(await explainDecision(deps, other, { decisionId: "d1" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    const admin = userPrincipal({ id: "u2", isAdmin: true });
    expect((await explainDecision(deps, admin, { decisionId: "d1" })).ok).toBe(true);
    // An agent is the person's, never their admin rights.
    const agent = agentPrincipal({ userId: "u1", id: "ak1", scopes: ["read"] });
    expect((await explainDecision(deps, agent, { decisionId: "d1" })).ok).toBe(true);
  });

  test("a row with no user reads for an admin only, not for whoever has its id (#266 review)", async () => {
    const { t, deps } = setup();
    t.state.decisions.push({ ...ROW, userId: null });
    expect((await explainDecision(deps, U1, { decisionId: "d2" })).ok).toBe(false);
    const admin = userPrincipal({ id: "u2", isAdmin: true });
    expect((await explainDecision(deps, admin, { decisionId: "d2" })).ok).toBe(true);
  });
});

describe("the template, and the model on top of it", () => {
  test("no model (EXPLAIN_MODEL off): the reason's template", async () => {
    const { deps } = setup();
    const out = await explainDecision(deps, U1, { decisionId: "d1" });
    expect(out).toMatchObject({ ok: true, phrased: false, rule: "session_cap_exceeded" });
    if (!out.ok) throw new Error("unreachable");
    expect(out.text).toBe(out.template);
    expect(out.text).toContain("$5.40");
    expect(out.reason.because.map((e) => e.name)).toEqual(["price", "sessionCap"]);
  });

  test("the model gets the structured reason only, in a strict schema, and phrases it", async () => {
    const m = model("Your $5.40 stay was over your $5.00 per-stop cap. Raise it in Limits.");
    const { deps } = setup(m.client);
    const out = await explainDecision(deps, U1, { decisionId: "d1" });
    expect(out).toMatchObject({ ok: true, phrased: true });
    if (!out.ok) throw new Error("unreachable");
    expect(out.text).toBe("Your $5.40 stay was over your $5.00 per-stop cap. Raise it in Limits.");
    const call = m.calls[0]!;
    expect(call.outputSchema).toEqual(EXPLAIN_SCHEMA);
    expect(call.tools).toBeUndefined();
    expect(call.maxTokens).toBe(EXPLAIN_MAX_TOKENS);
    // The reason as data — not the row, not the template.
    const sent = JSON.parse(call.messages[0]!.content as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["because", "subject", "what", "youCan"]);
    expect(sent["because"]).toEqual([
      { label: "the price", value: "$5.40" },
      { label: "the per-stop cap", value: "$5.00" },
    ]);
    expect(call.messages[0]!.content).not.toContain("sessionCapUsd");
  });

  test("a sentence with an amount the row doesn't carry is dropped", async () => {
    const m = model("You were $0.40 over. Your $5.40 stay passed your $5.00 cap.");
    const { deps } = setup(m.client);
    const out = await explainDecision(deps, U1, { decisionId: "d1" });
    if (!out.ok) throw new Error("unreachable");
    expect(out.text).toBe("Your $5.40 stay passed your $5.00 cap.");
  });

  test("any number not in what the model was sent is the template (#266 review)", async () => {
    // A distance, a stay, a zone or a clock time the row never held.
    for (const made of [
      "You were about 200 m away when it was refused.",
      "Your 2 hour stay passed the cap.",
      "Zone 417731 was over your cap.",
      "It was refused at 21:00.",
    ]) {
      const { deps } = setup(model(made).client);
      expect(await explainDecision(deps, U1, { decisionId: "d1" }), made).toMatchObject({
        phrased: false,
      });
    }
  });

  test("the call asks for low effort: three sentences need little thinking", async () => {
    const m = model("Your stay passed your cap.");
    const { deps } = setup(m.client);
    await explainDecision(deps, U1, { decisionId: "d1" });
    expect(m.calls[0]!.effort).toBe("low");
  });

  test("every sentence ungrounded: the template", async () => {
    const m = model("That cost you $12.00.");
    const { deps } = setup(m.client);
    const out = await explainDecision(deps, U1, { decisionId: "d1" });
    expect(out).toMatchObject({ phrased: false });
  });

  test.each([
    ["a refusal", { stopReason: "refusal" }],
    ["a cut-off", { stopReason: "max_tokens" }],
    ["unreadable JSON", { content: [{ type: "text" as const, text: "Sure! Here's why" }] }],
    ["a missing answer", { content: [{ type: "text" as const, text: "{}" }] }],
  ])("%s: the template", async (_why, reply) => {
    const { deps } = setup(model(reply).client);
    expect(await explainDecision(deps, U1, { decisionId: "d1" })).toMatchObject({
      ok: true,
      phrased: false,
    });
  });

  test("a model error: the template, never a failure", async () => {
    const { deps } = setup(model(new Error("529 overloaded")).client);
    expect(await explainDecision(deps, U1, { decisionId: "d1" })).toMatchObject({
      ok: true,
      phrased: false,
    });
  });

  test("a rule with no reason is never sent to the model", async () => {
    const m = model("anything");
    const { t, deps } = setup(m.client);
    t.state.decisions.push({ ...ROW, rule: "brand_new_rule" });
    const out = await explainDecision(deps, U1, { decisionId: "d2" });
    expect(out).toMatchObject({ phrased: false });
    expect(m.calls).toHaveLength(0);
  });
});

describe("what it costs", () => {
  test("outside a turn, the call is an assistant_turn row the daily cap reads", async () => {
    const { t, deps } = setup(model("Your stay passed your cap.").client);
    await explainDecision(deps, U1, { decisionId: "d1" });
    const row = t.state.decisions.at(-1)!;
    expect(row).toMatchObject({ kind: "assistant_turn", rule: "explain_phrased", userId: "u1" });
    expect((row.outcome as { estimatedCostUsd: number }).estimatedCostUsd).toBeGreaterThan(0);
  });

  test("inside a turn, the turn counts it: no row of its own", async () => {
    const { t, deps } = setup(model("Your stay passed your cap.").client);
    const usage: unknown[] = [];
    await explainDecision(deps, U1, { decisionId: "d1" }, (u) => usage.push(u));
    expect(usage).toEqual([{ model: "claude-haiku-5-5", inputTokens: 300, outputTokens: 60 }]);
    expect(t.state.decisions.filter((d) => d.kind === "assistant_turn")).toHaveLength(0);
  });

  test("the tool with no turn to bill still records its spend (#266 review)", async () => {
    const t = makeTestApp({
      now: () => NOW,
      explainModel: model("Your stay passed your cap.").client,
    });
    t.state.decisions.push({ ...ROW });
    await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" } as Parameters<
        NonNullable<typeof t.deps.assistantTools>["execute"]
      >[0],
      "explain_decision",
      { decision_id: "d1" },
    );
    expect(t.state.decisions.some((d) => d.rule === "explain_phrased")).toBe(true);
  });

  test("today's budget spent: the template, and no call", async () => {
    const m = model("anything");
    const { t, deps } = setup(m.client, 0.01);
    t.state.decisions.push({
      kind: "assistant_turn",
      rule: "turn_complete",
      inputs: {},
      outcome: { estimatedCostUsd: 0.02 },
      userId: "u1",
      createdAt: NOW,
    });
    expect(await explainDecision(deps, U1, { decisionId: "d1" })).toMatchObject({
      phrased: false,
    });
    expect(m.calls).toHaveLength(0);
  });
});
