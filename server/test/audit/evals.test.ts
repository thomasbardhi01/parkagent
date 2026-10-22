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

const byName = (name: string) => EVAL_DOCS.find((d) => d.name === name)!;

test("a fact is the invariant and its count on one line, not any digit anywhere", () => {
  const doc = byName("mixed"); // dry_run_mismatch 1, starting_too_long 2, prompted_more_than_twice 6
  const right = [
    "3 of 7 invariants fired.",
    "dry_run_mismatch fired 1 time.",
    "starting_too_long fired 2 times.",
    "prompted_more_than_twice fired 6 times.",
    "Nothing else.",
  ];
  expect(missingFacts(right, doc)).toEqual([]);
  // The wrong count; a count only inside the description; the count on
  // another line than the name.
  expect(
    missingFacts(
      right.map((l, i) => (i === 3 ? "prompted_more_than_twice fired 7 times." : l)),
      doc,
    ),
  ).toEqual(["prompted_more_than_twice 6"]);
  const described = doc.report.findings.find(
    (f) => f.invariant === "starting_too_long",
  )!.description;
  expect(
    missingFacts(
      right.map((l, i) => (i === 2 ? `starting_too_long: ${described}` : l)),
      doc,
    ),
  ).toEqual(["starting_too_long 2"]);
  expect(missingFacts(["dry_run_mismatch fired.", "1 of them.", ...right.slice(2)], doc)).toEqual([
    "dry_run_mismatch 1",
  ]);
});

test("a quiet day names no invariant and says nothing fired", () => {
  const doc = byName("quiet-day");
  expect(missingFacts(["No invariant fired overnight.", "", "", "", ""], doc)).toEqual([]);
  expect(missingFacts(["A calm night.", "", "", "", ""], doc)).toEqual([
    "a quiet day doesn't say nothing fired",
  ]);
  expect(missingFacts(["Nothing fired; extended_at_car was quiet.", "", "", "", ""], doc)).toEqual([
    "a quiet day names extended_at_car",
  ]);
});

for (const doc of EVAL_DOCS) {
  test(`template on ${doc.name}: ${doc.note}`, () => {
    const lines = templateSummary(doc.report);
    expect(lines).toHaveLength(5);
    expect(missingFacts(lines, doc)).toEqual([]);
    if (doc.quiet) expect(lines[0]).toContain("no invariant fired");
  });
}
