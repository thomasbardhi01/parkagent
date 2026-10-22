/**
 * The "why" eval, on the template (Issue M): every golden decision's
 * explanation states each of its facts, the invariant with its value in one
 * sentence. The manual explain-eval workflow holds EXPLAIN_MODEL's phrasing
 * to the same set.
 */

import { describe, expect, test } from "vitest";

import { GOLDEN, missingFacts } from "../src/eval/explainGolden.js";
import { explainDecision } from "../src/services/explanations.js";
import { hasReason } from "../src/services/reasons.js";

describe("the golden decisions", () => {
  test("thirty of them, every one a rule with a reason", () => {
    expect(GOLDEN).toHaveLength(30);
    expect(new Set(GOLDEN.map((g) => g.id)).size).toBe(30);
    for (const g of GOLDEN) expect(hasReason(g.row.kind, g.row.rule), g.id).toBe(true);
    // Every family: quoting, the gate, extending, the lifecycle, agents,
    // the card, the assistant.
    const kinds = new Set(GOLDEN.map((g) => g.row.kind));
    for (const kind of [
      "parked_quote",
      "session_start",
      "extend_tick",
      "session_end_return",
      "agent_confirm",
      "issuing_authorization",
      "assistant_plan",
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  test.each(GOLDEN.map((g) => [g.id, g] as const))("%s: the template states its facts", (_, g) => {
    const text = explainDecision({
      ...g.row,
      id: "d1",
      createdAt: new Date("2026-01-05T19:00:00Z"),
    });
    expect(missingFacts(text, g.facts), text).toEqual([]);
  });

  test("a fact is an invariant with its value, not a bare number", () => {
    const facts = [{ about: ["per-stop cap"], value: "$5.00" }];
    expect(missingFacts("The per-stop cap was $5.00.", facts)).toEqual([]);
    // The number alone, or beside another invariant, doesn't count.
    expect(missingFacts("It cost $5.00. That passed your per-stop cap.", facts)).toEqual(facts);
  });
});
