/**
 * Who acted (services/principal.ts) and the one decision writer that
 * stamps it (services/decisionLog.ts): a request runs as the person or
 * the admin key behind it, a job pass as a job for the row's owner, and
 * every decisions row says which — without any call site naming it.
 */

import { describe, expect, test } from "vitest";

import { makeExtender } from "../src/jobs/extendTick.js";
import { withDecisionLogging } from "../src/services/decisionLog.js";
import type { Principal } from "../src/services/principal.js";
import {
  currentPrincipal,
  jobPrincipal,
  principalFor,
  runAs,
  traceIdFrom,
  userPrincipal,
} from "../src/services/principal.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  NONADMIN_API_KEY,
  makeFakeDb,
  makeTestApp,
  seedSession,
} from "./helpers.js";

const AGENT: Principal = {
  userId: "u2",
  actor: "external_agent",
  agentKeyId: "k1",
  scopes: new Set(["read"]),
};

describe("the current principal", () => {
  test("is the one runAs set, across every await, and none outside", async () => {
    const p = userPrincipal({ id: "u2", isAdmin: false });
    expect(currentPrincipal()).toBeNull();
    const seen = await runAs(p, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentPrincipal();
    });
    expect(seen).toBe(p);
    expect(currentPrincipal()).toBeNull();
  });

  test("userPrincipal reads the admin flag; jobPrincipal acts for the row's owner", () => {
    expect(userPrincipal({ id: "u1", isAdmin: true })).toMatchObject({
      userId: "u1",
      actor: "admin",
    });
    expect(userPrincipal({ id: "u2", isAdmin: false })).toMatchObject({
      userId: "u2",
      actor: "user",
    });
    expect(jobPrincipal("u2")).toMatchObject({ userId: "u2", actor: "job" });
  });

  test("principalFor is the current one for that user, and never a downgrade", async () => {
    expect(principalFor("u2")).toMatchObject({ userId: "u2", actor: "user" });
    await runAs(AGENT, async () => {
      expect(principalFor("u2")).toBe(AGENT);
      // An agent (or an admin) reaching another user's money path is a
      // bug, not that user: it throws rather than be judged with consent
      // never checked.
      expect(() => principalFor("u1")).toThrow(/principal mismatch/);
    });
  });
});

describe("the decision writer", () => {
  const write = (db: ReturnType<typeof withDecisionLogging>, extra: Record<string, unknown> = {}) =>
    db.decision.create({
      data: { kind: "t", inputs: {}, rule: "r", outcome: {}, userId: "u2", ...extra },
    });

  test("stamps the current principal's actor and key", async () => {
    const { db: raw, state } = makeFakeDb();
    const logged: unknown[] = [];
    const db = withDecisionLogging(raw, { info: (payload) => logged.push(payload) });
    await runAs(userPrincipal({ id: "u1", isAdmin: true }), () => write(db));
    await runAs(AGENT, () => write(db));
    await runAs(jobPrincipal("u2"), () => write(db));
    await write(db);
    expect(state.decisions.map((d) => [d.actor, d.agentKeyId ?? null])).toEqual([
      ["admin", null],
      ["external_agent", "k1"],
      ["job", null],
      ["user", null],
    ]);
    expect(logged[1]).toMatchObject({ decision: { actor: "external_agent", rule: "r" } });
  });

  test("a caller that names its actor is believed", async () => {
    const { db: raw, state } = makeFakeDb();
    const db = withDecisionLogging(raw, { info: () => {} });
    await runAs(userPrincipal({ id: "u2", isAdmin: false }), () => write(db, { actor: "job" }));
    expect(state.decisions[0]?.actor).toBe("job");
  });
});

describe("through the app", () => {
  test("a request's decisions carry the person, or the admin key, behind it", async () => {
    const t = makeTestApp({});
    const put = (key: string) =>
      t.app.inject({
        method: "PUT",
        url: "/me/limits",
        headers: { "x-api-key": key },
        payload: { sessionCapUsd: 5 },
      });
    expect((await put(API_KEY)).statusCode).toBe(200);
    expect((await put(NONADMIN_API_KEY)).statusCode).toBe(200);
    const actors = t.state.decisions.map((d) => [d.userId, d.actor, d.traceId]);
    expect(actors).toEqual([
      ["u1", "admin", null],
      ["u2", "user", null],
    ]);
  });

  test("a request's decisions carry its traceparent's trace id, never a made-up one", async () => {
    const t = makeTestApp({});
    const put = (traceparent: string) =>
      t.app.inject({
        method: "PUT",
        url: "/me/limits",
        headers: { "x-api-key": NONADMIN_API_KEY, traceparent },
        payload: { sessionCapUsd: 5 },
      });
    expect((await put("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).statusCode).toBe(
      200,
    );
    expect((await put("not-a-trace")).statusCode).toBe(200);
    expect(t.state.decisions.map((d) => d.traceId)).toEqual([
      "4bf92f3577b34da6a3ce929d0e0e4736",
      null,
    ]);
  });

  test("traceIdFrom reads only a well-formed W3C header", () => {
    expect(traceIdFrom("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(traceIdFrom("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(traceIdFrom("4bf92f3577b34da6a3ce929d0e0e4736")).toBeNull();
    expect(traceIdFrom(["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"])).toBeNull();
    expect(traceIdFrom(undefined)).toBeNull();
  });

  test("the extension worker's decisions say a job acted for the session's owner", async () => {
    const T = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00-05:00`);
    const t = makeTestApp({ now: () => T("14:20") });
    const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
    seedSession(t.state, {
      userId: "u2",
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
      carLat: 40.7702,
      carLng: -73.9077,
      rateFirstHour: 2.0,
      rateAdditionalHour: 3.0,
      maxStayMinutes: 240,
      hoursJson: HOURS_MON_SAT,
      parknycConfirmation: "dry-seed",
    });
    await extender.tick();
    const ticks = t.state.decisions.filter((d) => d.kind === "extend_tick");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((d) => d.actor === "job" && d.userId === "u2")).toBe(true);
  });
});
