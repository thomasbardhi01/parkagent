/**
 * The Wallet: one place that answers "how am I paying, and what have I
 * spent", for three ways to pay (one active at a time):
 *
 *   provider_card   the card saved on the user's ParkNYC/ParkBoston account
 *                   (the default; nothing to set up)
 *   link_wallet     their Stripe Link wallet — assistant plans and garages,
 *                   each paid stop approved in Link; street meters stay on
 *                   the card on the provider account
 *   parkagent_card  our virtual card on every linked parking account,
 *                   funded per session by a hold on the user's own card
 *
 * GET  /wallet                            summary (services/wallet/summary.ts)
 * GET  /wallet/activity                   the unified, paginated ledger
 * PUT  /wallet/source                     switch, validating readiness
 * POST /wallet/setup-intent               save a card (Apple Pay / PaymentSheet)
 * POST /wallet/funding-methods            record the card a SetupIntent saved
 * PUT  /wallet/funding-methods/:id/default
 * DELETE /wallet/funding-methods/:id
 *
 * Nothing here moves money: saving a card charges nothing, and a source
 * switch only changes what the NEXT payment uses (the holds themselves are
 * in services/wallet/holds.ts, behind the dry-run and cap checks). Every
 * write still writes a decisions row.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { FundingMethodRow } from "../db.js";
import { providerById, providerStatusUsable } from "../providers/registry.js";
import { LinkJobStore, runSetupCard } from "../services/providerLink.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import { activityPage } from "../services/wallet/activity.js";
import { ensureParkAgentCard } from "../services/wallet/parkagentCard.js";
import { normalizeSource, walletSummary } from "../services/wallet/summary.js";

/** Apple Pay merchant for the funding sheet (see API.md "Apple Pay setup"). */
export const APPLE_PAY_MERCHANT_ID = "merchant.com.thomasbardhi.parkagent";

const sourceSchema = z.object({
  source: z.enum(["provider_card", "link_wallet", "parkagent_card"]),
  /** A Debug build choosing the ParkAgent card before ISSUING_LIVE; only
   * honored while Stripe runs on a test-mode key. */
  sandbox: z.boolean().optional(),
  /** Choosing the ParkAgent card puts it on every linked parking account,
   * replacing the card saved there — the user must agree first. */
  consentReplacePaymentMethod: z.boolean().optional(),
});

const activitySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.iso.datetime({ offset: true }).optional(),
});

const fundingMethodSchema = z.object({
  setupIntentId: z.string().min(1).max(200),
  makeDefault: z.boolean().optional(),
});

