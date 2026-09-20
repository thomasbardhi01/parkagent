/**
 * The card janitor: once a day, cancel Issuing cards created lazily at the
 * "Link provider" step (POST /card/prepare) whose user walked away —
 * pending_onboarding for more than 7 days with no provider ever linked.
 *
 * Ledger integrity rule: a card that has EVER transacted is never canceled
 * (its authorizations must keep resolving) — it is frozen instead. That
 * case shouldn't arise for a never-linked user, but the guard is cheap.
 * A cardholder left with no cards is deactivated on Stripe (the closest
 * thing to deletion the API offers) and its rows are removed, so a
 * returning user simply gets a fresh card from the next /card/prepare.
 * Every action writes a decisions row.
 */

import type { AppDb } from "../db.js";
import type { StripeGateway } from "../services/stripeGateway.js";

export const ABANDONED_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export interface CardJanitorDeps {
  db: AppDb;
  /** Absent when Stripe isn't configured; the janitor then no-ops. */
  stripe?: StripeGateway | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: (() => Date) | undefined;
}

export interface CardJanitor {
  /** One sweep; exposed for tests. */
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeCardJanitor(deps: CardJanitorDeps): CardJanitor {
  const now = () => deps.now?.() ?? new Date();

  async function sweepCard(card: {
    stripeCardId: string;
    last4: string;
    cardholderId: string;
    cardholder?: { id: string; userId: string; stripeCardholderId: string };
  }): Promise<void> {
    const stripe = deps.stripe!;
    const holder = card.cardholder;
    if (!holder) return;

    // "Never linked": no provider account of theirs has ever reached
    // linked. A user who linked (even if since expired/unlinked) is
    // onboarding, not abandoned — leave their card alone.
    const accounts = await deps.db.providerAccount.findMany({ where: { userId: holder.userId } });
    if (accounts.some((a) => a.linkedAt !== null)) return;

    const transacted =
      (await deps.db.issuingAuthorization.findFirst({
        where: { stripeCardId: card.stripeCardId },
      })) !== null;

    if (transacted) {
      const status = await stripe.setCardStatus(card.stripeCardId, "inactive");
      await deps.db.issuingCard.update({
        where: { stripeCardId: card.stripeCardId },
        data: { status },
      });
      await deps.db.decision.create({
        data: {
          kind: "card_janitor",
          inputs: { stripeCardId: card.stripeCardId, last4: card.last4, transacted: true },
          rule: "freeze_abandoned_transacted",
          outcome: { ok: true, status },
          userId: holder.userId,
        },
      });
      return;
    }

    await stripe.setCardStatus(card.stripeCardId, "canceled");
    await deps.db.issuingCard.update({
      where: { stripeCardId: card.stripeCardId },
      data: { status: "canceled" },
    });

    // Cardholder cleanup: with no live cards left, deactivate on Stripe and
    // drop the rows so the next /card/prepare starts fresh.
    const liveCards = await deps.db.issuingCard.findMany({
      where: { cardholderId: card.cardholderId, status: { not: "canceled" } },
    });
    let cardholderRemoved = false;
    if (liveCards.length === 0) {
      await stripe.deactivateCardholder(holder.stripeCardholderId);
      await deps.db.issuingCard.deleteMany({ where: { cardholderId: card.cardholderId } });
      await deps.db.issuingCardholder.delete({ where: { id: holder.id } });
      cardholderRemoved = true;
    }
    await deps.db.decision.create({
      data: {
        kind: "card_janitor",
        inputs: { stripeCardId: card.stripeCardId, last4: card.last4, transacted: false },
        rule: "cancel_abandoned",
        outcome: { ok: true, cardholderRemoved },
        userId: holder.userId,
      },
    });
  }

  async function tick(): Promise<void> {
    if (!deps.stripe) return;
    const cutoff = new Date(now().getTime() - ABANDONED_AFTER_DAYS * DAY_MS);
    const stale = await deps.db.issuingCard.findMany({
      where: { status: "pending_onboarding", createdAt: { lt: cutoff } },
      include: { cardholder: true },
    });
    for (const card of stale) {
      try {
        await sweepCard(card);
      } catch (err) {
        deps.log.warn(`card janitor failed on ${card.stripeCardId}: ${String(err)}`);
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    tick,
    start(intervalMs = DAY_MS) {
      if (timer) return;
      // One sweep at boot, then daily.
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      deps.log.info(`card janitor started (every ${Math.round(intervalMs / 3_600_000)}h)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
