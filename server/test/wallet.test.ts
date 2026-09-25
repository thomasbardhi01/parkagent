/**
 * The Wallet's HTTP surface: GET /wallet in each state the app renders,
 * PUT /wallet/source's readiness checks, saving a card (setup-intent →
 * funding-methods), default/remove, the unified Activity pages, and the
 * old funding routes turning admin-only.
 */

import { describe, expect, test } from "vitest";

import type { LinkClient } from "../src/services/link/linkClient.js";
import {
  API_KEY,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  makeFakeGateway,
  makeFakeProviderOps,
  makeTestApp,
  seedFundingMethod,
  seedHold,
  seedLinkSpendRequest,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);

function call(
  t: ReturnType<typeof makeTestApp>,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = HEADERS,
) {
  return t.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/** A Link client that connects and reports a Visa payment method. */
function linkClient(): LinkClient {
  let n = 0;
  return {
    authorizationUrl: ({ state }) => `https://login.link.com/auth?state=${state}`,
    exchangeCode: async () => ({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      scope: "",
    }),
    refresh: async () => ({
      accessToken: "tok2",
      refreshToken: "ref2",
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      scope: "",
    }),
    revoke: async () => {},
    createSpendRequest: async (_t, args) => {
      n += 1;
      return {
        id: `lsrq_${n}`,
        status: "pending_approval",
        amountUsd: args.amountUsd,
        approvalUrl: `https://app.link.com/approve/${n}`,
        validUntil: null,
      };
    },
    retrieveSpendRequest: async (_t, id) => ({
      id,
      status: "pending_approval",
      amountUsd: 0,
      approvalUrl: null,
      validUntil: null,
    }),
    cancelSpendRequest: async () => {},
    defaultPaymentMethod: async () => ({ type: "card", brand: "Visa", last4: "1234" }),
  };
}

async function connectLink(t: ReturnType<typeof makeTestApp>) {
  const { state } = t.deps.linkWallet!.startConnect("u1");
  await t.deps.linkWallet!.handleCallback(state, "code");
}

describe("GET /wallet — the states the app renders", () => {
  test("provider_card active: the card on the provider account, what pays where", async () => {
    const t = makeTestApp({ seedLinkedProvider: false });
    seedProviderAccount(t.state, { provider: "passport", cardBrand: "Visa", cardLast4: "4242" });
    const body = (await call(t, "GET", "/wallet")).json();
    expect(body.activeSource).toBe("provider_card");
    expect(body.providerCard.cards).toEqual([
      {
        provider: "passport",
        displayName: "ParkBoston",
        city: "bos",
        brand: "Visa",
        last4: "4242",
      },
    ]);
    const passport = body.providers.find((p: { id: string }) => p.id === "passport");
    expect(passport).toMatchObject({
      status: "linked",
      paysWith: { source: "provider_card", brand: "Visa", last4: "4242" },
      attention: null,
    });
    const nyc = body.providers.find((p: { id: string }) => p.id === "parknyc");
    expect(nyc).toMatchObject({ status: "unlinked", paysWith: null, attention: "connect" });
    expect(body.spending).toEqual({
      todayUsd: 0,
      dailyCapUsd: 60,
      sessionCapUsd: 45,
      monthUsd: 0,
      byCity: [
        { city: "bos", cityDisplayName: "Boston", monthUsd: 0 },
        { city: "nyc", cityDisplayName: "New York City", monthUsd: 0 },
      ],
      linkMonthUsd: 0,
    });
    expect(body.dryRun).toBe(true);
  });

  test("Link connected and active: its payment method, approvals, manage link, scope", async () => {
    const t = makeTestApp({ linkClient: linkClient(), paymentSource: "link_wallet" });
    await connectLink(t);
    await t.deps.linkWallet!.createSpendRequestsForStops("u1", {
      planId: "p1",
      stops: [
        {
          stopId: "g1",
          label: "Deck",
          amountUsd: 4.1,
          merchantName: "SpotHero",
          merchantUrl: "https://spothero.com",
        },
      ],
    });
    const body = (await call(t, "GET", "/wallet")).json();
    expect(body.activeSource).toBe("link_wallet");
    expect(body.options[1]).toEqual({
      source: "link_wallet",
      availability: "available",
      needs: null,
      sandbox: false,
    });
    expect(body.link).toMatchObject({
      configured: true,
      connected: true,
      paymentMethod: { type: "card", brand: "Visa", last4: "1234" },
      manageUrl: "https://app.link.com",
      covers: "plans_and_garages",
    });
    expect(body.link.pendingApprovals).toEqual([
      {
        spendRequestId: "lsrq_1",
        amountUsd: 4.1,
        merchantName: "SpotHero",
        approvalUrl: "https://app.link.com/approve/1",
        expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      },
    ]);
    // Street meters under Link still pay with the provider account's card.
    expect(body.providers[0].paysWith).toMatchObject({ source: "provider_card" });
  });

  test("Link not configured: coming soon, and switching to it is refused", async () => {
    const t = makeTestApp({});
    const body = (await call(t, "GET", "/wallet")).json();
    expect(body.options[1]).toMatchObject({ availability: "coming_soon" });
    expect(body.link).toMatchObject({ configured: false, connected: false, paymentMethod: null });
    const put = await call(t, "PUT", "/wallet/source", { source: "link_wallet" });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ error: "link_not_configured" });
  });

  test("ParkAgent card in sandbox: selectable before ISSUING_LIVE, add a card first", async () => {
    const t = makeTestApp({ issuingSandbox: true, stripe: makeFakeGateway() });
    const before = (await call(t, "GET", "/wallet")).json();
    expect(before.options[2]).toEqual({
      source: "parkagent_card",
      availability: "connect",
      needs: "add_card",
      sandbox: true,
    });
    expect(before.parkagentCard).toMatchObject({
      live: false,
      sandboxSelectable: true,
      fundingMethods: [],
      card: null,
    });

    seedFundingMethod(t.state);
    t.state.issuingCards.push({ stripeCardId: "ic_u1", userId: "u1", last4: "7777" });
    t.state.userPaymentSources["u1"] = "parkagent_card";
    t.state.providerAccounts[0]!.cardAdded = true;
    const after = (await call(t, "GET", "/wallet")).json();
    expect(after.options[2]).toMatchObject({ availability: "available", sandbox: true });
    expect(after.parkagentCard.fundingMethods).toEqual([
      {
        id: "fm1",
        brand: "Visa",
        last4: "4242",
        wallet: "apple_pay",
        expMonth: 12,
        expYear: 2031,
        isDefault: true,
      },
    ]);
    expect(after.parkagentCard.card).toMatchObject({
      last4: "7777",
      brand: "Visa",
      status: "active",
      expMonth: 8,
      expYear: 2030,
    });
    expect(after.providers[0].paysWith).toMatchObject({ source: "parkagent_card", last4: "7777" });
  });

  test("empty: nothing linked, nothing spent, no activity", async () => {
    const t = makeTestApp({ seedLinkedProvider: false });
    const body = (await call(t, "GET", "/wallet")).json();
    expect(body.providerCard.cards).toEqual([]);
    expect(body.providers.every((p: { attention: string }) => p.attention === "connect")).toBe(
      true,
    );
    expect(body.activity).toEqual({ items: [], nextCursor: null });
  });

  test("spending: garages approved in Link count today and this month, on their own line", async () => {
    const t = makeTestApp({ seedLinkedProvider: false });
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    seedSession(t.state, {
      status: "stopped",
      dryRun: false,
      city: "bos",
      amountUsd: 4,
      feeUsd: 0.1,
      createdAt: hoursAgo(2),
    });
    seedLinkSpendRequest(t.state, { amountUsd: 18, status: "approved", createdAt: hoursAgo(1) });
    // Awaiting approval, declined, or expired: nothing spent.
    seedLinkSpendRequest(t.state, {
      amountUsd: 12,
      status: "pending_approval",
      createdAt: hoursAgo(0.1),
    });
    seedLinkSpendRequest(t.state, { amountUsd: 30, status: "denied", createdAt: hoursAgo(1) });
    seedLinkSpendRequest(t.state, { amountUsd: 30, status: "expired", createdAt: hoursAgo(1) });
    // Saturday (Jan 3): this month, not today.
    seedLinkSpendRequest(t.state, { amountUsd: 9, status: "succeeded", createdAt: hoursAgo(50) });
    // December: neither.
    seedLinkSpendRequest(t.state, {
      amountUsd: 50,
      status: "approved",
      createdAt: hoursAgo(24 * 10),
    });

    const body = (await call(t, "GET", "/wallet")).json();
    expect(body.spending).toMatchObject({
      todayUsd: 22.1,
      monthUsd: 31.1,
      linkMonthUsd: 27,
      byCity: [
        { city: "bos", monthUsd: 4.1 },
        { city: "nyc", monthUsd: 0 },
      ],
    });
  });
});

