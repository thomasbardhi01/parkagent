/**
 * The "why" eval against the model (Issue M): each golden decision
 * (src/eval/explainGolden.ts) explained through the real capability with
 * EXPLAIN_MODEL on, and its phrasing held to the same facts CI holds the
 * template to. Spends real money (30 short calls on the cheap model), so it
 * runs only by hand: the manual `explain-eval` workflow, or
 *
 *   ANTHROPIC_API_KEY=… [EXPLAIN_MODEL=claude-haiku-5-5] pnpm -C server explain:eval
 *
 * Exits 1 if any phrased answer misses a fact. An answer that fell back to
 * the template (refusal, cut-off, scrubbed) is counted, and passes on the
 * template's facts.
 */

import type { AppDb } from "../db.js";
import { GOLDEN, missingFacts } from "../eval/explainGolden.js";
import { makeAnthropicModelClient } from "../services/assistant/anthropicClient.js";
import { DEFAULT_EXPLAIN_MODEL } from "../services/assistant/modelClient.js";
import { explainDecision } from "../services/capabilities/explainDecision.js";
import { userPrincipal } from "../services/principal.js";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(2);
}
const modelId = process.env["EXPLAIN_MODEL"] || DEFAULT_EXPLAIN_MODEL;
const explainModel = makeAnthropicModelClient(apiKey, modelId);
const at = new Date("2026-01-05T19:00:00Z");

/** Just enough of the DB for one decision at a time: the row by id, no
 * spend so far, and the spend rows the calls write, kept for the total. */
function dbFor(row: (typeof GOLDEN)[number]["row"], spend: number[]): AppDb {
  return {
    decision: {
      findUnique: async () => ({ id: "d1", userId: "u1", createdAt: at, ...row }),
      findMany: async () => [],
      create: async ({ data }: { data: { outcome?: { estimatedCostUsd?: number } } }) => {
        spend.push(data.outcome?.estimatedCostUsd ?? 0);
        return { id: "d2" };
      },
    },
  } as unknown as AppDb;
}

const spend: number[] = [];
let failed = 0;
let phrased = 0;
for (const golden of GOLDEN) {
  const out = await explainDecision(
    { db: dbFor(golden.row, spend), explainModel, now: () => at },
    userPrincipal({ id: "u1", isAdmin: false }),
    { decisionId: "d1" },
  );
  if (!out.ok) throw new Error(`${golden.id}: not found`);
  if (out.phrased) phrased += 1;
  const missing = missingFacts(out.text, golden.facts);
  if (missing.length > 0) failed += 1;
  console.log(
    `${missing.length === 0 ? "pass" : "FAIL"} ${golden.id}${out.phrased ? "" : " (template)"}: ${out.text}` +
      (missing.length > 0 ? `\n     missing: ${JSON.stringify(missing)}` : ""),
  );
}
const cost = spend.reduce((a, b) => a + b, 0);
console.log(
  `\n${GOLDEN.length - failed}/${GOLDEN.length} pass on ${modelId}; ${phrased} phrased, ` +
    `${GOLDEN.length - phrased} fell back to the template; estimated $${cost.toFixed(4)}`,
);
process.exit(failed > 0 ? 1 : 0);
