/**
 * Provider accounts: registry resolution, state sealing, link with cookie
 * domain filtering + headless verification, the chained link → setup-card
 * job, manual setup-card (incl. dry run), unlink (best-effort card removal
 * + freezing the Issuing card), the wallet top-up gates, and the
 * provider_not_linked refusal on session start.
 */

import { describe, expect, it } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import {
  cityForZone,
  cookieDomainAllowed,
  providerById,
  providerForCity,
} from "../src/providers/registry.js";
import type { CardFormDetails } from "../src/services/providerOps.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  makeFakeGateway,
  makeFakeProviderOps,
  makeTestApp,
  seedProviderAccount,
  testStateCrypto,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);
const LIVE = { policy: { dry_run: false }, envDryRun: false };

const SESSION_COOKIE = {
  name: "session",
  value: "cookie-value-1",
  domain: ".nyc.flowbirdapp.com",
  path: "/",
};
const WRONG_DOMAIN_COOKIE = { ...SESSION_COOKIE, domain: "evil.example.com" };

function post(t: ReturnType<typeof makeTestApp>, url: string, body?: unknown) {
  return t.app.inject({ method: "POST", url, headers: HEADERS, payload: (body ?? {}) as object });
}

/** The chained job runs async off the request; poll link-status briefly. */
async function waitForJob(
  t: ReturnType<typeof makeTestApp>,
  jobId: string,
): Promise<{ phase: string; reason?: string; retrySafe?: boolean; dryRun?: boolean }> {
  for (let i = 0; i < 100; i += 1) {
    const res = await t.app.inject({
      method: "GET",
      url: `/providers/parknyc/link-status?jobId=${jobId}`,
      headers: HEADERS,
    });
    const body = res.json() as { phase: string };
    if (body.phase === "done" || body.phase === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("link job never settled");
}

describe("registry", () => {
  it("maps city → provider and zoneId → city", () => {
    expect(providerForCity("nyc")?.id).toBe("parknyc");
    expect(providerForCity("bos")?.id).toBe("passport");
    expect(providerForCity("atlantis")).toBeNull();
    expect(providerForCity(null)).toBeNull();
    expect(cityForZone("nyc-110436")).toBe("nyc");
    expect(cityForZone("garbage")).toBeNull();
    expect(providerById("parknyc")?.displayName).toBe("ParkNYC");
    expect(providerById("nope")).toBeNull();
  });

  it("filters cookie domains with suffix matching, leading dot ignored", () => {
    const parknyc = providerById("parknyc")!;
    expect(cookieDomainAllowed(parknyc, ".nyc.flowbirdapp.com")).toBe(true);
    expect(cookieDomainAllowed(parknyc, "my.nyc.flowbirdapp.com")).toBe(true);
    expect(cookieDomainAllowed(parknyc, "flowbirdapp.com")).toBe(true);
    expect(cookieDomainAllowed(parknyc, "evilflowbirdapp.com")).toBe(false);
    expect(cookieDomainAllowed(parknyc, "example.com")).toBe(false);
  });
});

describe("state crypto", () => {
  it("round-trips and rejects tampering", () => {
    const crypto = testStateCrypto();
    const sealed = crypto.seal('{"cookies":[]}');
    expect(sealed).not.toContain("cookies");
    expect(crypto.open(sealed)).toBe('{"cookies":[]}');

    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expect(() => crypto.open(raw.toString("base64"))).toThrow();
  });
});

describe("POST /providers/:provider/link", () => {
  it("verifies, seals the state, and reports the wallet balance", async () => {
    const verified: string[] = [];
    const t = makeTestApp({
      seedLinkedProvider: false,
      now: () => NOW,
      providerOps: () =>
        makeFakeProviderOps({
          verifyAccount: async () => {
            verified.push("yes");
            return { ok: true, walletBalanceCents: 1250 };
          },
        }),
    });
    const res = await post(t, "/providers/parknyc/link", {
      cookies: [SESSION_COOKIE, WRONG_DOMAIN_COOKIE],
      set_up_card: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "linked", walletBalanceCents: 1250, jobId: null });
    expect(verified).toEqual(["yes"]);

    const account = t.state.providerAccounts[0]!;
    expect(account).toMatchObject({ provider: "parknyc", status: "linked", cardAdded: false });
    // Sealed, and only the allowed-domain cookie inside.
    expect(account.stateEncrypted).not.toContain("cookie-value-1");
    const opened = JSON.parse(testStateCrypto().open(account.stateEncrypted!)) as {
      cookies: { domain: string }[];
    };
    expect(opened.cookies).toHaveLength(1);
    expect(opened.cookies[0]!.domain).toBe(".nyc.flowbirdapp.com");
    // The audit records counts and domains, never values.
    const decision = t.state.decisions.find((d) => d.kind === "provider_link")!;
    expect(decision.rule).toBe("link_ok");
    expect(JSON.stringify(decision.inputs)).not.toContain("cookie-value-1");
  });

  it("400s when no cookie is on the provider's domains", async () => {
    const t = makeTestApp({ seedLinkedProvider: false, providerOps: () => makeFakeProviderOps() });
    const res = await post(t, "/providers/parknyc/link", {
      cookies: [WRONG_DOMAIN_COOKIE],
      set_up_card: false,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "no_session_cookies" });
    expect(t.state.providerAccounts).toHaveLength(0);
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "no_session_cookies" });
  });

  it("409s when verification fails, storing nothing", async () => {
    const t = makeTestApp({
      seedLinkedProvider: false,
      providerOps: () =>
        makeFakeProviderOps({
          verifyAccount: async () => ({
            ok: false,
            code: "auth_expired",
            message: "sign-in shown",
          }),
        }),
    });
    const res = await post(t, "/providers/parknyc/link", {
      cookies: [SESSION_COOKIE],
      set_up_card: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "verification_failed", code: "auth_expired" });
    expect(t.state.providerAccounts).toHaveLength(0);
  });

  it("requires explicit consent before a chained card setup", async () => {
    const t = makeTestApp({ seedLinkedProvider: false, providerOps: () => makeFakeProviderOps() });
    const res = await post(t, "/providers/parknyc/link", { cookies: [SESSION_COOKIE] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "consent_required" });
  });

  it("503s without a state key or executor; 404s an unknown provider", async () => {
    const noOps = makeTestApp({ seedLinkedProvider: false });
    const res = await post(noOps, "/providers/parknyc/link", {
      cookies: [SESSION_COOKIE],
      set_up_card: false,
    });
    expect(res.statusCode).toBe(503);

    const t = makeTestApp({ providerOps: () => makeFakeProviderOps() });
    const unknown = await post(t, "/providers/whoever/link", {
      cookies: [SESSION_COOKIE],
      set_up_card: false,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("chained link → setup-card", () => {
  const cardApp = (options: Parameters<typeof makeTestApp>[0] = {}) => {
    const t = makeTestApp({
      seedLinkedProvider: false,
      stripe: makeFakeGateway(),
      now: () => NOW,
      providerOps: () => makeFakeProviderOps(),
      ...LIVE,
      ...options,
    });
    t.state.issuingCards.push({
      stripeCardId: "ic_test_1",
      userId: "u1",
      last4: "4242",
      status: "pending_onboarding",
    });
    return t;
  };

  it("links, adds the card, and graduates it to active", async () => {
    const forms: CardFormDetails[] = [];
    const t = cardApp({
      providerOps: () =>
        makeFakeProviderOps({
          setupCard: async (card) => {
            forms.push({ ...card });
            return { ok: true };
          },
        }),
    });
    const res = await post(t, "/providers/parknyc/link", {
      cookies: [SESSION_COOKIE],
      set_up_card: true,
      consent_replace_payment_method: true,
    });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    const job = await waitForJob(t, jobId);
    expect(job).toMatchObject({ phase: "done", dryRun: false });
    // The form got the real details with the brand for the radio mapping…
    expect(forms[0]).toMatchObject({ number: "4242424242424242", cvc: "123", brand: "Visa" });
    // …the card is live, the account remembers it, and the audit is clean.
    expect(t.state.issuingCards[0]!.status).toBe("active");
    expect(t.state.providerAccounts[0]!.cardAdded).toBe(true);
    const decision = t.state.decisions.find((d) => d.kind === "provider_setup_card")!;
    expect(decision.rule).toBe("setup_ok");
    expect(JSON.stringify(decision.inputs)).not.toContain("4242424242424242");
  });

  it("reports a typed failure with retry-safety", async () => {
    const t = cardApp({
      providerOps: () =>
        makeFakeProviderOps({
          setupCard: async () => ({ ok: false, code: "ui_changed", message: "form moved" }),
        }),
    });
    const res = await post(t, "/providers/parknyc/link", {
      cookies: [SESSION_COOKIE],
      set_up_card: true,
      consent_replace_payment_method: true,
    });
    const job = await waitForJob(t, (res.json() as { jobId: string }).jobId);
    expect(job).toMatchObject({ phase: "failed", reason: "ui_changed", retrySafe: true });
    expect(t.state.issuingCards[0]!.status).toBe("pending_onboarding");
  });

  it("an unsupported brand fails not-retry-safe", async () => {
    const t = cardApp({
      providerOps: () =>
        makeFakeProviderOps({
          setupCard: async () => ({
            ok: false,
            code: "unsupported_card_brand",
            message: "no radio for brand",
          }),
        }),
    });
    const res = await post(t, "/providers/parknyc/link", {
      cookies: [SESSION_COOKIE],
      set_up_card: true,
      consent_replace_payment_method: true,
    });
    const job = await waitForJob(t, (res.json() as { jobId: string }).jobId);
    expect(job).toMatchObject({
      phase: "failed",
      reason: "unsupported_card_brand",
      retrySafe: false,
    });
  });
});

describe("POST /providers/:provider/setup-card", () => {
  it("in dry run never touches the provider and records wouldAdd", async () => {
    let touched = false;
    const t = makeTestApp({
      stripe: makeFakeGateway(),
      providerOps: () =>
        makeFakeProviderOps({
          setupCard: async () => {
            touched = true;
            return { ok: true };
          },
        }),
    });
    t.state.issuingCards.push({
      stripeCardId: "ic_test_1",
      userId: "u1",
      status: "pending_onboarding",
    });
    const res = await post(t, "/providers/parknyc/setup-card");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, dryRun: true });
    expect(touched).toBe(false);
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "provider_setup_card",
      rule: "dry_run",
      outcome: { wouldAdd: true },
    });
    expect(t.state.issuingCards[0]!.status).toBe("pending_onboarding");
  });

  it("409s without a card (no_card, retry-safe after /card/prepare)", async () => {
    const t = makeTestApp({
      stripe: makeFakeGateway(),
      providerOps: () => makeFakeProviderOps(),
      ...LIVE,
    });
    const res = await post(t, "/providers/parknyc/setup-card");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_card", retrySafe: true });
  });
});

describe("POST /providers/:provider/unlink", () => {
  it("removes the card best-effort, unlinks, and freezes the Issuing card", async () => {
    const removed: string[] = [];
    const t = makeTestApp({
      seedLinkedProvider: false,
      stripe: makeFakeGateway(),
      providerOps: () =>
        makeFakeProviderOps({
          removeCard: async (last4) => {
            removed.push(last4);
            return { ok: true };
          },
        }),
    });
    seedProviderAccount(t.state, { cardAdded: true });
    t.state.issuingCards.push({
      stripeCardId: "ic_test_1",
      userId: "u1",
      last4: "4242",
      status: "active",
    });

    const res = await post(t, "/providers/parknyc/unlink");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, cardRemoval: "removed", cardFrozen: true });
    expect(removed).toEqual(["4242"]);
    expect(t.state.providerAccounts[0]).toMatchObject({
      status: "unlinked",
      stateEncrypted: null,
      cardAdded: false,
    });
    // Frozen, never canceled.
    expect(t.state.issuingCards[0]!.status).toBe("inactive");
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "provider_unlink", rule: "unlink_ok" });
  });

  it("a failed removal never blocks the unlink", async () => {
    const t = makeTestApp({
      seedLinkedProvider: false,
      stripe: makeFakeGateway(),
      providerOps: () =>
        makeFakeProviderOps({
          removeCard: async () => ({ ok: false, code: "network", message: "offline" }),
        }),
    });
    seedProviderAccount(t.state, { cardAdded: true });
    t.state.issuingCards.push({ stripeCardId: "ic_test_1", userId: "u1", status: "active" });

    const res = await post(t, "/providers/parknyc/unlink");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, cardRemoval: "failed:network", cardFrozen: true });
    expect(t.state.providerAccounts[0]!.status).toBe("unlinked");
  });

  it("404s when nothing is linked", async () => {
    const t = makeTestApp({ seedLinkedProvider: false });
    const res = await post(t, "/providers/parknyc/unlink");
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /providers/:provider/topup", () => {
  it("refuses under dry run with the audit trail", async () => {
    let moved = false;
    const t = makeTestApp({
      providerOps: () =>
        makeFakeProviderOps({
          topupWallet: async () => {
            moved = true;
            return { ok: true, walletBalanceCents: 9999 };
          },
        }),
    });
    const res = await post(t, "/providers/parknyc/topup", { amountUsd: 25 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "dry_run", wouldAllow: true });
    expect(moved).toBe(false);
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "provider_topup", rule: "dry_run" });
  });

  it("caps a single top-up at daily_cap_usd and runs the real move", async () => {
    const t = makeTestApp({ ...LIVE, providerOps: () => makeFakeProviderOps() });
    const over = await post(t, "/providers/parknyc/topup", { amountUsd: 61 });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: "amount_over_daily_cap" });

    const ok = await post(t, "/providers/parknyc/topup", { amountUsd: 20 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, walletBalanceCents: 3250 });
    expect(t.state.providerAccounts[0]!.walletBalanceCents).toBe(3250);
  });
});

