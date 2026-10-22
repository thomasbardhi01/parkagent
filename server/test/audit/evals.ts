/**
 * The audit summary's golden eval set: ten findings documents, each with
 * the facts its five lines must say (every invariant that fired, and its
 * count). evals.test.ts holds the template to them in CI; eval-live.ts
 * holds the live model to them (the manual `audit-eval` workflow).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditReport } from "../../src/services/audit/summary.js";

export interface EvalDoc {
  name: string;
  note: string;
  report: AuditReport;
  /** Strings the summary must contain. */
  facts: string[];
}

const dir = fileURLToPath(new URL("./evals", import.meta.url));

export const EVAL_DOCS: EvalDoc[] = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as EvalDoc);

/** The facts a summary leaves out. */
export function missingFacts(lines: string[], doc: EvalDoc): string[] {
  const text = lines.join("\n");
  return doc.facts.filter((fact) => !text.includes(fact));
}
