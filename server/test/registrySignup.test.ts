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

/** The opening tag of the element this (simple) selector matches in the
 * fixture, or null. */
function matchedTag(selector: string, html: string): string | null {
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return new RegExp(`<[a-z]+\\b[^>]*\\bid="${id[1]}"[^>]*>`, "i").exec(html)?.[0] ?? null;
  const named = /^input\[name=['"]?([\w-]+)['"]?\]$/.exec(selector);
  if (named) {
    return new RegExp(`<input\\b[^>]*\\bname="${named[1]}"[^>]*>`, "i").exec(html)?.[0] ?? null;
  }
  throw new Error(`registry uses a selector shape this test can't check: ${selector}`);
}

/** The fields the app may type into: plain text-entry inputs. */
const TYPEABLE = new Set(["text", "email", "tel"]);

function inputType(tag: string): string | null {
  if (!/^<input\b/i.test(tag)) return null;
  return (/\btype="([^"]*)"/i.exec(tag)?.[1] ?? "text").toLowerCase();
}

describe.each(allProviders().map((p): [string, ProviderInfo] => [p.id, p]))(
  "%s signup metadata",
  (id, provider) => {
    const html = readFileSync(fixtureFor[id]!, "utf8");

    test("every prefill selector matches the sign-up fixture", () => {
      for (const { field, selector } of provider.signup.prefill) {
        expect(matchedTag(selector, html), `${field} → ${selector}`).not.toBeNull();
      }
    });

    test("every prefill selector resolves to a text, email, or tel input — nothing else", () => {
      // The contract, checked on what each selector actually HITS in the
      // page, not on how the selector is spelled: a name like "pin" or an
      // id on a checkbox would sail past a word list.
      for (const { field, selector } of provider.signup.prefill) {
        const tag = matchedTag(selector, html)!;
        expect(TYPEABLE.has(inputType(tag) ?? ""), `${field} → ${selector} hits ${tag}`).toBe(true);
      }
    });

    test("the fixture's password, checkbox, and hidden inputs are hit by no selector", () => {
      const untouchable = [...html.matchAll(/<input\b[^>]*>/gi)]
        .map((m) => m[0])
        .filter((tag) => !TYPEABLE.has(inputType(tag) ?? ""));
      for (const { selector } of provider.signup.prefill) {
        expect(untouchable).not.toContain(matchedTag(selector, html));
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
