/**
 * explainDecision: one recorded decision, read by its owner (or an admin),
 * as the deterministic sentence the ledger row itself supports
 * (services/explanations.ts). This is the factual floor every surface
 * shows — the app, the assistant, REST and MCP; the model phrasing on top
 * of it is the assistant adapter's (tools.ts) today and Issue M's
 * capability later, and never changes a fact in it.
 */

import { explainDecision as templateFor } from "../explanations.js";
import type { Principal } from "../principal.js";
import type { CapabilityDeps } from "./turn.js";

export type ExplainOutcome =
  | { ok: true; decisionId: string; rule: string; kind: string; template: string }
  | { ok: false; reason: "not_found" };

export async function explainDecision(
  deps: Pick<CapabilityDeps, "db">,
  principal: Principal,
  input: { decisionId: string },
): Promise<ExplainOutcome> {
  const row = await deps.db.decision.findUnique({ where: { id: input.decisionId } });
  // A row with no user (an Issuing decision for an unknown card) reads for
  // anyone who has its id; another user's row reads as not there.
  const theirs = row !== null && (row.userId === null || row.userId === principal.userId);
  if (!row || !(theirs || principal.actor === "admin")) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    decisionId: row.id,
    rule: row.rule,
    kind: row.kind,
    template: templateFor(row),
  };
}
