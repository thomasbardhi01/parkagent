/**
 * Plain-language rendering of a decisions row — the assistant's
 * explain_decision tool and (later) any "why did it do that?" UI read
 * through here. Pure: takes the row, returns sentences; never invents
 * facts not on the row.
 */

export interface DecisionRowForExplain {
  id: string;
  kind: string;
  rule: string;
  inputs: unknown;
  outcome: unknown;
  createdAt: Date;
}

const RULE_TEXT: Record<string, string> = {
  auto_pay_ok: "everything checked out, so it was safe to pay automatically",
  unknown_zone: "no metered zone was close enough to the reported location",
  candidates_disagree:
    "the two sides of the street charge differently, so the driver had to pick a side",
  free_period: "the meter wasn't charging for that window, so there was nothing to pay",
  rate_above_ceiling: "the meter rate is above the auto-pay ceiling, so it asked first",
  session_cap_exceeded: "the total would exceed the per-session spending cap",
  daily_cap_exceeded: "today's spending plus this total would exceed the daily cap",
  needs_zone_number: "the block's pay-by-app number isn't known yet, so it asked for it",
  max_stay_exceeded: "the requested time is longer than the zone's legal maximum stay",
  provider_not_linked: "no parking-provider account is linked for that city",
  executor_failed: "the payment automation hit an error at the provider",
  start_ok: "the session was started and paid",
  extend_ok: "the session was extended",
  stop_ok: "the session was stopped",
  extend: "ticket risk clearly outweighed the cost of more meter time",
  extend_failed: "it tried to extend but the provider automation failed",
  warn_max_stay: "the legal max stay is nearly used up, so it warned instead of extending",
  hold_return_likely: "you looked likely to be back before the meter ran out",
  hold_not_near_expiry: "the session wasn't close enough to expiry to act",
  hold_session_cap: "extending would exceed the per-session cap",
  hold_daily_cap: "extending would exceed the daily cap",
  hold_max_extensions: "the auto-extend count limit was already used up",
  hold_auto_extend_disabled: "auto-extend is switched off in policy",
  hysteresis_hold: "a fresh decision was still settling, so it held for stability",
  expired: "the meter ran out before anything could extend it",
  approved: "the card charge matched a pending session and fit the budget",
  declined_unknown_card: "the charge came from a card this system doesn't manage",
  declined_wrong_mcc: "the merchant wasn't a parking merchant",
  declined_no_pending_session: "no parking session was awaiting payment",
  declined_over_daily_cap: "the charge would exceed the daily cap",
  declined_dry_run: "dry-run mode was on, so no money could move",
  replayed: "a duplicate delivery was answered from the recorded decision",
};

const KIND_TEXT: Record<string, string> = {
  parked_quote: "Quoted a detected park",
  session_start: "Session start",
  session_extend: "Session extension",
  session_stop: "Session stop",
  extend_tick: "Auto-extend check",
  issuing_authorization: "Card authorization",
  zone_number_report: "Zone number report",
  assistant_tool: "Assistant tool call",
  assistant_plan: "Assistant plan proposal",
  assistant_confirm: "Plan confirmation",
};

export function explainDecision(row: DecisionRowForExplain): string {
  const what = KIND_TEXT[row.kind] ?? `Decision (${row.kind})`;
  const why = RULE_TEXT[row.rule] ?? `rule "${row.rule}" fired`;
  const outcome = row.outcome as { action?: string; allowed?: boolean; ok?: boolean; code?: string };
  const parts = [`${what} at ${row.createdAt.toISOString()}: ${why}.`];
  if (outcome?.action) parts.push(`Resulting action: ${outcome.action}.`);
  if (outcome?.allowed === false) parts.push("The request was refused.");
  if (outcome?.ok === false && outcome.code) {
    parts.push(`The provider step failed with code "${outcome.code}".`);
  }
  parts.push(`Decision id ${row.id} has the full inputs on record.`);
  return parts.join(" ");
}
