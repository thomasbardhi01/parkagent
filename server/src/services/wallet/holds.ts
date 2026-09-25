/**
 * ParkAgent card funding, one paid leg at a time. The user's own card never
 * carries a balance with us: before the executor pays for a parkagent_card
 * session (its start, or any extension), a HOLD is placed on the user's
 * saved card for the quote plus a buffer; the provider then charges our
 * virtual Issuing card, and the Issuing webhook approves that charge only
 * against a live hold with room left (see claimHoldForAuthorization); once
 * the leg is over the hold captures exactly what the ParkAgent card paid
 * and releases the rest.
 *
 * Money rules, in the order this file enforces them:
 *  - effective dry run is checked FIRST: under dry run no PaymentIntent is
 *    ever created — the decision records what would have been held;
 *  - the session/daily caps are checked by the callers BEFORE a hold is
 *    asked for (a hold never authorizes spend the policy refused);
 *  - one hold per (session, leg): the row is unique and the PaymentIntent
 *    carries a per-leg idempotency key, so a retry can't hold twice;
 *  - settling claims the hold (held → settling) before touching Stripe, so
 *    two settlers (the leg's own and the sweep) can't both capture;
 *  - every step writes a decisions row (kind "wallet_hold").
 */

import type { AppDb, SessionHoldRow } from "../../db.js";
import type { StripeGateway } from "../stripeGateway.js";

/** The buffer over the quote: 20%, but never less than $2 — ParkBoston
 * sells in per-zone increments and a receipt can land a little over the
 * estimate; the hold must cover what the provider actually charges. */
export const HOLD_BUFFER_MIN_USD = 2;
export const HOLD_BUFFER_SHARE = 0.2;

/** How recent a hold must be for the Issuing webhook to match a charge to
 * it: the executor pays within seconds of the hold; anything older is a
 * finished leg the sweep will settle. */
export const HOLD_MATCH_WINDOW_MS = 15 * 60_000;

/** A leg whose provider charge hasn't shown up as an Issuing authorization
 * by the time the executor returns is left held; the sweep settles holds
 * older than this (capturing whatever was authorized, else releasing). */
export const HOLD_SETTLE_GRACE_MS = 15 * 60_000;

const round2 = (usd: number) => Math.round(usd * 100) / 100;

export function holdAmountFor(quoteUsd: number): number {
  return round2(quoteUsd + Math.max(HOLD_BUFFER_MIN_USD, quoteUsd * HOLD_BUFFER_SHARE));
}

export interface HoldDeps {
  db: AppDb;
  policy: { effectiveDryRun(): boolean; hash(): string };
  stripe?: StripeGateway | undefined;
  now?: (() => Date) | undefined;
}

export type PlaceHoldResult =
  /** A real hold is on the card. */
  | { ok: true; simulated: false; hold: SessionHoldRow; heldUsd: number }
  /** Dry run: nothing was placed; the decision says what would have been. */
  | { ok: true; simulated: true; hold: null; heldUsd: number }
  /** The card refused — pay nothing; tell the user to update it. */
  | { ok: false; reason: "declined"; declineCode: string; hold: SessionHoldRow | null }
  /** No saved card / no Stripe / Stripe error: pay nothing either. */
  | {
      ok: false;
      reason: "no_funding_method" | "stripe_not_configured" | "stripe_failed";
      message: string;
    };

async function decide(
  deps: HoldDeps,
  userId: string,
  sessionId: string,
  rule: string,
  inputs: Record<string, unknown>,
  outcome: Record<string, unknown>,
): Promise<void> {
  await deps.db.decision.create({
    data: {
      kind: "wallet_hold",
      inputs: { ...inputs, dryRun: deps.policy.effectiveDryRun(), policyHash: deps.policy.hash() },
      rule,
      outcome,
      userId,
      sessionId,
    },
  });
}

