/**
 * The lazy card lifecycle: POST /card/prepare (idempotent, at the Link
 * provider step), the 7-day abandonment janitor (cancel vs freeze vs skip),
 * the pending_onboarding overlay on GET /card, and the Apple Pay top-up
 * intent (dry run vs real) with its payment_intent.succeeded webhook leg.
 */

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { makeCardJanitor } from "../src/jobs/cardJanitor.js";
import type { StripeGateway } from "../src/services/stripeGateway.js";
import {
  API_KEY,
  MONDAY_2PM,
  makeFakeGateway,
  makeTestApp,
  seedProviderAccount,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);
const LIVE = { policy: { dry_run: false }, envDryRun: false };
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 3600_000);

function post(t: ReturnType<typeof makeTestApp>, url: string, body?: unknown) {
  return t.app.inject({ method: "POST", url, headers: HEADERS, payload: (body ?? {}) as object });
}

describe("POST /card/prepare", () => {
  it("creates cardholder + card lazily, pending_onboarding, idempotent", async () => {
    const created: string[] = [];
    const t = makeTestApp({
      now: () => NOW,
      stripe: makeFakeGateway({
        createCardholder: async (name) => {
          created.push(`holder:${name}`);
          return { stripeCardholderId: "ich-u1" };
        },
        createCard: async () => {
          created.push("card");
          return { stripeCardId: "ic_lazy_1", last4: "7777", status: "active" };
        },
      }),
    });

    const first = await post(t, "/card/prepare");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      created: true,
      card: { stripeCardId: "ic_lazy_1", last4: "7777", status: "pending_onboarding" },
    });
    expect(created).toEqual(["holder:Thomas", "card"]);
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "card_prepare", rule: "prepared" });

    // Second call finds the card and creates nothing.
    const second = await post(t, "/card/prepare");
    expect(second.json()).toMatchObject({ created: false, card: { stripeCardId: "ic_lazy_1" } });
    expect(created).toEqual(["holder:Thomas", "card"]);
  });

  it("a canceled card gets a fresh one on the next prepare", async () => {
    const t = makeTestApp({ now: () => NOW, stripe: makeFakeGateway() });
    t.state.issuingCards.push({ stripeCardId: "ic_old", userId: "u1", status: "canceled" });
    const res = await post(t, "/card/prepare");
    expect(res.json()).toMatchObject({
      created: true,
      card: { stripeCardId: "ic_test_new", status: "pending_onboarding" },
    });
  });

  it("GET /card surfaces pending_onboarding and never re-mirrors it away", async () => {
    const t = makeTestApp({ now: () => NOW, stripe: makeFakeGateway() });
    t.state.issuingCards.push({
      stripeCardId: "ic_test_1",
      userId: "u1",
      status: "pending_onboarding",
    });
    const res = await t.app.inject({ method: "GET", url: "/card", headers: HEADERS });
    expect(res.json().card.status).toBe("pending_onboarding");
    expect(t.state.issuingCards[0]!.status).toBe("pending_onboarding");
  });
});

describe("card janitor", () => {
  function janitorApp(gateway?: Partial<StripeGateway>) {
    const calls: string[] = [];
    const t = makeTestApp({
      seedLinkedProvider: false,
      now: () => NOW,
      stripe: makeFakeGateway({
        setCardStatus: async (id, status) => {
          calls.push(`${id}:${status}`);
          return status;
        },
        deactivateCardholder: async (id) => {
          calls.push(`deactivate:${id}`);
        },
        ...gateway,
      }),
    });
    const janitor = makeCardJanitor({
      db: t.deps.db,
      stripe: t.deps.stripe,
      log: { info: () => {}, warn: () => {} },
      now: () => NOW,
    });
    return { t, janitor, calls };
  }

  it("cancels a stale pending card of a never-linked user and removes the cardholder", async () => {
    const { t, janitor, calls } = janitorApp();
    t.state.issuingCards.push({
      stripeCardId: "ic_stale",
      userId: "u1",
      status: "pending_onboarding",
      createdAt: EIGHT_DAYS_AGO,
    });

    await janitor.tick();
    expect(calls).toEqual(["ic_stale:canceled", "deactivate:ich-u1"]);
    expect(t.state.issuingCards).toHaveLength(0);
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "card_janitor",
      rule: "cancel_abandoned",
      outcome: { cardholderRemoved: true },
    });

    // The user returns: /card/prepare hands out a fresh card.
    const res = await post(t, "/card/prepare");
    expect(res.json()).toMatchObject({ created: true });
  });

  it("leaves fresh cards and ever-linked users alone", async () => {
    const { t, janitor, calls } = janitorApp();
    // Fresh pending card: too young.
    t.state.issuingCards.push({
      stripeCardId: "ic_fresh",
      userId: "u1",
      status: "pending_onboarding",
      createdAt: new Date(NOW.getTime() - 2 * 24 * 3600_000),
    });
    await janitor.tick();
    expect(calls).toEqual([]);

    // Stale, but the user linked (even though the link since expired).
    t.state.issuingCards[0]!.createdAt = EIGHT_DAYS_AGO;
    seedProviderAccount(t.state, { status: "expired" });
    await janitor.tick();
    expect(calls).toEqual([]);
    expect(t.state.issuingCards).toHaveLength(1);
  });

  it("freezes — never cancels — a stale card that has transacted", async () => {
    const { t, janitor, calls } = janitorApp();
    t.state.issuingCards.push({
      stripeCardId: "ic_used",
      userId: "u1",
      status: "pending_onboarding",
      createdAt: EIGHT_DAYS_AGO,
    });
    t.state.issuingAuthorizations.push({
      stripeAuthorizationId: "iauth_1",
      stripeCardId: "ic_used",
      userId: "u1",
      amountUsd: 7.28,
      merchantCategory: "parking_lots_garages",
      merchantCategoryCode: "7523",
      merchantName: null,
      approved: true,
      decision: "approved",
      status: "closed",
      createdAt: NOW,
    });

    await janitor.tick();
    expect(calls).toEqual(["ic_used:inactive"]);
    expect(t.state.issuingCards[0]!.status).toBe("inactive");
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "freeze_abandoned_transacted" });
  });
});

