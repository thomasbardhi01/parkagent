/**
 * POST /webhooks/stripe with the Stripe SDK mocked out: the fake gateway
 * "verifies" by checking for a fixed signature header and parses the body.
 * Real-time decisions come back in the HTTP response ({approved, metadata}),
 * so the assertions read the response, not recorded API calls.
 */

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import type { AppDeps } from "../src/app.js";
import { buildApp, makeAuthenticate } from "../src/app.js";
import { DryRunExecutor } from "../src/services/executor.js";
import { makePendingSessionCheck } from "../src/services/pendingSession.js";
import type { StripeGateway } from "../src/services/stripeGateway.js";
import type { Policy } from "../src/services/policy.js";
import {
  makeFakeDb,
  makeFakeGateway,
  makePolicyService,
  MONDAY_2PM,
  seedSession,
  TEST_PEPPER,
} from "./helpers.js";

const VALID_SIG = "test-signature";
const CARD_ID = "ic_test_1";
const USER_ID = "u1";

function makeFakeStripe() {
  const gateway: StripeGateway = makeFakeGateway({
    verifyEvent: (payload, signature) => {
      if (signature !== VALID_SIG) throw new Error("signature mismatch");
      return JSON.parse(payload.toString()) as Stripe.Event;
    },
  });
  return { gateway };
}

/** The decline reason a request response carries, for terse assertions. */
function reasonOf(res: { json(): { approved: boolean; metadata?: { reason?: string } } }) {
  const body = res.json();
  return { approved: body.approved, reason: body.metadata?.reason };
}

function makeWebhookApp(options: {
  policy?: Partial<Policy>;
  envDryRun?: boolean;
  hasPendingSession?: boolean;
  /** Use the real sessions-table check instead of the boolean stub. */
  realPendingCheck?: boolean;
  knownCard?: boolean;
}) {
  const { db, state } = makeFakeDb();
  if (options.knownCard !== false) {
    state.issuingCards.push({ stripeCardId: CARD_ID, userId: USER_ID });
  }
  const stripe = makeFakeStripe();
  const deps: AppDeps = {
    db,
    policy: makePolicyService(options.policy, options.envDryRun ?? true),
    findCandidates: async () => [],
    authenticate: makeAuthenticate(db, TEST_PEPPER),
    executorFor: () => new DryRunExecutor(() => {}),
    sendPush: async () => {},
    stripe: stripe.gateway,
    hasPendingSession: options.realPendingCheck
      ? makePendingSessionCheck(db)
      : async () => options.hasPendingSession ?? false,
    now: () => new Date(MONDAY_2PM),
  };
  return { app: buildApp(deps), state, ...stripe };
}

function authRequestEvent(
  authOverrides: Partial<Stripe.Issuing.Authorization> & Record<string, unknown> = {},
) {
  return {
    id: "evt_1",
    type: "issuing_authorization.request",
    api_version: "2026-08-26.dahlia",
    data: {
      object: {
        id: "iauth_1",
        object: "issuing.authorization",
        amount: 0,
        currency: "usd",
        approved: false,
        status: "pending",
        pending_request: { amount: 728, currency: "usd" },
        card: { id: CARD_ID },
        merchant_data: {
          category: "parking_lots_garages",
          category_code: "7523",
          name: "PARKNYC TEST METER",
        },
        ...authOverrides,
      },
    },
  };
}

function post(app: ReturnType<typeof buildApp>, event: unknown, signature = VALID_SIG) {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    payload: JSON.stringify(event),
  });
}

// Money can move only with both dry-run switches off; approval tests need that.
const LIVE = { policy: { dry_run: false }, envDryRun: false };

