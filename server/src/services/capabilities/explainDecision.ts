/**
 * explainDecision: one recorded decision, read by its owner (or an admin),
 * as the deterministic reason the ledger row supports (services/reasons.ts)
 * and, when EXPLAIN_MODEL is on, that reason phrased by the cheap model.
 * Every surface reads through here: the app's "Why?", the assistant's
 * explain_decision, REST and MCP. The model only phrases: it is given the
 * structured reason and nothing else, answers in a strict JSON schema, and
 * any amount it writes that isn't one of the reason's own is dropped
 * (scrubUngroundedAmounts). A refusal, a cut-off, an unreadable answer, a
 * model error or a spent daily budget all fall back to the template. Never
 * on the money path: it reads one row and writes only its own spend.
 */

import type { ModelClient, ModelUsage } from "../assistant/modelClient.js";
import { assistantSpendTodayUsd, estimateCostUsd } from "../assistant/spend.js";
import { scrubUngroundedAmounts } from "../assistant/replyText.js";
import { explainDecision as templateFor } from "../explanations.js";
import type { Principal } from "../principal.js";
import type { Reason } from "../reasons.js";
import { reasonOf } from "../reasons.js";
import type { CapabilityDeps } from "./turn.js";

export interface ExplainDeps extends Pick<CapabilityDeps, "db" | "now"> {
  /** The EXPLAIN_MODEL transport; absent → the template only. */
  explainModel?: ModelClient | undefined;
  /** ASSISTANT_DAILY_SPEND_CAP_USD: phrasing stops (the template stands)
   * once the person's assistant spend today reaches it. */
  assistantDailySpendCapUsd?: number | undefined;
}

export type ExplainOutcome =
  | {
      ok: true;
      decisionId: string;
      rule: string;
      kind: string;
      reason: Reason;
      /** The deterministic sentence: the floor. */
      template: string;
      /** What to show: the phrasing when it passed, else the template. */
      text: string;
      phrased: boolean;
    }
  | { ok: false; reason: "not_found" };

/** The phrasing call: a three-sentence answer, with room for Haiku's
 * thinking (on by default) ahead of it. */
export const EXPLAIN_MAX_TOKENS = 1024;

export const EXPLAIN_SYSTEM = [
  "You explain one parking decision to the driver it was about.",
  "You are given the decision's structured reason as JSON: what happened, the facts behind it (each a label and a value), and what the driver can do.",
  "Answer in at most three short, plain sentences, in the second person.",
  "Use only the facts given. Every number you write must be one of the given values, written exactly as given. Never estimate, round, add or combine numbers.",
  "If `youCan` is given, end with it in your own words; otherwise suggest nothing.",
  "No preamble, no apology, no mention of rules, rows or JSON.",
].join("\n");

/** The strict output schema (output_config.format). */
export const EXPLAIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string", description: "At most three sentences." } },
} as const;

export async function explainDecision(
  deps: ExplainDeps,
  principal: Principal,
  input: { decisionId: string },
  /** Inside an assistant turn, the turn's own accounting row counts the
   * call; elsewhere this writes an assistant_turn row of its own, so the
   * daily spend cap sees it either way. */
  onModelUsage?: (usage: ModelUsage) => void,
): Promise<ExplainOutcome> {
  const row = await deps.db.decision.findUnique({ where: { id: input.decisionId } });
  // The owner's, or an admin's: another user's row reads as not there, and
  // so does a row with no user (an Issuing decision for an unknown card),
  // whoever holds its id.
  const theirs = row !== null && row.userId === principal.userId;
  if (!row || !(theirs || principal.actor === "admin")) return { ok: false, reason: "not_found" };
  const reason = reasonOf(row);
  const template = templateFor(row);
  const base = {
    ok: true as const,
    decisionId: row.id,
    rule: row.rule,
    kind: row.kind,
    reason,
    template,
  };
  const phrased = await phrase(deps, principal, reason, onModelUsage);
  return phrased === null
    ? { ...base, text: template, phrased: false }
    : { ...base, text: phrased, phrased: true };
}

