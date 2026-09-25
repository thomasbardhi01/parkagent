/**
 * Session lifecycle (dry run), cap enforcement, and the /location + /device
 * endpoints. Zone fixture is 30th Ave & Steinway ($2.00/$3.00, 120 min max
 * stay) so a 90-minute start prices at $3.50 + $0.15 fee.
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import type { ExecutorResult } from "../src/services/executor.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  makeTestApp,
  seedLinkSpendRequest,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const NOW = new Date(MONDAY_2PM);

const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

function makeApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp({ zones: [STEINWAY_ZONE], now: () => NOW, ...options });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 40.7702,
    lng: -73.9077,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  return t;
}

function post(app: ReturnType<typeof makeTestApp>["app"], url: string, body: unknown) {
  return app.inject({ method: "POST", url, headers: HEADERS, payload: body as object });
}

const START = { parkedEventId: "pe1", zoneId: "nyc-417371", minutes: 90 };

test("dry-run lifecycle: start, report location, extend, stop", async () => {
  const { app, state, pushes } = makeApp();

  // Start: 90 min = 60 @ $2 + 30 @ $3 = $3.50 meter + $0.15 fee.
  const started = await post(app, "/session/start", START);
  expect(started.statusCode).toBe(200);
  const { sessionId, expiresAt, amountUsd } = started.json();
  expect(amountUsd).toBe(3.65);
  expect(new Date(expiresAt).getTime()).toBe(NOW.getTime() + 90 * 60_000);

  const session = state.sessions.find((s) => s.id === sessionId)!;
  expect(session).toMatchObject({
    status: "active",
    dryRun: true,
    purchasedMinutes: 90,
    chargedMinutes: 90,
    carLat: 40.7702,
    carLng: -73.9077,
    parkedEventId: "pe1",
  });
  expect(session.parknycConfirmation).toMatch(/^dry-/);
  expect(state.sessionEvents.map((e) => e.kind)).toEqual(["started"]);
  expect(state.decisions.at(-1)).toMatchObject({ kind: "session_start", rule: "start_ok" });
  expect(pushes.at(-1)!.push.type).toBe("session_started");
  expect(pushes.at(-1)!.push.body).toContain("Would have paid");

  // Location fixes attach to the active session.
  const loc = await post(app, "/location", {
    lat: 40.7712,
    lng: -73.9067,
    accuracy: 10,
    ts: MONDAY_2PM,
  });
  expect(loc.statusCode).toBe(200);
  expect(loc.json().sessionId).toBe(sessionId);
  expect(state.locationFixes).toHaveLength(1);

  // Extend 30 min: past the first hour, so 30 @ $3 = $1.50 + $0.15 fee.
  const extended = await post(app, "/session/extend", { sessionId, minutes: 30 });
  expect(extended.statusCode).toBe(200);
  expect(extended.json().amountUsd).toBe(1.65);
  expect(new Date(extended.json().expiresAt).getTime()).toBe(NOW.getTime() + 120 * 60_000);
  expect(session).toMatchObject({ purchasedMinutes: 120, extendCount: 1 });
  expect(Number(session.amountUsd)).toBe(5.0);
  expect(Number(session.feeUsd)).toBe(0.3);
  expect(state.decisions.at(-1)).toMatchObject({ kind: "session_extend", rule: "extend_ok" });
  expect(pushes.at(-1)!.push.type).toBe("session_extended");

  // Stop.
  const stopped = await post(app, "/session/stop", { sessionId });
  expect(stopped.statusCode).toBe(200);
  expect(stopped.json().stoppedAt).toBe(NOW.toISOString());
  expect(session.status).toBe("stopped");
  expect(state.sessionEvents.map((e) => e.kind)).toEqual(["started", "extended", "stopped"]);
  expect(state.decisions.at(-1)).toMatchObject({ kind: "session_stop", rule: "stop_ok" });
});

test("start against an unknown parked event or zone: 404", async () => {
  const { app } = makeApp();
  expect((await post(app, "/session/start", { ...START, parkedEventId: "nope" })).statusCode).toBe(
    404,
  );
  expect((await post(app, "/session/start", { ...START, zoneId: "nyc-0" })).statusCode).toBe(404);
});

test("a second start while a session is active: 409", async () => {
  const { app } = makeApp();
  await post(app, "/session/start", START);
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("session_already_active");
});

test("start beyond the zone max stay is refused and logged", async () => {
  const { app, state } = makeApp();
  const res = await post(app, "/session/start", { ...START, minutes: 150 });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "policy_violation", rule: "max_stay_exceeded" });
  expect(state.decisions.at(-1)).toMatchObject({ rule: "max_stay_exceeded" });
  expect(state.sessions).toHaveLength(0); // refused before anything was created
});

test("start over the session cap is refused", async () => {
  const { app } = makeApp({ policy: { session_cap_usd: 3 } });
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(409);
  expect(res.json().rule).toBe("session_cap_exceeded");
});

test("a real (non-dry-run) start over the daily cap is refused", async () => {
  const { app, state } = makeApp({ policy: { dry_run: false }, envDryRun: false });
  seedSession(state, { status: "stopped", dryRun: false, amountUsd: 57.5, feeUsd: 0.15 });
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(409);
  expect(res.json().rule).toBe("daily_cap_exceeded");
});

test("the daily cap is whatever paid: garages approved in Link today leave no room", async () => {
  const { app, state } = makeApp({ policy: { dry_run: false }, envDryRun: false });
  // $60 a day, $57.65 of it on a garage approved in Link this morning.
  seedLinkSpendRequest(state, {
    amountUsd: 57.65,
    status: "approved",
    createdAt: new Date("2026-01-05T09:00:00-05:00"),
  });
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(409);
  expect(res.json().rule).toBe("daily_cap_exceeded");
  expect(state.sessions).toHaveLength(0);
});

test("extend past the max stay is refused", async () => {
  const { app, state } = makeApp();
  const { sessionId } = (await post(app, "/session/start", START)).json();
  const res = await post(app, "/session/extend", { sessionId, minutes: 60 });
  expect(res.statusCode).toBe(409);
  expect(res.json().rule).toBe("max_stay_exceeded");
  expect(state.sessions[0]!.extendCount).toBe(0);
});

test("executor failure fails the session and pushes payment_failed", async () => {
  const failure: ExecutorResult = {
    ok: false,
    code: "ui_changed",
    message: "ParkNYC showed a captcha",
    diagnostics: { pageText: "please verify you are human", screenshotBase64: "aGk=" },
  };
  const { app, state, pushes } = makeApp({
    executor: {
      startSession: async () => failure,
      extendSession: async () => failure,
      stopSession: async () => failure,
    },
  });
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(502);
  expect(res.json()).toMatchObject({ error: "executor_failed", code: "ui_changed" });
  expect(state.sessions[0]!.status).toBe("failed"); // stays unpaid
  expect(state.sessionEvents.at(-1)).toMatchObject({ kind: "failed" });
  const details = state.sessionEvents.at(-1)!.details as Record<string, unknown>;
  expect(typeof details["durationMs"]).toBe("number");
  // The decision row carries the evidence and the executor timing.
  const decision = state.decisions.at(-1)!;
  expect(decision).toMatchObject({ rule: "executor_failed" });
  expect(decision.outcome["diagnostics"]).toEqual({
    pageText: "please verify you are human",
    screenshotBase64: "aGk=",
  });
  expect(typeof decision.outcome["durationMs"]).toBe("number");
  // The failure push says what to do instead, deep link included; the
  // executor code rides in `extra`, never in the words a driver reads.
  const push = pushes.at(-1)!.push;
  expect(push.type).toBe("payment_failed");
  // ui_changed can come after the pay click: "not confirmed", never
  // "unpaid" — a retry on a false "unpaid" would pay twice.
  expect(push.title).toBe("Payment not confirmed");
  expect(push.body).toBe(
    "ParkNYC didn't confirm the payment for zone 417371. Check ParkNYC's app before paying again, so you don't pay twice.",
  );
  expect(push.body).not.toContain("unpaid");
  expect(push.body).not.toContain("ui_changed");
  expect(push.extra).toMatchObject({
    code: "ui_changed",
    zoneNumber: "417371",
    deepLink: "parkagent://pay?zone=417371",
  });
});

test("free_period: no charge, no active session, hours logged, 'parking is free' push", async () => {
  const freeResult: ExecutorResult = {
    ok: false,
    code: "free_period",
    message: "No Meter Parking. Please Check Signage Paid parking is between 8am-8pm EST Mon-Sat.",
    freePeriod: {
      rawText: "No Meter Parking. ... Paid parking is between 8am-8pm EST Mon-Sat.",
      hours: {
        startLabel: "8am",
        endLabel: "8pm",
        startMinutes: 480,
        endMinutes: 1200,
        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        tz: "EST",
      },
    },
  };
  const { app, state, pushes } = makeApp({
    executor: {
      startSession: async () => freeResult,
      extendSession: async () => freeResult,
      stopSession: async () => freeResult,
    },
  });
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: "free_period", zoneId: "nyc-417371" });
  // No active/paid session.
  expect(state.sessions.every((s) => s.status !== "active")).toBe(true);
  expect(state.sessions.at(-1)!.status).toBe("free_period");
  // Decision logs the provider hours AND our zone hours for comparison.
  const decision = state.decisions.at(-1)!;
  expect(decision.rule).toBe("free_period");
  expect(decision.inputs["providerHours"]).toMatchObject({ startMinutes: 480, endMinutes: 1200 });
  expect(decision.inputs).toHaveProperty("zoneHours");
  // The push says it's free — not a payment failure.
  const push = pushes.at(-1)!.push;
  expect(push.type).toBe("free_period");
  expect(push.title).toContain("free");
});

test("free_period on extend is a hold: no failure, 'parking is free' push, 409", async () => {
  const okStart: ExecutorResult = {
    ok: true,
    providerSessionId: "p1",
    expiresAt: new Date(NOW.getTime() + 90 * 60_000),
    amountUsd: 4.5,
  };
  const freeResult: ExecutorResult = {
    ok: false,
    code: "free_period",
    message: "No Meter Parking. Please Check Signage Paid parking is between 8am-8pm EST Mon-Sat.",
  };
  const { app, state, pushes } = makeApp({
    executor: {
      startSession: async () => okStart,
      extendSession: async () => freeResult,
      stopSession: async () => okStart,
    },
  });
  const started = await post(app, "/session/start", START);
  expect(started.statusCode).toBe(200);
  const sessionId = started.json().sessionId;
  const expiresBefore = state.sessions[0]!.expiresAt!.getTime();

  const res = await post(app, "/session/extend", { sessionId, minutes: 30 });
  // Not an executor failure: nothing to extend because nothing charges now.
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "free_period" });

  // A hold: the session keeps its time and is never marked failed.
  expect(state.sessions[0]!.extendCount).toBe(0);
  expect(state.sessions[0]!.expiresAt!.getTime()).toBe(expiresBefore);
  expect(state.sessionEvents.map((e) => e.kind)).toEqual(["started", "free_period"]);

  // The push says parking is free — never a tap-to-pay payment failure.
  expect(pushes.some((p) => p.push.type === "payment_failed")).toBe(false);
  expect(pushes.at(-1)!.push.type).toBe("free_period");

  const decision = state.decisions.at(-1)!;
  expect(decision).toMatchObject({ kind: "session_extend", rule: "free_period" });
});

test("payment_method_missing pushes an 'add a card' failure naming the zone's own provider", async () => {
  const failure: ExecutorResult = {
    ok: false,
    code: "payment_method_missing",
    message: "the provider has no saved payment method on this account",
  };
  const executor = {
    startSession: async () => failure,
    extendSession: async () => failure,
    stopSession: async () => failure,
  };

  // NYC zone → ParkNYC. The push used to say ParkBoston for every city.
  const { app, state, pushes } = makeApp({ executor });
  const res = await post(app, "/session/start", START);
  expect(res.statusCode).toBe(502);
  expect(res.json()).toMatchObject({ error: "executor_failed", code: "payment_method_missing" });
  expect(state.sessions[0]!.status).toBe("failed");
  const push = pushes.at(-1)!.push;
  expect(push.type).toBe("payment_failed");
  expect(push.title).toBe("Add a card to ParkNYC");
  expect(push.body).toContain("ParkNYC has no card saved");
  expect(push.extra).toMatchObject({ code: "payment_method_missing" });

  // Boston zone → ParkBoston, same code path.
  const bos = makeTestApp({
    zones: [
      {
        zoneId: "bos-boylston-st-e-d-819305",
        city: "bos",
        providerZoneNumber: "81234",
        rateFirstHour: 3.75,
        rateAdditionalHour: 3.75,
        maxStayMinutes: 120,
        hoursJson: HOURS_MON_SAT,
      },
    ],
    now: () => NOW,
    executor,
  });
  // Boston pays through Passport, so that account has to be linked too.
  seedProviderAccount(bos.state, { id: "pa-bos", provider: "passport" });
  bos.state.parkedEvents.push({
    id: "pe-bos",
    userId: "u1",
    lat: 42.3503,
    lng: -71.081,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  const bosRes = await post(bos.app, "/session/start", {
    parkedEventId: "pe-bos",
    zoneId: "bos-boylston-st-e-d-819305",
    minutes: 90,
  });
  expect(bosRes.statusCode).toBe(502);
  expect(bos.pushes.at(-1)!.push.title).toBe("Add a card to ParkBoston");
});

test("location without an active session: 409", async () => {
  const { app } = makeApp();
  const res = await post(app, "/location", {
    lat: 40.77,
    lng: -73.9,
    accuracy: 10,
    ts: MONDAY_2PM,
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("no_active_session");
});

test("device registration is idempotent by token", async () => {
  const { app, state } = makeApp();
  const body = { token: "abc123", platform: "ios", environment: "development" };
  expect((await post(app, "/device", body)).statusCode).toBe(200);
  expect((await post(app, "/device", { ...body, environment: "production" })).statusCode).toBe(200);
  expect(state.deviceTokens).toHaveLength(1);
  expect(state.deviceTokens[0]).toMatchObject({ userId: "u1", environment: "production" });
});
