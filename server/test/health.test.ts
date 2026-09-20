import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

afterEach(() => {
  delete process.env["DRY_RUN"];
});

test("GET /health reports ok and reflects DRY_RUN", async () => {
  process.env["DRY_RUN"] = "true";
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, dryRun: true, commit: "dev", builtAt: "dev" });
});

test("GET /health reports dryRun false when DRY_RUN is not 'true'", async () => {
  process.env["DRY_RUN"] = "false";
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.json()).toEqual({ ok: true, dryRun: false, commit: "dev", builtAt: "dev" });
});

test("GET /health surfaces the build-injected commit and build time", async () => {
  process.env["GIT_SHA"] = "abc1234";
  process.env["BUILD_TIME"] = "2026-01-01T00:00:00Z";
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.json()).toMatchObject({ commit: "abc1234", builtAt: "2026-01-01T00:00:00Z" });
  delete process.env["GIT_SHA"];
  delete process.env["BUILD_TIME"];
});
