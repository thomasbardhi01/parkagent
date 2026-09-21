/**
 * The Card tab's server surface: the virtual card summary, its ledger,
 * test-mode funding moves, client-side PAN reveal, and freeze/unfreeze.
 * Shapes are pinned by API.md and the iOS client (CardResponse & co in
 * ios/.../APIModels.swift).
 *
 * The PAN never transits this server (non-negotiable): /card/reveal hands
 * the app a short-lived Stripe ephemeral key and the app reads the card
 * details from Stripe directly.
 *
 * Funding moves money, so both moves are policy-gated (a single transfer is
 * capped at daily_cap_usd), refuse under effective dry run, and write a
 * decisions row either way. A financial account that isn't ready surfaces
 * as 503 funding_unavailable, not a 500.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { nycStartOfDay, nycStartOfMonth } from "../services/hours.js";
import { FundingUnavailableError } from "../services/stripeGateway.js";

const transactionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Opaque to clients; today it is the createdAt of the previous page's
  // last row, echoed back as `nextCursor`.
  cursor: z.iso.datetime({ offset: true }).optional(),
});

const fundingSchema = z.object({
  amountUsd: z.number().positive().max(10_000),
});

const revealSchema = z.object({
  nonce: z.string().min(1).optional(),
  api_version: z.string().min(1).optional(),
});

/** How long after a session starts its card charge is expected to land —
 * the same window services/pendingSession.ts approves against, reused here
 * to attach ledger rows to the session that caused them. */
const SESSION_LINK_WINDOW_MS = 10 * 60_000;

