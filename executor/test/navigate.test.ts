/**
 * gotoWithRetry: one retry for transport trouble and navigation timeouts,
 * never for a page that loaded wrong, and never once the pay click happened.
 */

import { expect, test } from "vitest";

import { gotoWithRetry, isTransientNavigationError } from "../src/navigate.js";

function fakePage(failures: Error[]) {
  const calls: string[] = [];
  return {
    calls,
    page: {
      goto: async (url: string) => {
        calls.push(url);
        const failure = failures.shift();
        if (failure) throw failure;
        return null;
      },
    },
  };
}

const opts = (canRetry = () => true) => ({ timeoutMs: 1_000, canRetry, retryDelayMs: 0 });

test("a dropped connection is retried once and the second load wins", async () => {
  const { page, calls } = fakePage([
    new Error("page.goto: net::ERR_CONNECTION_RESET at https://x"),
  ]);
  let retries = 0;
  await gotoWithRetry(page as never, "https://x", { ...opts(), onRetry: () => (retries += 1) });
  expect(calls).toHaveLength(2);
  expect(retries).toBe(1);
});

test("a navigation timeout is retried once; a second failure surfaces", async () => {
  const timeout = () => new Error("page.goto: Timeout 15000ms exceeded.");
  const { page, calls } = fakePage([timeout(), timeout()]);
  await expect(gotoWithRetry(page as never, "https://x", opts())).rejects.toThrow("Timeout");
  expect(calls).toHaveLength(2);
});

test("never retried once the pay click happened", async () => {
  const { page, calls } = fakePage([new Error("net::ERR_INTERNET_DISCONNECTED")]);
  await expect(
    gotoWithRetry(
      page as never,
      "https://x",
      opts(() => false),
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("a non-transient failure is not retried", async () => {
  const { page, calls } = fakePage([new Error("page.goto: Protocol error: Target closed")]);
  await expect(gotoWithRetry(page as never, "https://x", opts())).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(isTransientNavigationError(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(true);
  expect(isTransientNavigationError(new Error("locator.waitFor: element not visible"))).toBe(false);
});
