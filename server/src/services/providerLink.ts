/**
 * Provider linking internals shared by routes/providers.ts and the chained
 * link → setup-card job: the setup-card operation itself, the in-memory job
 * store the app polls via GET /providers/:provider/link-status, and the
 * account-expiry bookkeeping.
 *
 * Card numbers pass through here on their way from Stripe to the provider's
 * payment form. They are fetched immediately before the executor call,
 * never logged, never written to decisions (only stripeCardId/last4 are),
 * and blanked as soon as the form is submitted.
 */

import type { AppDb } from "../db.js";
import { providerStatusUsable } from "../providers/registry.js";
import type { ProviderInfo } from "../providers/registry.js";
import { providerRelinkPush } from "./apns.js";
import type { PushSender } from "./apns.js";
import type { StateCrypto } from "./crypto.js";
import type { PolicyService } from "./policy.js";
import type {
  ProviderOpErrorCode,
  ProviderOpsFactory,
  ProviderStorageState,
} from "./providerOps.js";
import type { StripeGateway } from "./stripeGateway.js";

// ---------------------------------------------------------------------------
// Link jobs (the chained setup). Durable in link_jobs: a deploy or
// machine stop mid-job must not lose the answer the app is polling for
// (GET /providers/:provider/link-status). Rows stuck in progress past 15
// minutes are failed with reason "timeout" by the link-job janitor.

export type LinkJobPhase = "linking" | "adding_card" | "done" | "failed";

export interface LinkJob {
  id: string;
  userId: string;
  provider: string;
  phase: LinkJobPhase;
  /** Typed failure reason (ProviderOpErrorCode, "no_card", or "timeout"). */
  reason?: string;
  /** On failure: is POST /providers/:provider/setup-card worth retrying
   * as-is (transient), or does something need fixing first? */
  retrySafe?: boolean;
  /** True when dry run skipped the real card setup. */
  dryRun?: boolean;
}

export class LinkJobStore {
  constructor(private readonly db: AppDb) {}

  async create(job: LinkJob): Promise<void> {
    await this.db.linkJob.create({
      data: {
        id: job.id,
        userId: job.userId,
        provider: job.provider,
        phase: job.phase,
        ...(job.reason !== undefined ? { reason: job.reason } : {}),
        ...(job.retrySafe !== undefined ? { retrySafe: job.retrySafe } : {}),
        ...(job.dryRun !== undefined ? { dryRun: job.dryRun } : {}),
      },
    });
  }

  async update(id: string, patch: Partial<Omit<LinkJob, "id">>): Promise<void> {
    await this.db.linkJob.update({
      where: { id },
      data: {
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.retrySafe !== undefined ? { retrySafe: patch.retrySafe } : {}),
        ...(patch.dryRun !== undefined ? { dryRun: patch.dryRun } : {}),
      },
    });
  }

  async get(id: string): Promise<LinkJob | undefined> {
    const row = await this.db.linkJob.findUnique({ where: { id } });
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      phase: row.phase as LinkJobPhase,
      ...(row.reason !== null ? { reason: row.reason } : {}),
      ...(row.retrySafe !== null ? { retrySafe: row.retrySafe } : {}),
      ...(row.dryRun !== null ? { dryRun: row.dryRun } : {}),
    };
  }
}

// ---------------------------------------------------------------------------

export interface ProviderLinkDeps {
  db: AppDb;
  policy: PolicyService;
  sendPush: PushSender;
  stripe?: StripeGateway | undefined;
  stateCrypto?: StateCrypto | undefined;
  providerOps?: ProviderOpsFactory | undefined;
  /** ISSUING_LIVE. Before it, the ParkAgent card is sandbox-only and never
   * goes onto a real parking account. */
  issuingLive?: boolean | undefined;
  now?: (() => Date) | undefined;
}

/** The cookies died (or never were a session): flag it and ask for a re-link. */
export async function markAccountExpired(
  deps: ProviderLinkDeps,
  userId: string,
  provider: ProviderInfo,
): Promise<void> {
  await deps.db.providerAccount.update({
    where: { userId_provider: { userId, provider: provider.id } },
    data: { status: "expired" },
  });
  await deps.sendPush(
    userId,
    providerRelinkPush({ provider: provider.id, displayName: provider.displayName }),
  );
}

export function openState(crypto: StateCrypto, sealed: string): ProviderStorageState | null {
  try {
    return JSON.parse(crypto.open(sealed)) as ProviderStorageState;
  } catch {
    return null;
  }
}

export type SetupCardOutcome =
  | { ok: true; dryRun: boolean }
  | { ok: false; code: ProviderOpErrorCode | "no_card"; message: string; retrySafe: boolean };

