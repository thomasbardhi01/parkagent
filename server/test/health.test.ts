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
  expect(res.json()).toEqual({ ok: true, dryRun: true });
});

test("GET /health reports dryRun false when DRY_RUN is not 'true'", async () => {
  process.env["DRY_RUN"] = "false";
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.json()).toEqual({ ok: true, dryRun: false });
});
