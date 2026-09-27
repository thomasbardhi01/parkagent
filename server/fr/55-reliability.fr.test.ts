/**
 * FR-41 — requests that survive the network, live. A request retried
 * after its answer was lost is answered with the first answer (Idempotency-
 * Key), a key can't be reused for a different request, and the server says
 * whether it can reach its database (/health/ready, what Fly routes by).
 * Everything here is dry-run safe: /parked records a park and a decision,
 * nothing pays.
 */

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  gate,
  mostRecentEasternAt,
  NYC_AUTOPAY,
  ownUser,
  parkedBody,
  userFetch,
} from "./client.js";

/** This file's own throwaway user (client.ts `ownUser`). */
const me = ownUser(import.meta.url);

const AFTERNOON = mostRecentEasternAt(14, 0);

beforeAll(async () => {
  await gate();
});

describe("FR-41 idempotent retries", () => {
  it("FR-41 a park report retried under its key is answered once, with the first answer", async () => {
    const key = `fr-${randomUUID()}`;
    const body = parkedBody(NYC_AUTOPAY, { ts: AFTERNOON });
    const first = await userFetch(me, "POST", "/parked", body, { "idempotency-key": key });
    expect(first.status).toBe(200);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    // As if the phone never saw `first` and asked again.
    const retry = await userFetch(me, "POST", "/parked", body, { "idempotency-key": key });
    expect(retry.status).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body["parkedEventId"]).toBe(first.body["parkedEventId"]);
    expect(retry.body["decisionId"]).toBe(first.body["decisionId"]);
  });

  it("FR-41 the same key on a different request is refused", async () => {
    const key = `fr-${randomUUID()}`;
    await userFetch(me, "POST", "/parked", parkedBody(NYC_AUTOPAY, { ts: AFTERNOON }), {
      "idempotency-key": key,
    });
    const other = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: AFTERNOON, accuracy: 30 }),
      {
        "idempotency-key": key,
      },
    );
    expect(other.status).toBe(422);
    expect(other.body["error"]).toBe("idempotency_key_reused");
  });
});

describe("FR-41 readiness", () => {
  it("FR-41 /health/ready answers only when the database does", async () => {
    const res = await userFetch(me, "GET", "/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: "ok" });
  });
});
