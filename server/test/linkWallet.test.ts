/**
 * Link wallet against a faked LinkClient: the OAuth handshake, per-stop
 * spend requests on plan confirmation (request → approval → sealed card
 * → use), refresh-token rotation, and the 12-hour-expiry fallback to the
 * Issuing card.
 */

import { describe, expect, test } from "vitest";

import type {
  CreateSpendRequestArgs,
  LinkClient,
  LinkSpendRequestState,
  LinkTokens,
} from "../src/services/link/linkClient.js";
import { makeLinkHttpClient } from "../src/services/link/linkClient.js";
import { LinkWallet } from "../src/services/link/linkWallet.js";
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
        const { card: _omit, ...rest } = row;
        return rest;
      }
      return row;
    },
    cancelSpendRequest: async (_token, id) => {
      requests.get(id)!.status = "canceled";
    },
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

async function connectedWallet(now: () => Date = () => NOW) {
  const { client, state } = fakeLinkClient();
  const t = makeTestApp({ linkClient: client, now });
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
        { stopId: "s1", label: "Museum", amountUsd: 5, merchantName: "City parking meters", merchantUrl: "https://spothero.com" },
        { stopId: "s2", label: "Deck", amountUsd: 18, merchantName: "SpotHero", merchantUrl: "https://spothero.com" },
      ],
    });
    expect(created).toHaveLength(2); // verified: no batch approval exists
    expect(created[0]!.approvalUrl).toContain("app.link.com/activity/approve");
    for (const args of link.createdArgs) {
      expect(args.context.length).toBeGreaterThanOrEqual(100);
    }
  });

  test("approval seals the one-time card; it is usable exactly once", async () => {
    const { t, wallet, link } = await connectedWallet();
    const [req] = await wallet.createSpendRequestsForStops("u1", {
      planId: "plan1",
      stops: [{ stopId: "s1", label: "Museum", amountUsd: 5, merchantName: "City parking meters", merchantUrl: "https://spothero.com" }],
    });
    expect(await wallet.usableCardForStop("u1", "s1")).toBeNull(); // not approved yet

    link.approve(req!.spendRequestId);
    await wallet.syncSpendRequest("u1", req!.spendRequestId);
    const row = t.state.linkSpendRequests[0]!;
    expect(row.status).toBe("approved");
    expect(row.cardEncrypted).not.toContain("4000009990001984"); // sealed

    const usable = await wallet.usableCardForStop("u1", "s1");
    expect(usable?.card.number).toBe("4000009990001984");

    await wallet.markCardUsed(usable!.spendRequestId);
    expect(await wallet.usableCardForStop("u1", "s1")).toBeNull(); // single-use
  });

  test("past valid_until (12 h) the card is unusable — the Issuing fallback fires", async () => {
    let at = NOW;
    const { wallet, link } = await connectedWallet(() => at);
    const [req] = await wallet.createSpendRequestsForStops("u1", {
      planId: "plan1",
      stops: [{ stopId: "s1", label: "Evening stop", amountUsd: 5, merchantName: "City parking meters", merchantUrl: "https://spothero.com" }],
    });
    link.approve(req!.spendRequestId);
    await wallet.syncSpendRequest("u1", req!.spendRequestId);
    expect(await wallet.usableCardForStop("u1", "s1")).not.toBeNull();

    // 13 hours later — past the 12-hour validity window.
    at = new Date(NOW.getTime() + 13 * 60 * 60_000);
    expect(await wallet.usableCardForStop("u1", "s1")).toBeNull();
  });
});

describe("routes and plan integration", () => {
  test("confirm with Link connected creates the spend request and returns the approval deep link", async () => {
    const { t, link } = await connectedWallet();
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
        ],
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "opt-street" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: "street_confirmed",
      paymentSource: "link_wallet",
    });
    expect(res.json().linkApproval.approvalUrl).toContain("app.link.com");
    expect(link.requests.size).toBe(1);

    // The app polls sync after the user approves.
    link.approve(res.json().linkApproval.spendRequestId);
    const sync = await t.app.inject({
      method: "POST",
      url: `/link/spend-requests/${res.json().linkApproval.spendRequestId}/sync`,
      headers: HEADERS,
      payload: {},
    });
    expect(sync.json()).toMatchObject({ status: "approved" });
  });

  test("policy link_wallet_for_plans:false keeps plans on the Issuing card", async () => {
    const { client } = fakeLinkClient();
    const t = makeTestApp({ linkClient: client, policy: { link_wallet_for_plans: false } });
    const wallet = t.deps.linkWallet!;
    const { state: s } = wallet.startConnect("u1");
    await wallet.handleCallback(s, "code");
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "single_spot",
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "o1",
            type: "street",
            label: "Street",
            detail: "",
            priceUsd: 3.65,
            durationMinutes: 60,
            zoneId: "nyc-417371",
            recommended: true,
          },
        ],
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", optionId: "o1" },
    });
    expect(res.json()).toMatchObject({ paymentSource: "issuing_card", linkApproval: null });
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
    expect(url).toContain(encodeURIComponent("payment_methods.agentic userinfo:read").replace(/%20/g, "+"));
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
    for (const field of ["grant_type=authorization_code", "code=c1", "code_verifier=v1", "client_secret=sec_1"]) {
      expect(calls[0]!.body).toContain(field);
    }
  });
});
