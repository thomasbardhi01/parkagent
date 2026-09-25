/**
 * POST /webhooks/stripe — Stripe Issuing events, signature-verified with
 * STRIPE_WEBHOOK_SECRET. No x-api-key: the signature is the auth.
 *
 * issuing_authorization.request is the real-time path: Stripe holds the
 * card swipe open (~2s budget) while we decide, then we answer *in the HTTP
 * response* — 200 with a `Stripe-Version` header and `{approved, metadata}`
 * (the older approve/decline API calls are deprecated). The authorization
 * and a decisions row are written before we reply, so the audit persists
 * even if the response is slow. issuing_authorization.created/updated and
 * issuing_transaction.created keep the issuing_authorizations ledger in sync.
 *
 * The ParkAgent card spends only against a hold: after every other check
 * passes, the approval must claim room on a live session hold (see
 * services/wallet/holds.ts); the claim is stored on the ledger row
 * (hold_id, session_id) so a replay answers from the row and never claims
 * twice. payment_intent events for session holds reconcile a hold Stripe
 * itself settled (the 7-day auto-cancel), idempotently.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type Stripe from "stripe";

import type { AppDeps } from "../app.js";
import { nycStartOfDay } from "../services/hours.js";
import { applyHoldClaim, centsToUsd, decideAuthorization } from "../services/issuing.js";
import { noPendingSessions } from "../services/pendingSession.js";
import { claimHoldForAuthorization, releaseHoldClaim } from "../services/wallet/holds.js";

function cardId(auth: Stripe.Issuing.Authorization): string {
  return typeof auth.card === "string" ? auth.card : auth.card.id;
}

export function registerStripeWebhook(app: FastifyInstance, deps: AppDeps): void {
  // Own plugin scope so the raw-body parser (needed for signature
  // verification) applies only to this route, not the JSON routes.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );

    scope.post("/webhooks/stripe", async (req, reply) => {
      if (!deps.stripe) {
        return reply.code(503).send({ error: "stripe_not_configured" });
      }
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") {
        return reply.code(400).send({ error: "missing_signature" });
      }
      let event: Stripe.Event;
      try {
        event = deps.stripe.verifyEvent(req.body as Buffer, signature);
      } catch {
        return reply.code(400).send({ error: "invalid_signature" });
      }

      switch (event.type) {
        case "issuing_authorization.request":
          return handleAuthorizationRequest(deps, event, reply);
        case "issuing_authorization.created":
        case "issuing_authorization.updated":
          await upsertAuthorization(deps, event.data.object);
          return { received: true };
        case "issuing_transaction.created":
          await recordTransaction(deps, event.data.object);
          return { received: true };
        case "payment_intent.succeeded":
          if (event.data.object.metadata?.["parkagent"] === "session_hold") {
            await reconcileHold(deps, event.data.object, "captured");
          } else {
            await handleTopupSucceeded(deps, event.data.object);
          }
          return { received: true };
        case "payment_intent.canceled":
          if (event.data.object.metadata?.["parkagent"] === "session_hold") {
            await reconcileHold(deps, event.data.object, "released");
          }
          return { received: true };
        default:
          return { received: true };
      }
    });
  });
}

async function handleAuthorizationRequest(
  deps: AppDeps,
  event: Stripe.IssuingAuthorizationRequestEvent,
  reply: FastifyReply,
) {
  const auth = event.data.object;
  const at = deps.now?.() ?? new Date();
  const policy = deps.policy.get();
  const stripeCardId = cardId(auth);
  // On .request the hold being asked for is pending_request.amount;
  // auth.amount is still 0.
  const amountUsd = centsToUsd(auth.pending_request?.amount ?? auth.amount);
  const merchantCategory = auth.merchant_data?.category ?? null;
  const merchantCategoryCode = auth.merchant_data?.category_code ?? null;

  const card = await deps.db.issuingCard.findUnique({
    where: { stripeCardId },
    include: { cardholder: true },
  });
  const userId = card?.cardholder.userId ?? null;

  const spentTodayUsd = userId
    ? (
        await deps.db.issuingAuthorization.findMany({
          where: { userId, approved: true, createdAt: { gte: nycStartOfDay(at) } },
          select: { amountUsd: true },
        })
      ).reduce((sum, row) => sum + Number(row.amountUsd ?? 0), 0)
    : 0;
  const hasPendingSession = userId
    ? await (deps.hasPendingSession ?? noPendingSessions)(userId, at)
    : false;

  // Stripe redelivers events, and a lifecycle .created can arrive before a
  // slow .request retry. A row that already carries one of OUR decisions is
  // answered idempotently — deciding twice could flip the answer (spend
  // moved between deliveries) and the create below would crash on the
  // unique stripeAuthorizationId. A row first seen via .created (decision
  // "external") gets a real decision now, updated in place.
  const existing = await deps.db.issuingAuthorization.findUnique({
    where: { stripeAuthorizationId: auth.id },
  });
  if (
    existing?.decision !== undefined &&
    existing.decision !== "external" &&
    existing.approved !== undefined
  ) {
    await deps.db.decision.create({
      data: {
        kind: "issuing_authorization",
        inputs: { stripeAuthorizationId: auth.id, stripeCardId, amountUsd, replayed: true },
        rule: existing.decision,
        outcome: { approved: existing.approved, replayed: true },
        userId,
      },
    });
    return reply
      .code(200)
      .header("Stripe-Version", event.api_version ?? deps.stripe!.apiVersion)
      .header("Content-Type", "application/json")
      .send({ approved: existing.approved, metadata: { reason: existing.decision } });
  }

  let decision = decideAuthorization(
    {
      amountUsd,
      merchantCategory,
      merchantCategoryCode,
      knownCard: card !== null,
      hasPendingSession,
      spentTodayUsd,
      effectiveDryRun: deps.policy.effectiveDryRun(),
    },
    policy,
  );
  // Last gate, and the only write: the ParkAgent card pays only against a
  // live hold on the user's own card with room for this amount.
  let claimedHold: { id: string; sessionId: string } | null = null;
  let holdCheck: string = "not_checked";
  if (decision.approve && userId) {
    const claim = await claimHoldForAuthorization(deps.db, userId, amountUsd, at);
    holdCheck = claim.claimed ? "claimed" : claim.reason;
    if (claim.claimed) claimedHold = { id: claim.hold.id, sessionId: claim.hold.sessionId };
    decision = applyHoldClaim(decision, claim);
  }

  // Persist the audit BEFORE answering, so the decision survives even a slow
  // or dropped response (Stripe's Autopilot may then approve/decline on our
  // behalf, but request_history.reason records that — see the docs).
  const row = {
    stripeAuthorizationId: auth.id,
    stripeCardId,
    userId,
    amountUsd,
    merchantCategory,
    merchantCategoryCode,
    merchantName: auth.merchant_data?.name ?? null,
    approved: decision.approve,
    decision: decision.reason,
    status: "pending",
    sessionId: claimedHold?.sessionId ?? null,
    holdId: claimedHold?.id ?? null,
  };
  if (existing) {
    await deps.db.issuingAuthorization.update({
      where: { stripeAuthorizationId: auth.id },
      data: {
        approved: decision.approve,
        decision: decision.reason,
        status: "pending",
        amountUsd,
        sessionId: row.sessionId,
        holdId: row.holdId,
      },
    });
  } else {
    try {
      await deps.db.issuingAuthorization.create({ data: row });
    } catch (err) {
      // A duplicate delivery racing this one won the insert. Its decision
      // stands; the room this one claimed on the hold must go back, or the
      // hold would later capture the charge twice.
      if (claimedHold) await releaseHoldClaim(deps.db, claimedHold.id, amountUsd);
      throw err;
    }
  }
  await deps.db.decision.create({
    data: {
      kind: "issuing_authorization",
      inputs: {
        stripeAuthorizationId: auth.id,
        stripeCardId,
        amountUsd,
        merchantCategory,
        merchantCategoryCode,
        merchantName: auth.merchant_data?.name ?? null,
        knownCard: card !== null,
        hasPendingSession,
        spentTodayUsd,
        holdCheck,
        dryRun: deps.policy.effectiveDryRun(),
        policyHash: deps.policy.hash(),
      },
      rule: decision.reason,
      outcome: {
        approved: decision.approve,
        wouldApprove: decision.wouldApprove,
        ...(claimedHold && decision.approve ? { holdId: claimedHold.id } : {}),
      },
      userId,
      ...(claimedHold && decision.approve ? { sessionId: claimedHold.sessionId } : {}),
    },
  });

  // Answer the real-time request directly (200 + Stripe-Version header +
  // {approved, metadata}); the version must be one Stripe supports, so we
  // echo the event's own api_version.
  return reply
    .code(200)
    .header("Stripe-Version", event.api_version ?? deps.stripe!.apiVersion)
    .header("Content-Type", "application/json")
    .send({ approved: decision.approve, metadata: { reason: decision.reason } });
}

/** .created/.updated: sync lifecycle onto the ledger row; create it if the
 * request event never reached us (e.g. an authorization made while the
 * webhook was down, or a `stripe trigger` fixture card). */
