/**
 * makeUserExecutorProvider: sessions now run on the caller's linked
 * provider account. Dry-run calls always get the DryRunExecutor; real
 * calls fail typed (auth_expired) without a linked+decryptable account,
 * and an auth_expired result flips the account to expired and pushes a
 * re-link request. The real ParkNYC path (lazy package import) is only
 * exercised E2E — these tests stop at the seam.
 */

import { expect, test } from "vitest";

import type { Push } from "../src/services/apns.js";
import { DryRunExecutor } from "../src/services/executor.js";
import { makeUserExecutorProvider } from "../src/services/parknycExecutor.js";
import { makeFakeDb, seedProviderAccount, testStateCrypto } from "./helpers.js";

const dryRunExecutor = new DryRunExecutor(() => {});

function makeProvider(options: { linked?: boolean; withCrypto?: boolean } = {}) {
  const { db, state } = makeFakeDb();
  if (options.linked !== false) seedProviderAccount(state);
  const pushes: { userId: string; push: Push }[] = [];
  const provider = makeUserExecutorProvider({
    db,
    ...(options.withCrypto !== false ? { stateCrypto: testStateCrypto() } : {}),
    dryRunExecutor,
    sendPush: async (userId, push) => {
      pushes.push({ userId, push });
    },
    warn: () => {},
  });
  return { provider, state, pushes };
}

const startArgs = { zoneNumber: "110436", minutes: 30, amountUsd: 2.5, feeUsd: 0.15 };

test("dry-run calls always get the dry-run executor", () => {
  const { provider } = makeProvider({ linked: false });
  expect(provider({ userId: "u1", city: "nyc", dryRun: true })).toBe(dryRunExecutor);
});

test("a real call without a linked account fails typed auth_expired", async () => {
  const { provider } = makeProvider({ linked: false });
  const result = await provider({ userId: "u1", city: "nyc", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: false, code: "auth_expired" });
});

test("a city with no provider fails typed, not thrown", async () => {
  const { provider } = makeProvider();
  const result = await provider({ userId: "u1", city: "atlantis", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: false, code: "unknown" });
});

test("without PROVIDER_STATE_KEY real calls fail typed", async () => {
  const { provider } = makeProvider({ withCrypto: false });
  const result = await provider({ userId: "u1", city: "nyc", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: false, code: "unknown" });
  expect((result as { message: string }).message).toContain("PROVIDER_STATE_KEY");
});

test("undecryptable state fails typed auth_expired (key rotation)", async () => {
  const { provider, state } = makeProvider();
  state.providerAccounts[0]!.stateEncrypted = "bm90LXNlYWxlZA=="; // not sealed by us
  const result = await provider({ userId: "u1", city: "nyc", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: false, code: "auth_expired" });
});
