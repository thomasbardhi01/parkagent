/**
 * FR-10 / FR-11 — per-user limits, live. Each user sets their own per-stop
 * and per-day caps and default stay (GET/PUT /me/limits) within the
 * policy's caps, which are the ceilings; every cap check reads the
 * caller's own. What a live, dry-run server can prove:
 *
 *  - a user's limits read and refuse exactly as documented;
 *  - a user's own per-stop cap decides its own auto-pay at a known NYC
 *    zone;
 *  - a second user's limits and decisions are untouched by the first's,
 *    and the other way round.
 *
 * Both users are this file's own throwaways (client.ts `ownUser`; the
 * second is declared in pool.mjs). Every test starts them on the
 * operator's defaults, so no test depends on another having run — or on
 * a run that died with a cap still set, which used to leak into the next
 * file's auto-pay (the caps lived on the shared FR user).
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  easternWeekday,
  gate,
  mostRecentEasternAt,
  NYC_AUTOPAY,
  ownUser,
  parkedBody,
  userFetch,
} from "./client.js";

const me = ownUser(import.meta.url);
const other = ownUser(import.meta.url, "other");

const AFTERNOON = mostRecentEasternAt(14, 0);
// NYC meters are free on Sundays: nothing to cap.
const SUNDAY = easternWeekday(AFTERNOON) === "Sun";
const RESET = { sessionCapUsd: null, dailyCapUsd: null, defaultStayMinutes: null };

let policy: Record<string, unknown>;

beforeAll(async () => {
  policy = (await gate())["policy"] as Record<string, unknown>;
});

beforeEach(async () => {
  for (const user of [me, other]) {
    expect((await userFetch(user, "PUT", "/me/limits", RESET)).status).toBe(200);
  }
});

describe("FR-10 / FR-11 per-user limits", () => {
  it("FR-10 FR-11 GET /me/limits reads the caller's limits under the policy's caps as ceilings", async () => {
    const res = await userFetch(me, "GET", "/me/limits");
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
    const res = await userFetch(me, "PUT", "/me/limits", { sessionCapUsd: ceiling + 1 });
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
    expect((await userFetch(me, "GET", "/me/limits")).body["saved"]).toEqual(RESET);
  });

  it("FR-10 the caller's own per-stop cap decides its own auto-pay", async (ctx) => {
    if (SUNDAY) {
      ctx.skip();
      return;
    }
    const saved = await userFetch(me, "PUT", "/me/limits", { sessionCapUsd: 1 });
    expect(saved.status).toBe(200);
    expect((saved.body["limits"] as Record<string, unknown>)["sessionCapUsd"]).toBe(1);

    const res = await userFetch(me, "POST", "/parked", parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: "confirm", rule: "session_cap_exceeded" });
  });

  it("FR-10 FR-11 one user's limits never affect another's", async () => {
    // One user caps itself hard…
    expect(
      (await userFetch(me, "PUT", "/me/limits", { sessionCapUsd: 1, dailyCapUsd: 2 })).status,
    ).toBe(200);

    // …and the other still runs on the operator's defaults.
    const theirs = await userFetch(other, "GET", "/me/limits");
    expect(theirs.status).toBe(200);
    expect(theirs.body["saved"]).toEqual(RESET);
    expect((theirs.body["limits"] as Record<string, unknown>)["dailyCapUsd"]).toBe(
      policy["daily_cap_usd"],
    );
    if (!SUNDAY) {
      const parked = await userFetch(
        other,
        "POST",
        "/parked",
        parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }),
      );
      expect(parked.status).toBe(200);
      expect(parked.body["rule"]).not.toBe("session_cap_exceeded");
      expect(parked.body["rule"]).not.toBe("daily_cap_exceeded");
    }

    // The other way round: their change leaves the first user's alone.
    const theirsSaved = await userFetch(other, "PUT", "/me/limits", { defaultStayMinutes: 30 });
    expect(theirsSaved.status).toBe(200);
    expect((await userFetch(me, "GET", "/me/limits")).body["saved"]).toEqual({
      sessionCapUsd: 1,
      dailyCapUsd: 2,
      defaultStayMinutes: null,
    });
  });
});
