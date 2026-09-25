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
 *
 * The Wallet (routes/wallet.ts, services/wallet/) adds the ParkAgent card's
 * funding: a Stripe Customer per user, SetupIntents that save the user's own
 * card (Apple Pay or card entry via PaymentSheet), and per-session holds —
 * manual-capture PaymentIntents placed off-session before the executor pays,
 * captured for what the ParkAgent card actually paid, the rest released.
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

/** What the provider payment form needs; see providerOps.CardFormDetails.
 * Handled like a password: never logged, never stored, never returned. */
export interface IssuingCardSecret {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  brand: string;
  last4: string;
}

/** One of the user's own saved cards, as the Wallet shows it. */
export interface FundingCardDetails {
  paymentMethodId: string;
  /** The Customer it is attached to (null when detached). */
  customerId: string | null;
  /** Display brand ("Visa", "Mastercard", …) — normalized from Stripe's
   * lowercase card.brand. */
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  /** "apple_pay" when the card was tokenized by Apple Pay, else null. */
  wallet: string | null;
}

/** What a SetupIntent became (POST /wallet/funding-methods reads it). */
export interface SetupIntentState {
  setupIntentId: string;
  /** Stripe status: "succeeded" once the card is saved. */
  status: string;
  customerId: string | null;
  paymentMethodId: string | null;
}

/** A hold attempt's outcome. A decline is an answer, not an exception:
 * the caller records it, pays nothing, and asks the user to update the
 * card. Other Stripe failures throw. */
export type HoldAttempt =
  | { ok: true; paymentIntentId: string }
  | {
      ok: false;
      /** Present when Stripe created the intent before refusing it. */
      paymentIntentId: string | null;
      /** Stripe decline_code / error code, e.g. "insufficient_funds",
       * "authentication_required" (off-session SCA), "card_declined". */
      declineCode: string;
      message: string;
    };

/** Stripe's card.brand values → the names the app shows. */
export function displayBrand(brand: string | null | undefined): string {
  switch ((brand ?? "").toLowerCase()) {
    case "visa":
      return "Visa";
    case "mastercard":
      return "Mastercard";
    case "amex":
      return "American Express";
    case "discover":
      return "Discover";
    case "diners":
      return "Diners Club";
    case "jcb":
      return "JCB";
    case "unionpay":
      return "UnionPay";
    default:
      return brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card";
  }
}

/** Test-mode keys can't move real money; the Wallet lets a Debug build
 * choose the ParkAgent card against them before ISSUING_LIVE. */
export function isTestModeKey(secretKey: string | undefined): boolean {
  return secretKey !== undefined && /^(sk|rk)_test_/.test(secretKey);
}