describe("PUT /wallet/source readiness", () => {
  test("Link must be connected", async () => {
    const t = makeTestApp({ linkClient: linkClient() });
    const res = await call(t, "PUT", "/wallet/source", { source: "link_wallet" });
    expect(res.json()).toMatchObject({ error: "link_not_connected" });
    await connectLink(t);
    const ok = await call(t, "PUT", "/wallet/source", { source: "link_wallet" });
    expect(ok.json()).toMatchObject({ activeSource: "link_wallet" });
  });

  test("the ParkAgent card needs a saved card, then consent to go on each account", async () => {
    const t = makeTestApp({
      issuingSandbox: true,
      stripe: makeFakeGateway(),
      providerOps: () => makeFakeProviderOps(),
    });
    const noCard = await call(t, "PUT", "/wallet/source", {
      source: "parkagent_card",
      sandbox: true,
    });
    expect(noCard.json()).toMatchObject({ error: "no_funding_method" });

    seedFundingMethod(t.state);
    const noConsent = await call(t, "PUT", "/wallet/source", {
      source: "parkagent_card",
      sandbox: true,
    });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json()).toMatchObject({ error: "consent_required", providers: ["parknyc"] });
    expect(t.state.issuingCards).toEqual([]); // nothing created before consent

    const ok = await call(t, "PUT", "/wallet/source", {
      source: "parkagent_card",
      sandbox: true,
      consentReplacePaymentMethod: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().setupJobs).toMatchObject([{ provider: "parknyc" }]);
    // The card exists now, and the chained setup ran (dry run: recorded,
    // provider untouched).
    expect(t.state.issuingCards).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.state.linkJobs[0]).toMatchObject({ phase: "done", dryRun: true });
    expect(t.state.decisions.find((d) => d.kind === "provider_setup_card")!.rule).toBe("dry_run");
    const me = (await call(t, "GET", "/me")).json();
    expect(me.paymentSource).toBe("parkagent_card");
  });
});

