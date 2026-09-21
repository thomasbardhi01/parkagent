/**
 * Provider account endpoints: link (cookies from the app's login web view),
 * status, the chained link → setup-card job, unlink, manual setup-card, and
 * the provider-wallet top-up.
 *
 * Cookie VALUES are secrets: they go straight into the sealed state and
 * never into logs, decisions inputs, or responses — decisions record only
 * the cookie count and distinct domains.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { allProviders, cookieDomainAllowed, providerById } from "../providers/registry.js";
import type { ProviderInfo } from "../providers/registry.js";
import {
  LinkJobStore,
  markAccountExpired,
  openState,
  runSetupCard,
} from "../services/providerLink.js";
import type { ProviderStorageState } from "../services/providerOps.js";

const cookieSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().min(1).max(8192),
  domain: z.string().min(1).max(256),
  path: z.string().max(1024).optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});

const linkSchema = z.object({
  cookies: z.array(cookieSchema).min(1).max(200),
  set_up_card: z.boolean().default(true),
  consent_replace_payment_method: z.boolean().optional(),
});

const topupSchema = z.object({
  amountUsd: z.number().positive().max(10_000),
});

const linkStatusSchema = z.object({
  jobId: z.string().min(1),
});

export function registerProviders(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();
  const jobs = new LinkJobStore();

  /** Resolve :provider or reply 404; null means already replied. */
  function requireProvider(req: FastifyRequest, reply: FastifyReply): ProviderInfo | null {
    const { provider } = req.params as { provider: string };
    const info = providerById(provider);
    if (!info) {
      void reply.code(404).send({ error: "unknown_provider" });
      return null;
    }
    return info;
  }

  app.get("/providers/status", { preHandler: deps.authenticate }, async (req) => {
    const user = req.authedUser!;
    const accounts = await deps.db.providerAccount.findMany({ where: { userId: user.id } });
    return {
      providers: allProviders().map((p) => {
        const account = accounts.find((a) => a.provider === p.id);
        return {
          id: p.id,
          city: p.city,
          cityDisplayName: p.cityDisplayName,
          displayName: p.displayName,
          loginUrl: p.loginUrl,
          // The app's link web view watches these domains to know when the
          // user has actually signed in before capturing cookies.
          cookieDomains: p.cookieDomains,
          status: account?.status ?? "unlinked",
          linkedAt: account?.linkedAt?.toISOString() ?? null,
          lastVerifiedAt: account?.lastVerifiedAt?.toISOString() ?? null,
          cardAdded: account?.cardAdded ?? false,
          walletBalanceCents: account?.walletBalanceCents ?? null,
        };
      }),
    };
  });

  app.post("/providers/:provider/link", { preHandler: deps.authenticate }, async (req, reply) => {
    const provider = requireProvider(req, reply);
    if (!provider) return;
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const at = now();

    // Shadow mode: sessions pay with whatever payment method the account
    // already has, so linking neither replaces the payment method nor needs
    // consent for it — the chained setup-card is skipped outright.
    const shadowMode = deps.policy.get().shadow_mode === true;
    const setUpCard = body.set_up_card && !shadowMode;

    // Replacing the account's payment method is consequential enough to
    // demand explicit consent up front, before anything runs.
    if (setUpCard && body.consent_replace_payment_method !== true) {
      return reply.code(400).send({ error: "consent_required" });
    }
    if (!deps.stateCrypto || !deps.providerOps) {
      return reply.code(503).send({ error: "provider_linking_not_configured" });
    }
    const stateCrypto = deps.stateCrypto;

    // Only cookies on the provider's session domains may enter the state;
    // whatever else the web view saw is dropped here at the door.
    const filtered = body.cookies.filter((c) => cookieDomainAllowed(provider, c.domain));
    const decisionInputs = {
      provider: provider.id,
      cookieCount: filtered.length,
      droppedCount: body.cookies.length - filtered.length,
      domains: [...new Set(filtered.map((c) => c.domain))],
      setUpCard,
      shadowMode,
    };
    const decide = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: { kind: "provider_link", inputs: decisionInputs, rule, outcome, userId: user.id },
      });

    if (filtered.length === 0) {
      await decide("no_session_cookies", { ok: false });
      return reply
        .code(400)
        .send({ error: "no_session_cookies", expectedDomains: provider.cookieDomains });
    }

    const state: ProviderStorageState = {
      cookies: filtered.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: c.sameSite ?? "Lax",
      })),
      origins: [],
    };

    let ops;
    try {
      ops = deps.providerOps(provider.id, state);
    } catch {
      await decide("provider_not_supported", { ok: false });
      return reply.code(409).send({ error: "provider_not_supported" });
    }

    // Verify headlessly: are these cookies a signed-in session?
    const verify = await ops.verifyAccount();
    if (!verify.ok) {
      await decide("verification_failed", { ok: false, code: verify.code });
      return reply.code(409).send({ error: "verification_failed", code: verify.code });
    }

    await deps.db.providerAccount.upsert({
      where: { userId_provider: { userId: user.id, provider: provider.id } },
      create: {
        userId: user.id,
        provider: provider.id,
        status: "linked",
        stateEncrypted: stateCrypto.seal(JSON.stringify(state)),
        linkedAt: at,
        lastVerifiedAt: at,
        walletBalanceCents: verify.walletBalanceCents,
      },
      update: {
        status: "linked",
        stateEncrypted: stateCrypto.seal(JSON.stringify(state)),
        linkedAt: at,
        lastVerifiedAt: at,
        walletBalanceCents: verify.walletBalanceCents,
      },
    });
    await decide("link_ok", { ok: true, walletBalanceCents: verify.walletBalanceCents });

    // Chained setup: verification passed, so the card goes on now — as a
    // job the app polls, since the executor takes seconds.
    let jobId: string | null = null;
    if (setUpCard) {
      jobId = randomUUID();
      jobs.create({ id: jobId, userId: user.id, provider: provider.id, phase: "adding_card" });
      const id = jobId;
      void runSetupCard(deps, user.id, provider)
        .then((outcome) => {
          if (outcome.ok) {
            jobs.update(id, { phase: "done", dryRun: outcome.dryRun });
          } else {
            jobs.update(id, {
              phase: "failed",
              reason: outcome.code,
              retrySafe: outcome.retrySafe,
            });
          }
        })
        .catch((err: unknown) => {
          req.log.error({ err }, "chained setup-card crashed");
          jobs.update(id, { phase: "failed", reason: "unknown", retrySafe: true });
        });
    }

    return {
      status: "linked",
      walletBalanceCents: verify.walletBalanceCents,
      jobId,
    };
  });

  app.get(
    "/providers/:provider/link-status",
    { preHandler: deps.authenticate },
    async (req, reply) => {
      const provider = requireProvider(req, reply);
      if (!provider) return;
      const parsed = linkStatusSchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: z.treeifyError(parsed.error) });
      }
      const user = req.authedUser!;
      const job = jobs.get(parsed.data.jobId);
      if (!job || job.userId !== user.id || job.provider !== provider.id) {
        return reply.code(404).send({ error: "unknown_job" });
      }
      return {
        phase: job.phase,
        ...(job.reason !== undefined ? { reason: job.reason } : {}),
        ...(job.retrySafe !== undefined ? { retrySafe: job.retrySafe } : {}),
        ...(job.dryRun !== undefined ? { dryRun: job.dryRun } : {}),
      };
    },
  );

  app.post(
    "/providers/:provider/setup-card",
    { preHandler: deps.authenticate },
    async (req, reply) => {
      const provider = requireProvider(req, reply);
      if (!provider) return;
      const user = req.authedUser!;

      const account = await deps.db.providerAccount.findUnique({
        where: { userId_provider: { userId: user.id, provider: provider.id } },
      });
      if (!account || account.status !== "linked") {
        return reply.code(409).send({ error: "provider_not_linked", provider: provider.id });
      }
      const outcome = await runSetupCard(deps, user.id, provider);
      if (outcome.ok) {
        return { ok: true, dryRun: outcome.dryRun };
      }
      if (outcome.code === "no_card") {
        return reply.code(409).send({ error: "no_card", retrySafe: outcome.retrySafe });
      }
      return reply
        .code(502)
        .send({ error: "setup_card_failed", code: outcome.code, retrySafe: outcome.retrySafe });
    },
  );

  app.post("/providers/:provider/unlink", { preHandler: deps.authenticate }, async (req, reply) => {
    const provider = requireProvider(req, reply);
    if (!provider) return;
    const user = req.authedUser!;

    const account = await deps.db.providerAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider: provider.id } },
    });
    if (!account || account.status === "unlinked") {
      return reply.code(404).send({ error: "not_linked" });
    }

    const holder = await deps.db.issuingCardholder.findUnique({
      where: { userId: user.id },
      include: { cards: true },
    });
    const card = holder?.cards.find((c) => c.status !== "canceled");

    // Best effort: take our card off the provider account while the
    // cookies still work. Failure never blocks the unlink.
    let cardRemoval = "skipped";
    if (
      account.cardAdded &&
      account.stateEncrypted &&
      deps.providerOps &&
      deps.stateCrypto &&
      card
    ) {
      const state = openState(deps.stateCrypto, account.stateEncrypted);
      if (state) {
        try {
          const result = await deps.providerOps(provider.id, state).removeCard(card.last4);
          cardRemoval = result.ok ? "removed" : `failed:${result.code}`;
        } catch {
          cardRemoval = "failed:unknown";
        }
      } else {
        cardRemoval = "failed:state_unreadable";
      }
    }

    await deps.db.providerAccount.update({
      where: { userId_provider: { userId: user.id, provider: provider.id } },
      data: { status: "unlinked", stateEncrypted: null, cardAdded: false },
    });

    // Ledger integrity: a card that has ever transacted is never canceled.
    // With no linked provider left there is nothing for it to pay, so it is
    // frozen — reversible when the user links again.
    const remaining = await deps.db.providerAccount.findMany({ where: { userId: user.id } });
    const anyLinked = remaining.some((a) => a.provider !== provider.id && a.status === "linked");
    let cardFrozen = false;
    if (!anyLinked && card && card.status === "active" && deps.stripe) {
      const status = await deps.stripe.setCardStatus(card.stripeCardId, "inactive");
      await deps.db.issuingCard.update({
        where: { stripeCardId: card.stripeCardId },
        data: { status },
      });
      cardFrozen = true;
    }

    await deps.db.decision.create({
      data: {
        kind: "provider_unlink",
        inputs: { provider: provider.id, cardAdded: account.cardAdded },
        rule: "unlink_ok",
        outcome: { ok: true, cardRemoval, cardFrozen },
        userId: user.id,
      },
    });
    return { ok: true, cardRemoval, cardFrozen };
  });

  app.post("/providers/:provider/topup", { preHandler: deps.authenticate }, async (req, reply) => {
    const provider = requireProvider(req, reply);
    if (!provider) return;
    const parsed = topupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const amountUsd = Math.round(parsed.data.amountUsd * 100) / 100;
    const user = req.authedUser!;
    const policy = deps.policy.get();
    const dryRun = deps.policy.effectiveDryRun();

    const account = await deps.db.providerAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider: provider.id } },
    });
    if (!account || account.status !== "linked") {
      return reply.code(409).send({ error: "provider_not_linked", provider: provider.id });
    }

    const decisionInputs = {
      provider: provider.id,
      amountUsd,
      dryRun,
      policyHash: deps.policy.hash(),
    };
    const refuse = async (rule: string, code: number, extra: Record<string, unknown> = {}) => {
      const decision = await deps.db.decision.create({
        data: {
          kind: "provider_topup",
          inputs: decisionInputs,
          rule,
          outcome: { allowed: false, ...extra },
          userId: user.id,
        },
      });
      return reply.code(code).send({ error: rule, decisionId: decision.id, ...extra });
    };

    // Same order as the card funding moves: caps first, dry run last.
    if (amountUsd > policy.daily_cap_usd) {
      return refuse("amount_over_daily_cap", 409);
    }
    if (dryRun) {
      return refuse("dry_run", 409, { wouldAllow: true });
    }
    if (!deps.providerOps || !deps.stateCrypto || !account.stateEncrypted) {
      return refuse("topup_unavailable", 503);
    }
    const state = openState(deps.stateCrypto, account.stateEncrypted);
    if (!state) {
      await markAccountExpired(deps, user.id, provider);
      return refuse("auth_expired", 502);
    }

    const result = await deps.providerOps(provider.id, state).topupWallet(amountUsd);
    if (!result.ok) {
      if (result.code === "auth_expired") {
        await markAccountExpired(deps, user.id, provider);
      }
      return refuse(result.code, 502);
    }
    await deps.db.providerAccount.update({
      where: { userId_provider: { userId: user.id, provider: provider.id } },
      data: { walletBalanceCents: result.walletBalanceCents },
    });
    const decision = await deps.db.decision.create({
      data: {
        kind: "provider_topup",
        inputs: decisionInputs,
        rule: "topup_ok",
        outcome: { allowed: true, ok: true, walletBalanceCents: result.walletBalanceCents },
        userId: user.id,
      },
    });
    return { ok: true, walletBalanceCents: result.walletBalanceCents, decisionId: decision.id };
  });
}
