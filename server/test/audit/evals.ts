/**
 * The audit summary's golden eval set: ten findings documents, each with
 * the facts its five lines must say. Each fact is an invariant that fired
 * with its count, said together on one line. A quiet day's lines must say
 * nothing fired and name no invariant. evals.test.ts holds the template
 * to them in CI; eval-live.ts holds the live model to them (the manual
 * `audit-eval` workflow).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditReport } from "../../src/services/audit/summary.js";

export interface EvalDoc {
  name: string;
  note: string;
  report: AuditReport;
  /** Each invariant that fired, with its count. */
  facts: { invariant: string; count: number }[];
  /** Nothing fired: no invariant may be named, and the lines say so. */
  quiet?: boolean;
}

const dir = fileURLToPath(new URL("./evals", import.meta.url));

export const EVAL_DOCS: EvalDoc[] = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as EvalDoc);

/** A quiet day, said: "no invariant fired", "nothing fired", "no findings". */
const SAYS_QUIET =
  /\b(no invariants?|nothing|none)\b[^.\n]*\bfired\b|\bno findings\b|\ball quiet\b/i;

/** What a summary fails to say, as readable strings (empty: it says it all). */
export function missingFacts(lines: string[], doc: EvalDoc): string[] {
  const names = doc.report.findings.map((f) => f.invariant);
  const missing: string[] = [];
  for (const fact of doc.facts) {
    const description = doc.report.findings.find(
      (f) => f.invariant === fact.invariant,
    )?.description;
    const said = lines.some((line) => {
      if (!line.includes(fact.invariant)) return false;
      // The count, said beside the name: not a digit of the name itself
      // ("…_30min") or of its description ("3-minute").
      let rest = line.split(fact.invariant).join(" ");
      if (description) rest = rest.split(description).join(" ");
      // The whole number: not part of 17, 1.5 or 71 (a full stop after
      // it is the end of a sentence).
      return new RegExp(`(?<![\\d.])${fact.count}(?!\\d|\\.\\d)`).test(rest);
    });
    if (!said) missing.push(`${fact.invariant} ${fact.count}`);
  }
  if (doc.quiet) {
    const text = lines.join("\n");
    const named = names.filter((name) => text.includes(name));
    if (named.length > 0) missing.push(`a quiet day names ${named.join(", ")}`);
    if (!SAYS_QUIET.test(text)) missing.push("a quiet day doesn't say nothing fired");
  }
  return missing;
}
