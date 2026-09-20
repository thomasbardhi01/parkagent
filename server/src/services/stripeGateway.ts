/**
 * The narrow slice of the Stripe SDK the routes use, mirroring the AppDb
 * pattern: routes and tests are written against this interface, so tests
 * fake it instead of mocking the SDK module.
 *
 * Real-time authorization decisions are returned in the webhook's HTTP
 * response (see routes/webhooksStripe.ts), not via an approve/decline API
 * call — those calls are deprecated — so for the webhook the gateway only
 * verifies events and surfaces the API version to stamp on that response.
 *
 * The card routes (routes/card.ts) add Issuing reads and writes plus the
 * financial-account funding calls. Funding uses the v2 money-management
 * APIs, which are preview-versioned and not yet in the SDK's typed surface,
 * so those go through stripe.rawRequest with an explicit Stripe-Version.
 */

import Stripe from "stripe";

import { usdToCents } from "./issuing.js";

/** Preview version the v2 money-management endpoints require. */
const MONEY_MANAGEMENT_VERSION = "2026-08-26.preview";

/** Card facts we don't mirror in the database (the PAN never comes back). */
export interface IssuingCardDetails {
  brand: string;
  expMonth: number;
  expYear: number;
  cardholderName: string;
  status: string;
}

/** Short-lived key the app uses to read card details from Stripe directly. */
export interface IssuingEphemeralKey {
  secret: string;
  apiVersion: string;
  expiresAt: Date;
}

export interface FundingBalance {
  balanceUsd: number;
  pendingUsd: number;
}

/**
 * The financial account isn't ready for the requested move — no account
 * discovered, no financial address, no payout recipient configured. Routes
 * turn this into a clear "not available yet" response instead of a 500.
 */
export class FundingUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "FundingUnavailableError";
  }
}

export interface StripeGateway {
  /** Verify the stripe-signature header and parse the event. Throws on a bad signature. */
  verifyEvent(payload: Buffer, signature: string): Stripe.Event;
  /** The SDK's pinned API version; the fallback Stripe-Version for responses. */
  apiVersion: string;
  /** Live card facts (brand, expiry, cardholder name) — never the PAN. */
  retrieveCard(stripeCardId: string): Promise<IssuingCardDetails>;
  /** Freeze/unfreeze: flip the Stripe card between active and inactive. */
  setCardStatus(stripeCardId: string, status: "active" | "inactive"): Promise<string>;
  /**
   * Ephemeral key scoped to one Issuing card, for client-side PAN reveal.
   * `apiVersion` lets a Stripe client SDK ask for the version it speaks;
   * `nonce` supports the Issuing Elements flow. Both optional.
   */
  createEphemeralKey(
    stripeCardId: string,
    options?: { nonce?: string; apiVersion?: string },
  ): Promise<IssuingEphemeralKey>;
  /** Available + pending USD on the financial account backing the cards. */
  fundingBalance(): Promise<FundingBalance>;
  /** Test-mode credit into the financial account (simulated ACH). */
  fundingTopup(amountUsd: number): Promise<void>;
  /** Outbound payment off the financial account to the configured recipient. */
  fundingWithdraw(amountUsd: number): Promise<void>;
}

export interface FundingConfig {
  /** fa_… id; discovered from an existing card when not set. */
  financialAccount?: string | undefined;
  /** Global Payouts recipient (acct id) withdrawals pay out to. */
  payoutRecipient?: string | undefined;
}