/** The user's default saved card and Customer, or null when either is missing. */
export async function defaultFundingMethod(
  db: AppDb,
  userId: string,
): Promise<{
  customerId: string;
  method: { id: string; stripePaymentMethodId: string; brand: string; last4: string };
} | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) return null;
  const methods = await db.fundingMethod.findMany({ where: { userId, removedAt: null } });
  const method = methods.find((m) => m.isDefault) ?? null;
  if (!method) return null;
  return { customerId: user.stripeCustomerId, method };
}

/**
 * Hold quote + buffer on the user's default card for one leg. Callers have
 * already passed the session/daily caps; this refuses nothing on policy
 * grounds except dry run, which it checks first.
 */
export async function placeHold(
  deps: HoldDeps,
  args: { userId: string; sessionId: string; leg: string; quoteUsd: number },
): Promise<PlaceHoldResult> {
  const quoteUsd = round2(args.quoteUsd);
  const heldUsd = holdAmountFor(quoteUsd);
  const inputs = { leg: args.leg, quoteUsd, heldUsd };

  // Non-negotiable: nothing is authorized on anyone's card in dry run.
  if (deps.policy.effectiveDryRun()) {
    await decide(deps, args.userId, args.sessionId, "dry_run", inputs, {
      placed: false,
      wouldHold: heldUsd,
    });
    return { ok: true, simulated: true, hold: null, heldUsd };
  }

  // A retried leg reuses its hold instead of stacking a second one.
  const legHolds = await deps.db.sessionHold.findMany({
    where: { sessionId: { in: [args.sessionId] } },
  });
  const existing = legHolds.find((h) => h.leg === args.leg);
  if (existing?.status === "held") {
    return { ok: true, simulated: false, hold: existing, heldUsd: Number(existing.amountUsd) };
  }

  const funding = await defaultFundingMethod(deps.db, args.userId);
  if (!funding) {
    await decide(deps, args.userId, args.sessionId, "no_funding_method", inputs, {
      placed: false,
    });
    return { ok: false, reason: "no_funding_method", message: "no saved card to hold against" };
  }
  if (!deps.stripe) {
    await decide(deps, args.userId, args.sessionId, "stripe_not_configured", inputs, {
      placed: false,
    });
    return { ok: false, reason: "stripe_not_configured", message: "Stripe is not configured" };
  }

  let attempt;
  try {
    attempt = await deps.stripe.createHold({
      customerId: funding.customerId,
      paymentMethodId: funding.method.stripePaymentMethodId,
      amountUsd: heldUsd,
      metadata: {
        parkagent: "session_hold",
        userId: args.userId,
        sessionId: args.sessionId,
        leg: args.leg,
      },
      idempotencyKey: `hold:${args.sessionId}:${args.leg}`,
    });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
    await decide(deps, args.userId, args.sessionId, "stripe_failed", inputs, {
      placed: false,
      error: message,
    });
    return { ok: false, reason: "stripe_failed", message };
  }

  const create = (
    status: string,
    extra: { paymentIntentId: string | null; declineCode?: string },
  ) =>
    deps.db.sessionHold.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId,
        leg: args.leg,
        paymentIntentId: extra.paymentIntentId,
        fundingMethodId: funding.method.id,
        quoteUsd,
        amountUsd: heldUsd,
        status,
        declineCode: extra.declineCode ?? null,
      },
    });

  if (!attempt.ok) {
    let hold: SessionHoldRow | null = null;
    try {
      hold = await create("declined", {
        paymentIntentId: attempt.paymentIntentId,
        declineCode: attempt.declineCode,
      });
    } catch (err) {
      // A retried leg whose earlier attempt already recorded the decline.
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
    await decide(deps, args.userId, args.sessionId, "hold_declined", inputs, {
      placed: false,
      declineCode: attempt.declineCode,
      paymentIntentId: attempt.paymentIntentId,
      fundingMethod: `${funding.method.brand} ${funding.method.last4}`,
    });
    return { ok: false, reason: "declined", declineCode: attempt.declineCode, hold };
  }

  let hold: SessionHoldRow;
  try {
    hold = await create("held", { paymentIntentId: attempt.paymentIntentId });
  } catch (err) {
    // Two racing attempts at the same leg: Stripe's idempotency key handed
    // both the same PaymentIntent; the unique (session, leg) row kept one.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const again = await deps.db.sessionHold.findUnique({
      where: { paymentIntentId: attempt.paymentIntentId },
    });
    if (!again) throw err;
    hold = again;
  }
  await decide(deps, args.userId, args.sessionId, "hold_placed", inputs, {
    placed: true,
    holdId: hold.id,
    paymentIntentId: attempt.paymentIntentId,
    fundingMethod: `${funding.method.brand} ${funding.method.last4}`,
  });
  return { ok: true, simulated: false, hold, heldUsd };
}

