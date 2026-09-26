/**
 * Graceful shutdown order (services/shutdown.ts). The regression: SIGTERM
 * closed the shared Chromium FIRST, killing a payment mid-flight, never
 * waited for requests or job passes in flight, and never disconnected the
 * database; Fly SIGKILLs after its kill timeout either way.
 */

import { expect, test } from "vitest";

import { makeShutdown } from "../src/services/shutdown.js";

function harness(options: { requestMs?: number; jobMs?: number; deadlineMs?: number } = {}) {
  const events: string[] = [];
  const later = (ms: number, label: string) =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        events.push(label);
        resolve();
      }, ms),
    );
  let exitCode: number | null = null;
  const shutdown = makeShutdown({
    stopJobs: () => events.push("jobs stopped"),
    closeServer: () => later(options.requestMs ?? 20, "requests drained"),
    drains: [() => later(options.jobMs ?? 40, "extension finished")],
    closeBrowser: async () => {
      events.push("browser closed");
    },
    disconnectDb: async () => {
      events.push("db disconnected");
    },
    log: { info() {}, warn: (msg) => events.push(`warn: ${msg}`) },
    exit: (code) => {
      exitCode = code;
    },
    deadlineMs: options.deadlineMs ?? 1_000,
  });
  return { shutdown, events, exitCode: () => exitCode };
}

test("in-flight work finishes before the browser it runs on closes", async () => {
  const h = harness();
  await h.shutdown("SIGTERM");
  expect(h.events).toEqual([
    "jobs stopped",
    "requests drained",
    "extension finished",
    "browser closed",
    "db disconnected",
  ]);
  expect(h.exitCode()).toBe(0);
});

test("past the deadline it says what was still running and exits 1", async () => {
  const h = harness({ jobMs: 500, deadlineMs: 100 });
  await h.shutdown("SIGTERM");
  expect(h.exitCode()).toBe(1);
  expect(h.events.at(-1)).toMatch(/deadline \(100 ms\) passed while draining jobs/);
  expect(h.events).not.toContain("browser closed");
});

test("a second signal mid-shutdown changes nothing", async () => {
  const h = harness();
  await Promise.all([h.shutdown("SIGTERM"), h.shutdown("SIGINT")]);
  expect(h.events.filter((e) => e === "jobs stopped")).toHaveLength(1);
});
