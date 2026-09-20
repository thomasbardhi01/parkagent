/**
 * makeExecutorProvider: the real ParkNYC executor may only ever be handed
 * out when env DRY_RUN is false, a storage-state path is configured, AND
 * the per-call effective dry-run flag is false. Everything else must get
 * the DryRunExecutor — money-path belt and braces.
 */

import { expect, test } from "vitest";

import { DryRunExecutor } from "../src/services/executor.js";
import { makeExecutorProvider } from "../src/services/parknycExecutor.js";

const dryRunExecutor = new DryRunExecutor(() => {});

function provider(overrides: Partial<Parameters<typeof makeExecutorProvider>[0]> = {}) {
  return makeExecutorProvider({
    envDryRun: false,
    statePath: "/tmp/parknyc-state.json",
    dryRunExecutor,
    warn: () => {},
    ...overrides,
  });
}

test("env DRY_RUN=true always yields the dry-run executor, whatever else is set", () => {
  const p = provider({ envDryRun: true });
  // Even a (buggy) per-call dryRun=false must not reach ParkNYC.
  expect(p(false)).toBe(dryRunExecutor);
  expect(p(true)).toBe(dryRunExecutor);
});

test("no PARKNYC_STATE_PATH yields the dry-run executor and warns once", () => {
  const warnings: string[] = [];
  const base = makeExecutorProvider({
    envDryRun: false,
    dryRunExecutor,
    warn: (msg) => warnings.push(msg),
  });
  expect(base(false)).toBe(dryRunExecutor);
  expect(base(false)).toBe(dryRunExecutor);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("PARKNYC_STATE_PATH");
});

test("DRY_RUN=false with a state path yields the real executor only for real calls", () => {
  const p = provider();
  expect(p(true)).toBe(dryRunExecutor); // policy.json dry_run flip still wins
  const real = p(false);
  expect(real).not.toBe(dryRunExecutor);
  expect(typeof real.startSession).toBe("function");
  expect(typeof real.extendSession).toBe("function");
  expect(typeof real.stopSession).toBe("function");
});
