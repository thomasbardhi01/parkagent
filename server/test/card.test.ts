/**
 * The Card tab endpoints: summary, ledger paging + session linking, the two
 * funding moves (policy gates, dry-run refusal, funding_unavailable), the
 * reveal key, and freeze/unfreeze. Stripe is the fake gateway from
 * helpers.ts; the routes' own logic is what's under test.
 */

import { describe, expect, it } from "vitest";

import { FundingUnavailableError } from "../src/services/stripeGateway.js";
import { API_KEY, makeFakeGateway, makeTestApp, MONDAY_2PM, seedSession } from "./helpers.js";

const CARD_ID = "ic_test_1";
const AUTH = { "x-api-key": API_KEY };

// Money can move only with both dry-run switches off.
const LIVE = { policy: { dry_run: false }, envDryRun: false };

function makeCardApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp({
    stripe: makeFakeGateway(),
    now: () => new Date(MONDAY_2PM),
    ...options,
  });
  t.state.issuingCards.push({
    stripeCardId: CARD_ID,
    userId: "u1",
    last4: "4242",
    status: "active",
    perAuthCapUsd: 45,
    dailyCapUsd: 60,
    holderName: "Thomas",
  });
  return t;
}

function seedAuthorization(
  t: ReturnType<typeof makeTestApp>,
  overrides: Partial<(typeof t.state.issuingAuthorizations)[number]> = {},
) {
  const n = t.state.issuingAuthorizations.length + 1;
  t.state.issuingAuthorizations.push({
    stripeAuthorizationId: `iauth_${n}`,
    stripeCardId: CARD_ID,
    userId: "u1",
    amountUsd: 7.28,
    merchantCategory: "parking_lots_garages",
    merchantCategoryCode: "7523",
    merchantName: "PARKNYC TEST METER",
    approved: true,
    decision: "approved",
    status: "pending",
    createdAt: new Date(MONDAY_2PM),
    ...overrides,
  });
}

