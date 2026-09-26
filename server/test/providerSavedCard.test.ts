/**
 * provider_card display info at link time: the link job reads the
 * brand/last4 off the provider's Your Cards screen once the sign-in is
 * verified (best effort, never blocking the link), stores it, and
 * link-status and /providers/status serve it. issuing_card users never
 * trigger the read — their card is ours.
 */

import { expect, test } from "vitest";

import { API_KEY, makeFakeProviderOps, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };

const COOKIES = [{ name: "session", value: "abc", domain: ".ppprk.com", path: "/" }];

/** Link, let the worker finish the job, and return the job's answer. */
async function link(t: ReturnType<typeof makeTestApp>) {
  const res = await t.app.inject({
    method: "POST",
    url: "/providers/passport/link",
    headers: HEADERS,
    payload: { cookies: COOKIES, set_up_card: false },
  });
  expect(res.statusCode).toBe(202);
  await t.linkWorker.tick();
  const status = await t.app.inject({
    method: "GET",
    url: `/providers/passport/link-status?jobId=${(res.json() as { jobId: string }).jobId}`,
    headers: HEADERS,
  });
  return status.json() as {
    phase: string;
    linked: boolean;
    cardBrand?: string;
    cardLast4?: string;
  };
}

test("provider_card link stores and serves the saved card's brand/last4", async () => {
  const t = makeTestApp({
    paymentSource: "provider_card",
    seedLinkedProvider: false,
    providerOps: () =>
      makeFakeProviderOps({
        readSavedCard: async () => ({ ok: true, brand: "Mastercard", last4: "7788" }),
      }),
  });
  const { app, state } = t;
  const job = await link(t);
  expect(job).toMatchObject({
    phase: "done",
    linked: true,
    cardBrand: "Mastercard",
    cardLast4: "7788",
  });

  const account = state.providerAccounts.find((a) => a.provider === "passport")!;
  expect(account.cardBrand).toBe("Mastercard");
  expect(account.cardLast4).toBe("7788");

  const status = await app.inject({ method: "GET", url: "/providers/status", headers: HEADERS });
  const passport = status.json().providers.find((p: { id: string }) => p.id === "passport");
  expect(passport).toMatchObject({ cardBrand: "Mastercard", cardLast4: "7788" });
  // Sign-up metadata rides on status for the link-or-create flow.
  expect(passport.signup.mode).toBe("passwordless");
});

test("a failed read never blocks the link — nulls are stored", async () => {
  const t = makeTestApp({
    paymentSource: "provider_card",
    seedLinkedProvider: false,
    providerOps: () =>
      makeFakeProviderOps({
        readSavedCard: async () => ({ ok: false, code: "ui_changed", message: "moved" }),
      }),
  });
  const { state } = t;
  const job = await link(t);
  expect(job).toMatchObject({ phase: "done", linked: true });
  expect(job.cardLast4).toBeUndefined();
  const account = state.providerAccounts.find((a) => a.provider === "passport")!;
  expect(account.cardBrand).toBeNull();
  expect(account.cardLast4).toBeNull();
});

test("issuing_card users never trigger the saved-card read", async () => {
  let readCalls = 0;
  const t = makeTestApp({
    // The ONE difference from the provider_card test above.
    paymentSource: "issuing_card",
    seedLinkedProvider: false,
    providerOps: () =>
      makeFakeProviderOps({
        readSavedCard: async () => {
          readCalls += 1;
          return { ok: true, brand: "Visa", last4: "4242" };
        },
      }),
  });
  const job = await link(t);
  expect(job).toMatchObject({ phase: "done", linked: true });
  expect(readCalls).toBe(0);
  expect(job.cardBrand).toBeUndefined();
});

test("unlink clears the stored display card", async () => {
  const t = makeTestApp({
    paymentSource: "provider_card",
    seedLinkedProvider: false,
    providerOps: () => makeFakeProviderOps(),
  });
  const { app, state } = t;
  await link(t);
  expect(state.providerAccounts[0]!.cardLast4).toBe("4242");
  const res = await app.inject({
    method: "POST",
    url: "/providers/passport/unlink",
    headers: HEADERS,
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  expect(state.providerAccounts[0]!.cardBrand).toBeNull();
  expect(state.providerAccounts[0]!.cardLast4).toBeNull();
});