export type SettleReason =
  /** The executor paid: capture what the ParkAgent card was charged. */
  | "leg_paid"
  /** The executor failed: capture only what was authorized anyway (the
   * provider may have charged before the flow derailed), release the rest. */
  | "leg_failed"
  /** The provider said parking is free: release immediately. */
  | "free_period"
  /** The sweep: a leg's grace period is over. */
  | "sweep";

export interface SettleResult {
  holdId: string;
  status: "captured" | "released" | "deferred" | "already_settled" | "settle_failed";
  capturedUsd: number;
  heldUsd: number;
}

/**
 * Capture what the ParkAgent card actually paid against this hold (the
 * approved Issuing authorizations the webhook attached), release the rest.
 * A paid leg with nothing authorized yet is DEFERRED to the sweep rather
 * than released: releasing would decline a provider charge still on its
 * way. Idempotent: a hold that isn't `held` is reported, never re-settled.
 */
export async function settleHold(
  deps: HoldDeps,
  holdId: string,
  reason: SettleReason,
): Promise<SettleResult> {
  const now = deps.now?.() ?? new Date();
  const hold = await deps.db.sessionHold.findUnique({ where: { id: holdId } });
  if (!hold) throw new Error(`settleHold: no hold ${holdId}`);
  const heldUsd = Number(hold.amountUsd);
  const authorizedUsd = round2(Number(hold.authorizedUsd ?? 0));
  const inputs = { holdId, leg: hold.leg, reason, heldUsd, authorizedUsd };

  if (hold.status !== "held") {
    return {
      holdId,
      status: "already_settled",
      capturedUsd: Number(hold.capturedUsd ?? 0),
      heldUsd,
    };
  }
  if (reason === "leg_paid" && authorizedUsd === 0) {
    await decide(deps, hold.userId, hold.sessionId, "capture_deferred", inputs, {
      note: "no ParkAgent card authorization recorded yet; the sweep settles it",
    });
    return { holdId, status: "deferred", capturedUsd: 0, heldUsd };
  }

  // Claim it: held → settling. From here the webhook can attach no more
  // authorizations (it only claims room on `held` holds), and a second
  // settler finds nothing to claim.
  const claimed = await deps.db.sessionHold.updateMany({
    where: { id: holdId, status: "held" },
    data: { status: "settling", settledAt: now },
  });
  if (claimed.count === 0) {
    return { holdId, status: "already_settled", capturedUsd: 0, heldUsd };
  }
  // Re-read: an authorization may have landed between the read and the claim.
  const fresh = (await deps.db.sessionHold.findUnique({ where: { id: holdId } })) ?? hold;
  const captureUsd = round2(Math.min(Number(fresh.authorizedUsd ?? 0), heldUsd));

  if (!deps.stripe || !hold.paymentIntentId) {
    await deps.db.sessionHold.update({ where: { id: holdId }, data: { status: "held" } });
    await decide(deps, hold.userId, hold.sessionId, "settle_failed", inputs, {
      error: "stripe_not_configured",
    });
    return { holdId, status: "settle_failed", capturedUsd: 0, heldUsd };
  }

  try {
    if (captureUsd > 0) {
      await deps.stripe.captureHold(hold.paymentIntentId, captureUsd, `capture:${holdId}`);
      await deps.db.sessionHold.update({
        where: { id: holdId },
        data: { status: "captured", capturedUsd: captureUsd, settledAt: now },
      });
      await decide(deps, hold.userId, hold.sessionId, "hold_captured", inputs, {
        capturedUsd: captureUsd,
        releasedUsd: round2(heldUsd - captureUsd),
        paymentIntentId: hold.paymentIntentId,
      });
      return { holdId, status: "captured", capturedUsd: captureUsd, heldUsd };
    }
    await deps.stripe.cancelHold(hold.paymentIntentId, `release:${holdId}`);
    await deps.db.sessionHold.update({
      where: { id: holdId },
      data: { status: "released", capturedUsd: 0, settledAt: now },
    });
    await decide(deps, hold.userId, hold.sessionId, "hold_released", inputs, {
      releasedUsd: heldUsd,
      paymentIntentId: hold.paymentIntentId,
    });
    return { holdId, status: "released", capturedUsd: 0, heldUsd };
  } catch (err) {
    // Put it back so the sweep retries; Stripe's idempotency keys make the
    // retry of a capture that did land a no-op.
    await deps.db.sessionHold.update({ where: { id: holdId }, data: { status: "held" } });
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
    await decide(deps, hold.userId, hold.sessionId, "settle_failed", inputs, { error: message });
    return { holdId, status: "settle_failed", capturedUsd: 0, heldUsd };
  }
}

