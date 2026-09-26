/**
 * FR-10 / FR-11 — per-user limits, live. Each user sets their own per-stop
 * and per-day caps and default stay (GET/PUT /me/limits) within the
 * policy's caps, which are the ceilings; every cap check reads the
 * caller's own. What a live, dry-run server can prove:
 *
 *  - the FR user's limits read and refuse exactly as documented;
 *  - the FR user's own per-stop cap decides its own auto-pay at a known
 *    NYC zone;
 *  - with a THROWAWAY session (`pnpm -C server create:fr-throwaway`), a
 *    second user's limits and decisions are untouched by the first's, and
 *    the other way round. That half self-skips without FR_THROWAWAY_SESSION.
 *
 * The FR user's limits are put back to the operator's defaults however
 * the tests end. (The throwaway is deleted by 60-accounts' afterAll and
 * the nightly's purge, which also drops its limits row.)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  easternWeekday,
  frFetch,
  gate,
  mostRecentEasternAt,
  NYC_AUTOPAY,
  parkedBody,
  sessionFetch,
  throwawaySession,
} from "./client.js";

const AFTERNOON = mostRecentEasternAt(14, 0);
// NYC meters are free on Sundays: nothing to cap.
const SUNDAY = easternWeekday(AFTERNOON) === "Sun";
const RESET = { sessionCapUsd: null, dailyCapUsd: null, defaultStayMinutes: null };

let policy: Record<string, unknown>;
const throwaway = throwawaySession();
let throwawayTouched = false;

beforeAll(async () => {
  policy = (await gate())["policy"] as Record<string, unknown>;
  // Start from the defaults, whatever an earlier run left.
  await frFetch("PUT", "/me/limits", RESET);
});

afterAll(async () => {
  await frFetch("PUT", "/me/limits", RESET).catch(() => null);
  if (throwaway && throwawayTouched) {
    await sessionFetch("PUT", "/me/limits", {
      bearer: throwaway.accessToken,
      payload: RESET,
    }).catch(() => null);
  }
});

describe("FR-10 / FR-11 per-user limits", () => {
  it("FR-10 FR-11 GET /me/limits reads the caller's limits under the policy's caps as ceilings", async () => {
    const res = await frFetch("GET", "/me/limits");
    expect(res.status).toBe(200);
    expect(res.body["ceilings"]).toEqual({
      sessionCapUsd: policy["session_cap_usd"],
      dailyCapUsd: policy["daily_cap_usd"],
    });
    // Nothing saved: the operator's defaults are in effect.
    expect(res.body["saved"]).toEqual(RESET);
    expect(res.body["limits"]).toMatchObject({
      sessionCapUsd: Math.min(
        policy["session_cap_usd"] as number,
        policy["daily_cap_usd"] as number,
      ),
      dailyCapUsd: policy["daily_cap_usd"],
      defaultStayMinutes: policy["default_stay_minutes"],
    });
  });

  it("FR-10 FR-11 a cap above the ceiling is refused, typed and in words, and nothing changes", async () => {
    const ceiling = policy["session_cap_usd"] as number;
    const res = await frFetch("PUT", "/me/limits", { sessionCapUsd: ceiling + 1 });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("invalid_limits");
    const issues = res.body["issues"] as Record<string, unknown>[];
    expect(issues[0]).toMatchObject({
      field: "sessionCapUsd",
      code: "above_ceiling",
      limit: ceiling,
    });
    expect(issues[0]!["message"]).toBe(
      `Per stop can't be more than $${ceiling.toFixed(2)} — the most ParkAgent pays right now.`,
    );
    expect((await frFetch("GET", "/me/limits")).body["saved"]).toEqual(RESET);
  });

  it("FR-10 the caller's own per-stop cap decides its own auto-pay", async (ctx) => {
    if (SUNDAY) {
      ctx.skip();
      return;
    }
    const saved = await frFetch("PUT", "/me/limits", { sessionCapUsd: 1 });
    expect(saved.status).toBe(200);
    expect((saved.body["limits"] as Record<string, unknown>)["sessionCapUsd"]).toBe(1);

    const res = await frFetch("POST", "/parked", parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: "confirm", rule: "session_cap_exceeded" });
    await frFetch("PUT", "/me/limits", RESET);
  });

  it("FR-10 FR-11 one user's limits never affect another's", async (ctx) => {
    if (!throwaway) {
      ctx.skip(); // no second user minted for this run
      return;
    }
    const bearer = throwaway.accessToken;
    // The FR user caps itself hard…
    expect((await frFetch("PUT", "/me/limits", { sessionCapUsd: 1, dailyCapUsd: 2 })).status).toBe(
      200,
    );

    // …and the other user still runs on the operator's defaults.
    const theirs = await sessionFetch("GET", "/me/limits", { bearer });
    expect(theirs.status).toBe(200);
    expect(theirs.body["saved"]).toEqual(RESET);
    expect((theirs.body["limits"] as Record<string, unknown>)["dailyCapUsd"]).toBe(
      policy["daily_cap_usd"],
    );
    if (!SUNDAY) {
      const parked = await sessionFetch("POST", "/parked", {
        bearer,
        payload: parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }),
      });
      expect(parked.status).toBe(200);
      expect(parked.body["rule"]).not.toBe("session_cap_exceeded");
      expect(parked.body["rule"]).not.toBe("daily_cap_exceeded");
    }

    // The other way round: their change leaves the FR user's alone.
    throwawayTouched = true;
    const theirsSaved = await sessionFetch("PUT", "/me/limits", {
      bearer,
      payload: { defaultStayMinutes: 30 },
    });
    expect(theirsSaved.status).toBe(200);
    expect((await frFetch("GET", "/me/limits")).body["saved"]).toEqual({
      sessionCapUsd: 1,
      dailyCapUsd: 2,
      defaultStayMinutes: null,
    });
    await frFetch("PUT", "/me/limits", RESET);
  });
});