describe("GET /card", () => {
  it("returns the summary with live details, controls, and spend windows", async () => {
    const t = makeCardApp();
    // Today (Mon 2pm), earlier this month, and last month.
    seedAuthorization(t, { amountUsd: 7.28, createdAt: new Date("2026-01-05T13:00:00-05:00") });
    seedAuthorization(t, { amountUsd: 5.0, createdAt: new Date("2026-01-02T12:00:00-05:00") });
    seedAuthorization(t, { amountUsd: 9.0, createdAt: new Date("2025-12-20T12:00:00-05:00") });
    // Declined charges never count toward spend.
    seedAuthorization(t, {
      amountUsd: 40,
      approved: false,
      decision: "declined_over_daily_cap",
      createdAt: new Date("2026-01-05T13:30:00-05:00"),
    });

    const res = await t.app.inject({ method: "GET", url: "/card", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      card: {
        stripeCardId: CARD_ID,
        last4: "4242",
        brand: "Visa",
        status: "active",
        expMonth: 8,
        expYear: 2030,
        cardholderName: "Thomas",
        spendingControls: { perAuthorizationUsd: 45, dailyUsd: 60 },
        spentTodayUsd: 7.28,
        spentThisMonthUsd: 12.28,
      },
      funding: { available: true, balanceUsd: 50, pendingUsd: 0 },
      dryRun: true,
    });
  });

  it("returns card: null (200) when the user has no card yet", async () => {
    const t = makeTestApp({ stripe: makeFakeGateway() });
    const res = await t.app.inject({ method: "GET", url: "/card", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ card: null, funding: { available: false } });
  });

  it("hides funding (not the card) when the financial account isn't ready", async () => {
    const t = makeCardApp({
      stripe: makeFakeGateway({
        fundingBalance: async () => {
          throw new FundingUnavailableError("no_financial_account");
        },
      }),
    });
    const res = await t.app.inject({ method: "GET", url: "/card", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      card: { last4: "4242" },
      funding: { available: false },
    });
  });

  it("re-mirrors a status changed on Stripe's side", async () => {
    const t = makeCardApp({
      stripe: makeFakeGateway({
        retrieveCard: async () => ({
          brand: "Visa",
          expMonth: 8,
          expYear: 2030,
          cardholderName: "Thomas",
          status: "inactive",
        }),
      }),
    });
    const res = await t.app.inject({ method: "GET", url: "/card", headers: AUTH });
    expect(res.json().card.status).toBe("inactive");
    expect(t.state.issuingCards[0]!.status).toBe("inactive");
  });

  it("503s when Stripe isn't configured but a card exists", async () => {
    const t = makeTestApp({});
    t.state.issuingCards.push({ stripeCardId: CARD_ID, userId: "u1" });
    const res = await t.app.inject({ method: "GET", url: "/card", headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "stripe_not_configured" });
  });

  it("401s without a key", async () => {
    const t = makeCardApp();
    const res = await t.app.inject({ method: "GET", url: "/card" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /card/transactions", () => {
  it("pages newest-first with an opaque cursor", async () => {
    const t = makeCardApp();
    for (let i = 1; i <= 5; i++) {
      seedAuthorization(t, {
        stripeAuthorizationId: `iauth_${i}`,
        createdAt: new Date(`2026-01-0${i}T12:00:00-05:00`),
      });
    }
    const first = await t.app.inject({
      method: "GET",
      url: "/card/transactions?limit=2",
      headers: AUTH,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.items.map((i: { id: string }) => i.id)).toEqual(["iauth_5", "iauth_4"]);
    expect(page1.nextCursor).toBeTruthy();

    const second = await t.app.inject({
      method: "GET",
      url: `/card/transactions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: AUTH,
    });
    const page2 = second.json();
    expect(page2.items.map((i: { id: string }) => i.id)).toEqual(["iauth_3", "iauth_2"]);

    const third = await t.app.inject({
      method: "GET",
      url: `/card/transactions?limit=2&cursor=${encodeURIComponent(page2.nextCursor)}`,
      headers: AUTH,
    });
    expect(third.json().items.map((i: { id: string }) => i.id)).toEqual(["iauth_1"]);
    expect(third.json().nextCursor).toBeNull();
  });

  it("carries merchant, amounts, decline reason, and the linked session", async () => {
    const t = makeCardApp();
    // A session started 3 minutes before the charge → linked.
    seedSession(t.state, {
      id: "sess1",
      userId: "u1",
      status: "active",
      startedAt: new Date("2026-01-05T13:57:00-05:00"),
    });
    seedAuthorization(t, { capturedUsd: 7.28, status: "closed" });
    seedAuthorization(t, {
      stripeAuthorizationId: "iauth_declined",
      approved: false,
      decision: "declined_no_pending_session",
      amountUsd: 12.5,
      createdAt: new Date("2026-01-05T18:00:00-05:00"), // hours later: no link
    });

    const res = await t.app.inject({ method: "GET", url: "/card/transactions", headers: AUTH });
    expect(res.json().items).toMatchObject([
      {
        id: "iauth_declined",
        approved: false,
        decision: "declined_no_pending_session",
        amountUsd: 12.5,
        sessionId: null,
      },
      {
        id: "iauth_1",
        merchantName: "PARKNYC TEST METER",
        amountUsd: 7.28,
        capturedUsd: 7.28,
        status: "closed",
        sessionId: "sess1",
      },
    ]);
  });
});

describe("POST /card/funding/topup and /card/funding/withdraw", () => {
  it("refuses under dry run, records the decision, and moves nothing", async () => {
    let moved = false;
    const t = makeCardApp({
      stripe: makeFakeGateway({
        fundingTopup: async () => {
          moved = true;
        },
      }),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/card/funding/topup",
      headers: AUTH,
      payload: { amountUsd: 20 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "dry_run", wouldAllow: true });
    expect(moved).toBe(false);
    expect(t.state.decisions).toMatchObject([
      { kind: "card_topup", rule: "dry_run", outcome: { allowed: false, wouldAllow: true } },
    ]);
  });

  it("tops up outside dry run and returns the fresh balance", async () => {
    const topups: number[] = [];
    const t = makeCardApp({
      ...LIVE,
      stripe: makeFakeGateway({
        fundingTopup: async (amountUsd) => {
          topups.push(amountUsd);
        },
        fundingBalance: async () => ({ balanceUsd: 70, pendingUsd: 20 }),
      }),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/card/funding/topup",
      headers: AUTH,
      payload: { amountUsd: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, balanceUsd: 70, pendingUsd: 20 });
    expect(topups).toEqual([20]);
    expect(t.state.decisions).toMatchObject([{ kind: "card_topup", rule: "topup_ok" }]);
  });

  it("caps a single move at daily_cap_usd", async () => {
    const t = makeCardApp(LIVE);
    const res = await t.app.inject({
      method: "POST",
      url: "/card/funding/topup",
      headers: AUTH,
      payload: { amountUsd: 61 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "amount_over_daily_cap" });
    expect(t.state.decisions).toMatchObject([{ rule: "amount_over_daily_cap" }]);
  });

  it("refuses a withdrawal beyond the available balance", async () => {
    const t = makeCardApp(LIVE); // fake balance is 50
    const res = await t.app.inject({
      method: "POST",
      url: "/card/funding/withdraw",
      headers: AUTH,
      payload: { amountUsd: 55 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds", balanceUsd: 50 });
    expect(t.state.decisions).toMatchObject([
      { kind: "card_withdraw", rule: "insufficient_funds" },
    ]);
  });

  it("answers 503 funding_unavailable, not 500, when the account isn't ready", async () => {
    const t = makeCardApp({
      ...LIVE,
      stripe: makeFakeGateway({
        fundingTopup: async () => {
          throw new FundingUnavailableError("no_financial_account");
        },
      }),
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/card/funding/topup",
      headers: AUTH,
      payload: { amountUsd: 20 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: "funding_unavailable",
      reason: "no_financial_account",
    });
    expect(t.state.decisions).toMatchObject([{ rule: "funding_unavailable" }]);
  });

  it("404s with no card and 400s on a bad amount", async () => {
    const noCard = makeTestApp({ stripe: makeFakeGateway() });
    const res404 = await noCard.app.inject({
      method: "POST",
      url: "/card/funding/topup",
      headers: AUTH,
      payload: { amountUsd: 20 },
    });
    expect(res404.statusCode).toBe(404);

    const t = makeCardApp(LIVE);
    const res400 = await t.app.inject({
      method: "POST",
      url: "/card/funding/topup",
      headers: AUTH,
      payload: { amountUsd: -5 },
    });
    expect(res400.statusCode).toBe(400);
  });
});

describe("GET /card/reveal", () => {
  it("returns the ephemeral key facts and audits the reveal", async () => {
    const t = makeCardApp();
    const res = await t.app.inject({ method: "GET", url: "/card/reveal", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stripeCardId: CARD_ID,
      ephemeralKeySecret: "ek_test_fake",
      apiVersion: "2026-08-26.dahlia",
    });
    expect(t.state.decisions).toMatchObject([{ kind: "card_reveal", rule: "reveal_ok" }]);
  });

  it("passes a requested api_version through to the key", async () => {
    const t = makeCardApp();
    const res = await t.app.inject({
      method: "GET",
      url: "/card/reveal?api_version=2020-03-02",
      headers: AUTH,
    });
    expect(res.json().apiVersion).toBe("2020-03-02");
  });

  it("404s when there is no card", async () => {
    const t = makeTestApp({ stripe: makeFakeGateway() });
    const res = await t.app.inject({ method: "GET", url: "/card/reveal", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_card" });
  });
});

describe("POST /card/freeze and /card/unfreeze", () => {
  it("freezes: flips Stripe, mirrors the row, audits", async () => {
    const calls: string[] = [];
    const t = makeCardApp({
      stripe: makeFakeGateway({
        setCardStatus: async (_id, status) => {
          calls.push(status);
          return status;
        },
      }),
    });
    const res = await t.app.inject({ method: "POST", url: "/card/freeze", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "inactive" });
    expect(calls).toEqual(["inactive"]);
    expect(t.state.issuingCards[0]!.status).toBe("inactive");
    expect(t.state.decisions).toMatchObject([{ kind: "card_status", rule: "freeze_ok" }]);

    const back = await t.app.inject({ method: "POST", url: "/card/unfreeze", headers: AUTH });
    expect(back.json()).toEqual({ status: "active" });
    expect(t.state.issuingCards[0]!.status).toBe("active");
  });
});
