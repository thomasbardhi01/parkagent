/**
 * Idempotency keys (services/idempotency.ts): a retry after a lost
 * response gets the first answer instead of running the work again.
 * The regression each test pins: POST /session/extend retried after its
 * answer was lost in a tunnel bought the time twice; a retried /parked
 * recorded two parks.
 */

import { expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import {
  IDEMPOTENCY_STALE_MS,
  makeIdempotencyJanitor,
  requestHash,
} from "../src/services/idempotency.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
} from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 240,
  hoursJson: HOURS_MON_SAT,
};

function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  let clock = NOW;
  const t = makeTestApp({
    zones: [STEINWAY_ZONE],
    candidates: [STEINWAY_A],
    now: () => clock,
    ...options,
  });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: 40.7702,
    lng: -73.9077,
    accuracyM: 12,
    ts: NOW,
    signals: ["motion_stop"],
  });
  return {
    ...t,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function send(
  t: ReturnType<typeof app>,
  url: string,
  payload: object,
  key?: string,
  apiKey = API_KEY,
) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { "x-api-key": apiKey, ...(key ? { "idempotency-key": key } : {}) },
    payload,
  });
}

async function started(t: ReturnType<typeof app>) {
  const res = await send(t, "/session/start", {
    parkedEventId: "pe1",
    zoneId: "nyc-417371",
    minutes: 60,
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sessionId: string }).sessionId;
}

test("an extension retried with its key after a lost answer extends once and replays the answer", async () => {
  const t = app();
  const sessionId = await started(t);
  const first = await send(t, "/session/extend", { sessionId, minutes: 30 }, "extend-key-0001");
  expect(first.statusCode).toBe(200);

  // The phone never saw `first` (a tunnel); it retries with the same key.
  const retry = await send(t, "/session/extend", { sessionId, minutes: 30 }, "extend-key-0001");
  expect(retry.statusCode).toBe(200);
  expect(retry.headers["idempotent-replayed"]).toBe("true");
  expect(retry.json()).toEqual(first.json());

  const session = t.state.sessions.find((s) => s.id === sessionId)!;
  expect(session.extendCount).toBe(1);
  expect(session.purchasedMinutes).toBe(90);
  expect(t.state.decisions.filter((d) => d.kind === "session_extend")).toHaveLength(1);
});

test("without a key a retry is a second request (why the app always sends one)", async () => {
  const t = app();
  const sessionId = await started(t);
  await send(t, "/session/extend", { sessionId, minutes: 30 });
  await send(t, "/session/extend", { sessionId, minutes: 30 });
  expect(t.state.sessions.find((s) => s.id === sessionId)!.extendCount).toBe(2);
});

test("a park report retried with its key records one park", async () => {
  const t = app();
  const first = await send(t, "/parked", parkedBody(), "parked-key-0001");
  const retry = await send(t, "/parked", parkedBody(), "parked-key-0001");
  expect(retry.json()).toEqual(first.json());
  expect(t.state.parkedEvents.filter((e) => e.userId === "u1")).toHaveLength(2); // pe1 + one new
  expect(t.state.decisions.filter((d) => d.kind === "parked_quote")).toHaveLength(1);
});

test("an answer that was a refusal is still the answer", async () => {
  const t = app();
  const first = await send(
    t,
    "/session/start",
    { parkedEventId: "pe1", zoneId: "nyc-417371", minutes: 600 },
    "start-key-0001",
  );
  expect(first.statusCode).toBe(409);
  const retry = await send(
    t,
    "/session/start",
    { parkedEventId: "pe1", zoneId: "nyc-417371", minutes: 600 },
    "start-key-0001",
  );
  expect(retry.statusCode).toBe(409);
  expect(retry.headers["idempotent-replayed"]).toBe("true");
  expect(t.state.decisions.filter((d) => d.kind === "session_start")).toHaveLength(1);
});

test("the same key on a different request is refused and runs nothing", async () => {
  const t = app();
  const sessionId = await started(t);
  await send(t, "/session/extend", { sessionId, minutes: 30 }, "extend-key-0002");
  const other = await send(t, "/session/extend", { sessionId, minutes: 60 }, "extend-key-0002");
  expect(other.statusCode).toBe(422);
  expect(other.json()).toEqual({ error: "idempotency_key_reused" });
  expect(t.state.sessions.find((s) => s.id === sessionId)!.extendCount).toBe(1);
});

test("a retry while the first is still running waits instead of running twice", async () => {
  const t = app();
  const sessionId = await started(t);
  const body = { sessionId, minutes: 30 };
  t.state.idempotencyKeys.push({
    id: "idem-running",
    userId: "u1",
    key: "extend-key-0003",
    method: "POST",
    path: "/session/extend",
    requestHash: requestHash("POST", "/session/extend", body),
    state: "in_progress",
    statusCode: null,
    response: null,
    createdAt: NOW,
    completedAt: null,
  });
  const res = await send(t, "/session/extend", body, "extend-key-0003");
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "request_in_progress", retryAfterSeconds: 2 });
  expect(t.state.sessions.find((s) => s.id === sessionId)!.extendCount).toBe(0);
});

test("a claim abandoned by a dead process is taken over once it's stale", async () => {
  const t = app();
  const sessionId = await started(t);
  const body = { sessionId, minutes: 30 };
  t.state.idempotencyKeys.push({
    id: "idem-dead",
    userId: "u1",
    key: "extend-key-0004",
    method: "POST",
    path: "/session/extend",
    requestHash: requestHash("POST", "/session/extend", body),
    state: "in_progress",
    statusCode: null,
    response: null,
    createdAt: NOW,
    completedAt: null,
  });
  t.advance(IDEMPOTENCY_STALE_MS + 1_000);
  const res = await send(t, "/session/extend", body, "extend-key-0004");
  expect(res.statusCode).toBe(200);
  expect(t.state.idempotencyKeys.find((r) => r.id === "idem-dead")).toMatchObject({
    state: "done",
    statusCode: 200,
  });
});

test("keys are per user", async () => {
  const t = app();
  const mine = await send(t, "/parked", parkedBody(), "shared-key-0001");
  const theirs = await send(t, "/parked", parkedBody(), "shared-key-0001", NONADMIN_API_KEY);
  expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
  expect(theirs.json().parkedEventId).not.toBe(mine.json().parkedEventId);
});

test("a malformed key is refused before anything runs", async () => {
  const t = app();
  const res = await send(t, "/parked", parkedBody(), "short");
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: "invalid_idempotency_key" });
  expect(t.state.decisions).toHaveLength(0);
});

test("keys go after a day", async () => {
  const t = app();
  await send(t, "/parked", parkedBody(), "parked-key-0002");
  expect(t.state.idempotencyKeys).toHaveLength(1);
  const janitor = makeIdempotencyJanitor({
    db: t.deps.db,
    now: () => new Date(NOW.getTime() + 25 * 60 * 60_000),
    log: { warn() {} },
  });
  await janitor.sweep();
  expect(t.state.idempotencyKeys).toHaveLength(0);
});

test("an answer carrying card details or a client secret is never stored", async () => {
  const t = app();
  // Whatever these answer, a key sent with them must not keep the answer.
  for (const url of [
    "/link/spend-requests/lsrq_1/card",
    "/wallet/setup-intent",
    "/card/funding/topup-intent",
    "/link/connect",
  ]) {
    await send(t, url, {}, "secret-key-0001");
  }
  expect(t.state.idempotencyKeys).toEqual([]);
});