export function registerCard(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();

  /** The caller's card row, or null after replying 404. */
  async function requireCard(userId: string, reply: FastifyReply) {
    const holder = await deps.db.issuingCardholder.findUnique({
      where: { userId },
      include: { cards: true },
    });
    const card = holder?.cards[0];
    if (!holder || !card) {
      await reply.code(404).send({ error: "no_card" });
      return null;
    }
    return { holder, card };
  }

  /** Replies 503 when Stripe isn't configured; null means already replied. */
  function requireStripe(reply: FastifyReply) {
    if (!deps.stripe) {
      void reply.code(503).send({ error: "stripe_not_configured" });
      return null;
    }
    return deps.stripe;
  }

  async function approvedSpendSince(userId: string, since: Date): Promise<number> {
    const rows = await deps.db.issuingAuthorization.findMany({
      where: { userId, approved: true, createdAt: { gte: since } },
      select: { amountUsd: true },
    });
    const sum = rows.reduce((total, row) => total + Number(row.amountUsd ?? 0), 0);
    return Math.round(sum * 100) / 100;
  }

  app.get("/card", async (req, reply) => {
    const user = req.authedUser!;
    const at = now();

    const holder = await deps.db.issuingCardholder.findUnique({
      where: { userId: user.id },
      include: { cards: true },
    });
    const cardRow = holder?.cards[0];
    const dryRun = deps.policy.effectiveDryRun();
    if (!holder || !cardRow) {
      return { card: null, funding: { available: false }, dryRun };
    }
    const stripe = requireStripe(reply);
    if (!stripe) return;

    const details = await stripe.retrieveCard(cardRow.stripeCardId);
    // pending_onboarding is OUR lifecycle overlay (the Stripe card is
    // "active" from creation) — never let a re-mirror erase it; setup-card
    // graduates it to active.
    if (cardRow.status !== "pending_onboarding" && details.status !== cardRow.status) {
      // A status changed in the Stripe dashboard; keep the mirror honest.
      await deps.db.issuingCard.update({
        where: { stripeCardId: cardRow.stripeCardId },
        data: { status: details.status },
      });
    }
    const effectiveStatus =
      cardRow.status === "pending_onboarding" ? cardRow.status : details.status;

    const [spentTodayUsd, spentThisMonthUsd] = await Promise.all([
      approvedSpendSince(user.id, nycStartOfDay(at)),
      approvedSpendSince(user.id, nycStartOfMonth(at)),
    ]);

    // Funding is best-effort on the summary: an unready financial account
    // (or a Stripe hiccup) hides the balance, never the card.
    let funding: { available: boolean; balanceUsd?: number; pendingUsd?: number } = {
      available: false,
    };
    try {
      funding = { available: true, ...(await stripe.fundingBalance()) };
    } catch (err) {
      req.log.info({ err }, "card funding balance unavailable");
    }

    return {
      card: {
        stripeCardId: cardRow.stripeCardId,
        last4: cardRow.last4,
        brand: details.brand,
        status: effectiveStatus,
        expMonth: details.expMonth,
        expYear: details.expYear,
        cardholderName: details.cardholderName || holder.name,
        // The controls actually on the Stripe card, mirrored at the last
        // issuing:setup run from policy.json.
        spendingControls: {
          perAuthorizationUsd: Number(cardRow.perAuthCapUsd),
          dailyUsd: Number(cardRow.dailyCapUsd),
        },
        spentTodayUsd,
        spentThisMonthUsd,
      },
      funding,
      dryRun,
    };
  });

  /**
   * Lazy card creation: called when the user reaches the "Link provider"
   * step, not at signup. Idempotent — an existing non-canceled card is
   * simply returned. The DB status starts at pending_onboarding (the Stripe
   * card itself is active); setup-card graduates it, and the janitor
   * cancels it after 7 abandoned days.
   */
  app.post("/card/prepare", async (req, reply) => {
    const user = req.authedUser!;
    const stripe = requireStripe(reply);
    if (!stripe) return;
    const policy = deps.policy.get();

    let holder = await deps.db.issuingCardholder.findUnique({
      where: { userId: user.id },
      include: { cards: true },
    });
    const existing = holder?.cards.find((c) => c.status !== "canceled");
    if (holder && existing) {
      return {
        created: false,
        card: {
          stripeCardId: existing.stripeCardId,
          last4: existing.last4,
          status: existing.status,
        },
      };
    }

    if (!holder) {
      const created = await stripe.createCardholder(user.name);
      const row = await deps.db.issuingCardholder.create({
        data: { userId: user.id, stripeCardholderId: created.stripeCardholderId, name: user.name },
      });
      holder = { ...row, cards: [] };
    }
    const card = await stripe.createCard(holder.stripeCardholderId, {
      perAuthUsd: policy.session_cap_usd,
      dailyUsd: policy.daily_cap_usd,
    });
    await deps.db.issuingCard.create({
      data: {
        cardholderId: holder.id,
        stripeCardId: card.stripeCardId,
        last4: card.last4,
        status: "pending_onboarding",
        perAuthCapUsd: policy.session_cap_usd,
        dailyCapUsd: policy.daily_cap_usd,
      },
    });
    await deps.db.decision.create({
      data: {
        kind: "card_prepare",
        inputs: { policyHash: deps.policy.hash() },
        rule: "prepared",
        outcome: { ok: true, stripeCardId: card.stripeCardId, last4: card.last4 },
        userId: user.id,
      },
    });
    return {
      created: true,
      card: { stripeCardId: card.stripeCardId, last4: card.last4, status: "pending_onboarding" },
    };
  });

  /**
   * Apple Pay top-up, step 1: a PaymentIntent the app confirms client-side
   * (Apple Pay sheet). Step 2 is the payment_intent.succeeded webhook,
   * which moves the settled money onto the financial account. Under dry
   * run this returns a fake client secret and Stripe is never called.
   */
  app.post("/card/funding/topup-intent", async (req, reply) => {
    const parsed = fundingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const amountUsd = Math.round(parsed.data.amountUsd * 100) / 100;
    const user = req.authedUser!;
    const policy = deps.policy.get();
    const dryRun = deps.policy.effectiveDryRun();

    const found = await requireCard(user.id, reply);
    if (!found) return;

    const decisionInputs = { amountUsd, dryRun, policyHash: deps.policy.hash() };
    if (amountUsd > policy.daily_cap_usd) {
      const decision = await deps.db.decision.create({
        data: {
          kind: "card_topup_intent",
          inputs: decisionInputs,
          rule: "amount_over_daily_cap",
          outcome: { allowed: false },
          userId: user.id,
        },
      });
      return reply.code(409).send({ error: "amount_over_daily_cap", decisionId: decision.id });
    }
    if (dryRun) {
      // No PaymentIntent exists and nothing can ever charge: the fake
      // secret lets the app walk its Apple Pay flow up to the sheet.
      const decision = await deps.db.decision.create({
        data: {
          kind: "card_topup_intent",
          inputs: decisionInputs,
          rule: "dry_run",
          outcome: { allowed: false, wouldCreate: true },
          userId: user.id,
        },
      });
      return {
        clientSecret: `pi_dryrun_${decision.id}_secret_dryrun`,
        paymentIntentId: null,
        dryRun: true,
      };
    }

    const stripe = requireStripe(reply);
    if (!stripe) return;
    const intent = await stripe.createPaymentIntent(amountUsd, {
      parkagent: "card_topup",
      userId: user.id,
    });
    await deps.db.decision.create({
      data: {
        kind: "card_topup_intent",
        inputs: decisionInputs,
        rule: "intent_created",
        outcome: { allowed: true, paymentIntentId: intent.paymentIntentId },
        userId: user.id,
      },
    });
    return {
      clientSecret: intent.clientSecret,
      paymentIntentId: intent.paymentIntentId,
      dryRun: false,
    };
  });

  app.get("/card/transactions", async (req, reply) => {
    const parsed = transactionsSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const { limit, cursor } = parsed.data;
    const user = req.authedUser!;

    const rows = await deps.db.issuingAuthorization.findMany({
      where: { userId: user.id, ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null;

    // Attach each authorization to the session whose start it paid for: the
    // newest session that began within the 10 minutes before the charge
    // (the window the webhook approved it under). Read-time join — the
    // ledger row itself stores no session id.
    const sessions = await deps.db.session.findMany({ where: { userId: user.id } });
    const sessionFor = (chargedAt: Date): string | null => {
      let best: { id: string; startedAt: Date } | null = null;
      for (const s of sessions) {
        const startedAt = s.startedAt ?? s.createdAt;
        const delta = chargedAt.getTime() - startedAt.getTime();
        if (delta < 0 || delta > SESSION_LINK_WINDOW_MS) continue;
        if (!best || startedAt > best.startedAt) best = { id: s.id, startedAt };
      }
      return best?.id ?? null;
    };

    return {
      items: page.map((row) => ({
        id: row.id,
        stripeAuthorizationId: row.stripeAuthorizationId,
        merchantName: row.merchantName,
        merchantCategory: row.merchantCategory,
        amountUsd: Number(row.amountUsd ?? 0),
        capturedUsd: row.capturedUsd === null ? null : Number(row.capturedUsd),
        approved: row.approved,
        decision: row.decision,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        sessionId: sessionFor(row.createdAt),
      })),
      nextCursor,
    };
  });

  /** Shared body for the two funding moves; they differ only in direction. */
  function fundingRoute(direction: "topup" | "withdraw") {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = fundingSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: z.treeifyError(parsed.error) });
      }
      const amountUsd = Math.round(parsed.data.amountUsd * 100) / 100;
      const user = req.authedUser!;
      const policy = deps.policy.get();
      const dryRun = deps.policy.effectiveDryRun();
      const kind = direction === "topup" ? "card_topup" : "card_withdraw";

      const found = await requireCard(user.id, reply);
      if (!found) return;
      const stripe = requireStripe(reply);
      if (!stripe) return;

      const decisionInputs = {
        direction,
        amountUsd,
        dryRun,
        policyHash: deps.policy.hash(),
      };
      const refuse = async (rule: string, code: number, extra: Record<string, unknown> = {}) => {
        const decision = await deps.db.decision.create({
          data: {
            kind,
            inputs: decisionInputs,
            rule,
            outcome: { allowed: false, ...extra },
            userId: user.id,
          },
        });
        return reply.code(code).send({ error: rule, decisionId: decision.id, ...extra });
      };

      // Checks in webhook order: policy caps first, dry run last (so the
      // audit shows what would have happened), then the move itself.
      if (amountUsd > policy.daily_cap_usd) {
        return refuse("amount_over_daily_cap", 409);
      }
      try {
        if (direction === "withdraw") {
          const balance = await stripe.fundingBalance();
          if (amountUsd > balance.balanceUsd) {
            return refuse("insufficient_funds", 409, { balanceUsd: balance.balanceUsd });
          }
        }
        if (dryRun) {
          // Non-negotiable: no code path moves money while a dry-run switch
          // is on. The decision records that only dry run stood in the way.
          return refuse("dry_run", 409, { wouldAllow: true });
        }
        if (direction === "topup") {
          await stripe.fundingTopup(amountUsd);
        } else {
          await stripe.fundingWithdraw(amountUsd);
        }
        const balance = await stripe.fundingBalance();
        const decision = await deps.db.decision.create({
          data: {
            kind,
            inputs: decisionInputs,
            rule: `${direction}_ok`,
            outcome: { allowed: true, ok: true, ...balance },
            userId: user.id,
          },
        });
        return { ok: true, ...balance, decisionId: decision.id };
      } catch (err) {
        if (err instanceof FundingUnavailableError) {
          return refuse("funding_unavailable", 503, { reason: err.reason });
        }
        req.log.error({ err }, `card ${direction} failed`);
        return refuse("stripe_failed", 502);
      }
    };
  }

  app.post("/card/funding/topup", fundingRoute("topup"));
  app.post("/card/funding/withdraw", fundingRoute("withdraw"));

  app.get("/card/reveal", async (req, reply) => {
    const parsed = revealSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const found = await requireCard(user.id, reply);
    if (!found) return;
    const stripe = requireStripe(reply);
    if (!stripe) return;

    const key = await stripe.createEphemeralKey(found.card.stripeCardId, {
      ...(parsed.data.nonce ? { nonce: parsed.data.nonce } : {}),
      ...(parsed.data.api_version ? { apiVersion: parsed.data.api_version } : {}),
    });
    // Audit every reveal: it exposes the PAN on the device.
    await deps.db.decision.create({
      data: {
        kind: "card_reveal",
        inputs: { stripeCardId: found.card.stripeCardId, expiresAt: key.expiresAt.toISOString() },
        rule: "reveal_ok",
        outcome: { ok: true },
        userId: user.id,
      },
    });
    return {
      stripeCardId: found.card.stripeCardId,
      ephemeralKeySecret: key.secret,
      apiVersion: key.apiVersion,
      expiresAt: key.expiresAt.toISOString(),
    };
  });

  /** Freeze/unfreeze share everything but the target status. */
  function statusRoute(status: "active" | "inactive", rule: string) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.authedUser!;
      const found = await requireCard(user.id, reply);
      if (!found) return;
      const stripe = requireStripe(reply);
      if (!stripe) return;

      const newStatus = await stripe.setCardStatus(found.card.stripeCardId, status);
      await deps.db.issuingCard.update({
        where: { stripeCardId: found.card.stripeCardId },
        data: { status: newStatus },
      });
      await deps.db.decision.create({
        data: {
          kind: "card_status",
          inputs: { stripeCardId: found.card.stripeCardId, requested: status },
          rule,
          outcome: { ok: true, status: newStatus },
          userId: user.id,
        },
      });
      return { status: newStatus };
    };
  }

  app.post("/card/freeze", statusRoute("inactive", "freeze_ok"));
  app.post("/card/unfreeze", statusRoute("active", "unfreeze_ok"));
}
