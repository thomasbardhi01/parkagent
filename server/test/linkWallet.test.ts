/**
 * Link wallet against a faked LinkClient: the OAuth handshake, refresh-token
 * rotation, per-stop spend requests (request → approval → sealed card →
 * reveal at the garage's own checkout), the approval timeout, and the
 * Wallet's scope rule — Link pays garages (single spots and plan stops),
 * never a street meter.
 */

import { describe, expect, test } from "vitest";

import type {
  CreateSpendRequestArgs,
  LinkClient,
  LinkSpendRequestState,
  LinkTokens,
} from "../src/services/link/linkClient.js";
import { makeLinkHttpClient } from "../src/services/link/linkClient.js";
import { makeWalletTick } from "../src/jobs/walletTick.js";
import { API_KEY, MONDAY_2PM, makeTestApp, testStateCrypto } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);

function fakeLinkClient() {
  const requests = new Map<string, LinkSpendRequestState & { context: string }>();
  let counter = 0;
  let tokenCounter = 0;
  const state = {
    requests,
    createdArgs: [] as CreateSpendRequestArgs[],
    refreshCalls: 0,
    revoked: [] as string[],
    paymentMethod: { type: "card", brand: "Visa", last4: "1234" } as {
      type: "card" | "bank_account";
      brand: string | null;
      last4: string | null;
    } | null,
    approve(id: string, card?: Partial<LinkSpendRequestState["card"]>) {
      const row = requests.get(id)!;
      row.status = "approved";
      row.card = {
        brand: "visa",
        number: "4000009990001984",
        cvc: "100",
        expMonth: 6,
        expYear: 2029,
        validUntil: new Date(NOW.getTime() + 12 * 60 * 60_000).toISOString(),
        ...card,
      };
    },
  };
  const client: LinkClient = {
    authorizationUrl: ({ state: s, codeChallenge }) =>
      `https://login.link.com/auth?state=${s}&code_challenge=${codeChallenge}`,
    exchangeCode: async () => nextTokens(),
    refresh: async (refreshToken) => {
      state.refreshCalls += 1;
      if (refreshToken.startsWith("dead")) throw new Error("invalid_grant");
      return nextTokens();
    },
    revoke: async (token) => {
      state.revoked.push(token);
    },
    createSpendRequest: async (_token, args) => {
      state.createdArgs.push(args);
      counter += 1;
      const row: LinkSpendRequestState & { context: string } = {
        id: `lsrq_${counter}`,
        status: "pending_approval",
        amountUsd: args.amountUsd,
        approvalUrl: `https://app.link.com/activity/approve/lsrq_${counter}`,
        validUntil: null,
        context: args.context,
      };
      requests.set(row.id, row);
      return row;
    },
    retrieveSpendRequest: async (_token, id, options) => {
      const row = requests.get(id)!;
      if (!options?.includeCard) {
        const rest = { ...row };
        delete rest.card;
        return rest;
      }
      return row;
    },
    cancelSpendRequest: async (_token, id) => {
      requests.get(id)!.status = "canceled";
    },
    defaultPaymentMethod: async () => state.paymentMethod,
  };
  function nextTokens(): LinkTokens {
    tokenCounter += 1;
    return {
      accessToken: `liwltoken_${tokenCounter}`,
      refreshToken: `liwlrefresh_${tokenCounter}`,
      expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      scope: "payment_methods.agentic userinfo:read",
    };
  }
  return { client, state };
}

async function connectedWallet(
  now: () => Date = () => NOW,
  options: Parameters<typeof makeTestApp>[0] = {},
) {
  const { client, state } = fakeLinkClient();
  const t = makeTestApp({ linkClient: client, now, ...options });
  const wallet = t.deps.linkWallet!;
  const { state: oauthState } = wallet.startConnect("u1");
  await wallet.handleCallback(oauthState, "auth-code");
  return { t, wallet, link: state };
}

