/**
 * The narrow slice of the Stripe SDK the webhook route uses, mirroring the
 * AppDb pattern: routes and tests are written against this interface, so
 * tests fake it instead of mocking the SDK module.
 *
 * Real-time authorization decisions are returned in the webhook's HTTP
 * response (see routes/webhooksStripe.ts), not via an approve/decline API
 * call — those calls are deprecated — so the gateway only verifies events
 * and surfaces the API version to stamp on that response.
 */

import Stripe from "stripe";

export interface StripeGateway {
  /** Verify the stripe-signature header and parse the event. Throws on a bad signature. */
  verifyEvent(payload: Buffer, signature: string): Stripe.Event;
  /** The SDK's pinned API version; the fallback Stripe-Version for responses. */
  apiVersion: string;
}

export function makeStripeGateway(secretKey: string, webhookSecret: string): StripeGateway {
  const stripe = new Stripe(secretKey);
  return {
    verifyEvent: (payload, signature) =>
      stripe.webhooks.constructEvent(payload, signature, webhookSecret),
    apiVersion: stripe.getApiField("version") as string,
  };
}
