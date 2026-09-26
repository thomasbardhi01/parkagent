import { afterEach, describe, expect, test } from "vitest";
import {
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_RECEIVE_TIMEOUT_MS,
  buildApp,
  createFastify,
} from "../src/app.js";
import { makeTestApp } from "./helpers.js";

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

describe("GET /health/ready", () => {
  test("answers ok when the database answers", async () => {
    const t = makeTestApp({});
    t.deps.dbPing = async () => [{ "?column?": 1 }];
    const res = await t.app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: "ok" });
  });

  test("503 when the database is down — Fly stops routing here", async () => {
    const t = makeTestApp({});
    t.deps.dbPing = async () => {
      throw new Error("connection refused");
    };
    const res = await t.app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: "down" });
  });

  test("503 when the database hangs, within the check's own timeout", async () => {
    const t = makeTestApp({});
    t.deps.dbPing = () => new Promise(() => {});
    const started = Date.now();
    const res = await t.app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: "timeout" });
    expect(Date.now() - started).toBeLessThan(4_500);
  });
});

describe("the server's own timeouts", () => {
  test("slow-drip requests are cut off, and keep-alive outlives Fly's proxy", () => {
    const app = createFastify();
    expect(app.initialConfig.requestTimeout).toBe(REQUEST_RECEIVE_TIMEOUT_MS);
    expect(app.initialConfig.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(REQUEST_RECEIVE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});
