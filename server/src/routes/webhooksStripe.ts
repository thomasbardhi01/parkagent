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
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type Stripe from "stripe";

import type { AppDeps } from "../app.js";
import { nycStartOfDay } from "../services/hours.js";
import { centsToUsd, decideAuthorization } from "../services/issuing.js";
import { noPendingSessions } from "../services/pendingSession.js";

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

  const decision = decideAuthorization(
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

  // Persist the audit BEFORE answering, so the decision survives even a slow
  // or dropped response (Stripe's Autopilot may then approve/decline on our
  // behalf, but request_history.reason records that — see the docs).
  await deps.db.issuingAuthorization.create({
    data: {
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
    },
  });
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
        dryRun: deps.policy.effectiveDryRun(),
        policyHash: deps.policy.hash(),
      },
      rule: decision.reason,
      outcome: { approved: decision.approve, wouldApprove: decision.wouldApprove },
      userId,
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
