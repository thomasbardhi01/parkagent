/**
 * Five lines that say what the nightly audit found (L). The template is
 * deterministic and always there. With AUDIT_SUMMARY on, a Haiku call
 * rewrites the findings (never the raw rows) into five lines of its own,
 * kept only when they are grounded: every number in them is one the
 * findings carry, no dollar amount appears (scrubUngroundedAmounts), and
 * every invariant that fired is named. The template is what the report
 * says whenever the model is off, over its daily budget, refuses, fails,
 * or writes something ungrounded. Report-only: nothing here is on the
 * money path, and nothing it says changes anything.
 */

import type { AppDb } from "../../db.js";
import type { ModelClient } from "../assistant/loop.js";
import { estimateCostUsd, scrubUngroundedAmounts } from "../assistant/loop.js";
import { nycStartOfDay } from "../hours.js";
import type { Finding } from "./invariants.js";

/** The model the summary is asked of (index.ts builds its client). */
export const AUDIT_MODEL = "claude-haiku-5-5";
/** Room for five short lines and the model's own (adaptive) thinking. */
export const AUDIT_MAX_TOKENS = 4_000;
/** A summary that hasn't come back by now is the template's. */
export const AUDIT_DEADLINE_MS = 30_000;
export const SUMMARY_LINES = 5;

export interface AuditReport {
  window: { from: string; to: string };
  findings: Finding[];
}

export interface AuditSummary {
  lines: string[];
  source: "model" | "template";
  /** Why the template: off, over_budget, refused, failed, ungrounded. */
  reason?: string;
}

/** What the model must answer with. Strict-mode JSON schema: no length
 * bounds, so the five lines are checked here. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: { lines: { type: "array", items: { type: "string" } } },
  required: ["lines"],
  additionalProperties: false,
};

const SYSTEM = [
  "You summarize a parking app's nightly audit for its two founders, who read it in the morning.",
  "The input is JSON: the audit window and one finding per invariant (its name, severity, what it checks, how many parks or sessions broke it).",
  'Answer with JSON {"lines": [...]}: exactly five short lines of plain English.',
  "Name every invariant whose count is above zero, exactly as written in the input, with its count, most severe first.",
  "Every number you write must appear in the input. Write no dollar amounts, no ids, and nothing the input doesn't say.",
  "When nothing fired, say so plainly.",
].join(" ");

const fired = (findings: Finding[]) =>
  findings
    .filter((f) => f.count > 0)
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.count - a.count);
const rank = (s: Finding["severity"]) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
const tally = (findings: Finding[], severity: Finding["severity"]) =>
  fired(findings).filter((f) => f.severity === severity).length;

/** The five lines the report says without a model, from the findings. */
export function templateSummary(report: AuditReport): string[] {
  const hits = fired(report.findings);
  const day = `${report.window.from.slice(0, 16)}Z to ${report.window.to.slice(0, 16)}Z`;
  const lines = [
    hits.length === 0
      ? `Nightly audit ${day}: no invariant fired (${report.findings.length} checked).`
      : `Nightly audit ${day}: ${hits.length} of ${report.findings.length} invariants fired ` +
        `(${tally(report.findings, "high")} high, ${tally(report.findings, "medium")} medium, ` +
        `${tally(report.findings, "low")} low).`,
  ];
  const line = (f: Finding) =>
    `${f.severity}: ${f.invariant} ×${f.count}: ${f.description}` +
    (f.examples.length > 0 ? ` (e.g. ${f.examples.slice(0, 2).join(", ")})` : "");
  for (const f of hits.slice(0, 3)) lines.push(line(f));
  const rest = hits.slice(3);
  if (rest.length > 0) {
    lines.push(`Also: ${rest.map((f) => `${f.invariant} ×${f.count}`).join(", ")}.`);
  }
  const quiet = report.findings.filter((f) => f.count === 0).map((f) => f.invariant);
  while (lines.length < SUMMARY_LINES) {
    lines.push(
      lines.length === SUMMARY_LINES - 1 && quiet.length > 0
        ? `Quiet: ${quiet.join(", ")}.`
        : "Nothing else to report.",
    );
  }
  return lines.slice(0, SUMMARY_LINES);
}