describe("POST /card/funding/topup-intent", () => {
  it("dry run: fake client secret, decisions row, Stripe never called", async () => {
    let created = false;
    const t = makeTestApp({
      stripe: makeFakeGateway({
        createPaymentIntent: async () => {
          created = true;
          return { paymentIntentId: "pi_x", clientSecret: "s" };
        },
      }),
    });
    t.state.issuingCards.push({ stripeCardId: "ic_test_1", userId: "u1" });

    const res = await post(t, "/card/funding/topup-intent", { amountUsd: 25 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.paymentIntentId).toBeNull();
    expect(body.clientSecret).toMatch(/^pi_dryrun_/);
    expect(created).toBe(false);
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "card_topup_intent", rule: "dry_run" });
  });

  it("real: creates the intent; the cap still gates", async () => {
    const t = makeTestApp({ ...LIVE, stripe: makeFakeGateway() });
    t.state.issuingCards.push({ stripeCardId: "ic_test_1", userId: "u1" });

    const over = await post(t, "/card/funding/topup-intent", { amountUsd: 61 });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: "amount_over_daily_cap" });

    const ok = await post(t, "/card/funding/topup-intent", { amountUsd: 25 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      paymentIntentId: "pi_test_1",
      clientSecret: "pi_test_1_secret_abc",
      dryRun: false,
    });
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "intent_created" });
  });
});

describe("webhook payment_intent.succeeded", () => {
  const VALID_SIG = "test-signature";

  function webhookApp(overrides: Partial<StripeGateway> = {}) {
    const moves: number[] = [];
    const t = makeTestApp({
      stripe: makeFakeGateway({
        verifyEvent: (payload, signature) => {
          if (signature !== VALID_SIG) throw new Error("bad signature");
          return JSON.parse(payload.toString()) as Stripe.Event;
        },
        moveToFinancialAccount: async (amountUsd) => {
          moves.push(amountUsd);
        },
        ...overrides,
      }),
    });
    return { t, moves };
  }

  function intentEvent(metadata: Record<string, string>) {
    return {
      id: "evt_pi",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test_1",
          object: "payment_intent",
          amount: 2500,
          amount_received: 2500,
          currency: "usd",
          metadata,
        },
      },
    };
  }

  function deliver(t: ReturnType<typeof makeTestApp>, event: unknown) {
    return t.app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": VALID_SIG },
      payload: JSON.stringify(event),
    });
  }

  it("moves a tagged top-up onto the financial account and audits it", async () => {
    const { t, moves } = webhookApp();
    const res = await deliver(t, intentEvent({ parkagent: "card_topup", userId: "u1" }));
    expect(res.statusCode).toBe(200);
    expect(moves).toEqual([25]);
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "card_topup_funded",
      rule: "funded",
      userId: "u1",
      inputs: { paymentIntentId: "pi_test_1", amountUsd: 25 },
    });
  });

  it("ignores intents that aren't ours and records a failed move", async () => {
    const { t, moves } = webhookApp();
    await deliver(t, intentEvent({ someone: "else" }));
    expect(moves).toEqual([]);
    expect(t.state.decisions).toHaveLength(0);

    const failing = webhookApp({
      moveToFinancialAccount: async () => {
        throw new Error("financial account not ready");
      },
    });
    const res = await deliver(failing.t, intentEvent({ parkagent: "card_topup", userId: "u1" }));
    expect(res.statusCode).toBe(200); // Stripe still gets its ack
    expect(failing.t.state.decisions.at(-1)).toMatchObject({ rule: "funding_move_failed" });
  });
});
