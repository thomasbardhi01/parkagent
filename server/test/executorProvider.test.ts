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
import type { Executor } from "../src/services/executor.js";
import { DryRunExecutor } from "../src/services/executor.js";
import { makeUserExecutorProvider } from "../src/services/parknycExecutor.js";
import { makeFakeDb, seedProviderAccount, testStateCrypto } from "./helpers.js";

const dryRunExecutor = new DryRunExecutor(() => {});

function makeProvider(options: { linked?: boolean; withCrypto?: boolean; provider?: string } = {}) {
  const { db, state } = makeFakeDb();
  if (options.linked !== false) {
    seedProviderAccount(state, options.provider ? { provider: options.provider } : {});
  }
  const pushes: { userId: string; push: Push }[] = [];
  // The executor-picker seam: records which provider's executor was asked
  // for instead of importing the Playwright package.
  const pickedProviders: string[] = [];
  const fakeReal: Executor = {
    startSession: async () => ({
      ok: true,
      providerSessionId: "real-1",
      expiresAt: new Date(),
      amountUsd: 1,
    }),
    extendSession: async () => ({
      ok: true,
      providerSessionId: "real-1",
      expiresAt: new Date(),
      amountUsd: 1,
    }),
    stopSession: async () => ({
      ok: true,
      providerSessionId: "real-1",
      expiresAt: new Date(),
      amountUsd: 0,
    }),
  };
  const provider = makeUserExecutorProvider({
    db,
    ...(options.withCrypto !== false ? { stateCrypto: testStateCrypto() } : {}),
    dryRunExecutor,
    sendPush: async (userId, push) => {
      pushes.push({ userId, push });
    },
    warn: () => {},
    makeRealExecutor: (providerId) => {
      pickedProviders.push(providerId);
      return fakeReal;
    },
  });
  return { provider, state, pushes, pickedProviders };
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

test("the picker resolves nyc to the parknyc executor", async () => {
  const { provider, pickedProviders } = makeProvider();
  const result = await provider({ userId: "u1", city: "nyc", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: true, providerSessionId: "real-1" });
  expect(pickedProviders).toEqual(["parknyc"]);
});

test("the picker resolves bos to the passport executor", async () => {
  const { provider, pickedProviders } = makeProvider({ provider: "passport" });
  const result = await provider({ userId: "u1", city: "bos", dryRun: false }).startSession({
    ...startArgs,
    zoneNumber: "", // Boston zones store none; the executor map-resolves
  });
  expect(result).toMatchObject({ ok: true, providerSessionId: "real-1" });
  expect(pickedProviders).toEqual(["passport"]);
});

test("a bos call with only a parknyc account linked fails typed auth_expired", async () => {
  const { provider, pickedProviders } = makeProvider(); // linked: parknyc only
  const result = await provider({ userId: "u1", city: "bos", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: false, code: "auth_expired" });
  expect(pickedProviders).toEqual([]);
});

test("undecryptable state fails typed auth_expired (key rotation)", async () => {
  const { provider, state } = makeProvider();
  state.providerAccounts[0]!.stateEncrypted = "bm90LXNlYWxlZA=="; // not sealed by us
  const result = await provider({ userId: "u1", city: "nyc", dryRun: false }).startSession(
    startArgs,
  );
  expect(result).toMatchObject({ ok: false, code: "auth_expired" });
});
