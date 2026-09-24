/**
 * Access + refresh token primitives. Access tokens are compact HS256 JWTs
 * signed with AUTH_JWT_SECRET (node:crypto — no JWT dependency for one
 * algorithm); refresh tokens are opaque CSPRNG strings stored only as
 * SHA-256(secret:token), so a DB dump can't mint sessions. Rotation and
 * reuse detection live in services/authService.ts.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Access tokens live 15 minutes; the app silently refreshes on 401. */
export const ACCESS_TOKEN_TTL_S = 15 * 60;
/** Sliding refresh expiry: 60 days from the last rotation. */
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  /** users.id */
  sub: string;
  name: string;
  admin: boolean;
  iat: number;
  exp: number;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

function hmac(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

export function signAccessToken(
  secret: string,
  user: { id: string; name: string; isAdmin: boolean },
  now: Date,
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: AccessClaims = {
    sub: user.id,
    name: user.name,
    admin: user.isAdmin,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_S,
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = hmac(secret, `${header}.${payload}`).toString("base64url");
  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date(claims.exp * 1000),
  };
}

/** null on any defect: wrong shape, wrong alg, bad signature, expired. */
export function verifyAccessToken(secret: string, token: string, now: Date): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString()) as {
      alg?: string;
    };
    // Pinned algorithm: a token claiming "none" or an RS* alg is invalid.
    if (parsedHeader.alg !== "HS256") return null;
    const expected = hmac(secret, `${header}.${payload}`);
    const got = Buffer.from(signature, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as AccessClaims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** 256 bits from the CSPRNG — the plaintext lives only on the phone. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** At-rest form; the secret peppers it like API keys are peppered. */
export function hashRefreshToken(secret: string, token: string): string {
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}