export interface StripeGateway {
  /** Verify the stripe-signature header and parse the event. Throws on a bad signature. */
  verifyEvent(payload: Buffer, signature: string): Stripe.Event;
  /** The SDK's pinned API version; the fallback Stripe-Version for responses. */
  apiVersion: string;
  /** Live card facts (brand, expiry, cardholder name) — never the PAN. */
  retrieveCard(stripeCardId: string): Promise<IssuingCardDetails>;
  /**
   * The sensitive fields (expand number/cvc), for filling the provider's
   * payment form server-side. Callers must not log or persist the result.
   */
  retrieveCardSecret(stripeCardId: string): Promise<IssuingCardSecret>;
  /** Freeze/unfreeze/cancel the Stripe card. Cancel is permanent. */
  setCardStatus(stripeCardId: string, status: "active" | "inactive" | "canceled"): Promise<string>;
  /** Lazy provisioning (POST /card/prepare): cardholder + virtual card. */
  createCardholder(name: string): Promise<{ stripeCardholderId: string }>;
  createCard(
    stripeCardholderId: string,
    controls: { perAuthUsd: number; dailyUsd: number },
  ): Promise<{ stripeCardId: string; last4: string; status: string }>;
  /** Closest thing Stripe has to deleting a cardholder (janitor cleanup). */
  deactivateCardholder(stripeCardholderId: string): Promise<void>;
  /** Apple Pay top-up: the intent the app confirms client-side. */
  createPaymentIntent(
    amountUsd: number,
    metadata: Record<string, string>,
  ): Promise<{ paymentIntentId: string; clientSecret: string }>;
  /** Move settled top-up money onto the financial account backing the cards. */
  moveToFinancialAccount(amountUsd: number): Promise<void>;
  /**
   * Ephemeral key scoped to one Issuing card, for client-side PAN reveal.
   * `apiVersion` lets a Stripe client SDK ask for the version it speaks;
   * `nonce` supports the Issuing Elements flow. Both optional.
   */
  createEphemeralKey(
    stripeCardId: string,
    options?: { nonce?: string; apiVersion?: string },
  ): Promise<IssuingEphemeralKey>;
  /**
   * Shadow mode: fire a TEST-MODE Issuing authorization at the user's card
   * (Stripe's test helper, same as scripts/stripe-trigger.ts) so the
   * webhook, budget checks, and ledger run in parallel with a real provider
   * spend. Never moves real money; test keys only.
   */
  createTestAuthorization(
    stripeCardId: string,
    amountUsd: number,
    merchant: { name: string; city: string; state: string },
  ): Promise<{ authorizationId: string; approved: boolean }>;
  /** Available + pending USD on the financial account backing the cards. */
  fundingBalance(): Promise<FundingBalance>;
  /** Test-mode credit into the financial account (simulated ACH). */
  fundingTopup(amountUsd: number): Promise<void>;
  /** Outbound payment off the financial account to the configured recipient. */
  fundingWithdraw(amountUsd: number): Promise<void>;

  // ---- Wallet: the ParkAgent card's funding (see services/wallet/) ----

