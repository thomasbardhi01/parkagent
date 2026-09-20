import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { policyHash, snapshotPolicy } from "../src/services/policy.js";
import { DEFAULT_POLICY, makeFakeDb, makePolicyService } from "./helpers.js";

test("loads and exposes a valid policy.json", () => {
  const service = makePolicyService();
  expect(service.get()).toEqual(DEFAULT_POLICY);
  expect(service.hash()).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("effective dry run is true unless BOTH env and policy say false", () => {
  expect(makePolicyService({ dry_run: true }, true).effectiveDryRun()).toBe(true);
  expect(makePolicyService({ dry_run: true }, false).effectiveDryRun()).toBe(true);
  expect(makePolicyService({ dry_run: false }, true).effectiveDryRun()).toBe(true);
  expect(makePolicyService({ dry_run: false }, false).effectiveDryRun()).toBe(false);
});

test("rejects an invalid policy file at construction", () => {
  expect(() => makePolicyService({ session_cap_usd: -5 } as never)).toThrowError(/session_cap_usd/);
});

test("update validates strictly and persists atomically", () => {
  const service = makePolicyService();
  expect(() => service.update({ ...DEFAULT_POLICY, surprise: 1 })).toThrow();
  expect(() => service.update({ ...DEFAULT_POLICY, daily_cap_usd: "sixty" })).toThrow();
  // Failed updates leave the current policy untouched.
  expect(service.get()).toEqual(DEFAULT_POLICY);

  const next = { ...DEFAULT_POLICY, daily_cap_usd: 80 };
  service.update(next);
  expect(service.get().daily_cap_usd).toBe(80);
  // And the file on disk matches what get() serves.
  const path = (service as unknown as { filePath: string }).filePath;
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(next);
});

test("policy hash covers nested keys and ignores key order", () => {
  const base = policyHash(DEFAULT_POLICY);
  const reordered = JSON.parse(
    JSON.stringify(DEFAULT_POLICY, Object.keys(DEFAULT_POLICY).sort().reverse()),
  );
  reordered.auto_extend = { ...DEFAULT_POLICY.auto_extend };
  // The replacer key-array strips nested objects' keys (see policy.ts),
  // so nested blocks are restored by hand.
  reordered.city_overrides = { ...DEFAULT_POLICY.city_overrides };
  expect(policyHash(reordered)).toBe(base);
  expect(
    policyHash({
      ...DEFAULT_POLICY,
      auto_extend: { ...DEFAULT_POLICY.auto_extend, max_count: 3 },
    }),
  ).not.toBe(base);
});

test("snapshotPolicy writes once per distinct policy", async () => {
  const { db, state } = makeFakeDb();
  await snapshotPolicy(db, DEFAULT_POLICY, "boot");
  await snapshotPolicy(db, DEFAULT_POLICY, "boot");
  expect(state.snapshots).toHaveLength(1);
  expect(state.snapshots[0]).toMatchObject({ source: "boot" });

  await snapshotPolicy(db, { ...DEFAULT_POLICY, daily_cap_usd: 80 }, "put");
  expect(state.snapshots).toHaveLength(2);
  expect(state.snapshots[1]).toMatchObject({ source: "put" });
});
