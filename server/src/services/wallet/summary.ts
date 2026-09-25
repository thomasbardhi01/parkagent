/**
 * GET /wallet: one answer to "how am I paying, and what have I spent".
 * The three ways to pay with their availability, the active one's details,
 * each parking account and what pays there, spend against the caps, and
 * the first page of Activity. The app composes all copy from these facts
 * (provider names come from the registry here, never hardcoded).
 */

import type { AppDeps } from "../../app.js";
import { allProviders, providerStatusUsable } from "../../providers/registry.js";
import { nycStartOfMonth } from "../hours.js";
import { LINK_MANAGE_URL } from "../link/linkClient.js";
import type { LinkPaymentMethodSummary } from "../link/linkClient.js";
import type { PendingLinkApproval } from "../link/linkWallet.js";
import { spentToday } from "../sessions.js";
import { activityPage } from "./activity.js";
import type { ActivityPage } from "./activity.js";
import { parkAgentCardOf } from "./parkagentCard.js";

export type PaymentSourceId = "provider_card" | "link_wallet" | "parkagent_card";

export const PAYMENT_SOURCES: PaymentSourceId[] = [
  "provider_card",
  "link_wallet",
  "parkagent_card",
];

/** Stored values from before the rename read as the new one. */
export function normalizeSource(stored: string | null | undefined): PaymentSourceId {
  if (stored === "issuing_card" || stored === "parkagent_card") return "parkagent_card";
  if (stored === "link_wallet") return "link_wallet";
  return "provider_card";
}

export interface SourceOption {
  source: PaymentSourceId;
  /** available | connect (a one-time setup step first) | coming_soon */
  availability: "available" | "connect" | "coming_soon";
  /** What the setup step is, when availability is "connect". */
  needs: "connect_link" | "add_card" | null;
  /** parkagent_card only: selectable by a Debug build against a test-mode
   * Stripe key before ISSUING_LIVE (nothing real can be charged). */
  sandbox: boolean;
}

export interface WalletSummary {
  activeSource: PaymentSourceId;
  dryRun: boolean;
  options: SourceOption[];
  providerCard: {
    cards: {
      provider: string;
      displayName: string;
      city: string;
      brand: string | null;
      last4: string;
    }[];
  };
  link: {
    configured: boolean;
    connected: boolean;
    paymentMethod: LinkPaymentMethodSummary | null;
    pendingApprovals: PendingLinkApproval[];
    manageUrl: string;
    /** What Link pays: assistant plans' garage stops and garage bookings —
     * street meters stay on the card on the provider account. */
    covers: "plans_and_garages";
  };
  parkagentCard: {
    live: boolean;
    sandboxSelectable: boolean;
    fundingMethods: {
      id: string;
      brand: string;
      last4: string;
      wallet: string | null;
      expMonth: number | null;
      expYear: number | null;
      isDefault: boolean;
    }[];
    card: {
      stripeCardId: string;
      last4: string;
      brand: string | null;
      /** pending_onboarding | active | inactive (frozen) | canceled */
      status: string;
      expMonth: number | null;
      expYear: number | null;
      cardholderName: string | null;
    } | null;
  };
  providers: {
    id: string;
    city: string;
    cityDisplayName: string;
    displayName: string;
    /** linked | expiring | expired | unlinked */
    status: string;
    /** What pays street meters on this account under the active source;
     * null while the account can't pay at all (not connected / expired). */
    paysWith: {
      source: "provider_card" | "parkagent_card";
      brand: string | null;
      last4: string | null;
    } | null;
    /** What the user should do here, if anything:
     * connect | reconnect | add_parkagent_card (the ParkAgent card isn't on
     * this account yet) | own_card_replaced (the account carries the
     * ParkAgent card but another source is active — add your own card back
     * in the provider's app). */
    attention: "connect" | "reconnect" | "add_parkagent_card" | "own_card_replaced" | null;
  }[];
  spending: {
    todayUsd: number;
    dailyCapUsd: number;
    sessionCapUsd: number;
    monthUsd: number;
    byCity: { city: string; cityDisplayName: string; monthUsd: number }[];
  };
  activity: ActivityPage;
}

const round2 = (usd: number) => Math.round(usd * 100) / 100;

