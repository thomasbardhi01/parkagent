/**
 * Shadow mode (policy.json `shadow_mode`): while the real executor pays
 * through whatever payment method the user's provider account already has,
 * every session start and extension ALSO fires a Stripe TEST-MODE Issuing
 * authorization for the same amount at the user's virtual card. Stripe then
 * calls our webhook, whose budget checks and ledger writes run exactly as
 * they would for a real card swipe — the whole Stripe pipeline rehearses in
 * parallel with the real spend.
 *
 * The result is recorded on the money move's own decisions row (outcome
 * .shadow) and surfaced by `pnpm -C server decisions:recent`. A shadow
 * failure never fails the session: this is instrumentation, not payment.
 */

import type { AppDb } from "../db.js";
import type { StripeGateway } from "./stripeGateway.js";

export interface ShadowResult {
  /** Did a test authorization actually fire? */
  fired: boolean;
  /** Stripe's iauth_… id, when fired. */
  authorizationId?: string;
  /** The webhook's live answer, as Stripe reports it back. */
  approved?: boolean;
  amountUsd?: number;
  /** Why nothing fired (stripe_not_configured | no_card | zero_amount) or
   * the Stripe error message. */
  reason?: string;
}

const MERCHANTS: Record<string, { name: string; city: string; state: string }> = {
  nyc: { name: "PARKAGENT SHADOW PARKNYC", city: "New York", state: "NY" },
  bos: { name: "PARKAGENT SHADOW PARKBOSTON", city: "Boston", state: "MA" },
};

export interface ShadowDeps {
  db: Pick<AppDb, "issuingCardholder">;
  stripe?: StripeGateway | undefined;
}

/** Never throws — a shadow failure is recorded, not raised. */
export async function fireShadowAuthorization(
  deps: ShadowDeps,
  userId: string,
  amountUsd: number,
  city: string,
): Promise<ShadowResult> {
  if (!deps.stripe) return { fired: false, reason: "stripe_not_configured" };
  if (amountUsd <= 0) return { fired: false, reason: "zero_amount" };

  const holder = await deps.db.issuingCardholder
    .findUnique({ where: { userId }, include: { cards: true } })
    .catch(() => null);
  const card = holder?.cards.find((c) => c.status !== "canceled");
  if (!card) return { fired: false, reason: "no_card" };

  const merchant = MERCHANTS[city] ?? MERCHANTS["nyc"]!;
  try {
    const auth = await deps.stripe.createTestAuthorization(card.stripeCardId, amountUsd, merchant);
    return {
      fired: true,
      authorizationId: auth.authorizationId,
      approved: auth.approved,
      amountUsd,
    };
  } catch (err) {
    return { fired: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
