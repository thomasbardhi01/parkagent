/**
 * The ParkAgent card as a payment source: the virtual Issuing card we put
 * on every linked parking account, and whether a parkagent_card session
 * can pay right now.
 *
 * Readiness is checked BEFORE any session row or hold exists, so a user
 * who picked the ParkAgent card but has no funding card, a frozen card, or
 * a provider account still carrying their own card is refused with a
 * reason the Wallet can act on — never charged against a hold the provider
 * would bypass. (A provider account that doesn't carry our card would
 * charge the user's own card there while we held and captured on ours:
 * that double charge is what `not_on_provider` prevents.)
 */

import type { AppDb } from "../../db.js";
import type { PolicyService } from "../policy.js";
import type { StripeGateway } from "../stripeGateway.js";
import { defaultFundingMethod } from "./holds.js";

export type ParkAgentCardReadiness =
  | { ready: true; cardOnProvider: boolean }
  | {
      ready: false;
      reason:
        | "no_funding_method"
        | "no_parkagent_card"
        | "parkagent_card_frozen"
        | "parkagent_card_not_on_provider";
    };

/** The user's live (non-canceled) Issuing card, if any. */
export async function parkAgentCardOf(db: AppDb, userId: string) {
  const holder = await db.issuingCardholder.findUnique({
    where: { userId },
    include: { cards: true },
  });
  const card = holder?.cards.find((c) => c.status !== "canceled") ?? null;
  return holder && card ? { holder, card } : null;
}

export async function parkAgentCardReadiness(
  db: AppDb,
  userId: string,
  providerId: string | null,
  dryRun: boolean,
): Promise<ParkAgentCardReadiness> {
  if (!(await defaultFundingMethod(db, userId))) {
    return { ready: false, reason: "no_funding_method" };
  }
  const found = await parkAgentCardOf(db, userId);
  if (!found) return { ready: false, reason: "no_parkagent_card" };
  if (found.card.status === "inactive") return { ready: false, reason: "parkagent_card_frozen" };
  if (!providerId) return { ready: true, cardOnProvider: false };
  const account = await db.providerAccount.findUnique({
    where: { userId_provider: { userId, provider: providerId } },
  });
  const cardOnProvider = account?.cardAdded === true;
  // Dry run never touches a provider account, so setup-card never ran for
  // real and cardAdded stays false: the would-be session is still allowed
  // (nothing pays) and the decision records cardOnProvider: false.
  if (!cardOnProvider && !dryRun) {
    return { ready: false, reason: "parkagent_card_not_on_provider" };
  }
  return { ready: true, cardOnProvider };
}

/**
 * Lazy creation of the ParkAgent card (the old POST /card/prepare body):
 * an existing non-canceled card is returned as is; otherwise the
 * cardholder (if needed) and one virtual card are created with spending
 * controls from the current policy. Creating a card moves no money — the
 * card spends only against holds (see holds.ts). Writes a decisions row
 * when it creates.
 */
export async function ensureParkAgentCard(
  deps: { db: AppDb; policy: PolicyService; stripe: StripeGateway },
  user: { id: string; name: string },
): Promise<{ created: boolean; card: { stripeCardId: string; last4: string; status: string } }> {
  const policy = deps.policy.get();
  let holder = await deps.db.issuingCardholder.findUnique({
    where: { userId: user.id },
    include: { cards: true },
  });
  const existing = holder?.cards.find((c) => c.status !== "canceled");
  if (holder && existing) {
    return {
      created: false,
      card: { stripeCardId: existing.stripeCardId, last4: existing.last4, status: existing.status },
    };
  }
  if (!holder) {
    const created = await deps.stripe.createCardholder(user.name);
    const row = await deps.db.issuingCardholder.create({
      data: { userId: user.id, stripeCardholderId: created.stripeCardholderId, name: user.name },
    });
    holder = { ...row, cards: [] };
  }
  const card = await deps.stripe.createCard(holder.stripeCardholderId, {
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
}