describe("connect flow", () => {
  test("request → callback stores sealed tokens; status flips; disconnect revokes", async () => {
    const { t, wallet, link } = await connectedWallet();
    expect((await wallet.status("u1")).connected).toBe(true);
    // Sealed, never plaintext, and openable with the test key.
    const row = t.state.linkAccounts[0]!;
    expect(row.tokensEncrypted).not.toContain("liwltoken");
    expect(testStateCrypto().open(row.tokensEncrypted!)).toContain("liwltoken_1");

    await wallet.disconnect("u1");
    expect((await wallet.status("u1")).connected).toBe(false);
    expect(link.revoked).toHaveLength(1);
    expect(t.state.linkAccounts[0]!.tokensEncrypted).toBeNull();
  });

  test("a stale or forged OAuth state is rejected", async () => {
    const { client } = fakeLinkClient();
    const t = makeTestApp({ linkClient: client });
    await expect(t.deps.linkWallet!.handleCallback("forged", "code")).rejects.toThrow(
      "unknown_state",
    );
  });

  test("an expired access token refreshes and persists the ROTATED refresh token", async () => {
    let at = NOW;
    const { wallet, link, t } = await connectedWallet(() => at);
    // Jump past the 1-hour access token.
    at = new Date(NOW.getTime() + 2 * 60 * 60_000);
    const token = await wallet.accessToken("u1");
    expect(token).toBe("liwltoken_2");
    expect(link.refreshCalls).toBe(1);
    expect(testStateCrypto().open(t.state.linkAccounts[0]!.tokensEncrypted!)).toContain(
      "liwlrefresh_2",
    );
  });

  test("a dead refresh token disconnects cleanly instead of looping", async () => {
    let at = NOW;
    const { wallet, t } = await connectedWallet(() => at);
    // Poison the stored refresh token, then expire the access token.
    t.state.linkAccounts[0]!.tokensEncrypted = testStateCrypto().seal(
      JSON.stringify({
        accessToken: "x",
        refreshToken: "dead_token",
        expiresAt: NOW.toISOString(),
        scope: "",
      }),
    );
    at = new Date(NOW.getTime() + 2 * 60 * 60_000);
    expect(await wallet.accessToken("u1")).toBeNull();
    expect((await wallet.status("u1")).connected).toBe(false);
  });
});