describe("saving a card for the ParkAgent card", () => {
  test("setup-intent: one Customer per user, a client secret, the Apple Pay merchant", async () => {
    const created: string[] = [];
    const t = makeTestApp({
      issuingSandbox: true,
      stripe: makeFakeGateway({
        createCustomer: async ({ userId }, key) => {
          created.push(key);
          return { customerId: `cus_${userId}` };
        },
      }),
    });
    const refused = await call(t, "POST", "/wallet/setup-intent", {});
    expect(refused.json()).toMatchObject({ error: "parkagent_card_not_live" });

    const first = await call(t, "POST", "/wallet/setup-intent", { sandbox: true });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      setupIntentId: "seti_test_1",
      clientSecret: "seti_test_1_secret_abc",
      customerId: "cus_u1",
      merchantId: "merchant.com.thomasbardhi.parkagent",
    });
    await call(t, "POST", "/wallet/setup-intent", { sandbox: true });
    expect(created).toEqual(["customer:u1"]); // reused the second time
    expect(t.state.users[0]!.stripeCustomerId).toBe("cus_u1");
    expect(t.state.decisions.filter((d) => d.rule === "setup_intent_created")).toHaveLength(2);
  });

  test("funding-methods records the saved card; someone else's intent reads as unknown", async () => {
    const t = makeTestApp({ issuingSandbox: true, stripe: makeFakeGateway() });
    await call(t, "POST", "/wallet/setup-intent", { sandbox: true });

    const foreign = makeTestApp({
      issuingSandbox: true,
      stripe: makeFakeGateway({
        retrieveSetupIntent: async (id) => ({
          setupIntentId: id,
          status: "succeeded",
          customerId: "cus_someone_else",
          paymentMethodId: "pm_x",
        }),
      }),
    });
    await call(foreign, "POST", "/wallet/setup-intent", { sandbox: true });
    expect(
      (await call(foreign, "POST", "/wallet/funding-methods", { setupIntentId: "seti_x" }))
        .statusCode,
    ).toBe(404);

    const res = await call(t, "POST", "/wallet/funding-methods", { setupIntentId: "seti_test_1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().fundingMethod).toEqual({
      id: "fm1",
      brand: "Visa",
      last4: "4242",
      wallet: "apple_pay",
      expMonth: 12,
      expYear: 2031,
      isDefault: true,
    });
    // Idempotent: posting the same intent again returns the same card.
    const again = await call(t, "POST", "/wallet/funding-methods", {
      setupIntentId: "seti_test_1",
    });
    expect(again.json().fundingMethod.id).toBe("fm1");
    expect(t.state.fundingMethods).toHaveLength(1);
  });

  test("an unfinished SetupIntent is refused", async () => {
    const t = makeTestApp({
      issuingSandbox: true,
      stripe: makeFakeGateway({
        retrieveSetupIntent: async (id) => ({
          setupIntentId: id,
          status: "requires_payment_method",
          customerId: "cus_u1",
          paymentMethodId: null,
        }),
      }),
    });
    await call(t, "POST", "/wallet/setup-intent", { sandbox: true });
    const res = await call(t, "POST", "/wallet/funding-methods", { setupIntentId: "seti_test_1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "setup_not_complete" });
  });

  test("remove: refused while it's the ParkAgent card's only card or holding a leg", async () => {
    const t = makeTestApp({ stripe: makeFakeGateway(), paymentSource: "parkagent_card" });
    const only = seedFundingMethod(t.state);
    const inUse = await call(t, "DELETE", `/wallet/funding-methods/${only.id}`);
    expect(inUse.json()).toMatchObject({ error: "funding_method_in_use" });

    const second = seedFundingMethod(t.state, { isDefault: false, last4: "0005" });
    seedHold(t.state, { fundingMethodId: second.id });
    const holding = await call(t, "DELETE", `/wallet/funding-methods/${second.id}`);
    expect(holding.json()).toMatchObject({ error: "hold_in_progress" });

    // The default goes; the other card is promoted.
    t.state.sessionHolds[0]!.status = "captured";
    const removed = await call(t, "DELETE", `/wallet/funding-methods/${only.id}`);
    expect(removed.json()).toEqual({ ok: true, promotedDefault: second.id });
    expect(t.state.fundingMethods.find((m) => m.id === second.id)!.isDefault).toBe(true);
    // Someone else's id is a 404.
    expect((await call(t, "DELETE", "/wallet/funding-methods/nope")).statusCode).toBe(404);
  });
});

