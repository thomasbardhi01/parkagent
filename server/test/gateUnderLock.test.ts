/**
 * The money gate's second reading, on the fresh row under the extension
 * lock, and the one spend sum everything reads. An extension priced within
 * the caps can stop fitting by the time it holds the lock (another one
 * landed meanwhile): the refusal is a policy refusal with its own ledger
 * row, never an executor failure. And under a dry run, today's dry runs
 * count toward the day wherever the day is read — the gate, and the
 * assistant's budget line alike.
 */

import { describe, expect, test } from "vitest";

import { makeExtender } from "../src/jobs/extendTick.js";
import { applyPatch, emptyState, parsePatch } from "../src/services/assistant/requestState.js";
import {
  HOURS_MON_SAT,
  NONADMIN_API_KEY,
  makeTestApp,
  seedAwayPark,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";
import type { FakeDbState } from "./helpers.js";

const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`);
const CAPS = { session_cap_usd: 10, daily_cap_usd: 20, dry_run: false };

/** A real session, 90 minutes bought at 13:00, priced like Steinway St.,
 * on the owner's linked account (an extension needs one, as a start does). */
function activeSession(state: FakeDbState, userId: string, expiresAt: Date) {
  if (!state.providerAccounts.some((a) => a.userId === userId && a.provider === "parknyc")) {
    seedProviderAccount(state, { userId });
  }
  return seedSession(state, {
    userId,
    status: "active",
    dryRun: false,
    zoneId: "nyc-417371",
    providerZoneNumber: "417371",
    city: "nyc",
    startedAt: T("13:00"),
    expiresAt,
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
}

/** Land `usd` of real spend for `userId` the moment the extension lock is
 * taken: what the gate's second reading sees and the first did not. */
function spendUnderLock(t: ReturnType<typeof makeTestApp>, userId: string, usd: number) {
  const raw = t.deps.db.$transaction;
  let landed = false;
  t.deps.db.$transaction = async (fn) => {
    if (!landed) {
      landed = true;
      seedSession(t.state, { userId, status: "stopped", dryRun: false, amountUsd: usd });
    }
    return raw(fn);
  };
}

describe("the gate under the extension lock", () => {
  test("a manual extension refused there answers 409 with its own ledger row", async () => {
    const t = makeTestApp({ policy: CAPS, envDryRun: false, now: () => T("14:20") });
    const session = activeSession(t.state, "u2", T("15:00"));
    // Priced within the day ($3.65 spent, 30 more minutes fit); then $16
    // lands before the lock, and the day no longer has room.
    spendUnderLock(t, "u2", 16);
    const res = await t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: { "x-api-key": NONADMIN_API_KEY },
      payload: { sessionId: session.id, minutes: 30 },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ error: "policy_violation", rule: "daily_cap_exceeded" });
    expect(typeof body.decisionId).toBe("string");
    const row = t.state.decisions.filter((d) => d.kind === "session_extend").at(-1)!;
    expect(row.rule).toBe("daily_cap_exceeded");
    expect(row.outcome).toMatchObject({ allowed: false });
    // The row says what the gate read under the lock, not the pre-lock sum.
    expect(row.inputs).toMatchObject({ underLock: true, spentTodayUsd: 19.65 });
    expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
  });

  test("the worker books an under-lock cap refusal as its hold rule, not an executor failure", async () => {
    const t = makeTestApp({ policy: CAPS, envDryRun: false, now: () => T("14:20") });
    const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
    const session = activeSession(t.state, "u2", T("14:30"));
    // The park its walk-away left: "away" is the lifecycle's (phonePosition).
    seedAwayPark(t.state, session);
    // The driver is far away and walking further: the cost rule extends.
    [100, 300, 600].forEach((m, i) =>
      t.state.locationFixes.push({
        id: `f-${i}`,
        sessionId: session.id,
        userId: "u2",
        lat: 40.7702 + m / 111_320,
        lng: -73.9077,
        accuracyM: 10,
        ts: new Date(T("14:16").getTime() + i * 60_000),
      }),
    );
    spendUnderLock(t, "u2", 16);
    await extender.tick();
    const row = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(row.rule).toBe("hold_daily_cap");
    expect(row.outcome).toMatchObject({
      action: "hold",
      code: "daily_cap_exceeded",
      underLock: true,
    });
    expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
    // Not booked as the settled rule, so the driver isn't left unwarned:
    // the next tick reads the same hold from its own ladder and pushes.
    expect(t.state.sessions.find((s) => s.id === session.id)!.lastExtenderRule).not.toBe(
      "hold_daily_cap",
    );
    expect(t.pushes).toHaveLength(0);
    await extender.tick();
    expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe(
      "hold_daily_cap",
    );
    expect(t.pushes).toHaveLength(1);
    expect(JSON.stringify(t.pushes[0]!.push)).toContain("budget");
  });

  // A garbled ledger row landing as the lock is taken: today's sum is NaN
  // there, the gate refuses amount_invalid, and that refusal is booked as
  // one, never as an executor failure.
  test("a manual extension refused there as amount_invalid answers 409 with that rule", async () => {
    const t = makeTestApp({ policy: CAPS, envDryRun: false, now: () => T("14:20") });
    const session = activeSession(t.state, "u2", T("15:00"));
    spendUnderLock(t, "u2", Number.NaN);
    const res = await t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: { "x-api-key": NONADMIN_API_KEY },
      payload: { sessionId: session.id, minutes: 30 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "policy_violation", rule: "amount_invalid" });
    const row = t.state.decisions.filter((d) => d.kind === "session_extend").at(-1)!;
    expect(row.rule).toBe("amount_invalid");
    expect(row.outcome).toMatchObject({ allowed: false });
    expect(row.inputs).toMatchObject({ underLock: true });
    expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
  });

  test("the worker books an under-lock amount_invalid as a hold, not an executor failure", async () => {
    const t = makeTestApp({ policy: CAPS, envDryRun: false, now: () => T("14:20") });
    const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
    const session = activeSession(t.state, "u2", T("14:30"));
    // The park its walk-away left: "away" is the lifecycle's (phonePosition).
    seedAwayPark(t.state, session);
    [100, 300, 600].forEach((m, i) =>
      t.state.locationFixes.push({
        id: `f-${i}`,
        sessionId: session.id,
        userId: "u2",
        lat: 40.7702 + m / 111_320,
        lng: -73.9077,
        accuracyM: 10,
        ts: new Date(T("14:16").getTime() + i * 60_000),
      }),
    );
    spendUnderLock(t, "u2", Number.NaN);
    await extender.tick();
    const row = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(row.rule).toBe("hold_gate_refused");
    expect(row.outcome).toMatchObject({
      action: "hold",
      code: "amount_invalid",
      underLock: true,
    });
    expect(t.executorCalls.filter((c) => c.op === "extend")).toHaveLength(0);
  });
});

describe("one spend sum", () => {
  test("under a dry run, the assistant's budget line counts today's dry runs too", async () => {
    const t = makeTestApp({ policy: { daily_cap_usd: 20, dry_run: true } });
    seedSession(t.state, { userId: "u1", status: "stopped", dryRun: true, amountUsd: 7 });
    const patch = parsePatch({ startsAt: "2026-01-05T15:00:00-05:00" });
    if (!patch.ok) throw new Error("patch");
    const applied = applyPatch(emptyState(), patch.patch, "", t.deps.now!());
    if (!applied.ok) throw new Error("state");
    const outcome = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1", requestState: applied.state },
      "build_itinerary",
      {
        stops: [
          {
            label: "A",
            lat: 40.7702,
            lng: -73.9077,
            arrival: "2026-01-05T15:00:00-05:00",
            duration_minutes: 60,
          },
        ],
      },
    );
    // The same sum the confirm gate will refuse on: $7 of the $20 is gone.
    expect(outcome.result).toMatchObject({
      dailyCapUsd: 20,
      spentTodayUsd: 7,
      remainingBudgetUsd: 13,
    });
    // Who read it is on the record too.
    expect(t.state.decisions.at(-1)).toMatchObject({ kind: "assistant_tool", actor: "user" });
  });
});