describe("spend requests: request → approval → card → spend", () => {
  test("one request per stop, context ≥100 chars, approval URLs surfaced", async () => {
    const { wallet, link } = await connectedWallet();
    const created = await wallet.createSpendRequestsForStops("u1", {
      planId: "plan1",
      itineraryId: "day1",
      stops: [
        {
          stopId: "s1",
          label: "Museum",
          amountUsd: 5,
          merchantName: "City parking meters",
          merchantUrl: "https://spothero.com",
        },
        {
          stopId: "s2",
          label: "Deck",
          amountUsd: 18,
          merchantName: "SpotHero",
          merchantUrl: "https://spothero.com",
        },
      ],
    });
    expect(created).toHaveLength(2); // verified: no batch approval exists
    expect(created[0]!.approvalUrl).toContain("app.link.com/activity/approve");
    for (const args of link.createdArgs) {
      expect(args.context.length).toBeGreaterThanOrEqual(100);
    }
  });

  test("approval seals the one-time card; only its owner can reveal it, while valid", async () => {
    let at = NOW;
    const { t, wallet, link } = await connectedWallet(() => at);
    const [req] = await wallet.createSpendRequestsForStops("u1", {
      planId: "plan1",
      stops: [
        {
          stopId: "s1",
          label: "Deck",
          amountUsd: 18,
          merchantName: "SpotHero",
          merchantUrl: "https://spothero.com",
        },
      ],
    });
    await expect(wallet.revealCard("u1", req!.spendRequestId)).rejects.toThrow("not_approved");

    link.approve(req!.spendRequestId);
    await wallet.syncSpendRequest("u1", req!.spendRequestId);
    const row = t.state.linkSpendRequests[0]!;
    expect(row.status).toBe("approved");
    expect(row.cardEncrypted).not.toContain("4000009990001984"); // sealed at rest

    await expect(wallet.revealCard("u2", req!.spendRequestId)).rejects.toThrow(
      "unknown_spend_request",
    );
    expect((await wallet.revealCard("u1", req!.spendRequestId)).number).toBe("4000009990001984");
    expect(row.revealedAt).toEqual(NOW);

    // 13 hours later — past the 12-hour validity window — it's gone.
    at = new Date(NOW.getTime() + 13 * 60 * 60_000);
    await expect(wallet.revealCard("u1", req!.spendRequestId)).rejects.toThrow("card_expired");
  });

  test("an approval nobody gives inside Link's 10-minute window expires, uncharged", async () => {
    let at = NOW;
    const { t, wallet, link } = await connectedWallet(() => at);
    const [req] = await wallet.createSpendRequestsForStops("u1", {
      planId: "plan1",
      stops: [
        {
          stopId: "s1",
          label: "Deck",
          amountUsd: 18,
          merchantName: "SpotHero",
          merchantUrl: "https://spothero.com",
        },
      ],
    });
    expect(t.state.linkSpendRequests[0]!.approvalExpiresAt).toEqual(
      new Date(NOW.getTime() + 10 * 60_000),
    );
    expect(await wallet.pendingApprovals("u1")).toHaveLength(1);

    const tick = makeWalletTick({
      db: t.deps.db,
      policy: t.deps.policy,
      linkWallet: wallet,
      now: () => at,
      log: { info: () => {}, warn: () => {} },
    });
    at = new Date(NOW.getTime() + 9 * 60_000);
    expect((await tick.tick()).approvalsExpired).toBe(0); // still inside the window
    at = new Date(NOW.getTime() + 11 * 60_000);
    expect((await tick.tick()).approvalsExpired).toBe(1);
    expect(t.state.linkSpendRequests[0]!.status).toBe("expired");
    expect(await wallet.pendingApprovals("u1")).toEqual([]);
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "link_wallet",
      rule: "approval_expired",
      outcome: { charged: false },
    });
    // A late approval in Link can't revive it: sync answers expired and
    // never seals a card.
    link.approve(req!.spendRequestId);
    expect(await wallet.syncSpendRequest("u1", req!.spendRequestId)).toEqual({
      status: "expired",
    });
    expect(t.state.linkSpendRequests[0]!.cardEncrypted ?? null).toBeNull();
    // And the sweep is idempotent.
    expect((await tick.tick()).approvalsExpired).toBe(0);
  });
});

/** A single-spot plan with one street and one garage option. */
function seedSpotPlan(t: ReturnType<typeof makeTestApp>, garagePriceUsd = 18) {
  t.state.assistantPlans.push({
    id: "plan1",
    userId: "u1",
    conversationId: "c1",
    kind: "single_spot",
    plan: {
      kind: "single_spot",
      options: [
        {
          id: "opt-street",
          type: "street",
          label: "Street",
          detail: "",
          priceUsd: 3.65,
          durationMinutes: 90,
          zoneId: "nyc-417371",
          recommended: true,
        },
        {
          id: "opt-garage",
          type: "garage",
          label: "Deck on 5th",
          detail: "",
          priceUsd: garagePriceUsd,
          durationMinutes: 120,
          provider: "spothero",
          deepLink: "https://spothero.com/checkout/135220",
          recommended: false,
        },
      ],
    },
  });
}

function confirm(t: ReturnType<typeof makeTestApp>, optionId: string) {
  return t.app.inject({
    method: "POST",
    url: "/assistant/confirm",
    headers: HEADERS,
    payload: { planId: "plan1", optionId },
  });
}

/** Link as the active Wallet source, outside dry run. */
const LINK_LIVE = {
  paymentSource: "link_wallet",
  policy: { dry_run: false },
  envDryRun: false,
} as const;

