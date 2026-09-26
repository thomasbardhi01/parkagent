/**
 * Account reads under a hard budget (linking): when it runs out the
 * client is closed, which stops the browser work, and the answer is a
 * typed "timeout", never a hang.
 */

import { expect, test } from "vitest";

import { withBudget } from "../src/index.js";

function fakeClient() {
  let closed = 0;
  let release: (() => void) | null = null;
  return {
    get closed() {
      return closed;
    },
    async close() {
      closed += 1;
      release?.();
    },
    /** Hangs until closed, then fails like Playwright does. */
    async hang(): Promise<{ ok: true }> {
      await new Promise<void>((resolve) => (release = resolve));
      throw new Error("Target page, context or browser has been closed");
    },
  };
}

test("a read that outlives its budget is closed and answers timeout", async () => {
  const client = fakeClient();
  const started = Date.now();
  const result = await withBudget(client, (c) => c.hang(), { budgetMs: 50 });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(result).toMatchObject({ ok: false, code: "timeout" });
  expect(client.closed).toBeGreaterThanOrEqual(1);
});

test("a caller abort stops the read the same way", async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const pending = withBudget(client, (c) => c.hang(), { signal: controller.signal });
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, code: "timeout" });
});

test("a read inside its budget returns its own answer and still closes", async () => {
  const client = fakeClient();
  const result = await withBudget(client, async () => ({ ok: true as const, last4: "4242" }), {
    budgetMs: 1_000,
  });
  expect(result).toEqual({ ok: true, last4: "4242" });
  expect(client.closed).toBe(1);
});