/** Every number the report itself says: what a summary's numbers must be. */
export function reportNumbers(report: AuditReport): Set<string> {
  const said = JSON.stringify({
    window: report.window,
    // The example ids are cuids: their digits are no number of the report's.
    findings: report.findings.map((f) => ({
      invariant: f.invariant,
      severity: f.severity,
      description: f.description,
      count: f.count,
    })),
    tallies: {
      fired: fired(report.findings).length,
      checked: report.findings.length,
      high: tally(report.findings, "high"),
      medium: tally(report.findings, "medium"),
      low: tally(report.findings, "low"),
    },
  });
  return new Set(said.match(/\d+(?:\.\d+)?/g) ?? []);
}

/** Why `lines` can't stand for the report, or null when they can. */
export function ungrounded(lines: unknown, report: AuditReport): string | null {
  if (!Array.isArray(lines) || lines.length !== SUMMARY_LINES) return "not five lines";
  if (!lines.every((l) => typeof l === "string" && l.trim().length > 0)) return "an empty line";
  const text = (lines as string[]).join("\n");
  if (scrubUngroundedAmounts(text, new Set()).dropped.length > 0) return "a dollar amount";
  const allowed = reportNumbers(report);
  const stray = (text.match(/\d+(?:\.\d+)?/g) ?? []).find((n) => !allowed.has(n));
  if (stray !== undefined) return `the number ${stray}`;
  const missing = fired(report.findings).find((f) => !text.includes(f.invariant));
  if (missing) return `no mention of ${missing.invariant}`;
  return null;
}

/** The audit's own model spend today (its decisions rows): held to the
 * assistant's daily cap. */
async function spentTodayUsd(db: AppDb, at: Date): Promise<number> {
  const rows = await db.decision.findMany({
    where: { createdAt: { gte: nycStartOfDay(at) }, kind: "audit_summary" },
  });
  return rows
    .filter((r) => r.kind === "audit_summary")
    .reduce(
      (sum, r) => sum + Number((r.outcome as { estimatedCostUsd?: number }).estimatedCostUsd ?? 0),
      0,
    );
}

/**
 * The report's five lines: the model's when AUDIT_SUMMARY gave it a
 * client, it's within budget, and what it wrote is grounded; the
 * template's otherwise. Writes one decisions row saying which and why.
 */
export async function summarize(
  deps: { db: AppDb; model?: ModelClient | undefined; capUsd: number; now: Date },
  report: AuditReport,
): Promise<AuditSummary> {
  const template = templateSummary(report);
  let summary: AuditSummary = { lines: template, source: "template", reason: "off" };
  let usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  } | null = null;
  if (deps.model) {
    const spent = await spentTodayUsd(deps.db, deps.now);
    if (spent >= deps.capUsd) {
      summary = { lines: template, source: "template", reason: "over_budget" };
    } else {
      try {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("deadline")), AUDIT_DEADLINE_MS);
        });
        const reply = await Promise.race([
          deps.model.create({
            system: SYSTEM,
            messages: [{ role: "user", content: JSON.stringify(report) }],
            maxTokens: AUDIT_MAX_TOKENS,
            outputSchema: SUMMARY_SCHEMA,
          }),
          deadline,
        ]).finally(() => clearTimeout(timer));
        if (reply.usage) {
          const model = reply.model ?? AUDIT_MODEL;
          usage = {
            model,
            inputTokens: reply.usage.inputTokens,
            outputTokens: reply.usage.outputTokens,
            estimatedCostUsd: estimateCostUsd(
              model,
              reply.usage.inputTokens,
              reply.usage.outputTokens,
            ),
          };
        }
        if (reply.stopReason === "refusal") {
          summary = { lines: template, source: "template", reason: "refused" };
        } else {
          const text = reply.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          const lines = (JSON.parse(text) as { lines?: unknown }).lines;
          const why = ungrounded(lines, report);
          summary =
            why === null
              ? { lines: (lines as string[]).map((l) => l.trim()), source: "model" }
              : { lines: template, source: "template", reason: `ungrounded: ${why}` };
        }
      } catch (err) {
        summary = {
          lines: template,
          source: "template",
          reason: `failed: ${String(err).split("\n")[0]}`,
        };
      }
    }
  }
  await deps.db.decision.create({
    data: {
      kind: "audit_summary",
      inputs: {
        window: report.window,
        fired: fired(report.findings).map((f) => ({ invariant: f.invariant, count: f.count })),
        capUsd: deps.capUsd,
      },
      rule:
        summary.source === "model"
          ? "model"
          : `template_${(summary.reason ?? "off").split(":")[0]}`,
      outcome: {
        source: summary.source,
        reason: summary.reason ?? null,
        ...(usage ?? { estimatedCostUsd: 0 }),
      },
      userId: null,
    },
  });
  return summary;
}