/** What the capability runs with on a REST surface (the app's and the
 * agent's "why"): the model only when EXPLAIN_MODEL is on, the person's
 * assistant budget, and no turn to bill. */
export function explainDepsFor(deps: {
  db: ExplainDeps["db"];
  now?: (() => Date) | undefined;
  assistantTools?: { explainModel: ModelClient | undefined } | undefined;
  assistantDailySpendCapUsd?: number | undefined;
}): ExplainDeps {
  return {
    db: deps.db,
    now: deps.now,
    explainModel: deps.assistantTools?.explainModel,
    assistantDailySpendCapUsd: deps.assistantDailySpendCapUsd,
  };
}

/** The "why" answer every REST surface sends: the reason as data, and the
 * sentence to show. */
export function whyBody(out: Extract<ExplainOutcome, { ok: true }>) {
  return {
    decisionId: out.decisionId,
    kind: out.kind,
    rule: out.rule,
    reason: {
      subject: out.reason.subject,
      what: out.reason.what,
      because: out.reason.because,
      youCan: out.reason.youCan,
    },
    text: out.text,
    phrased: out.phrased,
  };
}

/** The model's phrasing of a reason, or null for the template. */
async function phrase(
  deps: ExplainDeps,
  principal: Principal,
  reason: Reason,
  onModelUsage: ((usage: ModelUsage) => void) | undefined,
): Promise<string | null> {
  if (!deps.explainModel || !reason.known) return null;
  const now = deps.now?.() ?? new Date();
  if (deps.assistantDailySpendCapUsd !== undefined) {
    const spent = await assistantSpendTodayUsd(deps.db, principal.userId, now);
    if (spent >= deps.assistantDailySpendCapUsd) return null;
  }
  const facts = {
    subject: reason.subject,
    what: reason.what,
    because: reason.because.map(({ label, value }) => ({ label, value })),
    youCan: reason.youCan,
  };
  const sent = JSON.stringify(facts);
  let answer: string | null;
  try {
    const response = await deps.explainModel.create({
      system: EXPLAIN_SYSTEM,
      messages: [{ role: "user", content: sent }],
      maxTokens: EXPLAIN_MAX_TOKENS,
      outputSchema: EXPLAIN_SCHEMA,
      // Three sentences of rewording: thinking counts against max_tokens,
      // and low keeps it from crowding the answer out.
      effort: "low",
    });
    const usage: ModelUsage = {
      model: response.model ?? "unknown",
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
    if (onModelUsage) onModelUsage(usage);
    else await recordSpend(deps, principal, usage);
    // Only a finished answer replaces the template: a refusal or a
    // cut-off keeps the floor.
    if (response.stopReason !== "end_turn") return null;
    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = JSON.parse(text) as { answer?: unknown };
    answer = typeof parsed.answer === "string" ? parsed.answer.trim() : null;
  } catch {
    // An explanation never fails: the template stands.
    return null;
  }
  if (!answer) return null;
  // Numbers only from the evidence: a sentence with any other amount goes.
  const grounded = new Set(
    reason.because
      .map((e) => /^\$(\d+)\.(\d{2})$/.exec(e.value))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]) * 100 + Number(m[2])),
  );
  const scrubbed = scrubUngroundedAmounts(answer, grounded).text.trim();
  if (scrubbed.length === 0) return null;
  // …and every number at all (a distance, a stay, a zone, a time) must
  // be one the model was sent: any other digit run is the template.
  const sentRuns = new Set(sent.match(/\d+/g) ?? []);
  const invented = (scrubbed.match(/\d+/g) ?? []).some((run) => !sentRuns.has(run));
  return invented ? null : scrubbed;
}

/** A phrasing outside an assistant turn is still assistant spend. */
async function recordSpend(deps: ExplainDeps, principal: Principal, usage: ModelUsage) {
  await deps.db.decision.create({
    data: {
      kind: "assistant_turn",
      inputs: { purpose: "explain_decision" },
      rule: "explain_phrased",
      outcome: {
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens),
      },
      userId: principal.userId,
    },
  });
}
