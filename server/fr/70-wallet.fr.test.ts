/**
 * FR-33 — the Wallet, as far as the dedicated FR user can drive it live in
 * dry run: the summary's shape and honesty (three ways to pay with their
 * availability, every parking account and what pays there, spend against
 * the policy's caps, the Activity page), source switching refusing what
 * isn't ready and accepting what is, and the pieces that must answer
 * without ever reaching Stripe or Link from here.
 *
 * Guard rails on top of client.ts's: nothing here creates a Stripe
 * Customer, SetupIntent, or hold (setup-intent is only called where the
 * server must refuse it before any Stripe call), no Link request is ever
 * made, no /card route is called, and the FR user is left on
 * provider_card. The hold → capture → release money path itself is pinned
 * by server/test/walletHolds.test.ts (a live hold needs a linked provider,
 * which the FR user deliberately never has).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frFetch, gate } from "./client.js";

let policy: Record<string, unknown>;
let wallet: Record<string, unknown>;

beforeAll(async () => {
  policy = (await gate())["policy"] as Record<string, unknown>;
  // Start from the default, whatever a previous run left behind.
  await frFetch("PUT", "/wallet/source", { source: "provider_card" });
  const res = await frFetch("GET", "/wallet");
  expect(res.status).toBe(200);
  wallet = res.body;
});

afterAll(async () => {
  await frFetch("PUT", "/wallet/source", { source: "provider_card" });
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
    // The FR user never connects Link.
    expect(link["connected"]).toBe(false);

    const card = wallet["parkagentCard"] as Record<string, unknown>;
    const cardOption = options[2]!;
    if (card["live"] !== true && card["sandboxSelectable"] !== true) {
      expect(cardOption["availability"]).toBe("coming_soon");
    }
    // The FR user never saves a card, so nothing is ready to hold against.
    expect(card["fundingMethods"]).toEqual([]);
    expect(cardOption["availability"]).not.toBe("available");
  });

  it("FR-33 every parking account and what pays there — the unlinked FR user is told to connect", () => {
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
    // Dry-run sessions move no money, and the FR user never pays for real.
    expect(spending["todayUsd"]).toBe(0);
    expect(spending["monthUsd"]).toBe(0);
    const byCity = spending["byCity"] as Record<string, unknown>[];
    expect(byCity.map((c) => c["city"]).sort()).toEqual(["bos", "nyc"]);
  });

  it("FR-33 GET /me reports the same active source as the Wallet", async () => {
    const me = await frFetch("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body["paymentSource"]).toBe(wallet["activeSource"]);
  });
});

describe("FR-33 GET /wallet/activity is the unified, paginated ledger", () => {
  it("FR-33 pages carry typed items and an opaque cursor; bad paging is refused", async () => {
    const page = await frFetch("GET", "/wallet/activity?limit=2");
    expect(page.status).toBe(200);
    const items = page.body["items"] as Record<string, unknown>[];
    expect(items.length).toBeLessThanOrEqual(2);
    for (const item of items) {
      expect(["session", "garage", "link_payment", "plan"]).toContain(item["kind"]);
      expect(
        String(item["id"]).startsWith(
          `${item["kind"] === "link_payment" ? "link" : item["kind"]}:`,
        ),
      ).toBe(true);
      if (item["kind"] === "plan") {
        // A plan made in the assistant is not money moved: priced, never
        // a charge (FR-38).
        expect(item["totalUsd"]).toBeUndefined();
        expect(typeof item["plannedUsd"]).toBe("number");
      }
      if (item["kind"] === "session") {
        expect(typeof item["explanation"]).toBe("string");
        expect(Array.isArray(item["timeline"])).toBe(true);
        // The FR user's sessions are refused before any row (unlinked), but
        // if one ever exists it is dry run and says so.
        expect(item["dryRun"]).toBe(true);
      }
    }
    const next = page.body["nextCursor"];
    expect(next === null || typeof next === "string").toBe(true);
    if (typeof next === "string") {
      const second = await frFetch(
        `GET`,
        `/wallet/activity?limit=2&cursor=${encodeURIComponent(next)}`,
      );
      expect(second.status).toBe(200);
      const firstIds = new Set(items.map((i) => i["id"]));
      for (const item of second.body["items"] as Record<string, unknown>[]) {
        expect(firstIds.has(item["id"])).toBe(false);
      }
    }
    expect((await frFetch("GET", "/wallet/activity?limit=0")).status).toBe(400);
    expect((await frFetch("GET", "/wallet/activity?cursor=yesterday")).status).toBe(400);
  });
});

describe("FR-33 switching how you pay validates readiness", () => {
  it("FR-33 Link is refused until it's configured and connected", async () => {
    const res = await frFetch("PUT", "/wallet/source", { source: "link_wallet" });
    expect(res.status).toBe(409);
    const link = wallet["link"] as Record<string, unknown>;
    expect(res.body["error"]).toBe(
      link["configured"] ? "link_not_connected" : "link_not_configured",
    );
    expect(typeof res.body["decisionId"]).toBe("string");
  });

  it("FR-33 the ParkAgent card is refused until it's live (or sandboxed) and has a card to hold against", async () => {
    const card = wallet["parkagentCard"] as Record<string, unknown>;
    const plain = await frFetch("PUT", "/wallet/source", { source: "parkagent_card" });
    expect(plain.status).toBe(409);
    expect(plain.body["error"]).toBe(
      card["live"] === true ? "no_funding_method" : "parkagent_card_not_live",
    );

    const sandbox = await frFetch("PUT", "/wallet/source", {
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
    expect((await frFetch("PUT", "/wallet/source", { source: "issuing_card" })).status).toBe(400);
  });

  it("FR-33 the card on the provider account is always choosable, and nothing else moved", async () => {
    const res = await frFetch("PUT", "/wallet/source", { source: "provider_card" });
    expect(res.status).toBe(200);
    expect(res.body["activeSource"]).toBe("provider_card");
    expect(res.body["setupJobs"]).toEqual([]);
    const after = await frFetch("GET", "/wallet");
    expect(after.body["activeSource"]).toBe("provider_card");
  });

  it("FR-33 saving a card is refused before any Stripe call while the ParkAgent card isn't live", async () => {
    const card = wallet["parkagentCard"] as Record<string, unknown>;
    // Only where the refusal is certain: a live card would mint a real
    // Customer, which this suite never does.
    if (card["live"] === true) return;
    const res = await frFetch("POST", "/wallet/setup-intent", {});
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("parkagent_card_not_live");
  });
});

describe("FR-33 the funded-balance surface is gone", () => {
  it("FR-33 the old payment-source route is gone — the Wallet is the one place", async () => {
    expect((await frFetch("GET", "/me/payment-source")).status).toBe(404);
  });

  it("FR-33 a Link card can't be revealed for a request the caller doesn't own", async () => {
    const res = await frFetch("POST", "/link/spend-requests/lsrq_not_yours/card", {});
    expect([404, 503]).toContain(res.status);
    expect(res.body["error"]).toBe(
      res.status === 503 ? "link_not_configured" : "unknown_spend_request",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/\d{12,}/);
  });
});
