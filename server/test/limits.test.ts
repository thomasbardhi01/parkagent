/**
 * Per-user spending limits (GET/PUT /me/limits). policy.json's caps are the
 * ceilings; each user may set lower caps and their own default stay, and
 * every cap check reads that user's effective limits — never another
 * user's, never a global the app used to overwrite (the "Couldn't save to
 * the server" bug: the budget step PUT the whole shared policy, which is
 * admin-only, and on Fly the write itself failed).
 */

import { describe, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import { applyChange, limitsView } from "../src/services/limits.js";
import type { Policy } from "../src/services/policy.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  STEINWAY_A,
  STEINWAY_B,
  makeTestApp,
  parkedBody,
  seedSession,
} from "./helpers.js";
import type { FakeDbState } from "./helpers.js";

const U1 = { "x-api-key": API_KEY };
const U2 = { "x-api-key": NONADMIN_API_KEY };
type App = ReturnType<typeof makeTestApp>["app"];

function putLimits(app: App, headers: Record<string, string>, payload: object) {
  return app.inject({ method: "PUT", url: "/me/limits", headers, payload });
}
function getLimits(app: App, headers: Record<string, string>) {
  return app.inject({ method: "GET", url: "/me/limits", headers });
}
function saveLimits(
  state: FakeDbState,
  userId: string,
  data: Partial<Record<string, number | null>>,
) {
  const at = new Date(MONDAY_2PM);
  state.userLimits.push({
    userId,
    sessionCapUsd: data["sessionCapUsd"] ?? null,
    dailyCapUsd: data["dailyCapUsd"] ?? null,
    defaultStayMinutes: data["defaultStayMinutes"] ?? null,
    createdAt: at,
    updatedAt: at,
  });
}