export async function walletSummary(
  deps: AppDeps,
  userId: string,
  at: Date,
  pageOptions: { activityLimit: number },
): Promise<WalletSummary> {
  const policy = deps.policy.get();
  const dryRun = deps.policy.effectiveDryRun();
  const user = await deps.db.user.findUnique({
    where: { id: userId },
    select: { paymentSource: true, stripeCustomerId: true },
  });
  const activeSource = normalizeSource(user?.paymentSource);

  const [accounts, fundingRows, parkagent, linkStatus, activity, monthSessions] = await Promise.all(
    [
      deps.db.providerAccount.findMany({ where: { userId } }),
      deps.db.fundingMethod.findMany({ where: { userId, removedAt: null } }),
      parkAgentCardOf(deps.db, userId),
      deps.linkWallet?.status(userId) ?? Promise.resolve({ connected: false, connectedAt: null }),
      activityPage(deps.db, userId, { limit: pageOptions.activityLimit }),
      deps.db.session.findMany({
        where: {
          userId,
          dryRun: false,
          status: { in: ["pending", "active", "stopped", "expired"] },
          createdAt: { gte: nycStartOfMonth(at) },
        },
      }),
    ],
  );

  // ---- Link
  const linkConfigured = deps.linkWallet?.configured === true;
  const linkConnected = linkConfigured && linkStatus.connected;
  const [linkPaymentMethod, pendingApprovals] = linkConnected
    ? await Promise.all([
        deps.linkWallet!.paymentMethod(userId),
        deps.linkWallet!.pendingApprovals(userId),
      ])
    : [null, []];

  // ---- ParkAgent card
  const live = deps.issuingLive === true;
  const sandboxSelectable = !live && deps.issuingSandbox === true && deps.stripe !== undefined;
  const fundingMethods = fundingRows
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .map((m) => ({
      id: m.id,
      brand: m.brand,
      last4: m.last4,
      wallet: m.wallet,
      expMonth: m.expMonth,
      expYear: m.expYear,
      isDefault: m.isDefault,
    }));
  let card: WalletSummary["parkagentCard"]["card"] = null;
  if (parkagent) {
    card = {
      stripeCardId: parkagent.card.stripeCardId,
      last4: parkagent.card.last4,
      brand: null,
      status: parkagent.card.status,
      expMonth: null,
      expYear: null,
      cardholderName: parkagent.holder.name,
    };
    // Live facts (brand, expiry, name) are Stripe's; the card still renders
    // from our mirror when Stripe can't be asked.
    if (deps.stripe) {
      try {
        const details = await deps.stripe.retrieveCard(parkagent.card.stripeCardId);
        card = {
          ...card,
          brand: details.brand,
          expMonth: details.expMonth,
          expYear: details.expYear,
          cardholderName: details.cardholderName || parkagent.holder.name,
          // pending_onboarding is our overlay; otherwise Stripe's status.
          status: parkagent.card.status === "pending_onboarding" ? card.status : details.status,
        };
      } catch {
        // best effort
      }
    }
  }

  // ---- The three options
  const options: SourceOption[] = [
    { source: "provider_card", availability: "available", needs: null, sandbox: false },
    !linkConfigured
      ? { source: "link_wallet", availability: "coming_soon", needs: null, sandbox: false }
      : !linkConnected
        ? { source: "link_wallet", availability: "connect", needs: "connect_link", sandbox: false }
        : { source: "link_wallet", availability: "available", needs: null, sandbox: false },
    !live && !sandboxSelectable
      ? { source: "parkagent_card", availability: "coming_soon", needs: null, sandbox: false }
      : fundingMethods.length === 0
        ? {
            source: "parkagent_card",
            availability: "connect",
            needs: "add_card",
            sandbox: sandboxSelectable,
          }
        : {
            source: "parkagent_card",
            availability: "available",
            needs: null,
            sandbox: sandboxSelectable,
          },
  ];

  // ---- Parking accounts
  const providers = allProviders().map((p) => {
    const account = accounts.find((a) => a.provider === p.id);
    const status = account?.status ?? "unlinked";
    const usable = providerStatusUsable(status);
    const cardAdded = account?.cardAdded === true;
    let paysWith: WalletSummary["providers"][number]["paysWith"] = null;
    let attention: WalletSummary["providers"][number]["attention"] = null;
    if (!account || status === "unlinked") attention = "connect";
    else if (!usable || status === "expiring") attention = "reconnect";
    if (usable) {
      if (activeSource === "parkagent_card") {
        paysWith = {
          source: "parkagent_card",
          brand: card?.brand ?? null,
          last4: card?.last4 ?? null,
        };
        if (!cardAdded && !dryRun) attention = "add_parkagent_card";
      } else {
        paysWith = {
          source: "provider_card",
          brand: account?.cardBrand ?? null,
          last4: account?.cardLast4 ?? null,
        };
        // Our card replaced theirs when the ParkAgent card was active; it
        // pays nothing without a hold, so their own card must go back on.
        if (cardAdded) attention = "own_card_replaced";
      }
    }
    return {
      id: p.id,
      city: p.city,
      cityDisplayName: p.cityDisplayName,
      displayName: p.displayName,
      status,
      paysWith,
      attention,
    };
  });

  // ---- Spending (real money only — dry-run sessions moved none)
  const sessionTotal = (s: { amountUsd: unknown; feeUsd: unknown }) =>
    Number(s.amountUsd ?? 0) + Number(s.feeUsd ?? 0);
  const monthUsd = round2(monthSessions.reduce((sum, s) => sum + sessionTotal(s), 0));
  const byCity = allProviders()
    .map((p) => ({
      city: p.city,
      cityDisplayName: p.cityDisplayName,
      monthUsd: round2(
        monthSessions.filter((s) => s.city === p.city).reduce((sum, s) => sum + sessionTotal(s), 0),
      ),
    }))
    .sort((a, b) => a.cityDisplayName.localeCompare(b.cityDisplayName));

  return {
    activeSource,
    dryRun,
    options,
    providerCard: {
      cards: accounts
        .filter((a) => providerStatusUsable(a.status) && a.cardLast4)
        .map((a) => {
          const p = allProviders().find((x) => x.id === a.provider);
          return {
            provider: a.provider,
            displayName: p?.displayName ?? a.provider,
            city: p?.city ?? "",
            brand: a.cardBrand ?? null,
            last4: a.cardLast4!,
          };
        }),
    },
    link: {
      configured: linkConfigured,
      connected: linkConnected,
      paymentMethod: linkPaymentMethod,
      pendingApprovals,
      manageUrl: LINK_MANAGE_URL,
      covers: "plans_and_garages",
    },
    parkagentCard: { live, sandboxSelectable, fundingMethods, card },
    providers,
    spending: {
      todayUsd: round2(await spentToday(deps.db, userId, at)),
      dailyCapUsd: policy.daily_cap_usd,
      sessionCapUsd: policy.session_cap_usd,
      monthUsd,
      byCity,
    },
    activity,
  };
}
