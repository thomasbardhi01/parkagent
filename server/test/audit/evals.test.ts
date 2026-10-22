/**
 * The template against the golden eval set: on every document, five lines
 * that say every fact the document lists. The live model is held to the
 * same set by hand (eval-live.ts, the `audit-eval` workflow).
 */

import { expect, test } from "vitest";

import { templateSummary } from "../../src/services/audit/summary.js";
import { EVAL_DOCS, missingFacts } from "./evals.js";

test("the eval set has its ten documents", () => {
  expect(EVAL_DOCS).toHaveLength(10);
});

for (const doc of EVAL_DOCS) {
  test(`template on ${doc.name}: ${doc.note}`, () => {
    const lines = templateSummary(doc.report);
    expect(lines).toHaveLength(5);
    expect(missingFacts(lines, doc)).toEqual([]);
    if (doc.facts.length === 0) expect(lines[0]).toContain("no invariant fired");
  });
}
