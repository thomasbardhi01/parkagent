/**
 * The bridge's guard around every real provider call: the breaker first
 * (open → "provider_unavailable" and the browser is never touched), then
 * the gate (a wait past its bound → "busy", nothing ran), and the call's
 * queue wait, browser time, and retries on the result for its decisions
 * row. Stops at the seam: fake executors, no Playwright.
 */

import { expect, test } from "vitest";

import { CircuitBreaker } from "../src/services/circuitBreaker.js";
import type { Executor, ExecutorResult } from "../src/services/executor.js";
import { DryRunExecutor, executorOutcome } from "../src/services/executor.js";
import { ExecutorGate } from "../src/services/executorGate.js";
import {
  makeProviderOpsFactory,
  makeUserExecutorProvider,
} from "../src/services/parknycExecutor.js";
import type { ExecutorRuntime } from "../src/services/parknycExecutor.js";
import {
  makeFakeDb,
  makeFakeProviderOps,
  seedProviderAccount,
  testStateCrypto,
} from "./helpers.js";

const START = { zoneNumber: "110436", minutes: 60, amountUsd: 5, feeUsd: 0.35 };

function runtime(capacity = 1, sessionQueueWaitMs = 50): ExecutorRuntime {
  return { gate: new ExecutorGate(capacity), breaker: new CircuitBreaker(), sessionQueueWaitMs };
}

function sessions(rt: ExecutorRuntime, start: () => Promise<ExecutorResult>) {
  const { db, state } = makeFakeDb();
  seedProviderAccount(state);
  let calls = 0;
  const real: Executor = {
    startSession: async () => {
      calls += 1;
      return start();
    },
    extendSession: start,
    stopSession: start,
  };
  const executorFor = makeUserExecutorProvider({
    db,
    stateCrypto: testStateCrypto(),
    dryRunExecutor: new DryRunExecutor(() => {}),
    sendPush: async () => {},
    warn: () => {},
    makeRealExecutor: () => real,
    runtime: rt,
  });
  return {
    executor: executorFor({ userId: "u1", city: "nyc", dryRun: false }),
    calls: () => calls,
  };
}

const PAID: ExecutorResult = {
  ok: true,
  providerSessionId: "p1",
  expiresAt: new Date(),
  amountUsd: 5.35,
};

test("an open breaker fails fast: nothing runs, nothing is paid", async () => {
  const rt = runtime();
  const failing = sessions(rt, async () => ({ ok: false, code: "network", message: "down" }));
  for (let i = 0; i < 3; i += 1) await failing.executor.startSession(START);
  expect(rt.breaker.state("parknyc")).toBe("open");

  const result = await failing.executor.startSession(START);
  expect(result).toMatchObject({ ok: false, code: "provider_unavailable" });
  expect(failing.calls()).toBe(3);
});

test("a call that can't get a browser slot in time fails busy, never runs", async () => {
  const rt = runtime(1, 30);
  const held = await rt.gate.acquire();
  const s = sessions(rt, async () => PAID);
  const result = await s.executor.startSession(START);
  expect(result).toMatchObject({ ok: false, code: "busy" });
  expect(s.calls()).toBe(0);
  held.release();
});

test("the result carries queue wait, browser time, and retries for the decision", async () => {
  const rt = runtime(1, 1_000);
  const held = await rt.gate.acquire();
  const s = sessions(rt, async () => ({ ...PAID, retries: 1 }));
  const pending = s.executor.startSession(START);
  await new Promise((resolve) => setTimeout(resolve, 25));
  held.release();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.meta).toMatchObject({ retries: 1, queuedBehind: 1 });
  expect(result.meta!.queueMs).toBeGreaterThanOrEqual(20);
  expect(executorOutcome(result)).toEqual({ executor: result.meta });
});

test("a failure after the pay click says so on the decision", () => {
  const outcome = executorOutcome({
    ok: false,
    code: "browser_crashed",
    message: "died",
    afterPayClick: true,
    meta: { queueMs: 0, runMs: 9_000, retries: 0, queuedBehind: 0 },
  });
  expect(outcome).toEqual({
    executor: { queueMs: 0, runMs: 9_000, retries: 0, queuedBehind: 0, afterPayClick: true },
  });
});

test("account reads: the budget left after the queue goes to the browser, and the queue is reported", async () => {
  const rt = runtime(1);
  const held = await rt.gate.acquire();
  const budgets: (number | undefined)[] = [];
  const factory = makeProviderOpsFactory({}, rt, async () =>
    makeFakeProviderOps({
      verifyAccount: async (options) => {
        budgets.push(options?.budgetMs);
        return { ok: true, walletBalanceCents: null };
      },
    }),
  );
  const heard: number[] = [];
  const pending = factory("passport", { cookies: [], origins: [] }).verifyAccount({
    budgetMs: 1_000,
    onQueued: (n) => heard.push(n),
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 50));
  held.release();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(heard).toEqual([1, 0]);
  expect(budgets[0]).toBeLessThanOrEqual(960);
  expect(budgets[0]).toBeGreaterThan(0);
});

test("dry run never touches the gate or the breaker", async () => {
  const rt = runtime(1, 10);
  const held = await rt.gate.acquire();
  const { db } = makeFakeDb();
  const executorFor = makeUserExecutorProvider({
    db,
    dryRunExecutor: new DryRunExecutor(() => {}),
    sendPush: async () => {},
    warn: () => {},
    runtime: rt,
  });
  const result = await executorFor({ userId: "u1", city: "nyc", dryRun: true }).startSession(START);
  expect(result.ok).toBe(true);
  held.release();
});
