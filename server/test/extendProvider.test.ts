/**
 * An extension needs a usable parking account, as a start does ("Before
 * DRY_RUN=false" item 3): the money gate's `extend` intent refuses
 * `provider_not_linked` when the session's provider account is gone or
 * `expired` (the health job's mark), and `expiring` still pays
 * (providerStatusUsable). Before the lock and under it; the driver's
 * extend answers as a start does, the worker holds.
 *
 * One real Steinway St session, 90 minutes bought at 13:00 for $3.65.
 */

import { describe, expect, test } from "vitest";

import { makeExtender } from "../src/jobs/extendTick.js";
import {
  HOURS_MON_SAT,
  NONADMIN_API_KEY,
  makeTestApp,
  seedAwayPark,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";

const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`);
const U2 = { "x-api-key": NONADMIN_API_KEY };

function setup(account: "linked" | "expiring" | "expired" | null, expiresAt = T("15:00")) {
  const clock = { now: T("14:20") };
  const t = makeTestApp({ envDryRun: false, policy: { dry_run: false }, now: () => clock.now });
  if (account) seedProviderAccount(t.state, { userId: "u2", status: account });
  const session = seedSession(t.state, {
    userId: "u2",
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
    parknycConfirmation: "seed",
  });
  return { t, session, clock };
}

const extend = (t: ReturnType<typeof makeTestApp>, sessionId: string) =>
  t.app.inject({
    method: "POST",
    url: "/session/extend",
    headers: U2,
    payload: { sessionId, minutes: 30 },
  });

const extendCalls = (t: ReturnType<typeof makeTestApp>) =>
  t.executorCalls.filter((c) => c.op === "extend").length;

/** The phone far from the car and walking further: the worker wants time.
 * Walked away from the car first (FR-55): only a park row says "away". */
function walkingAway(t: ReturnType<typeof makeTestApp>, sessionId: string) {
  seedAwayPark(
    t.state,
    t.state.sessions.find((s) => s.id === sessionId)!,
  );
  [100, 300, 600].forEach((m, i) =>
    t.state.locationFixes.push({
      id: `f-${i}`,
      sessionId,
      userId: "u2",
      lat: 40.7702 + m / 111_320,
      lng: -73.9077,
      accuracyM: 10,
      // Sent within the last five minutes: the phone is still reporting.
      ts: new Date(T("14:17").getTime() + i * 60_000),
    }),
  );
}

/** Mark u2's account expired the moment the extension lock is taken: what
 * the gate's second reading sees and the first did not. */
function expireUnderLock(t: ReturnType<typeof makeTestApp>) {
  const raw = t.deps.db.$transaction;
  let done = false;
  t.deps.db.$transaction = async (fn) => {
    if (!done) {
      done = true;
      for (const a of t.state.providerAccounts) if (a.userId === "u2") a.status = "expired";
    }
    return raw(fn);
  };
}

describe("the driver's extend", () => {
  for (const account of ["expired", null] as const) {
    test(`an account ${account ?? "never linked"}: 409 provider_not_linked, as a start answers, nothing asked of the provider`, async () => {
      const { t, session } = setup(account);
      const res = await extend(t, session.id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: "provider_not_linked",
        provider: "parknyc",
        displayName: "ParkNYC",
      });
      const row = t.state.decisions.filter((d) => d.kind === "session_extend").at(-1)!;
      expect(row.rule).toBe("provider_not_linked");
      expect(row.inputs).toMatchObject({
        provider: "parknyc",
        accountStatus: account ?? "none",
      });
      expect(row.outcome).toMatchObject({ allowed: false });
      expect(extendCalls(t)).toBe(0);
      expect(t.state.sessions.find((s) => s.id === session.id)!.extendCount).toBe(0);
    });
  }

  for (const account of ["linked", "expiring"] as const) {
    test(`an account ${account}: it extends`, async () => {
      const { t, session } = setup(account);
      const res = await extend(t, session.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(extendCalls(t)).toBe(1);
    });
  }

  test("expired as the lock is taken: refused there, its own row, nothing asked of the provider", async () => {
    const { t, session } = setup("linked");
    expireUnderLock(t);
    const res = await extend(t, session.id);
    expect(res.statusCode).toBe(409);
    // The same answer as before the lock: to the link flow.
    expect(res.json()).toMatchObject({
      error: "provider_not_linked",
      provider: "parknyc",
      displayName: "ParkNYC",
    });
    const row = t.state.decisions.filter((d) => d.kind === "session_extend").at(-1)!;
    expect(row.rule).toBe("provider_not_linked");
    expect(row.inputs).toMatchObject({
      underLock: true,
      provider: "parknyc",
      accountStatus: "expired",
    });
    expect(row.outcome).toMatchObject({ allowed: false, accountStatus: "expired" });
    expect(extendCalls(t)).toBe(0);
  });
});

describe("the worker", () => {
  test("an expired account holds as hold_provider_not_linked; an expiring one extends", async () => {
    for (const [account, rule] of [
      ["expired", "hold_provider_not_linked"],
      ["expiring", "extend"],
    ] as const) {
      const { t, session } = setup(account, T("14:30"));
      walkingAway(t, session.id);
      await makeExtender({ ...t.deps, log: { info() {}, warn() {} } }).tick();
      const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
      expect(tick.rule, account).toBe(rule);
      expect(extendCalls(t), account).toBe(rule === "extend" ? 1 : 0);
    }
  });

  test("an expired account: the row names it, and the driver is asked to reconnect, once", async () => {
    const { t, session, clock } = setup("expired", T("14:30"));
    walkingAway(t, session.id);
    const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
    await extender.tick();
    const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(tick.rule).toBe("hold_provider_not_linked");
    expect(tick.inputs).toMatchObject({ provider: "parknyc", accountStatus: "expired" });
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0]!.push).toEqual({
      type: "provider_relink",
      title: "Reconnect ParkNYC",
      body: "Zone 417371 expires in 10 min. Reconnect ParkNYC to extend it.",
      extra: {
        provider: "parknyc",
        zoneNumber: "417371",
        deepLink: "parkagent://providers/link?provider=parknyc",
      },
    });
    // The same hold a minute later: no second push.
    clock.now = T("14:21");
    await extender.tick();
    expect(t.pushes).toHaveLength(1);
  });

  test("expired as the lock is taken: booked as the hold, not an executor failure", async () => {
    const { t, session } = setup("linked", T("14:30"));
    walkingAway(t, session.id);
    expireUnderLock(t);
    await makeExtender({ ...t.deps, log: { info() {}, warn() {} } }).tick();
    const tick = t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!;
    expect(tick.rule).toBe("hold_provider_not_linked");
    expect(tick.outcome).toMatchObject({
      action: "hold",
      code: "provider_not_linked",
      underLock: true,
      provider: "parknyc",
      accountStatus: "expired",
    });
    expect(extendCalls(t)).toBe(0);
  });
});
