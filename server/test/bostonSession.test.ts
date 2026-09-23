/**
 * Boston sessions and shadow mode. Zone fixture is the Boylston St Back Bay
 * block (flat $3.75/hr, Mon-Sat 8-8, 120 min max): a 90-minute start prices
 * at $5.63 meter + $0.35 ParkBoston fee (city_overrides), and the session
 * row carries city "bos" so the extension worker prices ticket risk with
 * Boston's $40 ticket.
 *
 * Shadow mode runs entirely in dry run here: the executor leg stays the
 * DryRunExecutor (dry-run switches are never bypassed) while the Stripe
 * test authorization fires and lands on the decisions row.
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import {
  API_KEY,
  MONDAY_2PM,
  makeFakeGateway,
  makeFakeProviderOps,
  makeTestApp,
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
  // User-reported at the meter (the source data has none, and ParkBoston's
  // app has no map) — the unknown→reported→verified progression lives in
  // zoneNumber.test.ts; here the number is already known.
  providerZoneNumber: "81234",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 120,
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

function post(app: ReturnType<typeof makeTestApp>["app"], url: string, body: unknown) {
  return app.inject({ method: "POST", url, headers: HEADERS, payload: body as object });
}

const START = { parkedEventId: "pe1", zoneId: BOYLSTON_ZONE.zoneId, minutes: 90 };

test("a Boston start stores city bos and prices the ParkBoston fee", async () => {
  const { app, state } = makeApp();

  const started = await post(app, "/session/start", START);
  expect(started.statusCode).toBe(200);
  // 90 min flat $3.75/hr = $5.63 meter (half-up) + $0.35 ParkBoston fee.
  expect(started.json().amountUsd).toBe(5.98);

  const session = state.sessions.at(-1)!;
  expect(session.city).toBe("bos");
  expect(Number(session.feeUsd)).toBe(0.35);
});

test("a Boston start without a linked passport account refuses provider_not_linked", async () => {
  const t = makeTestApp({ zones: [BOYLSTON_ZONE], now: () => NOW, seedLinkedProvider: false });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 42.3495,
    lng: -71.0798,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  // A linked ParkNYC account does not satisfy a Boston zone.
  seedProviderAccount(t.state, { provider: "parknyc" });

  const started = await post(t.app, "/session/start", START);
  expect(started.statusCode).toBe(409);
  expect(started.json()).toMatchObject({
    error: "provider_not_linked",
    provider: "passport",
    displayName: "ParkBoston",
  });
});

test("a Boston start with no reported zone number refuses needs_zone_number", async () => {
  // A copy, not the shared fixture: nobody has reported this one yet.
  const { app, state } = makeApp({ zones: [{ ...BOYLSTON_ZONE, providerZoneNumber: "" }] });

  const started = await post(app, "/session/start", START);
  expect(started.statusCode).toBe(409);
  expect(started.json()).toMatchObject({
    error: "needs_zone_number",
    zoneId: BOYLSTON_ZONE.zoneId,
  });
  // Refused before any session row or executor call; the decision records it.
  expect(state.sessions).toHaveLength(0);
  expect(state.decisions.find((d) => d.kind === "session_start")!.rule).toBe("needs_zone_number");
});

test("the extension worker prices Boston ticket risk with the $40 ticket", async () => {
  const { state, deps } = makeApp();
  const extender = makeExtender({ ...deps, log: { info() {}, warn() {} } });
  // Started 80 min ago, 10 min left, no fixes: heading unknown, dwell falls
  // back to the 90-min default, so pReturn = 0.6 and ticket risk uses the
  // city ticket: bos 40 × 0.4 = 16 (nyc would be 65 × 0.4 = 26).
  seedSession(state, {
    status: "active",
    dryRun: true,
    userId: "u1",
    zoneId: BOYLSTON_ZONE.zoneId,
    city: "bos",
    startedAt: new Date(NOW.getTime() - 80 * 60_000),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    createdAt: new Date(NOW.getTime() - 80 * 60_000),
    amountUsd: 5.63,
    feeUsd: 0.35,
    purchasedMinutes: 90,
    chargedMinutes: 90,
    rateFirstHour: 3.75,
    rateAdditionalHour: 3.75,
    maxStayMinutes: 120,
    hoursJson: HOURS_BOS,
    parknycConfirmation: "dry-seed",
  });

  await extender.tick();

  const tick = state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
  expect(tick.inputs["costTicketUsd"]).toBe(16);
  // $16 of ticket risk clearly beats a ~$2 extension: the worker extends,
  // and the extension's fee is Boston's $0.35.
  expect(tick.rule).toBe("extend");
  const price = tick.inputs["price"] as { feeUsd: number };
  expect(price.feeUsd).toBe(0.35);
});

// ---------------------------------------------------------------------------
// Shadow mode (dry run stays on throughout: the executor leg is the
// DryRunExecutor; only the Stripe test authorization fires for real).

test("shadow mode: session start fires a test authorization onto the decision", async () => {
  const fired: { cardId: string; amountUsd: number; merchant: { name: string } }[] = [];
  const stripe = makeFakeGateway({
    createTestAuthorization: async (cardId, amountUsd, merchant) => {
      fired.push({ cardId, amountUsd, merchant });
      return { authorizationId: "iauth_shadow_1", approved: true };
    },
  });
  const { app, state } = makeApp({ policy: { shadow_mode: true }, stripe });
  state.issuingCards.push({ stripeCardId: "ic_u1", userId: "u1" });

  const started = await post(app, "/session/start", START);
  expect(started.statusCode).toBe(200);

  expect(fired).toEqual([
    {
      cardId: "ic_u1",
      amountUsd: 5.98,
      merchant: expect.objectContaining({ name: "PARKAGENT SHADOW PARKBOSTON" }),
    },
  ]);
  const decision = state.decisions.find(
    (d) => d.kind === "session_start" && d.rule === "start_ok",
  )!;
  expect(decision.outcome["shadow"]).toMatchObject({
    fired: true,
    authorizationId: "iauth_shadow_1",
    approved: true,
    amountUsd: 5.98,
  });
  // The session itself stayed dry-run: the executor leg never went real.
  expect(state.sessions.at(-1)!.dryRun).toBe(true);
});

test("shadow mode: extension fires and records too; no card is recorded, not thrown", async () => {
  const stripe = makeFakeGateway({
    createTestAuthorization: async () => ({ authorizationId: "iauth_shadow_2", approved: false }),
  });
  const { app, state } = makeApp({ policy: { shadow_mode: true }, stripe });
  state.issuingCards.push({ stripeCardId: "ic_u1", userId: "u1" });

  const started = await post(app, "/session/start", START);
  const { sessionId } = started.json();
  const extended = await post(app, "/session/extend", { sessionId, minutes: 30 });
  expect(extended.statusCode).toBe(200);

  const extendDecision = state.decisions.find((d) => d.kind === "session_extend")!;
  expect(extendDecision.outcome["shadow"]).toMatchObject({
    fired: true,
    authorizationId: "iauth_shadow_2",
    approved: false,
  });

  // Without a card the shadow leg records why instead of firing or throwing.
  const bare = makeApp({ policy: { shadow_mode: true }, stripe: makeFakeGateway() });
  const bareStart = await post(bare.app, "/session/start", START);
  expect(bareStart.statusCode).toBe(200);
  const bareDecision = bare.state.decisions.find(
    (d) => d.kind === "session_start" && d.rule === "start_ok",
  )!;
  expect(bareDecision.outcome["shadow"]).toMatchObject({ fired: false, reason: "no_card" });
});

test("provider_card linking skips the chained setup-card and its consent gate (shadow mode has no say)", async () => {
  // The skip is driven by the user's payment source now, not shadow_mode:
  // shadow mode only adds a test authorization alongside real spends.
  const { app, state } = makeApp({
    policy: { shadow_mode: true },
    stripe: makeFakeGateway(),
    providerOps: () => makeFakeProviderOps(),
  });

  // No consent_replace_payment_method, set_up_card defaulting true: for an
  // issuing_card user this is 400 consent_required; for the provider_card
  // default it links and chains NO setup-card job.
  const linked = await post(app, "/providers/passport/link", {
    cookies: [{ name: "sid", value: "s3cret", domain: ".bostonma.ppprk.com" }],
  });
  expect(linked.statusCode).toBe(200);
  expect(linked.json()).toMatchObject({ status: "linked", jobId: null });

  const decision = state.decisions.find((d) => d.kind === "provider_link" && d.rule === "link_ok")!;
  expect(decision.inputs).toMatchObject({
    setUpCard: false,
    shadowMode: true,
    paymentSource: "provider_card",
  });
  expect(state.decisions.some((d) => d.kind === "provider_setup_card")).toBe(false);
});
