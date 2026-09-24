/**
 * provider_card display info at link time: linking reads the brand/last4
 * off the provider's Your Cards screen (best effort), stores it, and
 * /providers/status serves it for the Account sheet's masked-card row.
 * issuing_card users never trigger the read — their card is ours.
 */

import { expect, test } from "vitest";

import { API_KEY, makeFakeProviderOps, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };

const COOKIES = [
  { name: "session", value: "abc", domain: ".ppprk.com", path: "/" },
];

function link(app: ReturnType<typeof makeTestApp>["app"]) {
  return app.inject({
    method: "POST",
    url: "/providers/passport/link",
    headers: HEADERS,
    payload: { cookies: COOKIES, set_up_card: false },
  });
}

test("provider_card link stores and serves the saved card's brand/last4", async () => {
  const { app, state } = makeTestApp({
    paymentSource: "provider_card",
    seedLinkedProvider: false,
    providerOps: () =>
      makeFakeProviderOps({
        readSavedCard: async () => ({ ok: true, brand: "Mastercard", last4: "7788" }),
      }),
  });
  const res = await link(app);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ cardBrand: "Mastercard", cardLast4: "7788" });

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
  const { app, state } = makeTestApp({
    paymentSource: "provider_card",
    seedLinkedProvider: false,
    providerOps: () =>
      makeFakeProviderOps({
        readSavedCard: async () => ({ ok: false, code: "ui_changed", message: "moved" }),
      }),
  });
  const res = await link(app);
  expect(res.statusCode).toBe(200);
  expect(res.json().status).toBe("linked");
  const account = state.providerAccounts.find((a) => a.provider === "passport")!;
  expect(account.cardBrand).toBeNull();
  expect(account.cardLast4).toBeNull();
});

test("issuing_card users never trigger the saved-card read", async () => {
  let readCalls = 0;
  const { app } = makeTestApp({
    paymentSource: "issuing_card",
    seedLinkedProvider: false,
    stripe: undefined,
    providerOps: () =>
      makeFakeProviderOps({
        readSavedCard: async () => {
          readCalls += 1;
          return { ok: true, brand: "Visa", last4: "4242" };
        },
      }),
  });
  const res = await app.inject({
    method: "POST",
    url: "/providers/passport/link",
    headers: HEADERS,
    payload: { cookies: COOKIES, set_up_card: false },
  });
  expect(res.statusCode).toBe(200);
  expect(readCalls).toBe(0);
  expect(res.json().cardBrand).toBeNull();
});

test("unlink clears the stored display card", async () => {
  const { app, state } = makeTestApp({
    paymentSource: "provider_card",
    seedLinkedProvider: false,
    providerOps: () => makeFakeProviderOps(),
  });
  await link(app);
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