  /** The user's Stripe Customer. The idempotency key (per user) makes two
   * racing setup-intents get the SAME customer back from Stripe. */
  createCustomer(
    args: { userId: string; name: string; email?: string | null },
    idempotencyKey: string,
  ): Promise<{ customerId: string }>;
  /** DELETE /me: the person goes, and their saved cards with them. */
  deleteCustomer(customerId: string): Promise<void>;
  /** Saves a card for later off-session holds (usage off_session). The app
   * confirms it with Apple Pay or PaymentSheet; nothing is charged. */
  createSetupIntent(customerId: string): Promise<{ setupIntentId: string; clientSecret: string }>;
  retrieveSetupIntent(setupIntentId: string): Promise<SetupIntentState>;
  retrievePaymentMethod(paymentMethodId: string): Promise<FundingCardDetails>;
  /** invoice_settings.default_payment_method — mirrors our is_default. */
  setCustomerDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  /**
   * Place a hold: a manual-capture PaymentIntent confirmed off-session on
   * the saved card. Idempotent per key (one hold per session leg). A decline
   * comes back as `ok: false`; anything else throws.
   */
  createHold(args: {
    customerId: string;
    paymentMethodId: string;
    amountUsd: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<HoldAttempt>;
  /** Capture part of a hold; Stripe releases the uncaptured remainder. */
  captureHold(
    paymentIntentId: string,
    amountUsd: number,
    idempotencyKey: string,
  ): Promise<{ status: string }>;
  /** Release a hold entirely (nothing captured). */
  cancelHold(paymentIntentId: string, idempotencyKey: string): Promise<{ status: string }>;
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

  // Cardholders require billing/KYC details; test mode doesn't verify them,
  // so civic placeholders stand in (same values as scripts/issuing-setup.ts)
  // until live Issuing needs the real ones.
  const BILLING_ADDRESS = {
    line1: "1 Centre St",
    city: "New York",
    state: "NY",
    postal_code: "10007",
    country: "US",
  };
  const PLACEHOLDER_DOB = { day: 1, month: 1, year: 1990 };
  const PLACEHOLDER_PHONE = "+15555550123";

  /** Sandbox credit into the financial account via its financial address. */
  async function creditFinancialAccount(amountUsd: number): Promise<void> {
    const financialAccount = await resolveFinancialAccount();
    const address = await resolveFinancialAddress(financialAccount);
    // Sandbox-only helper: simulates an ACH credit arriving at the
    // account's financial address. Live funding is a later phase (v1
    // balance transfer / real top-up).
    await v2("post", `/v2/test_helpers/financial_addresses/${address}/credit`, {
      amount: { value: usdToCents(amountUsd), currency: "usd" },
      network: "ach",
    });
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

    retrieveCardSecret: async (stripeCardId) => {
      const card = await stripe.issuing.cards.retrieve(stripeCardId, {
        expand: ["number", "cvc"],
      });
      return {
        number: card.number ?? "",
        cvc: card.cvc ?? "",
        expMonth: card.exp_month,
        expYear: card.exp_year,
        brand: card.brand,
        last4: card.last4,
      };
    },

    setCardStatus: async (stripeCardId, status) => {
      const card = await stripe.issuing.cards.update(stripeCardId, { status });
      return card.status;
    },

    createCardholder: async (name) => {
      const trimmed = name.trim();
      const space = trimmed.indexOf(" ");
      const created = await stripe.issuing.cardholders.create({
        type: "individual",
        name: trimmed,
        phone_number: PLACEHOLDER_PHONE,
        individual: {
          first_name: space === -1 ? trimmed : trimmed.slice(0, space),
          last_name: space === -1 ? "Cardholder" : trimmed.slice(space + 1),
          dob: PLACEHOLDER_DOB,
        },
        billing: { address: BILLING_ADDRESS },
      });
      return { stripeCardholderId: created.id };
    },

    createCard: async (stripeCardholderId, controls) => {
      // Money-management accounts require the financial account id on card
      // creation; legacy balance accounts don't have one — create without.
      const financialAccount = await resolveFinancialAccount().catch((err: unknown) => {
        if (err instanceof FundingUnavailableError) return undefined;
        throw err;
      });
      const card = await stripe.issuing.cards.create({
        cardholder: stripeCardholderId,
        currency: "usd",
        type: "virtual",
        status: "active",
        spending_controls: {
          allowed_categories: ["parking_lots_garages"],
          spending_limits: [
            { amount: usdToCents(controls.perAuthUsd), interval: "per_authorization" },
            { amount: usdToCents(controls.dailyUsd), interval: "daily" },
          ],
        },
        // `financial_account_v2` is not yet in the SDK's CardCreateParams
        // type (same workaround as scripts/issuing-setup.ts).
        ...(financialAccount ? { financial_account_v2: financialAccount } : {}),
      } as Stripe.Issuing.CardCreateParams);
      return { stripeCardId: card.id, last4: card.last4, status: card.status };
    },

    deactivateCardholder: async (stripeCardholderId) => {
      await stripe.issuing.cardholders.update(stripeCardholderId, { status: "inactive" });
    },

    createPaymentIntent: async (amountUsd, metadata) => {
      const intent = await stripe.paymentIntents.create({
        amount: usdToCents(amountUsd),
        currency: "usd",
        metadata,
        automatic_payment_methods: { enabled: true },
      });
      return { paymentIntentId: intent.id, clientSecret: intent.client_secret ?? "" };
    },

    moveToFinancialAccount: (amountUsd) => creditFinancialAccount(amountUsd),

    createTestAuthorization: async (stripeCardId, amountUsd, merchant) => {
      const auth = await stripe.testHelpers.issuing.authorizations.create({
        card: stripeCardId,
        amount: usdToCents(amountUsd),
        currency: "usd",
        merchant_data: {
          category: "parking_lots_garages",
          name: merchant.name,
          city: merchant.city,
          state: merchant.state,
          country: "US",
        },
      });
      return { authorizationId: auth.id, approved: auth.approved };
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

    fundingTopup: (amountUsd) => creditFinancialAccount(amountUsd),

    createCustomer: async ({ userId, name, email }, idempotencyKey) => {
      const customer = await stripe.customers.create(
        {
          name,
          ...(email ? { email } : {}),
          metadata: { parkagent: "wallet", userId },
        },
        { idempotencyKey },
      );
      return { customerId: customer.id };
    },

    deleteCustomer: async (customerId) => {
      await stripe.customers.del(customerId);
    },

    createSetupIntent: async (customerId) => {
      const intent = await stripe.setupIntents.create({
        customer: customerId,
        // Saved for holds placed while the user is away from the app.
        usage: "off_session",
        // Apple Pay is a card wallet: "card" covers both entry paths.
        payment_method_types: ["card"],
        metadata: { parkagent: "wallet_setup" },
      });
      return { setupIntentId: intent.id, clientSecret: intent.client_secret ?? "" };
    },

    retrieveSetupIntent: async (setupIntentId) => {
      const intent = await stripe.setupIntents.retrieve(setupIntentId);
      const idOf = (v: unknown): string | null =>
        typeof v === "string" ? v : ((v as { id?: string } | null)?.id ?? null);
      return {
        setupIntentId: intent.id,
        status: intent.status,
        customerId: idOf(intent.customer),
        paymentMethodId: idOf(intent.payment_method),
      };
    },

    retrievePaymentMethod: async (paymentMethodId) => {
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      const customer = pm.customer;
      return {
        paymentMethodId: pm.id,
        customerId: typeof customer === "string" ? customer : (customer?.id ?? null),
        brand: displayBrand(pm.card?.brand),
        last4: pm.card?.last4 ?? "",
        expMonth: pm.card?.exp_month ?? null,
        expYear: pm.card?.exp_year ?? null,
        wallet: pm.card?.wallet?.type ?? null,
      };
    },

    setCustomerDefaultPaymentMethod: async (customerId, paymentMethodId) => {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    },

    detachPaymentMethod: async (paymentMethodId) => {
      await stripe.paymentMethods.detach(paymentMethodId);
    },

    createHold: async ({ customerId, paymentMethodId, amountUsd, metadata, idempotencyKey }) => {
      try {
        const intent = await stripe.paymentIntents.create(
          {
            amount: usdToCents(amountUsd),
            currency: "usd",
            customer: customerId,
            payment_method: paymentMethodId,
            payment_method_types: ["card"],
            capture_method: "manual",
            confirm: true,
            // The user is not in the app when a meter needs paying.
            off_session: true,
            description: "ParkAgent parking hold",
            metadata,
          },
          { idempotencyKey },
        );
        if (intent.status === "requires_capture") {
          return { ok: true, paymentIntentId: intent.id };
        }
        // Anything else can't complete without the user (e.g. an
        // authentication step): release it and report a decline.
        await stripe.paymentIntents.cancel(intent.id).catch(() => undefined);
        return {
          ok: false,
          paymentIntentId: intent.id,
          declineCode:
            intent.status === "requires_action" ? "authentication_required" : intent.status,
          message: `hold ended in status ${intent.status}`,
        };
      } catch (err) {
        const e = err as {
          type?: string;
          code?: string;
          decline_code?: string;
          message?: string;
          payment_intent?: { id?: string };
        };
        if (e.type !== "StripeCardError") throw err;
        return {
          ok: false,
          paymentIntentId: e.payment_intent?.id ?? null,
          declineCode: e.decline_code ?? e.code ?? "card_declined",
          message: (e.message ?? "card declined").split("\n")[0] ?? "card declined",
        };
      }
    },

    captureHold: async (paymentIntentId, amountUsd, idempotencyKey) => {
      const intent = await stripe.paymentIntents.capture(
        paymentIntentId,
        { amount_to_capture: usdToCents(amountUsd) },
        { idempotencyKey },
      );
      return { status: intent.status };
    },

    cancelHold: async (paymentIntentId, idempotencyKey) => {
      const intent = await stripe.paymentIntents.cancel(paymentIntentId, {}, { idempotencyKey });
      return { status: intent.status };
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
