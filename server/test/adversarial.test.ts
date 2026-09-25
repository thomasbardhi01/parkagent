/**
 * Adversarial cases from the pre-field-test audit: hostile or degenerate
 * inputs on every surface that decides or moves money — clock skew,
 * boundary geometry, expired links, races, webhook replays, stale phone
 * fixes. Each test pins the hardening added in the same PR.
 */

import type Stripe from "stripe";
import { describe, expect, test } from "vitest";

import { buildApp, makeAuthenticate } from "../src/app.js";
import type { SessionRow } from "../src/db.js";
import { makeExtender, pReturnInTime } from "../src/jobs/extendTick.js";
import { DryRunExecutor } from "../src/services/executor.js";
import type { Executor, ExecutorResult } from "../src/services/executor.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import {
  API_KEY,
  BOYLSTON_BOS,
  HOURS_MON_SAT,
  MONDAY_2PM,
  STEINWAY_A,
  makeFakeDb,
  makeFakeGateway,
  makePolicyService,
  makeTestApp,
  parkedBody,
  seedProviderAccount,
  seedSession,
  TEST_PEPPER,
  seedHold,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);

function post(app: ReturnType<typeof makeTestApp>["app"], url: string, body: unknown) {
  return app.inject({ method: "POST", url, headers: HEADERS, payload: body as object });
}

// ---------------------------------------------------------------- /parked

describe("/parked adversarial inputs", () => {
  test("a 500 m accuracy fix is accepted and widens the radius to 500 m", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
    const res = await post(app, "/parked", parkedBody({ accuracy: 500 }));
    expect(res.statusCode).toBe(200);
    expect(state.decisions[0]!.inputs["radiusM"]).toBe(500);
  });

  test("a ts far in the past is clamped to server time and audited", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
    const res = await post(app, "/parked", parkedBody({ ts: "2020-01-01T12:00:00-05:00" }));
    expect(res.statusCode).toBe(200);
    expect(state.decisions[0]!.inputs).toMatchObject({
      pricedAt: NOW.toISOString(),
      pricedAtSource: "request_ts_clamped",
    });
  });

  test("a ts far in the future is clamped to server time and audited", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
    const res = await post(app, "/parked", parkedBody({ ts: "2030-01-01T12:00:00-05:00" }));
    expect(res.statusCode).toBe(200);
    expect(state.decisions[0]!.inputs).toMatchObject({
      pricedAtSource: "request_ts_clamped",
    });
  });

  test("a slightly delayed ts (network lag) still prices at the request ts", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
    const fiveMinAgo = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    await post(app, "/parked", parkedBody({ ts: fiveMinAgo }));
    expect(state.decisions[0]!.inputs["pricedAtSource"]).toBe("request_ts");
  });

  test("a zone from a city with no provider quotes fine, provider null", async () => {
    const phl: Candidate = { ...STEINWAY_A, zoneId: "phl-123", city: "phl" };
    const { app } = makeTestApp({ candidates: [phl] });
    const res = await post(app, "/parked", parkedBody());
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.provider).toBeNull();
    // No provider → nobody to type a number at → never needsZoneNumber.
    expect(body.needsZoneNumber).toBe(false);
  });

  test("equidistant agreeing candidates: nearest-listed wins, action pay", async () => {
    const twin = { ...STEINWAY_A, zoneId: "nyc-425957", providerZoneNumber: "425957" };
    const { app } = makeTestApp({ candidates: [STEINWAY_A, twin] });
    const res = await post(app, "/parked", parkedBody());
    expect(res.json().action).toBe("pay");
    expect(res.json().candidates).toHaveLength(1);
  });

  test("a point between two cities' zones: confirm, provider follows the nearest", async () => {
    // Geometrically impossible for NYC/Boston, but the resolver must not
    // assume one city per response.
    const nycFar = { ...STEINWAY_A, distanceM: 24.9 };
    const { app } = makeTestApp({ candidates: [{ ...BOYLSTON_BOS, distanceM: 24.5 }, nycFar] });
    const res = await post(app, "/parked", parkedBody({ lat: 42.3495, lng: -71.0798 }));
    const body = res.json();
    expect(body.action).toBe("confirm");
    expect(body.rule).toBe("candidates_disagree");
    expect(body.provider.id).toBe("passport");
  });

  test("concurrent /parked calls from one user both record cleanly", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A] });
    const [a, b] = await Promise.all([
      post(app, "/parked", parkedBody()),
      post(app, "/parked", parkedBody()),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(state.parkedEvents).toHaveLength(2);
    expect(state.decisions.filter((d) => d.kind === "parked_quote")).toHaveLength(2);
  });
});

