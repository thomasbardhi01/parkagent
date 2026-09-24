/**
 * The daily provider-session health job: dead sessions flip to expired
 * with a re-link push, sessions whose cookies die soon get the nudge
 * early (status "expiring" — still usable), healthy ones just refresh
 * lastVerifiedAt. Every outcome is audited.
 */

import { expect, test } from "vitest";

import {
  EXPIRY_WARNING_MS,
  RECHECK_AFTER_MS,
  earliestCookieExpiry,
  makeProviderHealth,
} from "../src/jobs/providerHealthTick.js";
import type { Push } from "../src/services/apns.js";
import type { ProviderStorageState } from "../src/services/providerOps.js";
import {
  API_KEY,
  BOYLSTON_BOS,
  MONDAY_2PM,
  makeFakeProviderOps,
  makeTestApp,
  seedProviderAccount,
  testStateCrypto,
} from "./helpers.js";

const NOW = new Date(MONDAY_2PM);

function stateWithExpiry(expiresInMs: number | null): string {
  const state: ProviderStorageState = {
    cookies: [
      {
        name: "session",
        value: "s",
        domain: ".ppprk.com",
        path: "/",
        expires: expiresInMs === null ? -1 : (NOW.getTime() + expiresInMs) / 1000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
  return testStateCrypto().seal(JSON.stringify(state));
}

function makeHealthHarness(options: {
  verify?: () => ReturnType<ReturnType<typeof makeFakeProviderOps>["verifyAccount"]>;
  sealed: string;
  status?: string;
  /** Default: yesterday's pass, so today's is due. */
  lastVerifiedAt?: Date;
}) {
  // Boston candidates, so /parked resolves the Passport account seeded below.
  const harness = makeTestApp({ candidates: [BOYLSTON_BOS], seedLinkedProvider: false });
  seedProviderAccount(harness.state, {
    provider: "passport",
    status: options.status ?? "linked",
    stateEncrypted: options.sealed,
    lastVerifiedAt: options.lastVerifiedAt ?? new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
  });
  const pushes: { userId: string; push: Push }[] = [];
  const health = makeProviderHealth({
    db: harness.deps.db,
    sendPush: async (userId, push) => {
      pushes.push({ userId, push });
    },
    stateCrypto: harness.deps.stateCrypto,
    providerOps: () => makeFakeProviderOps(options.verify ? { verifyAccount: options.verify } : {}),
    log: { info: () => {}, warn: () => {} },
    now: () => NOW,
  });
  return { ...harness, health, pushes };
}

test("earliestCookieExpiry ignores session cookies without an expiry", () => {
  const state: ProviderStorageState = {
    cookies: [
      {
        name: "a",
        value: "",
        domain: "",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "b",
        value: "",
        domain: "",
        path: "/",
        expires: 200,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "c",
        value: "",
        domain: "",
        path: "/",
        expires: 100,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
  expect(earliestCookieExpiry(state)?.getTime()).toBe(100_000);
  expect(earliestCookieExpiry({ cookies: [], origins: [] })).toBeNull();
});

test("healthy account far from expiry: lastVerifiedAt refreshes, no push", async () => {
  const harness = makeHealthHarness({ sealed: stateWithExpiry(30 * 24 * 60 * 60 * 1000) });
  await harness.health.runOnce();
  const account = harness.state.providerAccounts[0]!;
  expect(account.status).toBe("linked");
  expect(account.lastVerifiedAt).toEqual(NOW);
  expect(harness.pushes).toHaveLength(0);
  expect(harness.state.decisions.at(-1)).toMatchObject({
    kind: "provider_health",
    rule: "verified",
  });
});

test("cookies dying inside the warning window: expiring + reconnect push", async () => {
  const harness = makeHealthHarness({ sealed: stateWithExpiry(EXPIRY_WARNING_MS / 2) });
  await harness.health.runOnce();
  const account = harness.state.providerAccounts[0]!;
  expect(account.status).toBe("expiring");
  expect(harness.pushes).toHaveLength(1);
  expect(harness.pushes[0]!.push.type).toBe("provider_relink");
  expect(harness.pushes[0]!.push.extra?.deepLink).toContain("provider=passport");
  expect(harness.state.decisions.at(-1)).toMatchObject({
    kind: "provider_health",
    rule: "expiring",
  });
});

test("an expiring account still reads as linked on /parked (session start: adversarial.test.ts)", async () => {
  const harness = makeHealthHarness({
    sealed: stateWithExpiry(EXPIRY_WARNING_MS / 2),
    status: "expiring",
  });
  const parked = await harness.app.inject({
    method: "POST",
    url: "/parked",
    headers: { "x-api-key": API_KEY },
    payload: { lat: 42.35, lng: -71.08, accuracy: 10, ts: MONDAY_2PM, signals: [] },
  });
  // Provider block reports it as linked-enough to pay.
  expect(parked.json().provider.linked).toBe(true);
});

test("dead session: expired + push; a transient failure changes nothing", async () => {
  const dead = makeHealthHarness({
    sealed: stateWithExpiry(30 * 24 * 60 * 60 * 1000),
    verify: async () => ({ ok: false, code: "auth_expired", message: "signed out" }),
  });
  await dead.health.runOnce();
  expect(dead.state.providerAccounts[0]!.status).toBe("expired");
  expect(dead.pushes.map((p) => p.push.type)).toEqual(["provider_relink"]);
  expect(dead.state.decisions.at(-1)).toMatchObject({ kind: "provider_health", rule: "expired" });

  const flaky = makeHealthHarness({
    sealed: stateWithExpiry(30 * 24 * 60 * 60 * 1000),
    verify: async () => ({ ok: false, code: "network", message: "dns" }),
  });
  await flaky.health.runOnce();
  expect(flaky.state.providerAccounts[0]!.status).toBe("linked");
  expect(flaky.pushes).toHaveLength(0);
  expect(flaky.state.decisions.at(-1)).toMatchObject({
    kind: "provider_health",
    rule: "check_failed",
  });
});

test("unreadable sealed state (rotated key): expired + push", async () => {
  const harness = makeHealthHarness({ sealed: "not-a-sealed-state" });
  await harness.health.runOnce();
  expect(harness.state.providerAccounts[0]!.status).toBe("expired");
  expect(harness.pushes).toHaveLength(1);
});

test("a boot-time pass skips accounts verified today: no provider traffic, no repeat push", async () => {
  let verifies = 0;
  const harness = makeHealthHarness({
    sealed: stateWithExpiry(EXPIRY_WARNING_MS / 2),
    status: "expiring",
    // This morning's daily pass already checked it (and pushed).
    lastVerifiedAt: new Date(NOW.getTime() - (RECHECK_AFTER_MS - 60_000)),
    verify: async () => {
      verifies += 1;
      return { ok: true };
    },
  });
  await harness.health.runOnce();
  expect(verifies).toBe(0);
  expect(harness.pushes).toHaveLength(0);

  // Once the window has passed, the account is due again — and nags again.
  harness.state.providerAccounts[0]!.lastVerifiedAt = new Date(NOW.getTime() - RECHECK_AFTER_MS);
  await harness.health.runOnce();
  expect(verifies).toBe(1);
  expect(harness.pushes).toHaveLength(1);
});