async function upsertAuthorization(deps: AppDeps, auth: Stripe.Issuing.Authorization) {
  const existing = await deps.db.issuingAuthorization.findUnique({
    where: { stripeAuthorizationId: auth.id },
  });
  if (existing) {
    // A reversal of an approval that holds room on a still-open hold gives
    // the room back, so the leg captures only what was really charged.
    // Guarded on the stored status, so a replayed .updated never releases
    // twice.
    if (
      auth.status === "reversed" &&
      existing.status !== "reversed" &&
      existing.approved === true &&
      existing.holdId
    ) {
      const releasedUsd = Number(existing.amountUsd ?? 0);
      const applied = await releaseHoldClaim(deps.db, existing.holdId, releasedUsd);
      const hold = await deps.db.sessionHold.findUnique({ where: { id: existing.holdId } });
      await deps.db.decision.create({
        data: {
          kind: "wallet_hold",
          inputs: { stripeAuthorizationId: auth.id, holdId: existing.holdId },
          rule: "authorization_reversed",
          // Not applied = the hold already captured this charge: the user
          // paid for a charge the provider took back, and needs a refund
          // (surfaced here for the operator; there is no automatic refund).
          outcome: {
            releasedUsd,
            applied,
            holdStatus: hold?.status ?? null,
            ...(!applied && hold?.status === "captured" ? { needsRefund: true } : {}),
          },
          userId: hold?.userId ?? null,
          ...(hold ? { sessionId: hold.sessionId } : {}),
        },
      });
    }
    await deps.db.issuingAuthorization.update({
      where: { stripeAuthorizationId: auth.id },
      data: {
        approved: auth.approved,
        status: auth.status,
        amountUsd: centsToUsd(auth.amount),
      },
    });
    return;
  }
  const card = await deps.db.issuingCard.findUnique({
    where: { stripeCardId: cardId(auth) },
    include: { cardholder: true },
  });
  await deps.db.issuingAuthorization.create({
    data: {
      stripeAuthorizationId: auth.id,
      stripeCardId: cardId(auth),
      userId: card?.cardholder.userId ?? null,
      amountUsd: centsToUsd(auth.amount),
      merchantCategory: auth.merchant_data?.category ?? null,
      merchantCategoryCode: auth.merchant_data?.category_code ?? null,
      merchantName: auth.merchant_data?.name ?? null,
      approved: auth.approved,
      decision: "external",
      status: auth.status,
    },
  });
}

