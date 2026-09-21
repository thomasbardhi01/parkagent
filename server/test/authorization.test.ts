/**
 * Authorization on top of authentication: the shared policy and /admin/*
 * are the owner's alone — any other valid key gets 403, and nothing else
 * about their access changes.
 */

import { expect, test } from "vitest";

import { API_KEY, NONADMIN_API_KEY, STEINWAY_A, makeTestApp, parkedBody } from "./helpers.js";

const admin = { "x-api-key": API_KEY, "content-type": "application/json" };
const nonAdmin = { "x-api-key": NONADMIN_API_KEY, "content-type": "application/json" };

test("a non-admin key cannot PUT /policy; the policy is untouched", async () => {
  const { app, deps } = makeTestApp({});
  const before = deps.policy.hash();
  const res = await app.inject({
    method: "PUT",
    url: "/policy",
    headers: nonAdmin,
    payload: { ...deps.policy.get(), daily_cap_usd: 10_000 },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: "forbidden" });
  expect(deps.policy.hash()).toBe(before);
});

test("the admin key still edits policy; everyone still reads it", async () => {
  const { app, deps } = makeTestApp({});
  const read = await app.inject({ method: "GET", url: "/policy", headers: nonAdmin });
  expect(read.statusCode).toBe(200);

  const put = await app.inject({
    method: "PUT",
    url: "/policy",
    headers: admin,
    payload: { ...deps.policy.get(), daily_cap_usd: 61 },
  });
  expect(put.statusCode).toBe(200);
  expect(put.json().policy.daily_cap_usd).toBe(61);
});

test("/admin/summary is 403 for a non-admin, 200 for the admin", async () => {
  const { app } = makeTestApp({});
  expect(
    (await app.inject({ method: "GET", url: "/admin/summary", headers: nonAdmin })).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: "GET", url: "/admin/summary", headers: admin })).statusCode,
  ).toBe(200);
});

test("a non-admin's ordinary routes keep working (403 is scoped, not global)", async () => {
  const { app } = makeTestApp({ candidates: [STEINWAY_A] });
  const res = await app.inject({
    method: "POST",
    url: "/parked",
    headers: nonAdmin,
    payload: parkedBody(),
  });
  expect(res.statusCode).toBe(200);
});