describe("routes and plan integration", () => {
  test("a garage confirmed with Link active: one spend request, approval, reveal, activity", async () => {
    const { t, link } = await connectedWallet(() => NOW, LINK_LIVE);
    seedSpotPlan(t);
    const res = await confirm(t, "opt-garage");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ kind: "garage_handoff", paymentSource: "link_wallet" });
    expect(body.linkApproval.approvalUrl).toContain("app.link.com");
    expect(link.requests.size).toBe(1);
    expect(link.createdArgs[0]).toMatchObject({ amountUsd: 18, merchantName: "SpotHero" });
    // The booking is recorded for Activity, carrying its Link request.
    expect(t.state.garageBookings).toMatchObject([
      { label: "Deck on 5th", paymentSource: "link_wallet", status: "handed_off" },
    ]);

    // The app polls sync after the user approves, then reveals the card
    // for the garage's own checkout.
    const id = body.linkApproval.spendRequestId as string;
    link.approve(id);
    const sync = await t.app.inject({
      method: "POST",
      url: `/link/spend-requests/${id}/sync`,
      headers: HEADERS,
      payload: {},
    });
    expect(sync.json()).toMatchObject({ status: "approved" });
    const reveal = await t.app.inject({
      method: "POST",
      url: `/link/spend-requests/${id}/card`,
      headers: HEADERS,
      payload: {},
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.headers["cache-control"]).toBe("no-store");
    expect(reveal.json()).toMatchObject({ number: "4000009990001984", expMonth: 6 });
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "link_card_reveal", rule: "reveal_ok" });
    // The reveal's audit row never carries the number.
    expect(JSON.stringify(t.state.decisions)).not.toContain("4000009990001984");

    const activity = await t.app.inject({
      method: "GET",
      url: "/wallet/activity",
      headers: HEADERS,
    });
    expect(activity.json().items).toMatchObject([
      { kind: "garage", label: "Deck on 5th", link: { spendRequestId: id, status: "approved" } },
    ]);
  });

  test("a street spot never goes to Link — it pays with the card on the provider account", async () => {
    const { t, link } = await connectedWallet(() => NOW, LINK_LIVE);
    seedSpotPlan(t);
    const res = await confirm(t, "opt-street");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: "street_confirmed",
      paymentSource: "provider_card",
      linkApproval: null,
    });
    expect(link.requests.size).toBe(0);
  });

  test("dry run creates no Link request unless Link itself is in test mode", async () => {
    const dry = await connectedWallet(() => NOW, { paymentSource: "link_wallet" });
    seedSpotPlan(dry.t);
    const res = await confirm(dry.t, "opt-garage");
    expect(res.json()).toMatchObject({
      kind: "garage_handoff",
      paymentSource: "garage_checkout",
      linkApproval: null,
      linkSkipped: "dry_run",
    });
    expect(dry.link.requests.size).toBe(0);

    const sandbox = await connectedWallet(() => NOW, {
      paymentSource: "link_wallet",
      linkTestMode: true,
    });
    seedSpotPlan(sandbox.t);
    const ok = await confirm(sandbox.t, "opt-garage");
    expect(ok.json()).toMatchObject({ paymentSource: "link_wallet" });
    expect(sandbox.link.createdArgs[0]).toMatchObject({ test: true });
  });

  test("the caps bind Link: over the per-stop cap no request is made", async () => {
    const { t, link } = await connectedWallet(() => NOW, LINK_LIVE);
    seedSpotPlan(t, 50); // cap is $45
    const res = await confirm(t, "opt-garage");
    expect(res.json()).toMatchObject({ linkApproval: null, linkSkipped: "session_cap_exceeded" });
    expect(link.requests.size).toBe(0);
  });

  test("an itinerary asks Link once per paid GARAGE stop; street stops stay on the curb", async () => {
    const { t, link } = await connectedWallet(() => NOW, LINK_LIVE);
    const stop = (id: string, choice: "street" | "garage", costUsd: number) => ({
      id,
      label: `Stop ${id}`,
      address: "1 Main St",
      lat: 42.35,
      lng: -71.07,
      arrival: "2026-01-05T15:00:00-05:00",
      durationMinutes: 60,
      choice,
      costUsd,
      ...(choice === "street"
        ? { zoneId: "nyc-417371" }
        : { deepLink: "https://spothero.com/checkout/1" }),
    });
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "itinerary",
      plan: {
        kind: "itinerary",
        date: "2026-01-05",
        stops: [stop("a", "street", 4), stop("b", "garage", 12), stop("c", "garage", 9)],
        totalUsd: 25,
        capUsd: 60,
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().linkApprovals).toHaveLength(2);
    expect(link.createdArgs.map((a) => a.amountUsd)).toEqual([12, 9]);
    const stops = t.state.itineraries[0]!.stops as { id: string; paymentSource: string }[];
    expect(stops.map((s) => s.paymentSource)).toEqual([
      "provider_card",
      "link_wallet",
      "link_wallet",
    ]);
  });

  test("policy link_wallet_for_plans:false keeps garages on their own checkout", async () => {
    const { t, link } = await connectedWallet(() => NOW, {
      ...LINK_LIVE,
      policy: { dry_run: false, link_wallet_for_plans: false },
    });
    seedSpotPlan(t);
    const res = await confirm(t, "opt-garage");
    expect(res.json()).toMatchObject({ paymentSource: "garage_checkout", linkApproval: null });
    expect(link.requests.size).toBe(0);
  });

  test("/link/status and 503s without configuration", async () => {
    const bare = makeTestApp({});
    // LinkWallet exists but has no client — configured false, still 200.
    const status = await bare.app.inject({ method: "GET", url: "/link/status", headers: HEADERS });
    expect(status.json()).toMatchObject({ configured: false, connected: false });
    const connect = await bare.app.inject({
      method: "POST",
      url: "/link/connect",
      headers: HEADERS,
      payload: {},
    });
    expect(connect.statusCode).toBe(503);
  });
});