describe("GET/PUT /me/limits", () => {
  test("a user with no limits runs on the operator's policy", async () => {
    const { app } = makeTestApp({});
    const res = await getLimits(app, U2);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      limits: { sessionCapUsd: 45, dailyCapUsd: 60, defaultStayMinutes: 90 },
      saved: { sessionCapUsd: null, dailyCapUsd: null, defaultStayMinutes: null },
      ceilings: { sessionCapUsd: 45, dailyCapUsd: 60 },
      bounds: { minCapUsd: 1, stayMinutes: { min: 15, max: 240 } },
      clamped: [],
    });
  });

  test("anyone may save their own — not just the operator — and every change is on the ledger", async () => {
    const { app, state } = makeTestApp({});
    const res = await putLimits(app, U2, {
      sessionCapUsd: 20,
      dailyCapUsd: 40,
      defaultStayMinutes: 60,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limits).toEqual({
      sessionCapUsd: 20,
      dailyCapUsd: 40,
      defaultStayMinutes: 60,
    });
    expect((await getLimits(app, U2)).json().saved).toEqual({
      sessionCapUsd: 20,
      dailyCapUsd: 40,
      defaultStayMinutes: 60,
    });
    expect(state.decisions.at(-1)).toMatchObject({
      kind: "limits_update",
      rule: "saved",
      userId: "u2",
      inputs: {
        change: { sessionCapUsd: 20, dailyCapUsd: 40, defaultStayMinutes: 60 },
        before: { sessionCapUsd: null, dailyCapUsd: null, defaultStayMinutes: null },
      },
    });
    // The shared policy is untouched.
    expect((await getLimits(app, U1)).json().limits).toEqual({
      sessionCapUsd: 45,
      dailyCapUsd: 60,
      defaultStayMinutes: 90,
    });
  });

  test("a field left out keeps its value; null goes back to the operator's default", async () => {
    const { app } = makeTestApp({});
    await putLimits(app, U2, { sessionCapUsd: 20, defaultStayMinutes: 60 });
    await putLimits(app, U2, { dailyCapUsd: 30 });
    expect((await getLimits(app, U2)).json().saved).toEqual({
      sessionCapUsd: 20,
      dailyCapUsd: 30,
      defaultStayMinutes: 60,
    });
    const reset = await putLimits(app, U2, { sessionCapUsd: null });
    expect(reset.json().limits.sessionCapUsd).toBe(30); // the default 45, under the day's 30
  });

  test("refusals are exact, typed, and change nothing", async () => {
    const { app, state } = makeTestApp({});
    const res = await putLimits(app, U2, {
      sessionCapUsd: 50,
      dailyCapUsd: 0.5,
      defaultStayMinutes: 300,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_limits",
      issues: [
        {
          field: "sessionCapUsd",
          code: "above_ceiling",
          message: "Per stop can't be more than $45.00 — the most ParkAgent pays right now.",
          limit: 45,
        },
        {
          field: "dailyCapUsd",
          code: "below_minimum",
          message: "Per day must be at least $1.00.",
          limit: 1,
        },
        {
          field: "defaultStayMinutes",
          code: "out_of_range",
          message: "Default stay must be between 15 minutes and 4 hours.",
          limit: 240,
        },
      ],
    });
    expect(state.userLimits).toEqual([]);
    expect(state.decisions.at(-1)).toMatchObject({ kind: "limits_update", rule: "refused" });

    const inverted = await putLimits(app, U2, { sessionCapUsd: 30, dailyCapUsd: 20 });
    expect(inverted.json().issues).toEqual([
      {
        field: "sessionCapUsd",
        code: "session_above_daily",
        message: "Per stop can't be more than per day ($20.00).",
        limit: 20,
      },
    ]);

    const junk = await putLimits(app, U2, { sessionCapUsd: "lots", extra: 1 });
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error).toBe("invalid_limits");
  });

  test("the operator lowering a cap binds a saved value at once, and says so", () => {
    const policy = { session_cap_usd: 30, daily_cap_usd: 60, default_stay_minutes: 90 } as Policy;
    const view = limitsView(policy, {
      userId: "u2",
      sessionCapUsd: 40,
      dailyCapUsd: null,
      defaultStayMinutes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(view.limits.sessionCapUsd).toBe(30);
    expect(view.clamped).toEqual(["sessionCapUsd"]);
    // Saving something else doesn't re-litigate the capped value.
    expect(applyChange(policy, view.saved, { defaultStayMinutes: 60 })).toMatchObject({ ok: true });
  });

  test("the policy's own PUT stays the operator's alone", async () => {
    const { app } = makeTestApp({});
    const res = await app.inject({ method: "PUT", url: "/policy", headers: U2, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------ every cap check, per user

describe("the auto-pay decision (/parked) reads the caller's limits, not anyone else's", () => {
  // Steinway: 90 minutes, $3.65 — under the policy's $45 per stop.
  test("per stop", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
    saveLimits(state, "u2", { sessionCapUsd: 3 });
    const mine = await app.inject({
      method: "POST",
      url: "/parked",
      headers: U2,
      payload: parkedBody(),
    });
    expect(mine.json()).toMatchObject({ action: "confirm", rule: "session_cap_exceeded" });
    const theirs = await app.inject({
      method: "POST",
      url: "/parked",
      headers: U1,
      payload: parkedBody(),
    });
    expect(theirs.json()).toMatchObject({ action: "pay", rule: "auto_pay_ok" });
  });

  test("per day", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
    saveLimits(state, "u2", { dailyCapUsd: 10 });
    // Real spend (dry-run sessions never count toward a daily cap).
    seedSession(state, { userId: "u2", status: "stopped", dryRun: false, amountUsd: 7, feeUsd: 0 });
    seedSession(state, { userId: "u1", status: "stopped", dryRun: false, amountUsd: 7, feeUsd: 0 });
    const mine = await app.inject({
      method: "POST",
      url: "/parked",
      headers: U2,
      payload: parkedBody(),
    });
    expect(mine.json()).toMatchObject({ action: "confirm", rule: "daily_cap_exceeded" });
    const theirs = await app.inject({
      method: "POST",
      url: "/parked",
      headers: U1,
      payload: parkedBody(),
    });
    expect(theirs.json()).toMatchObject({ action: "pay" });
  });

  test("the quote's default stay", async () => {
    const { app, state } = makeTestApp({ candidates: [STEINWAY_A, STEINWAY_B] });
    saveLimits(state, "u2", { defaultStayMinutes: 30 });
    const mine = await app.inject({
      method: "POST",
      url: "/parked",
      headers: U2,
      payload: parkedBody(),
    });
    expect(mine.json().quote).toMatchObject({ stayMinutes: 30 });
    const theirs = await app.inject({
      method: "POST",
      url: "/parked",
      headers: U1,
      payload: parkedBody(),
    });
    expect(theirs.json().quote).toMatchObject({ stayMinutes: 90 });
  });
});

const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

function sessionApp() {
  const now = new Date(MONDAY_2PM);
  const t = makeTestApp({ zones: [STEINWAY_ZONE], now: () => now });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 40.7702,
    lng: -73.9077,
    accuracyM: 12,
    ts: now,
    signals: ["motion_stop"],
  });
  return t;
}

const START = { parkedEventId: "pe1", zoneId: "nyc-417371", minutes: 90 };

describe("sessions read the owner's limits", () => {
  test("start: the owner's per-stop cap refuses before anything runs", async () => {
    const t = sessionApp();
    saveLimits(t.state, "u1", { sessionCapUsd: 3 });
    const res = await t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: START,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "policy_violation", rule: "session_cap_exceeded" });
    expect(t.state.sessions).toHaveLength(0);
  });

  test("start without a body minutes buys the owner's default stay", async () => {
    const t = sessionApp();
    saveLimits(t.state, "u1", { defaultStayMinutes: 45 });
    const res = await t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: "nyc-417371" },
    });
    expect(res.statusCode).toBe(200);
    expect(t.state.sessions[0]).toMatchObject({ purchasedMinutes: 45 });
  });

  test("a manual extension: the owner's per-stop cap counts what the session already spent", async () => {
    const t = sessionApp();
    const started = await t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: START,
    });
    expect(started.statusCode).toBe(200);
    // $3.65 spent; 30 more minutes is $1.65 (with the fee): over a $5 cap.
    saveLimits(t.state, "u1", { sessionCapUsd: 5 });
    const res = await t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: U1,
      payload: { sessionId: started.json().sessionId, minutes: 30 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ rule: "session_cap_exceeded" });
  });

  test("the extension worker holds on the owner's cap — and only the owner's", async () => {
    const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`);
    const t = makeTestApp({ now: () => T("14:20") });
    const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
    const session = (userId: string) =>
      seedSession(t.state, {
        userId,
        status: "active",
        dryRun: true,
        zoneId: "nyc-417371",
        providerZoneNumber: "417371",
        startedAt: T("13:00"),
        expiresAt: T("14:30"),
        createdAt: T("13:00"),
        amountUsd: 3.5,
        feeUsd: 0.15,
        purchasedMinutes: 90,
        chargedMinutes: 90,
        carLat: 40.7702,
        carLng: -73.9077,
        rateFirstHour: 2.0,
        rateAdditionalHour: 3.0,
        maxStayMinutes: 240,
        hoursJson: HOURS_MON_SAT,
        parknycConfirmation: "dry-seed",
      });
    const mine = session("u2");
    const theirs = session("u1");
    // The driver is far away and walking further: both want an extension.
    for (const s of [mine, theirs]) {
      [100, 300, 600].forEach((m, i) =>
        t.state.locationFixes.push({
          id: `f-${s.id}-${i}`,
          sessionId: s.id,
          userId: s.userId,
          lat: 40.7702 + m / 111_320,
          lng: -73.9077,
          accuracyM: 10,
          ts: new Date(T("14:10").getTime() + i * 60_000),
        }),
      );
    }
    saveLimits(t.state, "u2", { sessionCapUsd: 4 });
    await extender.tick();
    const ruleFor = (id: string) =>
      t.state.decisions.filter((d) => d.kind === "extend_tick" && d.sessionId === id).at(-1)?.rule;
    expect(ruleFor(mine.id)).toBe("hold_session_cap");
    expect(ruleFor(theirs.id)).not.toBe("hold_session_cap");
  });
});

describe("what the Wallet shows is the caller's own", () => {
  test("spending caps", async () => {
    const { app, state } = makeTestApp({});
    saveLimits(state, "u2", { sessionCapUsd: 10, dailyCapUsd: 25 });
    const mine = await app.inject({ method: "GET", url: "/wallet", headers: U2 });
    expect(mine.json().spending).toMatchObject({ dailyCapUsd: 25, sessionCapUsd: 10 });
    const theirs = await app.inject({ method: "GET", url: "/wallet", headers: U1 });
    expect(theirs.json().spending).toMatchObject({ dailyCapUsd: 60, sessionCapUsd: 45 });
  });
});

describe("the operator's top-up respects the operator's own daily cap", () => {
  test("a lower personal cap refuses a top-up the policy would allow", async () => {
    const t = makeTestApp({ policy: { dry_run: false }, envDryRun: false });
    saveLimits(t.state, "u1", { dailyCapUsd: 20 });
    const res = await t.app.inject({
      method: "POST",
      url: "/providers/parknyc/topup",
      headers: U1,
      payload: { amountUsd: 25 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("amount_over_daily_cap");
  });
});
