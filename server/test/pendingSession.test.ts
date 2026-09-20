/**
 * The issuing webhook's pending-session check: a pending or active session
 * for the user that started (pending: was created) within the last 10
 * minutes.
 */

import { describe, expect, it } from "vitest";

import { makePendingSessionCheck } from "../src/services/pendingSession.js";
import { makeFakeDb, MONDAY_2PM, seedSession } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function makeCheck() {
  const { db, state } = makeFakeDb();
  return { check: makePendingSessionCheck(db), state };
}

describe("makePendingSessionCheck", () => {
  it("is true for a pending session created within the window", async () => {
    const { check, state } = makeCheck();
    seedSession(state, { userId: "u1", status: "pending", createdAt: minutesAgo(5) });
    expect(await check("u1", NOW)).toBe(true);
  });

  it("is true for an active session started within the window", async () => {
    const { check, state } = makeCheck();
    seedSession(state, {
      userId: "u1",
      status: "active",
      startedAt: minutesAgo(3),
      createdAt: minutesAgo(30),
    });
    expect(await check("u1", NOW)).toBe(true);
  });

  it("is false when the session started too long ago", async () => {
    const { check, state } = makeCheck();
    seedSession(state, {
      userId: "u1",
      status: "active",
      startedAt: minutesAgo(11),
      createdAt: minutesAgo(11),
    });
    expect(await check("u1", NOW)).toBe(false);
  });

  it("is false for stopped/failed sessions and for other users", async () => {
    const { check, state } = makeCheck();
    seedSession(state, { userId: "u1", status: "stopped", startedAt: minutesAgo(2) });
    seedSession(state, { userId: "u1", status: "failed", createdAt: minutesAgo(2) });
    seedSession(state, { userId: "u2", status: "pending", createdAt: minutesAgo(2) });
    expect(await check("u1", NOW)).toBe(false);
  });

  it("is false with no sessions at all", async () => {
    const { check } = makeCheck();
    expect(await check("u1", NOW)).toBe(false);
  });
});
