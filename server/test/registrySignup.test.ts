/**
 * Link-or-create prefill metadata vs the recorded/drafted sign-up pages.
 * The registry's selectors and the fixture HTML must describe the same
 * page: when a live recording updates one, this test forces the other to
 * follow. Selector matching is deliberately dumb (ids and [name=…]) — the
 * app's web view injects by CSS selector, so the attribute existing in the
 * markup is the contract.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { allProviders } from "../src/providers/registry.js";
import type { ProviderInfo } from "../src/providers/registry.js";

const fixtureFor: Record<string, string> = {
  passport: "test/fixtures/signup/passport-entry.html",
  parknyc: "test/fixtures/signup/parknyc-registration.html",
};

/** Does the fixture contain an element this (simple) selector matches? */
function selectorInHtml(selector: string, html: string): boolean {
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return new RegExp(`id="${id[1]}"`).test(html);
  const named = /^input\[name=['"]?([\w-]+)['"]?\]$/.exec(selector);
  if (named) return new RegExp(`<input[^>]*name="${named[1]}"`).test(html);
  throw new Error(`registry uses a selector shape this test can't check: ${selector}`);
}

describe.each(allProviders().map((p): [string, ProviderInfo] => [p.id, p]))(
  "%s signup metadata",
  (id, provider) => {
    const html = readFileSync(fixtureFor[id]!, "utf8");

    test("every prefill selector matches the sign-up fixture", () => {
      for (const { field, selector } of provider.signup.prefill) {
        expect(selectorInHtml(selector, html), `${field} → ${selector}`).toBe(true);
      }
    });

    test("prefill never touches checkboxes, passwords, or captcha", () => {
      // The contract: text inputs only. Assert none of the selectors name
      // the fixture's password/terms/captcha elements.
      for (const { selector } of provider.signup.prefill) {
        expect(selector).not.toMatch(/password|terms|captcha|accept/i);
      }
    });

    test("the sign-up URL is https on a registered session domain", () => {
      expect(provider.signup.url).toMatch(/^https:\/\//);
      const host = new URL(provider.signup.url).hostname;
      expect(
        provider.cookieDomains.some((d) => host === d || host.endsWith(`.${d}`)),
        `${host} not under ${provider.cookieDomains.join(", ")}`,
      ).toBe(true);
    });
  },
);

test("passport signup is the passwordless entry screen with one prefill field", () => {
  const passport = allProviders().find((p) => p.id === "passport")!;
  expect(passport.signup.mode).toBe("passwordless");
  expect(passport.signup.prefill).toEqual([{ field: "emailOrPhone", selector: "#regEmail" }]);
  // Sign-in and sign-up are the same screen — the note must say so plainly.
  expect(passport.signup.note.toLowerCase()).toContain("password");
});

test("parknyc signup prefills the registration form fields", () => {
  const parknyc = allProviders().find((p) => p.id === "parknyc")!;
  expect(parknyc.signup.mode).toBe("form");
  expect(parknyc.signup.prefill.map((p) => p.field)).toEqual([
    "firstName",
    "lastName",
    "email",
    "phone",
    "zip",
    "plate",
  ]);
});