// ---------------------------------------------------------- /session/start

const NYC_ZONE = {
  zoneId: "nyc-417371",
  city: "nyc",
  providerZoneNumber: "417371",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

function seedParkedEvent(state: ReturnType<typeof makeTestApp>["state"]) {
  state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 40.7784,
    lng: -73.9819,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
}

describe("/session/start adversarial states", () => {
  test("an expired provider link refuses provider_not_linked", async () => {
    const t = makeTestApp({ zones: [NYC_ZONE], seedLinkedProvider: false });
    seedProviderAccount(t.state, { status: "expired" });
    seedParkedEvent(t.state);
    const res = await post(t.app, "/session/start", {
      parkedEventId: "pe1",
      zoneId: NYC_ZONE.zoneId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "provider_not_linked", provider: "parknyc" });
    expect(t.state.decisions.at(-1)!.rule).toBe("provider_not_linked");
  });

  test("an EXPIRING link still pays — only expired/unlinked refuse", async () => {
    // The pair to the test above: "expiring" is the health job's early
    // nudge (cookies die within days), and a `status === "linked"` check
    // anywhere on the pay path would silently stop paying for it.
    const t = makeTestApp({ zones: [NYC_ZONE], seedLinkedProvider: false });
    seedProviderAccount(t.state, { status: "expiring" });
    seedParkedEvent(t.state);
    const res = await post(t.app, "/session/start", {
      parkedEventId: "pe1",
      zoneId: NYC_ZONE.zoneId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toEqual(expect.any(String));
    expect(t.state.decisions.some((d) => d.rule === "provider_not_linked")).toBe(false);
  });

  test("a start during a wholly free period is refused, not sent to the executor", async () => {
    // Monday 8 PM: enforcement (Mon-Sat 08:30-19:00) is over; the quote is
    // $0 and typing minutes into the provider anyway could charge money
    // the quote never priced.
    const t = makeTestApp({ zones: [NYC_ZONE], now: () => new Date("2026-01-05T20:00:00-05:00") });
    seedParkedEvent(t.state);
    const res = await post(t.app, "/session/start", {
      parkedEventId: "pe1",
      zoneId: NYC_ZONE.zoneId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "policy_violation", rule: "free_period" });
    expect(t.state.sessions).toHaveLength(0);
  });

  test("two concurrent starts: exactly one pays, the loser gets 409", async () => {
    // A deliberately slow executor holds the first call open so the second
    // reaches the create — the one_open_session_per_user constraint (fake
    // mirrors prod) must refuse it before any executor call.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let executorCalls = 0;
    const dry = new DryRunExecutor(
      () => {},
      () => NOW,
    );
    const slowExecutor: Executor = {
      async startSession(args): Promise<ExecutorResult> {
        executorCalls += 1;
        await gate;
        return dry.startSession(args);
      },
      extendSession: (args) => dry.extendSession(args),
      stopSession: (args) => dry.stopSession(args),
    };
    const t = makeTestApp({ zones: [NYC_ZONE], executor: slowExecutor });
    seedParkedEvent(t.state);

    const first = post(t.app, "/session/start", { parkedEventId: "pe1", zoneId: NYC_ZONE.zoneId });
    const second = post(t.app, "/session/start", { parkedEventId: "pe1", zoneId: NYC_ZONE.zoneId });
    // Let both requests run up to the gate, then open it.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([first, second]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(executorCalls).toBe(1);
    expect(t.state.sessions.filter((s) => s.status === "active")).toHaveLength(1);
  });

  test("a stale orphaned pending session is swept, not a permanent block", async () => {
    const t = makeTestApp({ zones: [NYC_ZONE] });
    seedParkedEvent(t.state);
    seedSession(t.state, {
      status: "pending",
      createdAt: new Date(NOW.getTime() - 30 * 60_000),
    });
    const res = await post(t.app, "/session/start", {
      parkedEventId: "pe1",
      zoneId: NYC_ZONE.zoneId,
    });
    expect(res.statusCode).toBe(200);
    expect(t.state.sessions[0]!.status).toBe("failed");
  });

  test("a fresh pending session (another start in flight) blocks with 409", async () => {
    const t = makeTestApp({ zones: [NYC_ZONE] });
    seedParkedEvent(t.state);
    seedSession(t.state, { status: "pending", createdAt: NOW });
    const res = await post(t.app, "/session/start", {
      parkedEventId: "pe1",
      zoneId: NYC_ZONE.zoneId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("session_already_active");
  });
});

// ------------------------------------------------------- extension worker

const CAR = { lat: 40.7784, lng: -73.9819 };

function tickApp() {
  const t = makeTestApp({ now: () => NOW });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  return { ...t, extender };
}

function tickSession(
  state: ReturnType<typeof makeTestApp>["state"],
  overrides: Partial<SessionRow> = {},
): SessionRow {
  return seedSession(state, {
    status: "active",
    dryRun: true,
    zoneId: "nyc-417371",
    providerZoneNumber: "417371",
    startedAt: new Date(NOW.getTime() - 80 * 60_000),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    createdAt: new Date(NOW.getTime() - 80 * 60_000),
    amountUsd: 3.5,
    feeUsd: 0.15,
    purchasedMinutes: 90,
    chargedMinutes: 90,
    carLat: CAR.lat,
    carLng: CAR.lng,
    rateFirstHour: 2.0,
    rateAdditionalHour: 3.0,
    maxStayMinutes: 240,
    hoursJson: HOURS_MON_SAT,
    parknycConfirmation: "dry-seed",
    ...overrides,
  });
}

function addFix(
  state: ReturnType<typeof makeTestApp>["state"],
  sessionId: string,
  distM: number,
  ageMs: number,
) {
  state.locationFixes.push({
    id: `f${state.locationFixes.length + 1}`,
    sessionId,
    userId: "u1",
    lat: CAR.lat + distM / 111_320,
    lng: CAR.lng,
    accuracyM: 10,
    ts: new Date(NOW.getTime() - ageMs),
  });
}

describe("extension worker degraded location", () => {
  test("no fixes at all: heading unknown, dwell fallback, decision written", async () => {
    const { state, extender } = tickApp();
    tickSession(state);
    await extender.tick();
    const tick = state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(tick.inputs).toMatchObject({ fixCount: 0, heading: "unknown", distanceM: null });
  });

  test("stale fixes are dropped, not read as a live position", async () => {
    const { state, extender } = tickApp();
    const session = tickSession(state);
    // The phone reported from 5 km away — 40 minutes ago, then went dark.
    addFix(state, session.id, 5000, 42 * 60_000);
    addFix(state, session.id, 5000, 41 * 60_000);
    addFix(state, session.id, 5000, 40 * 60_000);
    await extender.tick();
    const tick = state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(tick.inputs).toMatchObject({
      fixCount: 0,
      staleFixCount: 3,
      heading: "unknown",
      distanceM: null,
    });
  });

  test("phone at the car: hold — the driver can feed the meter themselves", async () => {
    const { state, extender } = tickApp();
    const session = tickSession(state);
    addFix(state, session.id, 8, 2 * 60_000);
    addFix(state, session.id, 6, 60_000);
    addFix(state, session.id, 5, 10_000);
    await extender.tick();
    const tick = state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(tick.rule).toBe("hold_return_likely");
  });

  test("phone 5 km away with fresh fixes: extend", async () => {
    const { state, extender } = tickApp();
    const session = tickSession(state);
    addFix(state, session.id, 4800, 2 * 60_000);
    addFix(state, session.id, 4900, 60_000);
    addFix(state, session.id, 5000, 10_000);
    await extender.tick();
    const tick = state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(tick.rule).toBe("extend");
  });

  test("pReturnInTime: standing at the car beats the heading buckets", () => {
    expect(
      pReturnInTime({
        heading: "still",
        walkEtaMin: 0.2,
        remainingMin: 8,
        elapsedMin: 80,
        dwellP50Min: 180,
      }),
    ).toBe(0.98);
  });
});

// ------------------------------------------------------- webhook replays

const VALID_SIG = "test-signature";
const CARD_ID = "ic_test_1";

function makeWebhookApp() {
  const { db, state } = makeFakeDb();
  state.issuingCards.push({ stripeCardId: CARD_ID, userId: "u1" });
  // The ParkAgent card approves only against a live hold.
  seedHold(state, { amountUsd: 10, createdAt: NOW });
  const gateway = makeFakeGateway({
    verifyEvent: (payload, signature) => {
      if (signature !== VALID_SIG) throw new Error("signature mismatch");
      return JSON.parse(payload.toString()) as Stripe.Event;
    },
  });
  const app = buildApp({
    db,
    policy: makePolicyService({ dry_run: false }, false),
    findCandidates: async () => [],
    authenticate: makeAuthenticate(db, TEST_PEPPER),
    executorFor: () => new DryRunExecutor(() => {}),
    sendPush: async () => {},
    stripe: gateway,
    hasPendingSession: async () => true,
    now: () => NOW,
  });
  return { app, state };
}

function authEvent(type: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type,
    api_version: "2026-08-26.dahlia",
    data: {
      object: {
        id: "iauth_1",
        object: "issuing.authorization",
        amount: 0,
        currency: "usd",
        approved: false,
        status: "pending",
        pending_request: { amount: 728, currency: "usd" },
        card: { id: CARD_ID },
        merchant_data: {
          category: "parking_lots_garages",
          category_code: "7523",
          name: "PARKNYC TEST METER",
        },
        ...overrides,
      },
    },
  };
}

function postHook(app: ReturnType<typeof buildApp>, event: unknown) {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": VALID_SIG },
    payload: JSON.stringify(event),
  });
}

describe("webhook replay and ordering", () => {
  test("a replayed .request answers the recorded decision, no duplicate row", async () => {
    const { app, state } = makeWebhookApp();
    const first = await postHook(app, authEvent("issuing_authorization.request"));
    expect(first.json()).toMatchObject({ approved: true });

    const replay = await postHook(app, authEvent("issuing_authorization.request"));
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ approved: true, metadata: { reason: "approved" } });
    expect(state.issuingAuthorizations).toHaveLength(1);
    const replayDecision = state.decisions.at(-1)!;
    expect(replayDecision.outcome).toMatchObject({ replayed: true });
    // The hold's room was claimed ONCE: a double claim would later capture
    // the charge twice from the user's card.
    expect(state.sessionHolds[0]!.authorizedUsd).toBe(7.28);
  });

  test("a .created arriving before the .request retry does not crash it", async () => {
    const { app, state } = makeWebhookApp();
    // Lifecycle event first (webhook was down for the original request).
    const created = await postHook(
      app,
      authEvent("issuing_authorization.created", { amount: 728, approved: true }),
    );
    expect(created.statusCode).toBe(200);
    expect(state.issuingAuthorizations[0]!.decision).toBe("external");

    // The delayed .request retry now gets a real decision, updated in place.
    const request = await postHook(app, authEvent("issuing_authorization.request"));
    expect(request.statusCode).toBe(200);
    expect(request.json()).toMatchObject({ approved: true, metadata: { reason: "approved" } });
    expect(state.issuingAuthorizations).toHaveLength(1);
    expect(state.issuingAuthorizations[0]!.decision).toBe("approved");
  });

  test("amounts are cents on the wire, dollars in the ledger", async () => {
    const { app, state } = makeWebhookApp();
    await postHook(app, authEvent("issuing_authorization.request"));
    expect(state.issuingAuthorizations[0]!.amountUsd).toBe(7.28);
    // 728 dollars would blow the daily cap; 728 cents must not.
    expect(state.decisions.at(-1)!.rule).toBe("approved");
  });
});

// ------------------------------------------------------------ PUT /policy

describe("PUT /policy malformed input", () => {
  test("syntactically invalid JSON is a 400, policy untouched", async () => {
    const { app, deps } = makeTestApp({});
    const before = deps.policy.hash();
    const res = await app.inject({
      method: "PUT",
      url: "/policy",
      headers: HEADERS,
      payload: '{"dry_run": tru',
    });
    expect(res.statusCode).toBe(400);
    expect(deps.policy.hash()).toBe(before);
  });

  test("valid JSON with an unknown key is a 400 with zod details", async () => {
    const { app, deps } = makeTestApp({});
    const body = { ...deps.policy.get(), definitely_not_a_key: 1 };
    const res = await app.inject({
      method: "PUT",
      url: "/policy",
      headers: HEADERS,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});