export function registerWallet(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();
  const limitReads = makeRateLimiter({ max: 60, windowMs: 60_000 });
  const limitWrites = makeRateLimiter({ max: 20, windowMs: 60_000 });
  const jobs = new LinkJobStore(deps.db);

  const decide = (userId: string, kind: string, rule: string, inputs: unknown, outcome: unknown) =>
    deps.db.decision.create({ data: { kind, inputs, rule, outcome, userId } });

  /** Replies 503 when Stripe isn't configured; null means already replied. */
  function requireStripe(reply: FastifyReply) {
    if (!deps.stripe) {
      void reply.code(503).send({ error: "stripe_not_configured" });
      return null;
    }
    return deps.stripe;
  }

  /** The ParkAgent card may be chosen (and funded): live, or a sandbox
   * request against a test-mode key. */
  const parkagentSelectable = (sandbox: boolean | undefined) =>
    deps.issuingLive === true || (sandbox === true && deps.issuingSandbox === true);

  app.get("/wallet", { preHandler: limitReads }, async (req) => {
    return walletSummary(deps, req.authedUser!.id, now(), { activityLimit: 5 });
  });

  app.get("/wallet/activity", { preHandler: limitReads }, async (req, reply) => {
    const parsed = activitySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    return activityPage(deps.db, req.authedUser!.id, parsed.data);
  });

  app.put("/wallet/source", { preHandler: limitWrites }, async (req, reply) => {
    const parsed = sourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const wanted = parsed.data.source;
    const inputs = {
      source: wanted,
      sandbox: parsed.data.sandbox === true,
      issuingLive: deps.issuingLive === true,
      dryRun: deps.policy.effectiveDryRun(),
    };
    const refuse = async (code: number, error: string, extra: Record<string, unknown> = {}) => {
      const decision = await decide(user.id, "payment_source", error, inputs, {
        allowed: false,
        ...extra,
      });
      return reply.code(code).send({ error, decisionId: decision.id, ...extra });
    };

    if (wanted === "link_wallet") {
      if (deps.linkWallet?.configured !== true) return refuse(409, "link_not_configured");
      if (!(await deps.linkWallet.status(user.id)).connected) {
        return refuse(409, "link_not_connected");
      }
    }

    let setupJobs: { provider: string; jobId: string }[] = [];
    if (wanted === "parkagent_card") {
      if (!parkagentSelectable(parsed.data.sandbox)) return refuse(409, "parkagent_card_not_live");
      if (!deps.stripe) return refuse(503, "stripe_not_configured");
      const methods = await deps.db.fundingMethod.findMany({
        where: { userId: user.id, removedAt: null },
      });
      if (!methods.some((m) => m.isDefault)) return refuse(409, "no_funding_method");

      // Every linked account that doesn't carry our card yet gets it now —
      // which replaces the card saved there, so the user agrees first.
      const accounts = await deps.db.providerAccount.findMany({ where: { userId: user.id } });
      const needCard = accounts.filter((a) => providerStatusUsable(a.status) && !a.cardAdded);
      if (needCard.length > 0 && parsed.data.consentReplacePaymentMethod !== true) {
        return refuse(400, "consent_required", {
          providers: needCard.map((a) => a.provider),
        });
      }
      await ensureParkAgentCard({ db: deps.db, policy: deps.policy, stripe: deps.stripe }, user);
      for (const account of needCard) {
        const provider = providerById(account.provider);
        if (!provider) continue;
        const jobId = randomUUID();
        await jobs.create({
          id: jobId,
          userId: user.id,
          provider: provider.id,
          phase: "adding_card",
        });
        setupJobs.push({ provider: provider.id, jobId });
        // Runs behind the response like the link flow's chained setup (the
        // executor takes seconds); dry run records wouldAdd and touches
        // nothing. The app polls /providers/:provider/link-status.
        void runSetupCard(deps, user.id, provider)
          .then((outcome) =>
            outcome.ok
              ? jobs.update(jobId, { phase: "done", dryRun: outcome.dryRun })
              : jobs.update(jobId, {
                  phase: "failed",
                  reason: outcome.code,
                  retrySafe: outcome.retrySafe,
                }),
          )
          .catch((err: unknown) => {
            // Message only: this path holds the card number on its way to
            // the provider's form.
            const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
            req.log.error({ setupCardError: message }, "wallet setup-card crashed");
            void jobs.update(jobId, { phase: "failed", reason: "unknown", retrySafe: true });
          });
      }
    } else {
      setupJobs = [];
    }

    await deps.db.user.update({ where: { id: user.id }, data: { paymentSource: wanted } });
    const decision = await decide(user.id, "payment_source", "set", inputs, {
      allowed: true,
      paymentSource: wanted,
      setupJobs,
    });
    return { activeSource: wanted, setupJobs, decisionId: decision.id };
  });

  app.post("/wallet/setup-intent", { preHandler: limitWrites }, async (req, reply) => {
    const body = (req.body ?? {}) as { sandbox?: unknown };
    const user = req.authedUser!;
    if (!parkagentSelectable(body.sandbox === true)) {
      return reply.code(409).send({ error: "parkagent_card_not_live" });
    }
    const stripe = requireStripe(reply);
    if (!stripe) return;

    const row = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true, email: true, name: true },
    });
    let customerId = row?.stripeCustomerId ?? null;
    if (!customerId) {
      // The per-user idempotency key hands racing calls the same Customer;
      // the conditional write keeps the first one stored.
      const created = await stripe.createCustomer(
        { userId: user.id, name: row?.name ?? user.name, email: row?.email ?? null },
        `customer:${user.id}`,
      );
      const claim = await deps.db.user.updateMany({
        where: { id: user.id, stripeCustomerId: null },
        data: { stripeCustomerId: created.customerId },
      });
      if (claim.count === 1) {
        customerId = created.customerId;
      } else {
        const again = await deps.db.user.findUnique({
          where: { id: user.id },
          select: { stripeCustomerId: true },
        });
        customerId = again?.stripeCustomerId ?? created.customerId;
      }
    }
    const intent = await stripe.createSetupIntent(customerId);
    await decide(
      user.id,
      "wallet_funding",
      "setup_intent_created",
      { customerId, sandbox: body.sandbox === true },
      { setupIntentId: intent.setupIntentId },
    );
    return {
      setupIntentId: intent.setupIntentId,
      clientSecret: intent.clientSecret,
      customerId,
      merchantId: APPLE_PAY_MERCHANT_ID,
    };
  });

  app.post("/wallet/funding-methods", { preHandler: limitWrites }, async (req, reply) => {
    const parsed = fundingMethodSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const stripe = requireStripe(reply);
    if (!stripe) return;
    const row = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true },
    });
    const intent = await stripe.retrieveSetupIntent(parsed.data.setupIntentId).catch(() => null);
    // Someone else's intent reads exactly like a missing one.
    if (!intent || !row?.stripeCustomerId || intent.customerId !== row.stripeCustomerId) {
      return reply.code(404).send({ error: "unknown_setup_intent" });
    }
    if (intent.status !== "succeeded" || !intent.paymentMethodId) {
      return reply.code(409).send({ error: "setup_not_complete", status: intent.status });
    }
    const customerId = row.stripeCustomerId;
    const existing = await deps.db.fundingMethod.findUnique({
      where: { stripePaymentMethodId: intent.paymentMethodId },
    });
    // Someone else's card reads exactly like a missing intent.
    if (existing && existing.userId !== user.id) {
      return reply.code(404).send({ error: "unknown_setup_intent" });
    }
    if (existing && existing.removedAt === null) {
      return { fundingMethod: fundingMethodBody(existing) };
    }
    const pm = await stripe.retrievePaymentMethod(intent.paymentMethodId);
    const active = await deps.db.fundingMethod.findMany({
      where: { userId: user.id, removedAt: null },
    });
    const makeDefault = parsed.data.makeDefault !== false || !active.some((m) => m.isDefault);
    /** The default moves only once the card's row exists, so neither a
     * reactivation nor a racing duplicate can leave the user without one. */
    const setDefault = async (method: FundingMethodRow) => {
      if (!makeDefault || method.isDefault) return method;
      await deps.db.fundingMethod.updateMany({
        where: { userId: user.id },
        data: { isDefault: false },
      });
      const updated = await deps.db.fundingMethod.update({
        where: { id: method.id },
        data: { isDefault: true },
      });
      await stripe.setCustomerDefaultPaymentMethod(customerId, method.stripePaymentMethodId);
      return updated;
    };

    // The same setup posted again after its card was removed — a retry
    // that raced the delete, or a client replaying its last setup. The
    // card keeps its row (stripe_payment_method_id is unique), so it is
    // reactivated rather than inserted — but only while Stripe still has
    // it on this Customer: removing detaches it, and Stripe never lets a
    // detached card pay or be attached again. Otherwise it stays removed,
    // and the app adds the card afresh (a new SetupIntent, a new id).
    if (existing) {
      const inputs = { setupIntentId: intent.setupIntentId, fundingMethodId: existing.id };
      if (pm.customerId !== customerId) {
        const decision = await decide(
          user.id,
          "wallet_funding",
          "funding_method_readd_refused",
          inputs,
          { allowed: false, attachedTo: pm.customerId },
        );
        return reply.code(409).send({ error: "funding_method_removed", decisionId: decision.id });
      }
      const reactivated = await setDefault(
        await deps.db.fundingMethod.update({
          where: { id: existing.id },
          data: { removedAt: null, isDefault: false },
        }),
      );
      await decide(user.id, "wallet_funding", "funding_method_reactivated", inputs, {
        fundingMethodId: reactivated.id,
        isDefault: reactivated.isDefault,
      });
      return { fundingMethod: fundingMethodBody(reactivated) };
    }

    let inserted: FundingMethodRow;
    try {
      inserted = await deps.db.fundingMethod.create({
        data: {
          userId: user.id,
          stripePaymentMethodId: pm.paymentMethodId,
          brand: pm.brand,
          last4: pm.last4,
          expMonth: pm.expMonth,
          expYear: pm.expYear,
          wallet: pm.wallet,
          isDefault: false,
        },
      });
    } catch (err) {
      // A duplicate post of this setup, overlapping the first, inserted it
      // first — the same card, so its row is this answer too.
      if ((err as { code?: string }).code !== "P2002") throw err;
      const winner = await deps.db.fundingMethod.findUnique({
        where: { stripePaymentMethodId: pm.paymentMethodId },
      });
      if (winner?.userId !== user.id || winner.removedAt !== null) throw err;
      return { fundingMethod: fundingMethodBody(await setDefault(winner)) };
    }
    const created = await setDefault(inserted);
    await decide(
      user.id,
      "wallet_funding",
      "funding_method_added",
      { setupIntentId: intent.setupIntentId },
      {
        fundingMethodId: created.id,
        brand: pm.brand,
        last4: pm.last4,
        wallet: pm.wallet,
        isDefault: created.isDefault,
      },
    );
    return { fundingMethod: fundingMethodBody(created) };
  });

  app.put(
    "/wallet/funding-methods/:id/default",
    { preHandler: limitWrites },
    async (req, reply) => {
      const user = req.authedUser!;
      const { id } = req.params as { id: string };
      const method = await deps.db.fundingMethod.findUnique({ where: { id } });
      if (!method || method.userId !== user.id || method.removedAt !== null) {
        return reply.code(404).send({ error: "funding_method_not_found" });
      }
      const stripe = requireStripe(reply);
      if (!stripe) return;
      const row = await deps.db.user.findUnique({
        where: { id: user.id },
        select: { stripeCustomerId: true },
      });
      await deps.db.fundingMethod.updateMany({
        where: { userId: user.id },
        data: { isDefault: false },
      });
      const updated = await deps.db.fundingMethod.update({
        where: { id },
        data: { isDefault: true },
      });
      if (row?.stripeCustomerId) {
        await stripe.setCustomerDefaultPaymentMethod(
          row.stripeCustomerId,
          method.stripePaymentMethodId,
        );
      }
      await decide(
        user.id,
        "wallet_funding",
        "funding_method_default",
        { fundingMethodId: id },
        {
          ok: true,
        },
      );
      return { fundingMethod: fundingMethodBody(updated) };
    },
  );

  app.delete("/wallet/funding-methods/:id", { preHandler: limitWrites }, async (req, reply) => {
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const method = await deps.db.fundingMethod.findUnique({ where: { id } });
    if (!method || method.userId !== user.id || method.removedAt !== null) {
      return reply.code(404).send({ error: "funding_method_not_found" });
    }
    const stripe = requireStripe(reply);
    if (!stripe) return;
    const active = await deps.db.fundingMethod.findMany({
      where: { userId: user.id, removedAt: null },
    });
    const others = active.filter((m) => m.id !== id);
    const userRow = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true, stripeCustomerId: true },
    });
    const inputs = { fundingMethodId: id };
    // The ParkAgent card can't be left with nothing to hold against.
    if (normalizeSource(userRow?.paymentSource) === "parkagent_card" && others.length === 0) {
      const decision = await decide(user.id, "wallet_funding", "funding_method_in_use", inputs, {
        allowed: false,
      });
      return reply.code(409).send({ error: "funding_method_in_use", decisionId: decision.id });
    }
    // A leg in flight still has to be captured against this card.
    const open = await deps.db.sessionHold.findMany({ where: { userId: user.id, status: "held" } });
    if (open.some((h) => h.fundingMethodId === id)) {
      const decision = await decide(user.id, "wallet_funding", "hold_in_progress", inputs, {
        allowed: false,
      });
      return reply.code(409).send({ error: "hold_in_progress", decisionId: decision.id });
    }
    const wasDefault = method.isDefault;
    await stripe.detachPaymentMethod(method.stripePaymentMethodId);
    await deps.db.fundingMethod.update({
      where: { id },
      data: { removedAt: now(), isDefault: false },
    });
    // The newest remaining card becomes the default when the default goes.
    let promoted: string | null = null;
    if (wasDefault && others.length > 0) {
      const next = [...others].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      await deps.db.fundingMethod.update({ where: { id: next.id }, data: { isDefault: true } });
      if (userRow?.stripeCustomerId) {
        await stripe.setCustomerDefaultPaymentMethod(
          userRow.stripeCustomerId,
          next.stripePaymentMethodId,
        );
      }
      promoted = next.id;
    }
    await decide(user.id, "wallet_funding", "funding_method_removed", inputs, {
      ok: true,
      promotedDefault: promoted,
    });
    return { ok: true, promotedDefault: promoted };
  });
}

function fundingMethodBody(m: {
  id: string;
  brand: string;
  last4: string;
  wallet: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}) {
  return {
    id: m.id,
    brand: m.brand,
    last4: m.last4,
    wallet: m.wallet,
    expMonth: m.expMonth,
    expYear: m.expYear,
    isDefault: m.isDefault,
  };
}
