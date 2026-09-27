/**
 * FR-33 — the Wallet, as far as a new throwaway user can drive it live in
 * dry run: the summary's shape and honesty (three ways to pay with their
 * availability, every parking account and what pays there, spend against
 * the policy's caps, the Activity page), source switching refusing what
 * isn't ready and accepting what is, and the pieces that must answer
 * without ever reaching Stripe or Link from here.
 *
 * Guard rails on top of client.ts's: nothing here creates a Stripe
 * Customer, SetupIntent, or hold (setup-intent is only called where the
 * server must refuse it before any Stripe call), no Link request is ever
 * made, and no /card route is called. The hold → capture → release money
 * path itself is pinned by server/test/walletHolds.test.ts (a live hold
 * needs a linked provider, which a throwaway never has), and paging a real
 * ledger — sessions, garages, confirmed plans — by server/test/wallet.test.ts
 * (the suite never confirms a plan, so it never has one to page).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { gate, ownUser, userFetch } from "./client.js";

/** This file's own throwaway user (client.ts `ownUser`): a brand-new
 * account, so everything below is what a new user sees. */
const me = ownUser(import.meta.url);

let policy: Record<string, unknown>;
let wallet: Record<string, unknown>;

beforeAll(async () => {
  policy = (await gate())["policy"] as Record<string, unknown>;
  const res = await userFetch(me, "GET", "/wallet");
  expect(res.status).toBe(200);
  wallet = res.body;
});

const AVAILABILITY = ["available", "connect", "coming_soon"];

