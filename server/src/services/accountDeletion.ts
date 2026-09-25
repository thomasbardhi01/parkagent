/**
 * Account deletion — the one teardown behind DELETE /me, shared with the
 * FR throwaway purge (scripts/purge-fr-throwaways.ts) so the two can never
 * drift apart.
 *
 * Contract: any ParkAgent card is frozen (never canceled — its ledger must
 * keep resolving) and the Stripe Customer holding the user's saved funding
 * cards is deleted, refresh tokens are deleted (every device signs out),
 * provider accounts are unlinked and their sealed cookie states erased,
 * the Link wallet is disconnected (tokens revoked and erased), vehicles,
 * device tokens and conversations are deleted, and the users row is
 * TOMBSTONED — identity fields scrubbed, deleted_at stamped, row kept — so
 * the decisions ledger (a non-negotiable) keeps a valid user id without
 * keeping the person.
 */

import type { AppDb } from "../db.js";
import type { AppleTokenClient } from "./appleTokens.js";
import type { StateCrypto } from "./crypto.js";
import type { LinkWallet } from "./link/linkWallet.js";
import type { StripeGateway } from "./stripeGateway.js";

export interface AccountDeletionDeps {
  db: AppDb;
  /** Absent → an active issued card or a Stripe Customer can't be torn
   * down; callers without one (the purge script) must refuse such rows. */
  stripe?: StripeGateway | undefined;
  linkWallet?: LinkWallet | undefined;
  /** Revokes the Sign in with Apple token; absent → the sealed token stays
   * on the tombstone for jobs/appleRevocationTick.ts once configured. */
  appleTokens?: AppleTokenClient | undefined;
  stateCrypto?: StateCrypto | undefined;
  now: () => Date;
}

export interface AccountDeletionResult {
  cardFrozen: boolean;
  customerDeleted: boolean;
  /** true revoked at Apple · false tried and failed (the hourly job
   * retries) · null there was no Apple token, or no way to revoke yet. */
  appleRevoked: boolean | null;
  fundingMethodsRemoved: number;
  providersUnlinked: string[];
}

/**
 * Tear the account down and tombstone it. `audit` rides along on the
 * account_delete decision's inputs (the purge records `via`).
 */
export async function deleteAccount(
  deps: AccountDeletionDeps,
  userId: string,
  audit: Record<string, unknown> = {},
): Promise<AccountDeletionResult> {
  const { db, now } = deps;

  // 1. Freeze (never cancel) any issued card — its authorizations must
  //    keep resolving against a live Stripe object. First, because it is
  //    the one step that calls out and can fail: a Stripe error here
  //    leaves the account untouched and the delete safely retryable,
  //    instead of half torn down with a card still spending.
  let cardFrozen = false;
  const holder = await db.issuingCardholder.findUnique({
    where: { userId },
    include: { cards: true },
  });
  for (const card of holder?.cards ?? []) {
    if (card.status === "active" && deps.stripe) {
      const status = await deps.stripe.setCardStatus(card.stripeCardId, "inactive");
      await db.issuingCard.update({
        where: { stripeCardId: card.stripeCardId },
        data: { status },
      });
      cardFrozen = true;
    }
  }
  //    The saved funding cards go with the person: deleting the Stripe
  //    Customer detaches them. Also a call-out, so also before anything
  //    local changes.
  const identity = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, appleRefreshTokenSealed: true },
  });
  let customerDeleted = false;
  if (identity?.stripeCustomerId && deps.stripe) {
    await deps.stripe.deleteCustomer(identity.stripeCustomerId);
    customerDeleted = true;
  }
  const funding = await db.fundingMethod.findMany({
    where: { userId, removedAt: null },
  });
  for (const method of funding) {
    await db.fundingMethod.update({
      where: { id: method.id },
      data: { removedAt: now(), isDefault: false },
    });
  }
  // The Link wallet's sealed tokens: revoked (best effort) and erased.
  if (deps.linkWallet) {
    await deps.linkWallet.disconnect(userId).catch(() => undefined);
  }

  // 2. Sessions out everywhere: refresh tokens and push channels gone.
  await db.refreshToken.deleteMany({ where: { userId } });
  await db.deviceToken.deleteMany({ where: { userId } });

  // 3. Provider accounts: unlink and erase the sealed cookie states.
  const accounts = await db.providerAccount.findMany({ where: { userId } });
  await db.providerAccount.updateMany({
    where: { userId },
    data: {
      status: "unlinked",
      stateEncrypted: null,
      cardAdded: false,
      cardBrand: null,
      cardLast4: null,
    },
  });

  // 4. Personal data: vehicles (sessions detach first — they are the
  //    money audit and stay), and assistant conversations.
  await db.session.updateMany({ where: { userId }, data: { vehicleId: null } });
  await db.vehicle.deleteMany({ where: { userId } });
  await db.conversation.deleteMany({ where: { userId } });

  // Sign in with Apple: revoke the token so the app leaves the person's
  //    Apple ID (App Store 5.1.1(v)). After the steps that can abort, so a
  //    delete that fails above never revokes a login the account still
  //    has; never blocking — a failure leaves the sealed token on the
  //    tombstone and jobs/appleRevocationTick.ts retries.
  const appleRevoked = await revokeAppleToken(deps, identity?.appleRefreshTokenSealed ?? null);

  // 5. Tombstone the users row: the decisions ledger keeps its user id,
  //    the person's identity is gone, and no credential works again.
  await db.user.update({
    where: { id: userId },
    data: {
      name: "Deleted account",
      email: null,
      emailVerified: false,
      phone: null,
      phoneVerified: false,
      appleSub: null,
      googleSub: null,
      apiKey: null,
      apiKeyHash: null,
      apiKeyPrefix: null,
      stripeCustomerId: null,
      paymentSource: "provider_card",
      ...(appleRevoked === true ? { appleRefreshTokenSealed: null } : {}),
      deletedAt: now(),
    },
  });

  const providersUnlinked = accounts.map((a) => a.provider);
  await db.decision.create({
    data: {
      kind: "account_delete",
      inputs: { providersUnlinked, ...audit },
      rule: "deleted",
      outcome: {
        ok: true,
        cardFrozen,
        customerDeleted,
        fundingMethodsRemoved: funding.length,
        appleRevoked,
      },
      userId,
    },
  });
  return {
    cardFrozen,
    customerDeleted,
    appleRevoked,
    fundingMethodsRemoved: funding.length,
    providersUnlinked,
  };
}

/** Revoke a sealed Apple refresh token. null: nothing to revoke, or no way
 * to yet (unconfigured, or the sealing key can't open it). */
export async function revokeAppleToken(
  deps: Pick<AccountDeletionDeps, "appleTokens" | "stateCrypto">,
  sealed: string | null,
): Promise<boolean | null> {
  if (!sealed || !deps.appleTokens || !deps.stateCrypto) return null;
  let token: string;
  try {
    token = deps.stateCrypto.open(sealed);
  } catch {
    return null;
  }
  return (await deps.appleTokens.revoke(token)).ok;
}
