/**
 * `pnpm -C server audit:eval-live`: the live summary model against the
 * golden eval set. For each document it asks the model as the audit does
 * (summarize(), over a fake DB) and passes the document only when the
 * model's own lines came back, grounded, with every fact. Needs
 * ANTHROPIC_API_KEY; run by the manual `audit-eval` workflow. It spends a
 * few cents and changes nothing.
 */

import { makeAnthropicModelClient } from "../../src/services/assistant/anthropicClient.js";
import { AUDIT_MODEL, summarize } from "../../src/services/audit/summary.js";
import { makeFakeDb } from "../helpers.js";
import { EVAL_DOCS, missingFacts } from "./evals.js";

const key = process.env["ANTHROPIC_API_KEY"];
if (!key) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(2);
}
const model = makeAnthropicModelClient(key, process.env["AUDIT_EVAL_MODEL"] ?? AUDIT_MODEL);

let failed = 0;
for (const doc of EVAL_DOCS) {
  const { db } = makeFakeDb();
  const summary = await summarize({ db, model, capUsd: 1, now: new Date() }, doc.report);
  const missing = summary.source === "model" ? missingFacts(summary.lines, doc) : doc.facts;
  const ok = summary.source === "model" && missing.length === 0;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "pass" : "FAIL"}  ${doc.name}  (${summary.source}${summary.reason ? `: ${summary.reason}` : ""})`,
  );
  for (const line of summary.lines) console.log(`        ${line}`);
  if (missing.length > 0) console.log(`        missing: ${missing.join(", ")}`);
}
console.log(`${EVAL_DOCS.length - failed}/${EVAL_DOCS.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
