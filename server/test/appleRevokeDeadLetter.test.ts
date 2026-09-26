/**
 * Apple revocations that keep failing: retried with backoff from the row
 * (so a restart changes nothing), then dead-lettered after the last
 * attempt, kept for a person, and counted in /admin/summary. A token no
 * retry can open is dead-lettered at once.
 */

import { expect, test } from "vitest";

import {
  APPLE_REVOKE_MAX_ATTEMPTS,
  appleRevokeBackoffMs,
  makeAppleRevocationJob,
} from "../src/jobs/appleRevocationTick.js";
import type { AppleTokenClient } from "../src/services/appleTokens.js";
import { API_KEY, makeFakeDb, makeTestApp, testStateCrypto } from "./helpers.js";

const failingApple = (calls: string[]): AppleTokenClient => ({
  exchangeCode: async () => ({ ok: false, error: "unused" }) as never,
  revoke: async (token) => {
    calls.push(token);
    return { ok: false, error: "invalid_client" };
  },
});

function tombstone(state: ReturnType<typeof makeFakeDb>["state"], sealed: string) {
  const row = state.users.find((u) => u.id === "u2")!;
  row.deletedAt = new Date("2026-01-05T12:00:00Z");
  row.appleRefreshTokenSealed = sealed;
  return row;
}

test("backoff doubles from an hour, capped at a day", () => {
  expect(appleRevokeBackoffMs(1)).toBe(60 * 60_000);
  expect(appleRevokeBackoffMs(2)).toBe(2 * 60 * 60_000);
  expect(appleRevokeBackoffMs(10)).toBe(24 * 60 * 60_000);
});

test("after the last attempt the revoke is dead-lettered and left alone", async () => {
  const { db, state } = makeFakeDb();
  const row = tombstone(state, testStateCrypto().seal("r.apple-refresh-9"));
  const calls: string[] = [];
  let clock = new Date("2026-01-05T12:00:00Z");
  const job = makeAppleRevocationJob({
    db,
    appleTokens: failingApple(calls),
    stateCrypto: testStateCrypto(),
    log: { info() {}, warn() {} },
    now: () => clock,
  });
  for (let i = 0; i < APPLE_REVOKE_MAX_ATTEMPTS; i += 1) {
    await job.tick();
    clock = new Date(clock.getTime() + 25 * 60 * 60_000);
  }
  expect(calls).toHaveLength(APPLE_REVOKE_MAX_ATTEMPTS);
  expect(row.appleRevokeDeadAt).toEqual(expect.any(Date));
  expect(row.appleRefreshTokenSealed).toEqual(expect.any(String)); // kept for a person
  expect(state.decisions.at(-1)).toMatchObject({
    rule: "apple_token_revoke_dead_letter",
    userId: "u2",
  });
  await job.tick();
  expect(calls).toHaveLength(APPLE_REVOKE_MAX_ATTEMPTS);
});

test("a token no key can open is dead-lettered at once", async () => {
  const { db, state } = makeFakeDb();
  const row = tombstone(state, "not-a-sealed-token");
  const calls: string[] = [];
  const job = makeAppleRevocationJob({
    db,
    appleTokens: failingApple(calls),
    stateCrypto: testStateCrypto(),
    log: { info() {}, warn() {} },
  });
  await job.tick();
  expect(calls).toHaveLength(0);
  expect(row.appleRevokeDeadAt).toEqual(expect.any(Date));
  expect(row.appleRevokeLastError).toBe("token_unreadable");
});

test("/admin/summary shows dead letters and pending retries", async () => {
  const t = makeTestApp({ now: () => new Date("2026-01-05T19:00:00Z") });
  tombstone(t.state, "sealed").appleRevokeDeadAt = new Date();
  t.state.linkJobs.push({
    id: "job-dead",
    userId: "u1",
    provider: "passport",
    phase: "failed",
    reason: "timeout",
    retrySafe: true,
    dryRun: null,
    createdAt: new Date("2026-01-04T10:00:00Z"),
    stateSealed: null,
    setUpCard: false,
    attempts: 3,
    maxAttempts: 3,
    nextAttemptAt: null,
    lockedUntil: null,
    startedAt: null,
    finishedAt: new Date("2026-01-04T10:07:00Z"),
    deadAt: new Date("2026-01-04T10:07:00Z"),
    lastError: "provider did not answer within 45s",
    queuePosition: null,
    stages: {},
    notify: true,
    notifiedAt: null,
  });
  const res = await t.app.inject({
    method: "GET",
    url: "/admin/summary",
    headers: { "x-api-key": API_KEY },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.deadLetters.appleRevocations).toBe(1);
  expect(body.deadLetters.linkJobs).toEqual([
    expect.objectContaining({
      id: "job-dead",
      provider: "passport",
      reason: "timeout",
      attempts: 3,
    }),
  ]);
  expect(body.jobs).toEqual({ appleRevocationsPending: 0 });
  expect(body.providers).toEqual({});
});
