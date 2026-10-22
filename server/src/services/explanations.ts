/**
 * Plain-language rendering of a decisions row: the template every "why?"
 * surface shows (the app, the assistant's explain_decision, REST, MCP)
 * and the floor a model's phrasing falls back to. The words live in
 * services/reasons.ts, one entry per rule; this adds when, and where the
 * full record is. Pure: never a fact the row doesn't carry.
 */

import { reasonOf, reasonText } from "./reasons.js";

export interface DecisionRowForExplain {
  id: string;
  kind: string;
  rule: string;
  inputs: unknown;
  outcome: unknown;
  createdAt: Date;
}

export function explainDecision(row: DecisionRowForExplain): string {
  const at = row.createdAt.toISOString().slice(0, 16).replace("T", " ");
  return `${reasonText(reasonOf(row))} (${at} UTC; decision ${row.id} has the full record.)`;
}
