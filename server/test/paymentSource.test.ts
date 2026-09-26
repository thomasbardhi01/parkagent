/**
 * The payment-source setting (GET /wallet, PUT /wallet/source) and how it
 * drives everything downstream: provider linking skips or chains the
 * setup-card, sessions snapshot the source, the caps bind every source,
 * and shadow mode fires alongside regardless of source.
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import {
  API_KEY,
  MONDAY_2PM,
  makeFakeGateway,
  makeFakeProviderOps,
  makeTestApp,
  seedFundingMethod,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);

const HOURS_BOS = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];

const BOYLSTON_ZONE: ZoneTermsRow = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  street: "BOYLSTON ST",
  providerZoneNumber: "456",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 300,
  hoursJson: HOURS_BOS,
};

function makeApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp({
    zones: [BOYLSTON_ZONE],
    now: () => NOW,
    seedLinkedProvider: false,
    ...options,
  });
  seedProviderAccount(t.state, { provider: "passport" });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 42.3495,
    lng: -71.0798,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  return t;
}

function req(
  app: ReturnType<typeof makeTestApp>["app"],
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: HEADERS,
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

const START = { parkedEventId: "pe1", zoneId: BOYLSTON_ZONE.zoneId, minutes: 90 };

test("GET /wallet defaults to provider_card; Link and the ParkAgent card say coming soon", async () => {
  const { app } = makeApp();
  const res = await req(app, "GET", "/wallet");
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.activeSource).toBe("provider_card");
  expect(body.options).toEqual([
    { source: "provider_card", availability: "available", needs: null, sandbox: false },
    { source: "link_wallet", availability: "coming_soon", needs: null, sandbox: false },
    { source: "parkagent_card", availability: "coming_soon", needs: null, sandbox: false },
  ]);
  // GET /me reports the same fact — Account and Wallet can't disagree.
  const me = await req(app, "GET", "/me");
  expect(me.json().paymentSource).toBe("provider_card");
});

test("PUT parkagent_card is refused while it isn't live (or sandboxed), and audited", async () => {
  const { app, state } = makeApp();
  const res = await req(app, "PUT", "/wallet/source", { source: "parkagent_card" });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "parkagent_card_not_live" });
  // A sandbox request against a LIVE-mode key is refused the same way.
  const sandbox = await req(app, "PUT", "/wallet/source", {
    source: "parkagent_card",
    sandbox: true,
  });
  expect(sandbox.json()).toMatchObject({ error: "parkagent_card_not_live" });

  const decision = state.decisions.find((d) => d.kind === "payment_source")!;
  expect(decision.rule).toBe("parkagent_card_not_live");
  expect(decision.outcome).toMatchObject({ allowed: false });
  // Nothing changed.
  const after = await req(app, "GET", "/wallet");
  expect(after.json().activeSource).toBe("provider_card");
});

test("PUT switches the source when ready, both ways, and audits each change", async () => {
  const { app, state } = makeApp({ issuingLive: true, stripe: makeFakeGateway() });
  seedFundingMethod(state);
  state.providerAccounts[0]!.cardAdded = true; // our card is already on the account

  const toCard = await req(app, "PUT", "/wallet/source", { source: "parkagent_card" });
  expect(toCard.statusCode).toBe(200);
  expect(toCard.json()).toMatchObject({ activeSource: "parkagent_card", setupJobs: [] });

  const back = await req(app, "PUT", "/wallet/source", { source: "provider_card" });
  expect(back.statusCode).toBe(200);
  expect(back.json().activeSource).toBe("provider_card");

  const rules = state.decisions.filter((d) => d.kind === "payment_source").map((d) => d.rule);
  expect(rules).toEqual(["set", "set"]);

  const bad = await req(app, "PUT", "/wallet/source", { source: "cash" });
  expect(bad.statusCode).toBe(400);
  // The old value is not accepted on the wire any more.
  const old = await req(app, "PUT", "/wallet/source", { source: "issuing_card" });
  expect(old.statusCode).toBe(400);
});

test("provider_card linking skips setup-card without consent; parkagent_card chains it", async () => {
  // Default (provider_card): no consent needed, no job, account untouched.
  const t = makeApp({ providerOps: () => makeFakeProviderOps() });
  const linked = await req(t.app, "POST", "/providers/parknyc/link", {
    cookies: [{ name: "sid", value: "s3cret", domain: ".nyc.flowbirdapp.com" }],
  });
  expect(linked.statusCode).toBe(202);
  await t.linkWorker.tick();
  expect(t.state.linkJobs[0]).toMatchObject({ phase: "done", setUpCard: false });
  const link = t.state.decisions.find(
    (d) => d.kind === "provider_link" && d.rule === "link_queued",
  )!;
  expect(link.inputs).toMatchObject({ setUpCard: false, paymentSource: "provider_card" });

  // parkagent_card: the same request without consent is refused up front.
  const issuing = makeApp({
    providerOps: () => makeFakeProviderOps(),
    paymentSource: "parkagent_card",
    issuingLive: true,
  });
  const noConsent = await req(issuing.app, "POST", "/providers/parknyc/link", {
    cookies: [{ name: "sid", value: "s3cret", domain: ".nyc.flowbirdapp.com" }],
  });
  expect(noConsent.statusCode).toBe(400);
  expect(noConsent.json()).toEqual({ error: "consent_required" });
});

test("a session snapshots the user's payment source at start", async () => {
  const { app, state } = makeApp();
  const started = await req(app, "POST", "/session/start", START);
  expect(started.statusCode).toBe(200);
  expect(state.sessions.at(-1)!.paymentSource).toBe("provider_card");

  const decision = state.decisions.find(
    (d) => d.kind === "session_start" && d.rule === "start_ok",
  )!;
  expect(decision.inputs).toMatchObject({ paymentSource: "provider_card" });
});

test("session and daily caps bind provider_card sessions exactly like any source", async () => {
  // Session cap: 90 min at $3.75 = $5.63 + $0.35 fee = $5.98 > a $5 cap.
  const capped = makeApp({ policy: { session_cap_usd: 5 } });
  const overSession = await req(capped.app, "POST", "/session/start", START);
  expect(overSession.statusCode).toBe(409);
  expect(overSession.json()).toMatchObject({
    error: "policy_violation",
    rule: "session_cap_exceeded",
  });
  expect(
    capped.state.decisions.find((d) => d.rule === "session_cap_exceeded")!.inputs,
  ).toMatchObject({ paymentSource: "provider_card" });

  // Daily cap: $58 of real provider_card spend already today + $5.98 > $60.
  // envDryRun false so the daily-cap check is armed (dry runs don't count).
  const daily = makeApp({ envDryRun: false, policy: { dry_run: false, daily_cap_usd: 60 } });
  seedSession(daily.state, {
    userId: "u1",
    status: "stopped",
    dryRun: false,
    paymentSource: "provider_card",
    amountUsd: 58,
    feeUsd: 0,
    createdAt: NOW,
  });
  const overDaily = await req(daily.app, "POST", "/session/start", START);
  expect(overDaily.statusCode).toBe(409);
  expect(overDaily.json()).toMatchObject({ error: "policy_violation", rule: "daily_cap_exceeded" });
});

test("shadow mode fires its test authorization alongside a provider_card session", async () => {
  const stripe = makeFakeGateway({
    createTestAuthorization: async () => ({ authorizationId: "iauth_shadow_ps", approved: true }),
  });
  const { app, state } = makeApp({ policy: { shadow_mode: true }, stripe });
  state.issuingCards.push({ stripeCardId: "ic_u1", userId: "u1" });

  const started = await req(app, "POST", "/session/start", START);
  expect(started.statusCode).toBe(200);
  expect(state.sessions.at(-1)!.paymentSource).toBe("provider_card");

  const decision = state.decisions.find(
    (d) => d.kind === "session_start" && d.rule === "start_ok",
  )!;
  expect(decision.outcome["shadow"]).toMatchObject({
    fired: true,
    authorizationId: "iauth_shadow_ps",
    approved: true,
  });
});