/**
 * payment_intent.succeeded for an Apple Pay top-up (POST
 * /card/funding/topup-intent): the user's money settled into our Stripe
 * balance — move it onto the financial account backing the cards and audit
 * it. Intents not tagged parkagent=card_topup are someone else's business.
 * Idempotent against Stripe redelivery: an intent already in
 * processed_topups is acknowledged without moving anything again; a FAILED
 * move records no row, so the redelivery retries it.
 */
async function handleTopupSucceeded(deps: AppDeps, intent: Stripe.PaymentIntent): Promise<void> {
  if (intent.metadata?.["parkagent"] !== "card_topup") return;
  const userId = intent.metadata["userId"] ?? null;
  const amountUsd = centsToUsd(intent.amount_received ?? intent.amount);

  const processed = await deps.db.processedTopup.findUnique({
    where: { paymentIntentId: intent.id },
  });
  if (processed) {
    await deps.db.decision.create({
      data: {
        kind: "card_topup_funded",
        inputs: { paymentIntentId: intent.id, amountUsd, replayed: true },
        rule: "replayed",
        outcome: { ok: true, skipped: true },
        userId,
      },
    });
    return;
  }

  let moved = false;
  let error: string | null = null;
  try {
    await deps.stripe!.moveToFinancialAccount(amountUsd);
    moved = true;
  } catch (err) {
    error = String(err);
  }
  if (moved) {
    try {
      await deps.db.processedTopup.create({
        data: { paymentIntentId: intent.id, amountUsd, userId },
      });
    } catch (err) {
      // A concurrent delivery won the insert — the move above still ran,
      // so this is the one residual double-move window; surface it in
      // the audit rather than crashing the webhook.
      if ((err as { code?: string }).code !== "P2002") throw err;
      error = "duplicate_processed_row";
    }
  }
  await deps.db.decision.create({
    data: {
      kind: "card_topup_funded",
      inputs: { paymentIntentId: intent.id, amountUsd },
      rule: moved ? "funded" : "funding_move_failed",
      outcome: moved ? { ok: true, ...(error ? { note: error } : {}) } : { ok: false, error },
      userId,
    },
  });
}

