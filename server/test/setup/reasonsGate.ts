/**
 * The third net of reasonsCoverage.test.ts: a decision written during a
 * test with a rule services/reasons.ts has no entry for fails that test
 * file, so a rule only reachable at run time can't ship without a reason.
 */

import { afterAll } from "vitest";

import { unexplainedRules } from "./unexplainedRules.js";

afterAll(() => {
  if (unexplainedRules.size > 0) {
    throw new Error(
      `decisions were written with rules that have no reason in services/reasons.ts: ${[
        ...unexplainedRules,
      ].join(", ")}`,
    );
  }
});