export function makeStripeGateway(
  secretKey: string,
  webhookSecret: string,
  funding: FundingConfig = {},
): StripeGateway {
  const stripe = new Stripe(secretKey);
  let cachedFinancialAccount: string | undefined = funding.financialAccount;

  // v2 amounts are integer minor units keyed by currency; absent means zero.
  const usdOf = (amount: unknown): number => {
    const value = (amount as { value?: unknown } | null | undefined)?.value;
    return typeof value === "number" ? value / 100 : 0;
  };

  const v2 = (method: "get" | "post", path: string, params?: Record<string, unknown>) =>
    stripe.rawRequest(method, path, params, { apiVersion: MONEY_MANAGEMENT_VERSION }) as Promise<
      Record<string, unknown>
    >;

  /**
   * The financial account the cards draw from: explicit config wins, else
   * borrow the one an existing Issuing card uses (same discovery as
   * scripts/issuing-setup.ts). None found → funding isn't ready.
   */
  async function resolveFinancialAccount(): Promise<string> {
    if (cachedFinancialAccount) return cachedFinancialAccount;
    const cards = await stripe.issuing.cards.list({ limit: 1 });
    const card = cards.data[0];
    const v2Id = (card as unknown as { financial_account_v2?: string } | undefined)
      ?.financial_account_v2;
    const id = v2Id ?? card?.financial_account ?? undefined;
    if (!id) throw new FundingUnavailableError("no_financial_account");
    cachedFinancialAccount = id;
    return id;
  }

  /** The account's financial address (needed by the test-mode credit helper). */
  async function resolveFinancialAddress(financialAccount: string): Promise<string> {
    const list = await v2("get", "/v2/money_management/financial_addresses");
    const rows = (list["data"] ?? []) as { id?: string; financial_account?: string }[];
    const existing = rows.find((a) => a.financial_account === financialAccount);
    const address =
      existing ??
      ((await v2("post", "/v2/money_management/financial_addresses", {
        financial_account: financialAccount,
        currency: "usd",
      })) as { id?: string });
    if (!address.id) throw new FundingUnavailableError("no_financial_address");
    return address.id;
  }

  return {
    verifyEvent: (payload, signature) =>
      stripe.webhooks.constructEvent(payload, signature, webhookSecret),
    apiVersion: stripe.getApiField("version") as string,

    retrieveCard: async (stripeCardId) => {
      const card = await stripe.issuing.cards.retrieve(stripeCardId);
      const cardholder = typeof card.cardholder === "string" ? null : card.cardholder;
      return {
        brand: card.brand,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        cardholderName: cardholder?.name ?? "",
        status: card.status,
      };
    },

    setCardStatus: async (stripeCardId, status) => {
      const card = await stripe.issuing.cards.update(stripeCardId, { status });
      return card.status;
    },

    createEphemeralKey: async (stripeCardId, options = {}) => {
      const apiVersion = options.apiVersion ?? (stripe.getApiField("version") as string);
      const key = await stripe.ephemeralKeys.create(
        { issuing_card: stripeCardId, ...(options.nonce ? { nonce: options.nonce } : {}) },
        { apiVersion },
      );
      return {
        secret: key.secret ?? "",
        apiVersion,
        expiresAt: new Date(key.expires * 1000),
      };
    },

    fundingBalance: async () => {
      const financialAccount = await resolveFinancialAccount();
      const account = await v2(
        "get",
        `/v2/money_management/financial_accounts/${financialAccount}`,
      );
      const balance = (account["balance"] ?? {}) as Record<string, Record<string, unknown>>;
      return {
        balanceUsd: usdOf(balance["available"]?.["usd"]),
        pendingUsd:
          usdOf(balance["inbound_pending"]?.["usd"]) + usdOf(balance["outbound_pending"]?.["usd"]),
      };
    },

    fundingTopup: async (amountUsd) => {
      const financialAccount = await resolveFinancialAccount();
      const address = await resolveFinancialAddress(financialAccount);
      // Sandbox-only helper: simulates an ACH credit arriving at the
      // account's financial address. Live funding is a later phase.
      await v2("post", `/v2/test_helpers/financial_addresses/${address}/credit`, {
        amount: { value: usdToCents(amountUsd), currency: "usd" },
        network: "ach",
      });
    },

    fundingWithdraw: async (amountUsd) => {
      if (!funding.payoutRecipient) throw new FundingUnavailableError("no_payout_recipient");
      const financialAccount = await resolveFinancialAccount();
      await v2("post", "/v2/money_management/outbound_payments", {
        from: { financial_account: financialAccount, currency: "usd" },
        to: { recipient: funding.payoutRecipient },
        amount: { value: usdToCents(amountUsd), currency: "usd" },
        description: "ParkAgent card withdraw",
      });
    },
  };
}
