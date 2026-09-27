import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  PolicyNotSavedError,
  PolicyService,
  policyHash,
  snapshotPolicy,
} from "../src/services/policy.js";
import { API_KEY, DEFAULT_POLICY, makeFakeDb, makePolicyService, makeTestApp } from "./helpers.js";

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

// Permission bits don't bind root, so these run as a normal user only.
const asRoot = process.getuid?.() === 0;

/** Run `body` with `dir` read-only (r-x), restoring it after. */
function readOnly<T>(dir: string, body: () => T): T {
  chmodSync(dir, 0o555);
  try {
    return body();
  } finally {
    chmodSync(dir, 0o755);
  }
}

async function readOnlyWhile<T>(dir: string, body: () => Promise<T>): Promise<T> {
  chmodSync(dir, 0o555);
  try {
    return await body();
  } finally {
    chmodSync(dir, 0o755);
  }
}

const filePathOf = (service: PolicyService) =>
  (service as unknown as { filePath: string }).filePath;

describe.skipIf(asRoot)("a policy.json the server can't rewrite (#154)", () => {
  test("writable() says why, naming the directory", () => {
    const service = makePolicyService();
    expect(service.writable()).toEqual({ ok: true });
    const dir = dirname(filePathOf(service));
    readOnly(dir, () => {
      const answer = service.writable();
      expect(answer.ok).toBe(false);
      expect(!answer.ok && answer.reason).toContain(`its directory (${dir})`);
    });
  });

  test("a failed write changes nothing: not the policy in force, not the file", () => {
    const service = makePolicyService();
    const path = filePathOf(service);
    const before = readFileSync(path, "utf-8");
    readOnly(dirname(path), () => {
      expect(() => service.update({ ...DEFAULT_POLICY, daily_cap_usd: 999 })).toThrow(
        PolicyNotSavedError,
      );
    });
    // Before #154's fix the new cap was live in memory while PUT answered 500.
    expect(service.get().daily_cap_usd).toBe(DEFAULT_POLICY.daily_cap_usd);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("the image's layout: /app/policy.json links into a writable var/ under a read-only /app", () => {
    const app = mkdtempSync(join(tmpdir(), "parkagent-image-"));
    mkdirSync(join(app, "var"));
    writeFileSync(join(app, "var", "policy.json"), JSON.stringify(DEFAULT_POLICY));
    symlinkSync("var/policy.json", join(app, "policy.json"));

    readOnly(app, () => {
      const service = new PolicyService(join(app, "policy.json"), true);
      expect(service.writable()).toEqual({ ok: true });
      service.update({ ...DEFAULT_POLICY, daily_cap_usd: 75 });
      expect(service.get().daily_cap_usd).toBe(75);
    });
    // Written through the link, which is still a link.
    expect(readlinkSync(join(app, "policy.json"))).toBe("var/policy.json");
    expect(JSON.parse(readFileSync(join(app, "policy.json"), "utf-8")).daily_cap_usd).toBe(75);
  });

  test("PUT /policy answers 503 policy_not_saved and the old policy stays; GET says not editable", async () => {
    const { app, deps } = makeTestApp({});
    const admin = { "x-api-key": API_KEY, "content-type": "application/json" };
    const before = deps.policy.hash();
    await readOnlyWhile(dirname(filePathOf(deps.policy)), async () => {
      const read = await app.inject({ method: "GET", url: "/policy", headers: admin });
      expect(read.json().editable).toBe(false);
      const put = await app.inject({
        method: "PUT",
        url: "/policy",
        headers: admin,
        payload: { ...deps.policy.get(), daily_cap_usd: 61 },
      });
      expect(put.statusCode).toBe(503);
      expect(put.json().error).toBe("policy_not_saved");
    });
    expect(deps.policy.hash()).toBe(before);
    expect(
      (await app.inject({ method: "GET", url: "/policy", headers: admin })).json().editable,
    ).toBe(true);
  });
});