describe("POST /session/start without a linked provider", () => {
  const STEINWAY_ZONE: ZoneTermsRow = {
    zoneId: "nyc-417371",
    parknycZoneNumber: "417371",
    rateFirstHour: 2.0,
    rateAdditionalHour: 3.0,
    maxStayMinutes: 120,
    hoursJson: HOURS_MON_SAT,
  };

  it("409s naming the provider, and links unblock it", async () => {
    const t = makeTestApp({
      seedLinkedProvider: false,
      zones: [STEINWAY_ZONE],
      now: () => NOW,
    });
    t.state.parkedEvents.push({
      id: "pe1",
      userId: "u1",
      lat: 40.7702,
      lng: -73.9077,
      accuracyM: 12,
      ts: NOW,
      signals: ["motion_stop"],
    });
    const refused = await post(t, "/session/start", {
      parkedEventId: "pe1",
      zoneId: "nyc-417371",
      minutes: 90,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: "provider_not_linked",
      provider: "parknyc",
      displayName: "ParkNYC",
    });
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "session_start",
      rule: "provider_not_linked",
    });

    seedProviderAccount(t.state);
    const started = await post(t, "/session/start", {
      parkedEventId: "pe1",
      zoneId: "nyc-417371",
      minutes: 90,
    });
    expect(started.statusCode).toBe(200);
  });
});
