import { expect, test } from "vitest";

import { apiKeyPrefix, generateApiKey, hashApiKey } from "../src/services/apiKeys.js";
import { API_KEY, TEST_PEPPER, makeTestApp } from "./helpers.js";

test("hash is deterministic per (pepper, key) and pepper-sensitive", () => {
  const key = "abc123def456";
  expect(hashApiKey(TEST_PEPPER, key)).toBe(hashApiKey(TEST_PEPPER, key));
  expect(hashApiKey(TEST_PEPPER, key)).toMatch(/^[0-9a-f]{64}$/);
  expect(hashApiKey("other-pepper-16-chars", key)).not.toBe(hashApiKey(TEST_PEPPER, key));
  expect(hashApiKey(TEST_PEPPER, "abc123def457")).not.toBe(hashApiKey(TEST_PEPPER, key));
});

test("generated keys keep the historical shape; prefix identifies, never authenticates", () => {
  const key = generateApiKey();
  expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(apiKeyPrefix(key)).toBe(key.slice(0, 8));
});

test("auth accepts the key whose hash is stored, rejects hash and prefix as keys", async () => {
  const { app } = makeTestApp({});
  const attempt = (key: string) =>
    app.inject({ method: "GET", url: "/policy", headers: { "x-api-key": key } });

  expect((await attempt(API_KEY)).statusCode).toBe(200);
  // Someone holding a DB dump has the hash and a truncation of the key —
  // neither works. (The fixture key is only 8 chars, so its full prefix
  // IS the key; a truncation stands in for the stored prefix here.)
  expect((await attempt(hashApiKey(TEST_PEPPER, API_KEY))).statusCode).toBe(401);
  expect((await attempt(API_KEY.slice(0, 4))).statusCode).toBe(401);
});
