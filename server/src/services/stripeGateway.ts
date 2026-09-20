/**
 * The narrow slice of the Stripe SDK the webhook route uses, mirroring the
 * AppDb pattern: routes and tests are written against this interface, so
 * tests fake three methods instead of mocking the SDK module.
 */

import Stripe from "stripe";

export interface StripeGateway {
  /** Verify the stripe-signature header and parse the event. Throws on a bad signature. */
  verifyEvent(payload: Buffer, signature: string): Stripe.Event;
  /** Respond to a real-time authorization request: approve. */
  approve(authorizationId: string): Promise<void>;
  /** Respond to a real-time authorization request: decline, reason kept in metadata. */
  decline(authorizationId: string, reason: string): Promise<void>;
}

export function makeStripeGateway(secretKey: string, webhookSecret: string): StripeGateway {
  const stripe = new Stripe(secretKey);
  return {
    verifyEvent: (payload, signature) =>
      stripe.webhooks.constructEvent(payload, signature, webhookSecret),
    approve: async (authorizationId) => {
      await stripe.issuing.authorizations.approve(authorizationId);
    },
    decline: async (authorizationId, reason) => {
      await stripe.issuing.authorizations.decline(authorizationId, {
        metadata: { reason },
      });
    },
  };
}