describe("FR-33 GET /wallet answers how the user pays and what they spent", () => {
  it("FR-33 the three ways to pay, in order, each with an honest availability", () => {
    expect(wallet["activeSource"]).toBe("provider_card");
    expect(wallet["dryRun"]).toBe(true);
    const options = wallet["options"] as Record<string, unknown>[];
    expect(options.map((o) => o["source"])).toEqual([
      "provider_card",
      "link_wallet",
      "parkagent_card",
    ]);
    for (const option of options) {
      expect(AVAILABILITY).toContain(option["availability"]);
      expect(typeof option["sandbox"]).toBe("boolean");
    }
    // The card on the provider account needs nothing set up.
    expect(options[0]!["availability"]).toBe("available");

    const link = wallet["link"] as Record<string, unknown>;
    const linkOption = options[1]!;
    // "coming soon" exactly when the server has no Link credentials.
    expect(linkOption["availability"] === "coming_soon").toBe(link["configured"] === false);
    // Link never pays a street meter — the summary says what it covers.
    expect(link["covers"]).toBe("plans_and_garages");
    expect(String(link["manageUrl"])).toMatch(/^https:\/\//);
    // A throwaway never connects Link.
    expect(link["connected"]).toBe(false);

    const card = wallet["parkagentCard"] as Record<string, unknown>;
    const cardOption = options[2]!;
    if (card["live"] !== true && card["sandboxSelectable"] !== true) {
      expect(cardOption["availability"]).toBe("coming_soon");
    }
    // A throwaway never saves a card, so nothing is ready to hold against.
    expect(card["fundingMethods"]).toEqual([]);
    expect(cardOption["availability"]).not.toBe("available");
  });

  it("FR-33 every parking account and what pays there — an unlinked new user is told to connect", () => {
    const providers = wallet["providers"] as Record<string, unknown>[];
    expect(providers.map((p) => p["id"]).sort()).toEqual(["parknyc", "passport"]);
    for (const p of providers) {
      expect(p["status"]).toBe("unlinked");
      expect(p["paysWith"]).toBeNull();
      expect(p["attention"]).toBe("connect");
      expect(typeof p["displayName"]).toBe("string");
    }
    expect((wallet["providerCard"] as Record<string, unknown>)["cards"]).toEqual([]);
  });

  it("FR-33 spend is measured against the active policy's caps, split per city", () => {
    const spending = wallet["spending"] as Record<string, unknown>;
    expect(spending["dailyCapUsd"]).toBe(policy["daily_cap_usd"]);
    expect(spending["sessionCapUsd"]).toBe(policy["session_cap_usd"]);
    // A new account has spent nothing (and dry run moves no money).
    expect(spending["todayUsd"]).toBe(0);
    expect(spending["monthUsd"]).toBe(0);
    const byCity = spending["byCity"] as Record<string, unknown>[];
    expect(byCity.map((c) => c["city"]).sort()).toEqual(["bos", "nyc"]);
  });

  it("FR-33 GET /me reports the same active source as the Wallet", async () => {
    // Read together, now: a shuffled run may have switched sources since
    // the snapshot above.
    const now = await userFetch(me, "GET", "/wallet");
    const profile = await userFetch(me, "GET", "/me");
    expect(profile.status).toBe(200);
    expect(profile.body["paymentSource"]).toBe(now.body["activeSource"]);
  });
});

describe("FR-33 GET /wallet/activity is the unified, paginated ledger", () => {
  it("FR-33 a new user's ledger is empty and complete; bad paging is refused", async () => {
    // Nothing was paid, booked, or planned on this account: no items and
    // no cursor to a next page. (Paging a real ledger: wallet.test.ts.)
    const page = await userFetch(me, "GET", "/wallet/activity?limit=2");
    expect(page.status).toBe(200);
    expect(page.body["items"]).toEqual([]);
    expect(page.body["nextCursor"]).toBeNull();
    expect((await userFetch(me, "GET", "/wallet/activity?limit=0")).status).toBe(400);
    expect((await userFetch(me, "GET", "/wallet/activity?cursor=yesterday")).status).toBe(400);
  });
});

describe("FR-33 switching how you pay validates readiness", () => {
  it("FR-33 Link is refused until it's configured and connected", async () => {
    const res = await userFetch(me, "PUT", "/wallet/source", { source: "link_wallet" });
    expect(res.status).toBe(409);
    const link = wallet["link"] as Record<string, unknown>;
    expect(res.body["error"]).toBe(
      link["configured"] ? "link_not_connected" : "link_not_configured",
    );
    expect(typeof res.body["decisionId"]).toBe("string");
  });

  it("FR-33 the ParkAgent card is refused until it's live (or sandboxed) and has a card to hold against", async () => {
    const card = wallet["parkagentCard"] as Record<string, unknown>;
    const plain = await userFetch(me, "PUT", "/wallet/source", { source: "parkagent_card" });
    expect(plain.status).toBe(409);
    expect(plain.body["error"]).toBe(
      card["live"] === true ? "no_funding_method" : "parkagent_card_not_live",
    );

    const sandbox = await userFetch(me, "PUT", "/wallet/source", {
      source: "parkagent_card",
      sandbox: true,
    });
    expect(sandbox.status).toBe(409);
    expect(sandbox.body["error"]).toBe(
      card["live"] === true || card["sandboxSelectable"] === true
        ? "no_funding_method"
        : "parkagent_card_not_live",
    );
    // The old value isn't accepted on the wire.
    expect((await userFetch(me, "PUT", "/wallet/source", { source: "issuing_card" })).status).toBe(
      400,
    );
  });

  it("FR-33 the card on the provider account is always choosable, and nothing else moved", async () => {
    const res = await userFetch(me, "PUT", "/wallet/source", { source: "provider_card" });
    expect(res.status).toBe(200);
    expect(res.body["activeSource"]).toBe("provider_card");
    expect(res.body["setupJobs"]).toEqual([]);
    const after = await userFetch(me, "GET", "/wallet");
    expect(after.body["activeSource"]).toBe("provider_card");
  });

  it("FR-33 saving a card is refused before any Stripe call while the ParkAgent card isn't live", async () => {
    const card = wallet["parkagentCard"] as Record<string, unknown>;
    // Only where the refusal is certain: a live card would mint a real
    // Customer, which this suite never does.
    if (card["live"] === true) return;
    const res = await userFetch(me, "POST", "/wallet/setup-intent", {});
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("parkagent_card_not_live");
  });
});

describe("FR-33 the funded-balance surface is gone", () => {
  it("FR-33 the old payment-source route is gone — the Wallet is the one place", async () => {
    expect((await userFetch(me, "GET", "/me/payment-source")).status).toBe(404);
  });

  it("FR-33 a Link card can't be revealed for a request the caller doesn't own", async () => {
    const res = await userFetch(me, "POST", "/link/spend-requests/lsrq_not_yours/card", {});
    expect([404, 503]).toContain(res.status);
    expect(res.body["error"]).toBe(
      res.status === 503 ? "link_not_configured" : "unknown_spend_request",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/\d{12,}/);
  });
});
