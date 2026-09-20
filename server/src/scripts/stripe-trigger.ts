/**
 * Fire a test-mode Issuing authorization at the user's card so the
 * /webhooks/stripe real-time path is exercised end to end. Run
 * `stripe listen --forward-to localhost:3000/webhooks/stripe` (and the dev
 * server) first; Stripe holds this call open until the webhook answers, so
 * the printed `approved` is the webhook's actual decision.
 *
 * Usage:
 *   pnpm -C server stripe:trigger -- --user <users.id> [--amount 7.28]
 *       [--category parking_lots_garages]
 *
 * Try `--category taxicabs_limousines` for the wrong-MCC decline, or an
 * --amount above policy.daily_cap_usd for the budget decline. (The bare
 * Stripe CLI `stripe trigger issuing_authorization.request` also works but
 * invents its own card, so our webhook declines it as unknown_card.)
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config } from "dotenv";
import Stripe from "stripe";

import { createPrisma } from "../db.js";
import { usdToCents } from "../services/issuing.js";

// stripe v22 doesn't re-export TestHelpers.Issuing.AuthorizationCreateParams
// through the top-level namespace; derive the MCC union from the method.
type AuthorizationCreateParams = Parameters<
  Stripe["testHelpers"]["issuing"]["authorizations"]["create"]
>[0];
type MerchantCategory = NonNullable<
  NonNullable<AuthorizationCreateParams["merchant_data"]>["category"]
>;

// Secrets live in the repo-root .env (see .env.example), not in server/.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      user: { type: "string" },
      amount: { type: "string", default: "7.28" },
      category: { type: "string", default: "parking_lots_garages" },
    },
  });
  if (!flags.user) {
    console.error(
      "Usage: pnpm -C server stripe:trigger -- --user <users.id> [--amount 7.28] [--category parking_lots_garages]",
    );
    return 1;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!databaseUrl || !stripeKey) {
    console.error("DATABASE_URL and STRIPE_SECRET_KEY must be set (repo-root .env).");
    return 1;
  }

  const prisma = createPrisma(databaseUrl);
  try {
    const cardholder = await prisma.issuingCardholder.findUnique({
      where: { userId: flags.user },
      include: { cards: true },
    });
    const card = cardholder?.cards[0];
    if (!card) {
      console.error(`No issuing card for user ${flags.user} — run issuing:setup first.`);
      return 1;
    }

    const stripe = new Stripe(stripeKey);
    const auth = await stripe.testHelpers.issuing.authorizations.create({
      card: card.stripeCardId,
      amount: usdToCents(Number(flags.amount)),
      currency: "usd",
      merchant_data: {
        category: flags.category as MerchantCategory,
        name: "PARKNYC TEST METER",
        city: "New York",
        state: "NY",
        country: "US",
      },
    });
    console.log(
      `authorization ${auth.id}: approved=${auth.approved} ` +
        `($${flags.amount}, ${flags.category}) — see issuing_authorizations/decisions for the why`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
