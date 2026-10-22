/**
 * The extension worker and the gate's minutes rule (#292). A session held
 * to a max stay below what it had bought (a sign accepted before the
 * paid-minutes floor, or any row that got that way) reads a negative stay
 * left, and the worker asks the gate for that many minutes. The gate
 * refuses it as minutes_invalid; nothing is bought.
 *
 * Minutes are judged before the lock, so the gate's re-check under the
 * lock can't refuse them as they stand. The last two tests make it (a
 * stub on the locked call only) to show the worker and the route hold on
 * that answer like any other refusal there: nothing bought, on the record.
 */

import { afterEach, expect, test, vi } from "vitest";

import { makeExtender } from "../src/jobs/extendTick.js";
import type { GateIntent, GateResult } from "../src/services/moneyGate.js";
import { API_KEY, HOURS_MON_SAT, makeTestApp, seedSession } from "./helpers.js";

const asked = vi.hoisted(() => [] as { intent: GateIntent; result: GateResult }[]);
/** A rule the gate answers with under the lock, in place of its own. */
const underLock = vi.hoisted(() => ({ refuse: null as null | "minutes_invalid" }));
vi.mock("../src/services/moneyGate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/moneyGate.js")>();
  const moneyGate: typeof real.moneyGate = async (deps, principal, intent, at) => {
    let result = await real.moneyGate(deps, principal, intent, at);
    if (underLock.refuse && intent.kind === "extend" && intent.underLock && "policy" in result) {
      result = { ...result, ok: false, rule: underLock.refuse };
    }
    asked.push({ intent, result });
    return result;
  };
  return { ...real, moneyGate };
});

const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`); // a Monday
const NOW = T("14:20");
const CAR = { lat: 40.7702, lng: -73.9077 };

test("a negative stay left reaches the gate as minutes_invalid, and nothing is bought", async () => {
  const t = makeTestApp({ now: () => NOW });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  // 90 bought, held to 60: 30 minutes "left" below zero.
  const session = seedSession(t.state, {
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
    carLat: CAR.lat,
    carLng: CAR.lng,
    rateFirstHour: 2.0,
    rateAdditionalHour: 3.0,
    maxStayMinutes: 60,
    hoursJson: HOURS_MON_SAT,
    parknycConfirmation: "dry-seed",
  });
  [100, 300, 600].forEach((distM, i) => {
    t.state.locationFixes.push({
      id: `f${i + 1}`,
      sessionId: session.id,
      userId: "u1",
      lat: CAR.lat + distM / 111_320,
      lng: CAR.lng,
      accuracyM: 10,
      ts: new Date(NOW.getTime() - (3 - i) * 60_000),
    });
  });

  await extender.tick();

  const extend = asked.filter((a) => a.intent.kind === "extend");
  expect(extend.length).toBeGreaterThan(0);
  for (const { intent, result } of extend) {
    expect((intent as { minutes: number }).minutes).toBeLessThanOrEqual(0);
    expect(result).toMatchObject({ ok: false, rule: "minutes_invalid" });
  }
  // Nothing bought: the session is as it was, and no executor call.
  expect(session).toMatchObject({ purchasedMinutes: 90, extendCount: 0, maxStayMinutes: 60 });
  expect(session.expiresAt!.getTime()).toBe(T("14:30").getTime());
  expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
  const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
  expect(tick.outcome).not.toMatchObject({ action: "extend" });
});

afterEach(() => {
  underLock.refuse = null;
  asked.length = 0;
});

/** 90 bought of a 120 max, the phone far off and heading away: the worker
 * extends by 30 (extendTick.test.ts's first scenario). */
function extendable() {
  const t = makeTestApp({ now: () => NOW });
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const session = seedSession(t.state, {
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
    carLat: CAR.lat,
    carLng: CAR.lng,
    rateFirstHour: 2.0,
    rateAdditionalHour: 3.0,
    maxStayMinutes: 120,
    hoursJson: HOURS_MON_SAT,
    parknycConfirmation: "dry-seed",
  });
  [100, 300, 600].forEach((distM, i) => {
    t.state.locationFixes.push({
      id: `f${i + 1}`,
      sessionId: session.id,
      userId: "u1",
      lat: CAR.lat + distM / 111_320,
      lng: CAR.lng,
      accuracyM: 10,
      ts: new Date(NOW.getTime() - (3 - i) * 60_000),
    });
  });
  return { t, extender, session };
}

test("minutes_invalid under the lock: the worker holds, nothing bought", async () => {
  const { t, extender, session } = extendable();
  underLock.refuse = "minutes_invalid";
  await extender.tick();
  const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
  expect(tick.rule).toBe("hold_gate_refused");
  expect(tick.outcome).toMatchObject({ action: "hold", ok: false, code: "minutes_invalid" });
  expect(session).toMatchObject({ purchasedMinutes: 90, extendCount: 0 });
  expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
  // Control: without the stub the same tick extends.
  underLock.refuse = null;
  const control = extendable();
  await control.extender.tick();
  expect(control.session.purchasedMinutes).toBe(120);
});

test("minutes_invalid under the lock: a manual extend is a 409 on the record, nothing bought", async () => {
  const { t, session } = extendable();
  underLock.refuse = "minutes_invalid";
  const res = await t.app.inject({
    method: "POST",
    url: "/session/extend",
    headers: { "x-api-key": API_KEY },
    payload: { sessionId: session.id, minutes: 15 },
  });
  expect(res.statusCode, res.body).toBe(409);
  expect(res.json()).toMatchObject({ error: "policy_violation", rule: "minutes_invalid" });
  expect(t.state.decisions.at(-1)).toMatchObject({
    kind: "session_extend",
    rule: "minutes_invalid",
    inputs: { underLock: true },
  });
  expect(session.purchasedMinutes).toBe(90);
  expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
});
