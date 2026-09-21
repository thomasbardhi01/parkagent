/**
 * Device tokens are bound to the registering user: re-registration is
 * idempotent, a second account presenting the same token is refused, and
 * an explicit unbind (or user deletion, via the FK cascade) releases it.
 */

import { expect, test } from "vitest";

import { API_KEY, NONADMIN_API_KEY, makeTestApp } from "./helpers.js";

const u1 = { "x-api-key": API_KEY, "content-type": "application/json" };
const u2 = { "x-api-key": NONADMIN_API_KEY, "content-type": "application/json" };
const BODY = { token: "tok-abc", platform: "ios", environment: "development" } as const;

test("re-registration by the owner is idempotent and updates environment", async () => {
  const { app, state } = makeTestApp({});
  expect(
    (await app.inject({ method: "POST", url: "/device", headers: u1, payload: BODY })).statusCode,
  ).toBe(200);
  const again = await app.inject({
    method: "POST",
    url: "/device",
    headers: u1,
    payload: { ...BODY, environment: "production" },
  });
  expect(again.statusCode).toBe(200);
  expect(state.deviceTokens).toHaveLength(1);
  expect(state.deviceTokens[0]).toMatchObject({ userId: "u1", environment: "production" });
});

test("a token bound to one user is refused for another — the binding never moves", async () => {
  const { app, state } = makeTestApp({});
  await app.inject({ method: "POST", url: "/device", headers: u1, payload: BODY });
  const stolen = await app.inject({ method: "POST", url: "/device", headers: u2, payload: BODY });
  expect(stolen.statusCode).toBe(409);
  expect(stolen.json()).toEqual({ error: "token_bound_elsewhere" });
  expect(state.deviceTokens[0]!.userId).toBe("u1");
});

test("unbind releases the token; only then can the other user register it", async () => {
  const { app, state } = makeTestApp({});
  await app.inject({ method: "POST", url: "/device", headers: u1, payload: BODY });

  // The non-owner can't release someone else's binding.
  const foreign = await app.inject({
    method: "DELETE",
    url: "/device",
    headers: u2,
    payload: { token: BODY.token },
  });
  expect(foreign.statusCode).toBe(404);

  const release = await app.inject({
    method: "DELETE",
    url: "/device",
    headers: u1,
    payload: { token: BODY.token },
  });
  expect(release.statusCode).toBe(200);
  expect(state.deviceTokens).toHaveLength(0);

  const rebind = await app.inject({ method: "POST", url: "/device", headers: u2, payload: BODY });
  expect(rebind.statusCode).toBe(200);
  expect(state.deviceTokens[0]!.userId).toBe("u2");
});

test("unbinding a token that was never registered is 404", async () => {
  const { app } = makeTestApp({});
  const res = await app.inject({
    method: "DELETE",
    url: "/device",
    headers: u1,
    payload: { token: "tok-nope" },
  });
  expect(res.statusCode).toBe(404);
});
