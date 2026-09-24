/**
 * Boot configuration for sign-in: Apple only by default, and the server
 * must come up without any email or Google settings. A method switched on
 * without what it needs refuses boot instead of failing its first user.
 */

import { expect, test } from "vitest";

import { parseEnv } from "../src/env.js";

/** What a deployment must have — and no Resend or Google settings at all. */
const MINIMAL = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  DRY_RUN: "true",
  API_KEY_PEPPER: "pepper-pepper-pepper",
  SOCRATA_APP_TOKEN: "token",
  AUTH_JWT_SECRET: "x".repeat(32),
};

const issues = (source: Record<string, string>) => {
  const parsed = parseEnv(source);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
};

test("boots with no RESEND_API_KEY and no Google settings; email and Google default off", () => {
  const parsed = parseEnv(MINIMAL);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.EMAIL_SIGNIN_ENABLED).toBe("false");
  expect(parsed.data?.GOOGLE_SIGNIN_ENABLED).toBe("false");
  expect(parsed.data?.RESEND_API_KEY).toBeUndefined();
  expect(parsed.data?.GOOGLE_CLIENT_ID).toBeUndefined();
});

test("a Resend key alone doesn't switch email sign-in on", () => {
  const parsed = parseEnv({ ...MINIMAL, RESEND_API_KEY: "re_x" });
  expect(parsed.success).toBe(true);
  expect(parsed.data?.EMAIL_SIGNIN_ENABLED).toBe("false");
});

test("email switched on without a Resend key refuses boot", () => {
  expect(issues({ ...MINIMAL, EMAIL_SIGNIN_ENABLED: "true" })).toContain("RESEND_API_KEY");
  expect(issues({ ...MINIMAL, EMAIL_SIGNIN_ENABLED: "true", RESEND_API_KEY: "re_x" })).toEqual([]);
});

test("Google switched on without a client id refuses boot", () => {
  expect(issues({ ...MINIMAL, GOOGLE_SIGNIN_ENABLED: "true" })).toContain("GOOGLE_CLIENT_ID");
  expect(
    issues({
      ...MINIMAL,
      GOOGLE_SIGNIN_ENABLED: "true",
      GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
    }),
  ).toEqual([]);
});
