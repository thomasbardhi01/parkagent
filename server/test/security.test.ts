/**
 * The security surface: default-on auth, rate limits on the abuse-prone
 * routes, and the generic 500 — no internal error text to callers.
 */

import { describe, expect, test } from "vitest";

import { makeRateLimiter } from "../src/services/rateLimit.js";
import { signAccessToken } from "../src/services/authTokens.js";
import {
  API_KEY,
  MONDAY_2PM,
  STEINWAY_A,
  TEST_JWT_SECRET,
  makeTestApp,
  parkedBody,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

// Every route the server registers. Keep in step with buildApp — the test
// below asserts each is closed without a key, so a new route added here
// gets the check for free (and one forgotten here still 401s in prod: auth
// is an app-level onRequest hook, not per-route opt-in).
const ROUTES: { method: "GET" | "POST" | "PUT"; url: string }[] = [
  { method: "POST", url: "/parked" },
  { method: "GET", url: "/city?lat=40&lng=-73" },
  { method: "POST", url: "/zones/nyc-1/provider-number" },
  { method: "GET", url: "/policy" },
  { method: "PUT", url: "/policy" },
  { method: "POST", url: "/session/start" },
  { method: "POST", url: "/session/extend" },
  { method: "POST", url: "/session/stop" },
  { method: "POST", url: "/location" },
  { method: "POST", url: "/device" },
  { method: "GET", url: "/card" },
  { method: "POST", url: "/card/prepare" },
  { method: "GET", url: "/card/transactions" },
  { method: "POST", url: "/card/funding/topup" },
  { method: "POST", url: "/card/funding/withdraw" },
  { method: "POST", url: "/card/funding/topup-intent" },
  { method: "GET", url: "/card/reveal" },
  { method: "POST", url: "/card/freeze" },
  { method: "POST", url: "/card/unfreeze" },
  { method: "GET", url: "/providers/status" },
  { method: "POST", url: "/providers/parknyc/link" },
  { method: "GET", url: "/providers/parknyc/link-status?jobId=x" },
  { method: "POST", url: "/providers/parknyc/setup-card" },
  { method: "POST", url: "/providers/parknyc/unlink" },
  { method: "POST", url: "/providers/parknyc/topup" },
  { method: "GET", url: "/me" },
  { method: "PATCH", url: "/me" },
  { method: "DELETE", url: "/me" },
  { method: "GET", url: "/me/vehicles" },
  { method: "POST", url: "/me/vehicles" },
  { method: "PATCH", url: "/me/vehicles/v1" },
  { method: "DELETE", url: "/me/vehicles/v1" },
];

/** The sign-in surface: public by necessity — the credential is in the
 * body, so there is nothing to present in a header yet. */
const PUBLIC_AUTH_ROUTES = [
  "/auth/apple",
  "/auth/google",
  "/auth/email/start",
  "/auth/email/verify",
  "/auth/refresh",
  "/auth/logout",
];

describe("auth is default-on", () => {
  test.each(ROUTES)("$method $url 401s without a credential", async ({ method, url }) => {
    const { app } = makeTestApp({});
    const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  test("unknown paths 401 too — no route probing without a key", async () => {
    const { app } = makeTestApp({});
    const res = await app.inject({ method: "GET", url: "/admin/anything" });
    expect(res.statusCode).toBe(401);
  });

  test("/health stays public", async () => {
    const { app } = makeTestApp({});
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  test("/webhooks/stripe skips api-key auth (signature is the auth)", async () => {
    const { app } = makeTestApp({});
    const res = await app.inject({ method: "POST", url: "/webhooks/stripe", payload: {} });
    // 503 stripe_not_configured — the route ran; a 401 would mean the
    // api-key hook wrongly gated it.
    expect(res.statusCode).toBe(503);
  });

  test.each(PUBLIC_AUTH_ROUTES)("%s is reachable signed out", async (url) => {
    const { app } = makeTestApp({});
    const res = await app.inject({ method: "POST", url, payload: {} });
    // The route RAN: 400 (the empty body failed validation) or, for
    // /auth/google, 403 (the flag is off, checked before the body). Only a
    // 401 would be wrong — that would mean the auth hook gated the way in
    // to authenticating.
    expect([400, 403]).toContain(res.statusCode);
  });

  test("a garbage bearer token is rejected, not ignored", async () => {
    const { app } = makeTestApp({});
    // Falling through to the api-key branch on a bad bearer would let a
    // caller present both and have the key silently win.
    for (const authorization of [
      "Bearer not-a-jwt",
      "Bearer a.b.c",
      "Bearer ",
      `Bearer ${Buffer.from('{"alg":"none"}').toString("base64url")}.e30.`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization, "x-api-key": API_KEY },
      });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  test("a valid bearer token authenticates without any api key", async () => {
    const { app, state } = makeTestApp({});
    const user = state.users.find((u) => u.id === "u1")!;
    const { token } = signAccessToken(TEST_JWT_SECRET, user, new Date(MONDAY_2PM));

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe("u1");
  });

  test("a tombstoned user's still-valid token stops working at once", async () => {
    const { app, state } = makeTestApp({});
    const user = state.users.find((u) => u.id === "u1")!;
    const { token } = signAccessToken(TEST_JWT_SECRET, user, new Date(MONDAY_2PM));
    user.deletedAt = new Date(MONDAY_2PM);

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("rate limiting", () => {
  test("the 31st /parked inside a minute is 429 with Retry-After", async () => {
    const { app } = makeTestApp({ candidates: [STEINWAY_A] });
    for (let i = 0; i < 30; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/parked",
        headers: HEADERS,
        payload: parkedBody(),
      });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/parked",
      headers: HEADERS,
      payload: parkedBody(),
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  test("the window slides: old hits expire", async () => {
    let at = 0;
    const limiter = makeRateLimiter({ max: 2, windowMs: 60_000, now: () => at });
    const codes: number[] = [];
    const req = { authedUser: { id: "u1" }, ip: "1.1.1.1" };
    const reply = {
      code(c: number) {
        codes.push(c);
        return this;
      },
      header() {
        return this;
      },
      send() {
        return this;
      },
    };
    const run = () =>
      (limiter as unknown as (req: unknown, reply: unknown) => Promise<unknown>)(req, reply);

    await run();
    await run();
    await run(); // third inside the window → 429
    expect(codes).toEqual([429]);

    at = 61_000; // window passed
    await run();
    expect(codes).toEqual([429]);
  });

  test("limits are per user, not global", async () => {
    let at = 0;
    const limiter = makeRateLimiter({ max: 1, windowMs: 60_000, now: () => at });
    const codes: number[] = [];
    const reply = {
      code(c: number) {
        codes.push(c);
        return this;
      },
      header() {
        return this;
      },
      send() {
        return this;
      },
    };
    const run = (id: string) =>
      (limiter as unknown as (req: unknown, reply: unknown) => Promise<unknown>)(
        { authedUser: { id }, ip: "1.1.1.1" },
        reply,
      );
    await run("u1");
    await run("u2"); // different user — fresh allowance
    expect(codes).toEqual([]);
  });
});

describe("error hygiene", () => {
  test("an unhandled route error answers a generic 500, never its message", async () => {
    const { app } = makeTestApp({});
    const boom = async () => {
      throw new Error("postgres://user:hunter2@db.internal:5432/parkagent");
    };
    const t = makeTestApp({});
    t.deps.findCandidates = boom;
    const res = await t.app.inject({
      method: "POST",
      url: "/parked",
      headers: HEADERS,
      payload: parkedBody(),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(res.body).not.toContain("hunter2");
    void app;
  });

  test("malformed JSON keeps its 400 and a typed code, no echo", async () => {
    const { app } = makeTestApp({});
    const res = await app.inject({
      method: "POST",
      url: "/location",
      headers: HEADERS,
      payload: '{"lat": 40.7,,}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("40.7");
  });
});