describe("makeLinkHttpClient wire shapes", () => {
  test("authorization URL carries PKCE, state, scopes, and the publishable key", () => {
    const client = makeLinkHttpClient({
      clientId: "cli_1",
      clientSecret: "sec_1",
      publishableKey: "pk_test_1",
      redirectUri: "https://parkagent-api.fly.dev/link/callback",
    });
    const url = client.authorizationUrl({ state: "st1", codeChallenge: "ch1" });
    expect(url).toContain("https://login.link.com/auth?");
    expect(url).toContain("key=pk_test_1");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("state=st1");
    expect(url).toContain(
      encodeURIComponent("payment_methods.agentic userinfo:read").replace(/%20/g, "+"),
    );
  });

  test("token exchange posts the documented form fields with the pk bearer", async () => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const client = makeLinkHttpClient(
      {
        clientId: "cli_1",
        clientSecret: "sec_1",
        publishableKey: "pk_test_1",
        redirectUri: "https://x/cb",
      },
      async (url, init) => {
        calls.push({ url, body: init.body ?? "", auth: init.headers["Authorization"] ?? "" });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "liwltoken_a",
            refresh_token: "liwlrefresh_a",
            expires_in: 3600,
            scope: "payment_methods.agentic",
          }),
        };
      },
    );
    const tokens = await client.exchangeCode({ code: "c1", codeVerifier: "v1" });
    expect(tokens.accessToken).toBe("liwltoken_a");
    expect(calls[0]!.url).toBe("https://login.link.com/auth/token");
    expect(calls[0]!.auth).toBe("Bearer pk_test_1");
    for (const field of [
      "grant_type=authorization_code",
      "code=c1",
      "code_verifier=v1",
      "client_secret=sec_1",
    ]) {
      expect(calls[0]!.body).toContain(field);
    }
  });
});
