/**
 * withBrowserCrashRetry: one fresh-context retry when Chromium died under
 * the call — typed or thrown — and strictly no retry for anything else
 * (retrying a provider-side failure could pay a meter twice).
 */

import { expect, test } from "vitest";

import { isBrowserCrash } from "../src/parknyc/classify.js";
import { withBrowserCrashRetry } from "../src/retry.js";
import type { ExecutorResult } from "../src/types.js";

const OK: ExecutorResult = {
  ok: true,
  providerSessionId: "p1",
  expiresAt: new Date("2026-01-05T20:00:00Z"),
  amountUsd: 3.65,
};

test("a typed browser_crashed on the first attempt retries once and succeeds", async () => {
  let calls = 0;
  const result = await withBrowserCrashRetry(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, code: "browser_crashed", message: "died" };
    return OK;
  });
  expect(calls).toBe(2);
  expect(result).toEqual(OK);
});

test("a THROWN mid-call browser death (open/newContext) retries too", async () => {
  let calls = 0;
  const result = await withBrowserCrashRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("browserContext.newPage: Target page, context or browser has been closed");
    }
    return OK;
  });
  expect(calls).toBe(2);
  expect(result).toEqual(OK);
});

test("two crashes surface browser_crashed — no third attempt", async () => {
  let calls = 0;
  const result = await withBrowserCrashRetry(async () => {
    calls += 1;
    throw new Error("Target closed");
  });
  expect(calls).toBe(2);
  expect(result).toEqual({ ok: false, code: "browser_crashed", message: "Target closed" });
});

test("provider-side failures are never retried", async () => {
  for (const code of ["payment_declined", "auth_expired", "ui_changed", "network"] as const) {
    let calls = 0;
    const result = await withBrowserCrashRetry(async () => {
      calls += 1;
      return { ok: false, code, message: "provider said no" };
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, code });
  }
});

test("a success is passed through untouched, one attempt only", async () => {
  let calls = 0;
  const result = await withBrowserCrashRetry(async () => {
    calls += 1;
    return OK;
  });
  expect(calls).toBe(1);
  expect(result).toBe(OK);
});

test("non-crash thrown errors propagate unretried (the bridge types them unknown)", async () => {
  let calls = 0;
  await expect(
    withBrowserCrashRetry(async () => {
      calls += 1;
      throw new Error("require of ESM module failed");
    }),
  ).rejects.toThrow("require of ESM");
  expect(calls).toBe(1);
});

test("isBrowserCrash recognizes Playwright's death rattles, not provider errors", () => {
  expect(isBrowserCrash(new Error("Target page, context or browser has been closed"))).toBe(true);
  expect(isBrowserCrash(new Error("browser has been disconnected"))).toBe(true);
  expect(isBrowserCrash(new Error("Timeout 30000ms exceeded waiting for selector"))).toBe(false);
  expect(isBrowserCrash(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(false);
});

/** A crash after the pay click must never replay the flow: the provider
 * may already have charged. It surfaces for the server to report "not
 * confirmed". (Before this, the retry ran regardless: an "accepted
 * caveat" that could pay a meter twice.) */
test("a crash after the pay click is never retried", async () => {
  let calls = 0;
  const result = await withBrowserCrashRetry(async () => {
    calls += 1;
    return { ok: false, code: "browser_crashed", message: "died", afterPayClick: true };
  });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ code: "browser_crashed", afterPayClick: true });
});
