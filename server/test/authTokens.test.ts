/**
 * The access-token verifier, attacked directly. It is hand-rolled (one
 * algorithm, no JWT dependency), so the classic JWT mistakes — trusting
 * the header's `alg`, comparing signatures loosely, ignoring `exp` — get
 * their own tests rather than being assumed away.
 */

import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  ACCESS_TOKEN_TTL_S,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../src/services/authTokens.js";
import { MONDAY_2PM } from "./helpers.js";

const SECRET = "a-test-secret-of-at-least-32-characters";
const NOW = new Date(MONDAY_2PM);
const USER = { id: "u1", name: "Thomas", isAdmin: true };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("verifyAccessToken", () => {
  test("accepts a token it just signed, with the claims intact", () => {
    const { token, expiresAt } = signAccessToken(SECRET, USER, NOW);
    const claims = verifyAccessToken(SECRET, token, NOW);

    expect(claims).toMatchObject({ sub: "u1", name: "Thomas", admin: true });
    expect(expiresAt.getTime() - NOW.getTime()).toBe(ACCESS_TOKEN_TTL_S * 1000);
  });

  test("expires exactly at the 15-minute mark", () => {
    const { token } = signAccessToken(SECRET, USER, NOW);
    const oneSecondEarly = new Date(NOW.getTime() + (ACCESS_TOKEN_TTL_S - 1) * 1000);
    const atExpiry = new Date(NOW.getTime() + ACCESS_TOKEN_TTL_S * 1000);

    expect(verifyAccessToken(SECRET, token, oneSecondEarly)).not.toBeNull();
    expect(verifyAccessToken(SECRET, token, atExpiry)).toBeNull();
  });

  test("a different secret does not verify", () => {
    const { token } = signAccessToken(SECRET, USER, NOW);
    expect(verifyAccessToken(`${SECRET}-other`, token, NOW)).toBeNull();
  });

  /** The alg-confusion attack: a token that asks to be trusted unsigned. */
  test("rejects alg:none", () => {
    const header = b64({ alg: "none", typ: "JWT" });
    const payload = b64({ sub: "u1", name: "Thomas", admin: true, iat: 0, exp: 9_999_999_999 });
    expect(verifyAccessToken(SECRET, `${header}.${payload}.`, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, `${header}.${payload}.anything`, NOW)).toBeNull();
  });

  /** Privilege escalation by editing the payload and re-signing nothing. */
  test("rejects a tampered payload", () => {
    const { token } = signAccessToken(SECRET, { ...USER, isAdmin: false }, NOW);
    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = b64({ sub: "u1", name: "Thomas", admin: true, iat: 0, exp: 9_999_999_999 });

    expect(verifyAccessToken(SECRET, `${header}.${forged}.${signature}`, NOW)).toBeNull();
  });

  /** A signature of the right shape but the wrong content, and one of the
   * wrong length — the latter must not throw out of timingSafeEqual. */
  test("rejects wrong signatures of any length", () => {
    const { token } = signAccessToken(SECRET, USER, NOW);
    const [header, payload] = token.split(".") as [string, string];
    const wrongSameLength = createHmac("sha256", "not-the-secret")
      .update(`${header}.${payload}`)
      .digest("base64url");

    expect(verifyAccessToken(SECRET, `${header}.${payload}.${wrongSameLength}`, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, `${header}.${payload}.AAAA`, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, `${header}.${payload}.`, NOW)).toBeNull();
  });

  test.each([
    ["not a token at all", "hello"],
    ["too few segments", "a.b"],
    ["too many segments", "a.b.c.d"],
    ["garbage segments", "!!!.???.***"],
    ["empty", ""],
  ])("rejects a malformed token without throwing: %s", (_name, token) => {
    expect(verifyAccessToken(SECRET, token, NOW)).toBeNull();
  });
});

describe("refresh tokens", () => {
  test("are unguessable and never stored in the clear", () => {
    const token = generateRefreshToken();
    // 32 bytes, base64url — no padding, URL-safe.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateRefreshToken()).not.toBe(token);

    const hash = hashRefreshToken(SECRET, token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    // Peppered: the same token under a different secret is a different row,
    // so a stolen database alone can't be matched against.
    expect(hashRefreshToken(`${SECRET}-other`, token)).not.toBe(hash);
    expect(hashRefreshToken(SECRET, token)).toBe(hash);
  });
});
