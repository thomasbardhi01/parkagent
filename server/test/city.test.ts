import { expect, test } from "vitest";

import { API_KEY, BOYLSTON_BOS, STEINWAY_A, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };

function get(app: ReturnType<typeof makeTestApp>["app"], query: string) {
  return app.inject({ method: "GET", url: `/city?${query}`, headers: HEADERS });
}

test("requires a valid api key", async () => {
  const { app } = makeTestApp({ candidates: [STEINWAY_A] });
  const res = await app.inject({ method: "GET", url: "/city?lat=40.77&lng=-73.98" });
  expect(res.statusCode).toBe(401);
});

test("rejects a malformed query with 400", async () => {
  const { app } = makeTestApp({ candidates: [STEINWAY_A] });
  const res = await get(app, "lat=91&lng=-73.98");
  expect(res.statusCode).toBe(400);
});

test("nearest NYC zone → nyc + ParkNYC, with the caller's link status", async () => {
  const { app } = makeTestApp({ candidates: [STEINWAY_A] });
  const res = await get(app, "lat=40.77&lng=-73.98");
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    city: "nyc",
    cityDisplayName: "New York City",
    provider: {
      id: "parknyc",
      city: "nyc",
      displayName: "ParkNYC",
      loginUrl: expect.stringContaining("flowbirdapp.com"),
      cookieDomains: ["nyc.flowbirdapp.com", "flowbirdapp.com"],
      // Link-or-create metadata rides along for onboarding's Connect step.
      signup: expect.objectContaining({
        mode: "form",
        url: expect.stringContaining("flowbirdapp.com"),
        prefill: expect.arrayContaining([expect.objectContaining({ field: "plate" })]),
      }),
      status: "linked",
      linked: true,
    },
  });
});

test("nearest Boston zone → bos + Passport, unlinked for this caller", async () => {
  const { app } = makeTestApp({ candidates: [BOYLSTON_BOS] });
  const res = await get(app, "lat=42.35&lng=-71.08");
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    city: "bos",
    cityDisplayName: "Boston",
    provider: { id: "passport", status: "unlinked", linked: false },
  });
});

test("no zone anywhere near → nulls, not an error", async () => {
  const { app } = makeTestApp({ candidates: [] });
  const res = await get(app, "lat=39.95&lng=-75.16");
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ city: null, cityDisplayName: null, provider: null });
});