/**
 * payment_intent.succeeded / .canceled for a session hold. Our own settle
 * (services/wallet/holds.ts) already moved the hold out of `held` before
 * these land, so for those this is a replay and changes nothing. What it
 * catches is Stripe settling a hold on its own — an uncaptured intent is
 * auto-canceled after 7 days — which must not leave a phantom `held` row
 * the webhook could approve charges against. Compare-and-set on `held`:
 * a redelivery finds nothing to change.
 */
async function reconcileHold(
  deps: AppDeps,
  intent: Stripe.PaymentIntent,
  status: "captured" | "released",
): Promise<void> {
  const hold = await deps.db.sessionHold.findUnique({ where: { paymentIntentId: intent.id } });
  if (!hold) return;
  const capturedUsd = status === "captured" ? centsToUsd(intent.amount_received ?? 0) : 0;
  const changed = await deps.db.sessionHold.updateMany({
    where: { id: hold.id, status: "held" },
    data: { status, capturedUsd, settledAt: deps.now?.() ?? new Date() },
  });
  await deps.db.decision.create({
    data: {
      kind: "wallet_hold",
      inputs: { holdId: hold.id, paymentIntentId: intent.id, stripeStatus: intent.status },
      rule: changed.count === 1 ? `reconciled_${status}` : "replayed",
      outcome: { changed: changed.count === 1, capturedUsd },
      userId: hold.userId,
      sessionId: hold.sessionId,
    },
  });
}

/** issuing_transaction.created: the settled leg — attach the capture to its
 * authorization row. Stripe transaction amounts are negative for spend. */
async function recordTransaction(deps: AppDeps, txn: Stripe.Issuing.Transaction) {
  const authId = typeof txn.authorization === "string" ? txn.authorization : txn.authorization?.id;
  if (!authId) return;
  const existing = await deps.db.issuingAuthorization.findUnique({
    where: { stripeAuthorizationId: authId },
  });
  if (!existing) return;
  await deps.db.issuingAuthorization.update({
    where: { stripeAuthorizationId: authId },
    data: {
      stripeTransactionId: txn.id,
      capturedUsd: centsToUsd(Math.abs(txn.amount)),
      status: "closed",
    },
  });
}