describe("GET /wallet/activity", () => {
  test("merges sessions, garages, and Link payments newest first, in cursor pages", async () => {
    const t = makeTestApp({ seedLinkedProvider: false });
    seedProviderAccount(t.state, { provider: "passport", cardBrand: "Visa", cardLast4: "4242" });
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    seedSession(t.state, {
      id: "s-old",
      status: "stopped",
      city: "bos",
      zoneId: "bos-x",
      providerZoneNumber: "456",
      dryRun: false,
      paymentSource: "provider_card",
      amountUsd: 5.63,
      feeUsd: 0.35,
      purchasedMinutes: 90,
      createdAt: at(300),
      startedAt: at(300),
    });
    t.state.garageBookings.push({
      id: "gb1",
      userId: "u1",
      planId: "p1",
      itineraryId: null,
      optionId: "o1",
      provider: "spothero",
      label: "Deck on 5th",
      priceUsd: 18,
      startsAt: null,
      endsAt: null,
      deepLink: "https://spothero.com/checkout/1",
      paymentSource: "provider_card",
      linkSpendRequestId: null,
      status: "handed_off",
      createdAt: at(200),
    });
    t.state.linkSpendRequests.push({
      id: "lsrq_9",
      userId: "u1",
      itineraryId: null,
      stopId: "x",
      planId: "p2",
      amountUsd: 9,
      status: "approved",
      approvalUrl: null,
      merchantName: "ParkWhiz",
      cardEncrypted: null,
      validUntil: null,
      cardUsedAt: null,
      createdAt: at(100),
    });
    seedSession(t.state, {
      id: "s-new",
      status: "failed",
      city: "bos",
      zoneId: "bos-x",
      providerZoneNumber: "456",
      createdAt: at(10),
    });
    t.state.sessionEvents.push({
      id: "se1",
      sessionId: "s-new",
      kind: "failed",
      at: at(10),
      dryRun: false,
      details: { op: "start", code: "card_declined" },
    });

    const page1 = (await call(t, "GET", "/wallet/activity?limit=2")).json();
    expect(page1.items.map((i: { id: string }) => i.id)).toEqual(["session:s-new", "link:lsrq_9"]);
    expect(page1.items[0]).toMatchObject({
      kind: "session",
      status: "failed",
      explanation: "Your card was declined — nothing was paid.",
    });
    const page2 = (
      await call(
        t,
        "GET",
        `/wallet/activity?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      )
    ).json();
    expect(page2.items.map((i: { id: string }) => i.id)).toEqual(["garage:gb1", "session:s-old"]);
    expect(page2.nextCursor).toBeNull();
    const old = page2.items[1];
    expect(old).toMatchObject({
      zoneNumber: "456",
      durationMinutes: 90,
      meterUsd: 5.63,
      feeUsd: 0.35,
      totalUsd: 5.98,
      providerDisplayName: "ParkBoston",
      explanation: "Paid with your card on ParkBoston ••4242.",
    });
    expect(page2.items[0]).toMatchObject({
      kind: "garage",
      providerDisplayName: "SpotHero",
      priceUsd: 18,
      link: null,
    });
  });

  test("a failed session explains itself in words, never a raw executor code", async () => {
    const t = makeTestApp({});
    seedSession(t.state, { id: "s1", status: "failed", city: "nyc", createdAt: NOW });
    t.state.sessionEvents.push({
      id: "se1",
      sessionId: "s1",
      kind: "failed",
      at: NOW,
      dryRun: false,
      details: { op: "start", code: "payment_declined" },
    });
    const [item] = (await call(t, "GET", "/wallet/activity")).json().items;
    expect(item.explanation).toBe(
      "Couldn't pay at ParkNYC: the card saved there was declined — the meter was unpaid.",
    );
  });

  test("a ParkAgent-card session's row carries its holds and timeline", async () => {
    const t = makeTestApp({});
    seedSession(t.state, {
      id: "s1",
      status: "stopped",
      dryRun: false,
      paymentSource: "parkagent_card",
      amountUsd: 5.25,
      feeUsd: 0.35,
      purchasedMinutes: 90,
      startedAt: NOW,
      createdAt: NOW,
    });
    seedHold(t.state, {
      sessionId: "s1",
      amountUsd: 7.98,
      authorizedUsd: 5.6,
      capturedUsd: 5.6,
      status: "captured",
      settledAt: new Date(NOW.getTime() + 60_000),
    });
    t.state.sessionEvents.push({
      id: "se1",
      sessionId: "s1",
      kind: "started",
      at: NOW,
      minutes: 90,
      amountUsd: 5.25,
      feeUsd: 0.35,
      dryRun: false,
    });
    const [item] = (await call(t, "GET", "/wallet/activity")).json().items;
    expect(item.explanation).toBe(
      "Paid with the ParkAgent card — $5.60 taken from your card, the rest of the hold released.",
    );
    expect(item.receipt.holds).toEqual([
      {
        leg: "start",
        heldUsd: 7.98,
        capturedUsd: 5.6,
        status: "captured",
        paymentIntentId: "pi_seed_1",
      },
    ]);
    expect(item.timeline.map((e: { kind: string }) => e.kind)).toEqual([
      "hold_placed",
      "started",
      "hold_captured",
    ]);
  });
});

describe("no stored balance: the funding routes are admin-only", () => {
  test("a non-admin gets 403 on every one; the admin still gets the old answers", async () => {
    const t = makeTestApp({ stripe: makeFakeGateway() });
    t.state.issuingCards.push({ stripeCardId: "ic_u2", userId: "u2" });
    const other = { "x-api-key": NONADMIN_API_KEY };
    for (const [method, url] of [
      ["GET", "/card"],
      ["GET", "/card/transactions"],
      ["POST", "/card/funding/topup"],
      ["POST", "/card/funding/withdraw"],
      ["POST", "/card/funding/topup-intent"],
    ] as const) {
      const res = await call(
        t,
        method,
        url,
        method === "POST" ? { amountUsd: 5 } : undefined,
        other,
      );
      expect(res.statusCode, url).toBe(403);
    }
    // The card's own controls stay the user's.
    expect((await call(t, "POST", "/card/freeze", {}, other)).statusCode).toBe(200);
  });
});

describe("DELETE /me takes the wallet with the person", () => {
  test("Stripe Customer deleted, saved cards removed, Link disconnected", async () => {
    const deleted: string[] = [];
    const t = makeTestApp({
      linkClient: linkClient(),
      stripe: makeFakeGateway({
        deleteCustomer: async (id) => {
          deleted.push(id);
        },
      }),
    });
    seedFundingMethod(t.state);
    await connectLink(t);
    const res = await call(t, "DELETE", "/me");
    expect(res.json()).toEqual({ ok: true, deleted: true });
    expect(deleted).toEqual(["cus_u1"]);
    expect(t.state.fundingMethods[0]!.removedAt).not.toBeNull();
    expect(t.state.linkAccounts[0]).toMatchObject({
      status: "disconnected",
      tokensEncrypted: null,
    });
  });
});