describe("POST /webhooks/stripe: issuing_authorization.request", () => {
  it("approves within budget with a pending session and parking MCC", async () => {
    const t = makeWebhookApp({ ...LIVE, hasPendingSession: true });
    const res = await post(t.app, authRequestEvent());
    expect(res.statusCode).toBe(200);
    expect(res.headers["stripe-version"]).toBe("2026-08-26.dahlia");
    expect(reasonOf(res)).toEqual({ approved: true, reason: "approved" });
    // The ledger row and the audit decision both landed.
    expect(t.state.issuingAuthorizations).toMatchObject([
      { stripeAuthorizationId: "iauth_1", userId: USER_ID, amountUsd: 7.28, approved: true },
    ]);
    expect(t.state.decisions).toMatchObject([
      { kind: "issuing_authorization", rule: "approved", outcome: { approved: true } },
    ]);
    expect(t.state.decisions[0]!.inputs).toMatchObject({
      amountUsd: 7.28,
      spentTodayUsd: 0,
      hasPendingSession: true,
      dryRun: false,
    });
  });

  it("declines when the amount exceeds the remaining daily budget", async () => {
    const t = makeWebhookApp({ ...LIVE, hasPendingSession: true });
    // daily_cap_usd is 60; 55 already approved today leaves less than 7.28.
    t.state.issuingAuthorizations.push({
      stripeAuthorizationId: "iauth_0",
      stripeCardId: CARD_ID,
      userId: USER_ID,
      amountUsd: 55,
      merchantCategory: "parking_lots_garages",
      merchantCategoryCode: "7523",
      merchantName: null,
      approved: true,
      decision: "approved",
      status: "closed",
      createdAt: new Date(MONDAY_2PM),
    });
    const res = await post(t.app, authRequestEvent());
    expect(reasonOf(res)).toEqual({ approved: false, reason: "declined_over_daily_cap" });
    expect(t.state.decisions[0]!.inputs).toMatchObject({ spentTodayUsd: 55 });
  });

  it("declines a non-parking MCC", async () => {
    const t = makeWebhookApp({ ...LIVE, hasPendingSession: true });
    const res = await post(
      t.app,
      authRequestEvent({
        merchant_data: { category: "taxicabs_limousines", category_code: "4121", name: "TAXI" },
      } as never),
    );
    expect(reasonOf(res)).toEqual({ approved: false, reason: "declined_wrong_mcc" });
  });

  it("declines when no session is pending", async () => {
    const t = makeWebhookApp({ ...LIVE, hasPendingSession: false });
    const res = await post(t.app, authRequestEvent());
    expect(reasonOf(res)).toEqual({ approved: false, reason: "declined_no_pending_session" });
  });

  it("approves via the real sessions-table check when a session is fresh, declines when stale", async () => {
    const fresh = makeWebhookApp({ ...LIVE, realPendingCheck: true });
    seedSession(fresh.state, {
      userId: USER_ID,
      status: "pending",
      createdAt: new Date(new Date(MONDAY_2PM).getTime() - 5 * 60_000),
    });
    expect(reasonOf(await post(fresh.app, authRequestEvent()))).toEqual({
      approved: true,
      reason: "approved",
    });

    const stale = makeWebhookApp({ ...LIVE, realPendingCheck: true });
    seedSession(stale.state, {
      userId: USER_ID,
      status: "active",
      startedAt: new Date(new Date(MONDAY_2PM).getTime() - 25 * 60_000),
      createdAt: new Date(new Date(MONDAY_2PM).getTime() - 25 * 60_000),
    });
    expect(reasonOf(await post(stale.app, authRequestEvent()))).toEqual({
      approved: false,
      reason: "declined_no_pending_session",
    });
  });

  it("declines an unknown card", async () => {
    const t = makeWebhookApp({ ...LIVE, hasPendingSession: true, knownCard: false });
    const res = await post(t.app, authRequestEvent());
    expect(reasonOf(res)).toEqual({ approved: false, reason: "declined_unknown_card" });
    expect(t.state.issuingAuthorizations[0]).toMatchObject({ userId: null });
    expect(t.state.decisions[0]).toMatchObject({ userId: null });
  });

  it("declines instead of approving while dry run is on, and records wouldApprove", async () => {
    const t = makeWebhookApp({ hasPendingSession: true }); // default: dry_run true
    const res = await post(t.app, authRequestEvent());
    expect(reasonOf(res)).toEqual({ approved: false, reason: "declined_dry_run" });
    expect(t.state.decisions[0]!.outcome).toMatchObject({ wouldApprove: true });
  });
});

describe("POST /webhooks/stripe: plumbing", () => {
  it("rejects a bad signature without touching the db", async () => {
    const t = makeWebhookApp({ hasPendingSession: true });
    const res = await post(t.app, authRequestEvent(), "wrong");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_signature" });
    expect(t.state.issuingAuthorizations).toEqual([]);
    expect(t.state.decisions).toEqual([]);
  });

  it("503s when stripe is not configured", async () => {
    const { db } = makeFakeDb();
    const bare = buildApp({
      db,
      policy: makePolicyService(),
      findCandidates: async () => [],
      authenticate: makeAuthenticate(db, TEST_PEPPER),
      executorFor: () => new DryRunExecutor(() => {}),
      sendPush: async () => {},
    });
    const res = await post(bare, authRequestEvent());
    expect(res.statusCode).toBe(503);
  });

  it("updates the ledger on authorization.updated and transaction.created", async () => {
    const t = makeWebhookApp({ ...LIVE, hasPendingSession: true });
    await post(t.app, authRequestEvent());
    await post(t.app, {
      id: "evt_2",
      type: "issuing_authorization.updated",
      data: {
        object: {
          ...authRequestEvent().data.object,
          amount: 728,
          approved: true,
          status: "closed",
        },
      },
    });
    expect(t.state.issuingAuthorizations[0]).toMatchObject({ status: "closed", amountUsd: 7.28 });
    await post(t.app, {
      id: "evt_3",
      type: "issuing_transaction.created",
      data: {
        object: {
          id: "ipi_1",
          object: "issuing.transaction",
          amount: -728,
          authorization: "iauth_1",
        },
      },
    });
    expect(t.state.issuingAuthorizations[0]).toMatchObject({
      stripeTransactionId: "ipi_1",
      capturedUsd: 7.28,
    });
  });

  it("records an authorization first seen via created as external", async () => {
    const t = makeWebhookApp({ ...LIVE });
    await post(t.app, {
      id: "evt_4",
      type: "issuing_authorization.created",
      data: {
        object: {
          ...authRequestEvent().data.object,
          amount: 728,
          approved: true,
          status: "pending",
        },
      },
    });
    expect(t.state.issuingAuthorizations).toMatchObject([
      { stripeAuthorizationId: "iauth_1", decision: "external", userId: USER_ID },
    ]);
  });
});
