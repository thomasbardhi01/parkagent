/**
 * The approve/decline rule for real-time Issuing authorizations
 * (issuing_authorization.request). Pure: the webhook route gathers the
 * facts, this decides. Every decision is written to `decisions` by the
 * route (non-negotiable).
 *
 * The card's own spending controls (MCC allowlist, per-authorization and
 * daily limits — see scripts/issuing-setup.ts) are the first line of
 * defense inside Stripe; this rule is the second, and the only one that
 * knows about pending sessions and the dry-run switches.
 */

import type { Policy } from "./policy.js";

/** MCC 7523 — the only category the card is allowed to spend in. */
export const PARKING_CATEGORY = "parking_lots_garages";
export const PARKING_CATEGORY_CODE = "7523";

export type IssuingDecisionReason =
  | "approved"
  | "declined_unknown_card"
  | "declined_wrong_mcc"
  | "declined_no_pending_session"
  | "declined_over_daily_cap"
  | "declined_dry_run"
  // The ParkAgent card pays only against a hold on the user's own card
  // (services/wallet/holds.ts): none live, or not enough room left on it.
  | "declined_no_hold"
  | "declined_over_hold";

export interface IssuingDecision {
  approve: boolean;
  reason: IssuingDecisionReason;
  /** True when only the dry-run switches stood between this and an approval. */
  wouldApprove: boolean;
}

export interface AuthorizationFacts {
  /** Requested hold, USD. */
  amountUsd: number;
  /** Stripe merchant_data.category, e.g. "parking_lots_garages". */
  merchantCategory: string | null;
  /** Stripe merchant_data.category_code, e.g. "7523". */
  merchantCategoryCode: string | null;
  /** The authorization's card matched a row in issuing_cards. */
  knownCard: boolean;
  /** From the PendingSessionCheck interface (stubbed until sessions merge). */
  hasPendingSession: boolean;
  /** Approved card spend so far this NYC day, USD. */
  spentTodayUsd: number;
  /** PolicyService.effectiveDryRun(): env DRY_RUN || policy.dry_run. */
  effectiveDryRun: boolean;
}

export function decideAuthorization(facts: AuthorizationFacts, policy: Policy): IssuingDecision {
  const decline = (reason: IssuingDecisionReason, wouldApprove = false): IssuingDecision => ({
    approve: false,
    reason,
    wouldApprove,
  });
  if (!facts.knownCard) return decline("declined_unknown_card");
  const isParking =
    facts.merchantCategory === PARKING_CATEGORY ||
    facts.merchantCategoryCode === PARKING_CATEGORY_CODE;
  if (!isParking) return decline("declined_wrong_mcc");
  if (!facts.hasPendingSession) return decline("declined_no_pending_session");
  if (facts.spentTodayUsd + facts.amountUsd > policy.daily_cap_usd) {
    return decline("declined_over_daily_cap");
  }
  // Approving moves money; both dry-run switches must be off (non-negotiable).
  // (No holds exist in dry run, so wouldApprove means "would approve if a
  // hold covers it".)
  if (facts.effectiveDryRun) return decline("declined_dry_run", true);
  return { approve: true, reason: "approved", wouldApprove: true };
}

/**
 * The last gate, applied by the webhook only once every rule above says
 * approve: the hold claim (claimHoldForAuthorization) is a write, so it
 * runs after the pure checks and its answer can only turn an approval
 * into a decline, never the reverse.
 */
export function applyHoldClaim(
  decision: IssuingDecision,
  claim: { claimed: true } | { claimed: false; reason: "no_hold" | "over_hold" },
): IssuingDecision {
  if (!decision.approve || claim.claimed) return decision;
  return {
    approve: false,
    reason: claim.reason === "no_hold" ? "declined_no_hold" : "declined_over_hold",
    wouldApprove: false,
  };
}

/** Stripe rejects Issuing cardholder names longer than this. */
export const STRIPE_CARDHOLDER_NAME_MAX = 24;

/** Stands in when a user's name is empty or truncates away to nothing. */
export const FALLBACK_CARDHOLDER_NAME = "ParkAgent Cardholder";

/**
 * A users.name made safe for the Stripe Issuing cardholder `name` field:
 * whitespace collapsed, truncated to STRIPE_CARDHOLDER_NAME_MAX. Truncation
 * prefers the last word boundary inside the limit and never leaves a
 * dangling separator; a name that reduces to nothing gets the fallback.
 */
export function cardholderName(name: string): string {
  const collapsed = name.trim().replace(/\s+/g, " ");
  let out = collapsed;
  if (out.length > STRIPE_CARDHOLDER_NAME_MAX) {
    out = out.slice(0, STRIPE_CARDHOLDER_NAME_MAX);
    const lastSpace = out.lastIndexOf(" ");
    if (lastSpace > 0) out = out.slice(0, lastSpace);
    out = out.replace(/[\s\-_.,]+$/, "");
  }
  return out.length > 0 ? out : FALLBACK_CARDHOLDER_NAME;
}

/** Stripe amounts are integer cents; the rest of the repo is USD decimals. */
export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

export function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}