/**
 * The Issuing webhook's side: find a live hold of this user with room for
 * `amountUsd` and claim that room (authorized_usd += amount), atomically.
 * Newest hold first — one open session per user means at most one leg is in
 * flight. Returns the claimed hold, or why none fit.
 */
export async function claimHoldForAuthorization(
  db: AppDb,
  userId: string,
  amountUsd: number,
  at: Date,
): Promise<
  { claimed: true; hold: SessionHoldRow } | { claimed: false; reason: "no_hold" | "over_hold" }
> {
  const amount = round2(amountUsd);
  const live = (await db.sessionHold.findMany({ where: { userId, status: "held" } }))
    .filter((h) => at.getTime() - h.createdAt.getTime() <= HOLD_MATCH_WINDOW_MS)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (live.length === 0) return { claimed: false, reason: "no_hold" };
  for (const hold of live) {
    // Compare-and-set: authorized may grow only while the total stays
    // within the hold — two concurrent charges can't both squeeze in.
    const limit = round2(Number(hold.amountUsd) - amount);
    if (limit < 0) continue;
    const result = await db.sessionHold.updateMany({
      where: { id: hold.id, status: "held", authorizedUsd: { lte: limit } },
      data: { authorizedUsd: { increment: amount } },
    });
    if (result.count === 1) return { claimed: true, hold };
  }
  return { claimed: false, reason: "over_hold" };
}

/** Give back room claimed on a hold that no recorded approval stands
 * behind (a racing duplicate delivery lost the insert, or the provider
 * reversed the authorization while the leg was still open). */
export async function releaseHoldClaim(
  db: AppDb,
  holdId: string,
  amountUsd: number,
): Promise<boolean> {
  const result = await db.sessionHold.updateMany({
    where: { id: holdId, status: "held" },
    data: { authorizedUsd: { decrement: round2(amountUsd) } },
  });
  return result.count === 1;
}

/**
 * The sweep (jobs/walletTick.ts): settle every hold still `held` past its
 * grace period — a paid leg whose authorization arrived late gets captured,
 * a leg nobody charged gets released. Never throws per hold.
 */
export async function sweepHolds(deps: HoldDeps): Promise<SettleResult[]> {
  const now = deps.now?.() ?? new Date();
  const stale = await deps.db.sessionHold.findMany({
    where: { status: "held", createdAt: { lt: new Date(now.getTime() - HOLD_SETTLE_GRACE_MS) } },
  });
  const results: SettleResult[] = [];
  for (const hold of stale) {
    results.push(await settleHold(deps, hold.id, "sweep"));
  }
  return results;
}
