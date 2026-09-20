/**
 * Create (or sync) the Stripe Issuing cardholder and one virtual card for a
 * user, with spending controls from policy.json:
 *   - allowed_categories: parking_lots_garages (MCC 7523) only
 *   - per_authorization limit = session_cap_usd
 *   - daily limit           = daily_cap_usd
 *
 * Usage:
 *   pnpm -C server issuing:setup -- --user <users.id> [--email <email>]
 *       [--financial-account <fa_…>]
 *
 * Accounts whose Issuing runs on a money-management financial account
 * require that account's id on card creation. Pass --financial-account (or
 * set STRIPE_FINANCIAL_ACCOUNT); if neither is given the script discovers it
 * from an existing Issuing card on the account. Legacy Issuing balances need
 * none of this — the discovery simply finds nothing and card creation
 * proceeds without it.
 *
 * Idempotent: re-running reuses the existing cardholder/card and re-applies
 * the spending controls from the current policy.json. Only Stripe IDs are
 * stored (non-negotiable) — the PAN stays in Stripe's test-mode dashboard.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config } from "dotenv";
import Stripe from "stripe";

import { createPrisma } from "../db.js";
import { usdToCents } from "../services/issuing.js";
import { PolicyService } from "../services/policy.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

// Cardholders require a billing address; test mode doesn't verify it, so a
// civic placeholder stands in until live Issuing needs the real one.
const BILLING_ADDRESS = {
  line1: "1 Centre St",
  city: "New York",
  state: "NY",
  postal_code: "10007",
  country: "US",
};

// Individual cardholders need a name split and a DOB to clear KYC. Test mode
// doesn't verify these, so the user's name is split on the first space and a
// fixed placeholder DOB stands in, alongside the placeholder billing address.
const PLACEHOLDER_DOB = { day: 1, month: 1, year: 1990 };
// Required for 3D Secure on issued cards; a test-mode placeholder.
const PLACEHOLDER_PHONE = "+15555550123";

function individualDetails(name: string): Stripe.Issuing.CardholderCreateParams.Individual {
  const trimmed = name.trim();
  const space = trimmed.indexOf(" ");
  const firstName = space === -1 ? trimmed : trimmed.slice(0, space);
  const lastName = space === -1 ? "Cardholder" : trimmed.slice(space + 1);
  return { first_name: firstName, last_name: lastName, dob: PLACEHOLDER_DOB };
}

/**
 * The financial account a new card draws from. An explicit id (flag or
 * STRIPE_FINANCIAL_ACCOUNT) wins; otherwise borrow the one an existing
 * Issuing card on the account already uses. Returns undefined on a legacy
 * balance account (no cards, no financial account), where card creation
 * needs no such id.
 */
async function resolveFinancialAccount(
  stripe: Stripe,
  explicit: string | undefined,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const cards = await stripe.issuing.cards.list({ limit: 1 });
  const card = cards.data[0];
  if (!card) return undefined;
  // Money-management accounts expose it as `financial_account_v2`, not yet in
  // the SDK's Card type; fall back to the typed `financial_account`.
  const v2 = (card as unknown as { financial_account_v2?: string }).financial_account_v2;
  return v2 ?? card.financial_account ?? undefined;
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      user: { type: "string" },
      email: { type: "string" },
      "financial-account": { type: "string" },
    },
  });
  if (!flags.user) {
    console.error(
      "Usage: pnpm -C server issuing:setup -- --user <users.id> [--email <email>] [--financial-account <fa_…>]",
    );
    return 1;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!databaseUrl || !stripeKey) {
    console.error("DATABASE_URL and STRIPE_SECRET_KEY must be set (repo-root .env).");
    return 1;
  }

  const policy = new PolicyService(
    fileURLToPath(new URL("../../../policy.json", import.meta.url)),
    process.env["DRY_RUN"] === "true",
  ).get();
  const spendingControls: Stripe.Issuing.CardUpdateParams.SpendingControls = {
    allowed_categories: ["parking_lots_garages"],
    spending_limits: [
      { amount: usdToCents(policy.session_cap_usd), interval: "per_authorization" },
      { amount: usdToCents(policy.daily_cap_usd), interval: "daily" },
    ],
  };

  const stripe = new Stripe(stripeKey);
  const prisma = createPrisma(databaseUrl);
  try {
    const user = await prisma.user.findUnique({ where: { id: flags.user } });
    if (!user) {
      console.error(`No user with id ${flags.user} (see create:user).`);
      return 1;
    }

    const individual = individualDetails(user.name);
    let cardholder = await prisma.issuingCardholder.findUnique({
      where: { userId: user.id },
    });
    if (!cardholder) {
      const created = await stripe.issuing.cardholders.create({
        type: "individual",
        name: user.name,
        phone_number: PLACEHOLDER_PHONE,
        individual,
        ...(flags.email ? { email: flags.email } : {}),
        billing: { address: BILLING_ADDRESS },
      });
      cardholder = await prisma.issuingCardholder.create({
        data: { userId: user.id, stripeCardholderId: created.id, name: user.name },
      });
      console.log(`cardholder created: ${created.id}`);
    } else {
      // Backfill KYC on a cardholder that predates these fields, so a rerun
      // clears any past-due requirement before card creation.
      await stripe.issuing.cardholders.update(cardholder.stripeCardholderId, {
        phone_number: PLACEHOLDER_PHONE,
        individual,
      });
      console.log(`cardholder exists: ${cardholder.stripeCardholderId}`);
    }

    const existingCard = await prisma.issuingCard.findFirst({
      where: { cardholderId: cardholder.id },
    });
    if (!existingCard) {
      const financialAccount = await resolveFinancialAccount(
        stripe,
        flags["financial-account"] ?? process.env["STRIPE_FINANCIAL_ACCOUNT"],
      );
      const card = await stripe.issuing.cards.create({
        cardholder: cardholder.stripeCardholderId,
        currency: "usd",
        type: "virtual",
        status: "active",
        spending_controls: spendingControls,
        // Required on money-management Issuing accounts; omitted on legacy
        // balance accounts, where discovery returns undefined. The param is
        // `financial_account_v2` (not yet in the SDK's CardCreateParams type).
        ...(financialAccount ? { financial_account_v2: financialAccount } : {}),
      } as Stripe.Issuing.CardCreateParams);
      await prisma.issuingCard.create({
        data: {
          cardholderId: cardholder.id,
          stripeCardId: card.id,
          last4: card.last4,
          status: card.status,
          perAuthCapUsd: policy.session_cap_usd,
          dailyCapUsd: policy.daily_cap_usd,
        },
      });
      console.log(
        `card created: ${card.id} (…${card.last4})` +
          (financialAccount ? ` on ${financialAccount}` : ""),
      );
    } else {
      // Re-apply controls so the card tracks the current policy.json.
      await stripe.issuing.cards.update(existingCard.stripeCardId, {
        spending_controls: spendingControls,
      });
      await prisma.issuingCard.update({
        where: { id: existingCard.id },
        data: {
          perAuthCapUsd: policy.session_cap_usd,
          dailyCapUsd: policy.daily_cap_usd,
        },
      });
      console.log(
        `card exists: ${existingCard.stripeCardId} (…${existingCard.last4}), controls re-applied`,
      );
    }
    console.log(
      `controls: parking_lots_garages only, ` +
        `$${policy.session_cap_usd}/authorization, $${policy.daily_cap_usd}/day`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
