/**
 * GET /me/decisions/:decisionId/why (Issue M): the app's "Why?" on the
 * session timeline. The person's own decision as its reason and the
 * sentence to show; phrased only when EXPLAIN_MODEL is on, and that call is
 * the person's assistant spend. Another person's decision, or an agent
 * key, gets nothing.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient } from "../src/services/assistant/modelClient.js";
import { MONDAY_2PM, NONADMIN_API_KEY, makeTestApp } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const U2 = { "x-api-key": NONADMIN_API_KEY };

function setup(explainModel?: ModelClient) {
  const t = makeTestApp({ now: () => NOW, ...(explainModel ? { explainModel } : {}) });
  const seed = (userId: string) => {
    t.state.decisions.push({
      kind: "extend_tick",
      rule: "hold_return_likely",
      inputs: { distanceM: 140, expiresAt: "2026-01-05T20:30:00.000Z" },
      outcome: {},
      userId,
      createdAt: NOW,
    });
    return `d${t.state.decisions.length}`;
  };
  const why = (id: string, headers: Record<string, string> = U2) =>
    t.app.inject({ method: "GET", url: `/me/decisions/${id}/why`, headers });
  return { t, seed, why };
}

describe("GET /me/decisions/:decisionId/why", () => {
  test("your own decision: what happened, the evidence, the sentence", async () => {
    const { seed, why } = setup();
    const id = seed("u2");
    const res = await why(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      decisionId: id,
      kind: "extend_tick",
      rule: "hold_return_likely",
      phrased: false,
      reason: {
        subject: "Auto-extend check",
        because: [
          { name: "distance", value: "140 m" },
          { name: "expiresAt", value: "2026-01-05 20:30 UTC" },
        ],
        youCan: null,
      },
    });
    expect(res.json().text).toContain("likely to be back");
  });

  test("rate limited: 30 a minute, as other paid per-person reads (#268 review)", async () => {
    const { seed, why } = setup();
    const id = seed("u2");
    for (let i = 0; i < 30; i++) expect((await why(id)).statusCode).toBe(200);
    expect((await why(id)).statusCode).toBe(429);
  });

  test("another person's decision, or none, is not there", async () => {
    const { seed, why } = setup();
    const theirs = seed("u1");
    expect((await why(theirs)).statusCode).toBe(404);
    expect((await why("d999")).statusCode).toBe(404);
  });

  test("phrased when EXPLAIN_MODEL is on, and billed to the person", async () => {
    const model: ModelClient = {
      async create() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ answer: "You were 140 m away and heading back." }),
            },
          ],
          stopReason: "end_turn",
          model: "claude-haiku-5-5",
          usage: { inputTokens: 250, outputTokens: 40 },
        };
      },
    };
    const { t, seed, why } = setup(model);
    const res = await why(seed("u2"));
    expect(res.json()).toMatchObject({
      phrased: true,
      text: "You were 140 m away and heading back.",
    });
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "assistant_turn",
      rule: "explain_phrased",
      userId: "u2",
    });
  });
});
