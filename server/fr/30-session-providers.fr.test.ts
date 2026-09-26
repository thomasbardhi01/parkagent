/**
 * FR-13 / FR-17 / FR-10 — the money-path gate and provider accounts, as
 * far as a dedicated test user can drive them live: session start must
 * refuse without a linked provider account (dry run included), the
 * provider registry must advertise both cities' link flows, and the
 * payment-source switch (the Wallet's) must hold its gate. The paid start/extend/stop
 * flows themselves are pinned by the unit and executor-fixture suites
 * (see docs/functional-requirements.md).
 *
 * NOTE: the FR user is intentionally never provider-linked, so nothing in
 * this suite can ever reach a real provider, even outside dry run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frFetch, gate, mostRecentEasternAt, NYC_AUTOPAY, parkedBody } from "./client.js";

/** Set once the FR-10 test has tried to switch the FR user's source. */
let touchedSource = false;

beforeAll(async () => {
  await gate();
});

// The FR user is left on the default however FR-10 ends — a regression
// that let the switch through must not strand it on the ParkAgent card.
afterAll(async () => {
  if (touchedSource) {
    await frFetch("PUT", "/wallet/source", { source: "provider_card" }).catch(() => null);
  }
});

describe("FR-13 / FR-17 session start requires the caller's own linked provider", () => {
  it("FR-17 FR-13 POST /session/start refuses provider_not_linked for an unlinked user, before any executor call", async () => {
    const parked = await frFetch(
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: mostRecentEasternAt(14, 0) }),
    );
    expect(parked.status).toBe(200);
    const candidates = parked.body["candidates"] as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);

    const res = await frFetch("POST", "/session/start", {
      parkedEventId: parked.body["parkedEventId"],
      zoneId: candidates[0]!["zoneId"],
    });
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("provider_not_linked");
    expect(res.body["provider"]).toBe("parknyc");
    expect(typeof res.body["displayName"]).toBe("string");
  });
});

describe("FR-17 provider registry and link status", () => {
  it("FR-17 GET /providers/status lists both cities' providers with link material and an unlinked status for the FR user", async () => {
    const res = await frFetch("GET", "/providers/status");
    expect(res.status).toBe(200);
    const providers = res.body["providers"] as Record<string, unknown>[];
    const ids = providers.map((p) => p["id"]);
    expect(ids).toContain("parknyc");
    expect(ids).toContain("passport");
    for (const p of providers) {
      expect(typeof p["loginUrl"]).toBe("string");
      expect(Array.isArray(p["cookieDomains"])).toBe(true);
      expect((p["cookieDomains"] as string[]).length).toBeGreaterThan(0);
      // The dedicated FR user never links anywhere.
      expect(p["status"]).toBe("unlinked");
    }
  });

  it("FR-17 linking with no cookies for the provider's domains is rejected at the door", async () => {
    const res = await frFetch("POST", "/providers/parknyc/link", {
      cookies: [
        {
          name: "not-a-session",
          value: "x",
          domain: ".example.com",
          path: "/",
          expires: 1900000000,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      set_up_card: false,
    });
    // Wrong-domain cookies are all dropped → no_session_cookies (or 503
    // when the deployment has no PROVIDER_STATE_KEY — also a refusal).
    expect([400, 503]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body["error"]).toBe("no_session_cookies");
      expect(Array.isArray(res.body["expectedDomains"])).toBe(true);
    }
  });

  // Linking is a background job now; its status and "let me know" answer
  // only for the caller's own jobs. (Nothing here creates a job — that
  // would drive a real browser at the provider.)
  it("FR-17 a link job that isn't the caller's is unknown to link-status and to notify", async () => {
    const status = await frFetch("GET", "/providers/passport/link-status?jobId=fr-not-a-job");
    expect(status.status).toBe(404);
    expect(status.body["error"]).toBe("unknown_job");

    const notify = await frFetch("POST", "/providers/passport/link-jobs/fr-not-a-job/notify");
    expect(notify.status).toBe(404);
    expect(notify.body["error"]).toBe("unknown_job");
  });
});

describe("FR-10 payment source", () => {
  it("FR-10 the FR user defaults to the card on the provider account and the ParkAgent card's gate answers honestly", async () => {
    const wallet = await frFetch("GET", "/wallet");
    expect(wallet.status).toBe(200);
    expect(["provider_card", "link_wallet", "parkagent_card"]).toContain(
      wallet.body["activeSource"],
    );
    const card = wallet.body["parkagentCard"] as Record<string, unknown>;
    expect(typeof card["live"]).toBe("boolean");

    touchedSource = true;
    const wantCard = await frFetch("PUT", "/wallet/source", { source: "parkagent_card" });
    // Never allowed for the FR user: not live, or live with no card to
    // hold against — either way the caps' path stays untouched.
    expect(wantCard.status).toBe(409);
    expect(wantCard.body["error"]).toBe(
      card["live"] === true ? "no_funding_method" : "parkagent_card_not_live",
    );

    // Leave the FR user on the default either way.
    const restore = await frFetch("PUT", "/wallet/source", { source: "provider_card" });
    expect(restore.status).toBe(200);
    expect(restore.body["activeSource"]).toBe("provider_card");
  });
});
