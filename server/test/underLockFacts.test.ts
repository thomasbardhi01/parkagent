/**
 * The under-lock refusal row of a manual extend (#276): it records what
 * the gate read under the lock, today's spend included, and a gate that
 * refused there before reading it says null, never the spend read before
 * the lock. (`!== undefined`, not `??`: null is an answer.)
 */

import { expect, test, vi } from "vitest";

import { API_KEY, HOURS_MON_SAT, makeTestApp, seedSession } from "./helpers.js";

/** The gate's under-lock call refused before today's spend was read. */
const underLock = vi.hoisted(() => ({ refuse: false }));
vi.mock("../src/services/moneyGate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/moneyGate.js")>();
  const moneyGate: typeof real.moneyGate = async (deps, principal, intent, at) => {
    const result = await real.moneyGate(deps, principal, intent, at);
    if (underLock.refuse && intent.kind === "extend" && intent.underLock && "policy" in result) {
      return { ...result, ok: false, rule: "amount_invalid", spentTodayUsd: null };
    }
    return result;
  };
  return { ...real, moneyGate };
});

const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`); // a Monday

test.each([
  ["refused under the lock before it read today's spend: null", true],
  ["allowed (control): the extension goes through", false],
])("a manual extend %s", async (_case, refuse) => {
  underLock.refuse = refuse;
  const t = makeTestApp({ now: () => T("14:20") });
  // Spend already on the day, so the pre-lock read is a number.
  seedSession(t.state, { status: "stopped", dryRun: true, amountUsd: 4 });
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
    rateFirstHour: 2.0,
    rateAdditionalHour: 3.0,
    maxStayMinutes: 240,
    hoursJson: HOURS_MON_SAT,
    parknycConfirmation: "dry-seed",
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/session/extend",
    headers: { "x-api-key": API_KEY },
    payload: { sessionId: session.id, minutes: 15 },
  });
  const row = t.state.decisions.filter((d) => d.kind === "session_extend").at(-1)!;
  if (refuse) {
    expect(res.statusCode, res.body).toBe(409);
    expect(row).toMatchObject({ rule: "amount_invalid", inputs: { underLock: true } });
    // Not the number read before the lock: the gate under it read none.
    expect(row.inputs["spentTodayUsd"]).toBeNull();
    expect(session.purchasedMinutes).toBe(90);
  } else {
    expect(res.statusCode, res.body).toBe(200);
    expect(typeof row.inputs["spentTodayUsd"]).toBe("number");
  }
});