/** Transient failures are worth an as-is retry; the rest need a human. */
function retrySafeFor(code: ProviderOpErrorCode | "no_card"): boolean {
  switch (code) {
    case "network":
    case "ui_changed":
    case "unknown":
    case "no_card":
      return true;
    default:
      // auth_expired needs a re-link, unsupported_card_brand a different
      // card, payment_declined a look at the account, zone_not_found is
      // impossible here.
      return false;
  }
}

/**
 * Make the user's Issuing card the provider account's payment method.
 * Policy-checked by callers where needed; dry run never touches the
 * provider and records wouldAdd instead. Always writes a decisions row.
 */
export async function runSetupCard(
  deps: ProviderLinkDeps,
  userId: string,
  provider: ProviderInfo,
): Promise<SetupCardOutcome> {
  const dryRun = deps.policy.effectiveDryRun();

  const holder = await deps.db.issuingCardholder.findUnique({
    where: { userId },
    include: { cards: true },
  });
  const card = holder?.cards.find((c) => c.status !== "canceled");

  const decide = async (rule: string, outcome: Record<string, unknown>) => {
    await deps.db.decision.create({
      data: {
        kind: "provider_setup_card",
        inputs: {
          provider: provider.id,
          stripeCardId: card?.stripeCardId ?? null,
          last4: card?.last4 ?? null,
          dryRun,
          policyHash: deps.policy.hash(),
        },
        rule,
        outcome,
        userId,
      },
    });
  };

  if (!card) {
    await decide("no_card", { ok: false });
    return {
      ok: false,
      code: "no_card",
      message: "no Issuing card yet — call POST /card/prepare first",
      retrySafe: true,
    };
  }

  if (dryRun) {
    // Non-negotiable shape: dry run means the provider account is never
    // touched. The decision records that the setup would have run.
    await decide("dry_run", { ok: true, wouldAdd: true });
    return { ok: true, dryRun: true };
  }
  if (deps.issuingLive !== true) {
    // Before ISSUING_LIVE the ParkAgent card is a sandbox (test-mode)
    // card: putting it on a REAL parking account would replace the user's
    // own card with one no real meter can charge. Never.
    await decide("sandbox", { ok: true, wouldAdd: true, sandbox: true });
    return { ok: true, dryRun: true };
  }

  const account = await deps.db.providerAccount.findUnique({
    where: { userId_provider: { userId, provider: provider.id } },
  });
  if (!account || !providerStatusUsable(account.status) || !account.stateEncrypted) {
    await decide("auth_expired", { ok: false });
    return {
      ok: false,
      code: "auth_expired",
      message: `${provider.displayName} account is not linked`,
      retrySafe: false,
    };
  }
  if (!deps.stripe || !deps.stateCrypto || !deps.providerOps) {
    await decide("unknown", { ok: false, missing: "stripe/state key/executor" });
    return {
      ok: false,
      code: "unknown",
      message: "card setup is not configured on this server",
      retrySafe: false,
    };
  }
  const state = openState(deps.stateCrypto, account.stateEncrypted);
  if (!state) {
    await decide("auth_expired", { ok: false, stateUnreadable: true });
    await markAccountExpired(deps, userId, provider);
    return {
      ok: false,
      code: "auth_expired",
      message: "stored provider state could not be decrypted (key rotated?)",
      retrySafe: false,
    };
  }

  const ops = deps.providerOps(provider.id, state);
  const secret = await deps.stripe.retrieveCardSecret(card.stripeCardId);
  const result = await ops.setupCard({
    number: secret.number,
    cvc: secret.cvc,
    expMonth: secret.expMonth,
    expYear: secret.expYear,
    brand: secret.brand,
  });
  // Blank our copies the moment the form is done with them.
  secret.number = "";
  secret.cvc = "";

  if (!result.ok) {
    await decide(result.code, { ok: false, message: result.message });
    if (result.code === "auth_expired") {
      await markAccountExpired(deps, userId, provider);
    }
    return {
      ok: false,
      code: result.code,
      message: result.message,
      retrySafe: retrySafeFor(result.code),
    };
  }

  // The card is live on the provider: pending_onboarding graduates to
  // active, and the account remembers its payment method is ours.
  await deps.db.issuingCard.update({
    where: { stripeCardId: card.stripeCardId },
    data: { status: "active" },
  });
  await deps.db.providerAccount.update({
    where: { userId_provider: { userId, provider: provider.id } },
    data: { cardAdded: true },
  });
  await decide("setup_ok", { ok: true });
  return { ok: true, dryRun: false };
}
