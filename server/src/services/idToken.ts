/**
 * RS256 ID-token verification shared by Sign in with Apple and Google
 * Sign-In: fetch the issuer's JWKS, check the signature against the key the
 * token names, then the issuer/audience/expiry claims. The key fetcher is
 * injectable so tests verify real signatures against their own generated
 * RSA keys instead of the network.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface Jwk {
  kty: string;
  kid: string;
  alg?: string;
  n?: string;
  e?: string;
}

export type JwksFetcher = (options?: { force?: boolean }) => Promise<{ keys: Jwk[] }>;

/** Keys are cached for an hour. */
export const JWKS_CACHE_MS = 60 * 60 * 1000;
/** A forced refetch (a token named a kid the cache doesn't know — the
 * issuer rotated keys) waits at least this long after the last fetch, so
 * tokens with made-up kids can't turn every sign-in into a JWKS request. */
export const JWKS_MIN_REFETCH_MS = 60 * 1000;

/** Fetch-backed JWKS source: a 1-hour cache, a real forced refetch on an
 * unknown kid (it used to hand back the same cache, so an Apple key
 * rotation failed every sign-in for up to an hour), one fetch in flight at
 * a time, and a timeout — an issuer that hangs mustn't hang sign-in. */
export function makeJwksFetcher(
  url: string,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): JwksFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { keys: Jwk[]; at: number } | null = null;
  let inFlight: Promise<{ keys: Jwk[] }> | null = null;

  const refetch = (): Promise<{ keys: Jwk[] }> => {
    inFlight ??= (async () => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
        const body = (await response.json()) as { keys: Jwk[] };
        cached = { keys: body.keys, at: now() };
        return { keys: body.keys };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return async ({ force = false } = {}) => {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < JWKS_CACHE_MS && !(force && age >= JWKS_MIN_REFETCH_MS)) {
      return { keys: cached.keys };
    }
    return refetch();
  };
}

export interface VerifiedIdToken {
  sub: string;
  email?: string;
  emailVerified: boolean;
  /** Apple's is_private_email: the address is a @privaterelay.appleid.com
   * forward. Stored like any other verified address — it is unique and
   * deliverable (once the sending domain is registered with the relay). */
  isPrivateEmail: boolean;
  /** Google's given/family name claims, when present. */
  name?: string;
}

export type IdTokenError =
  "malformed" | "unknown_key" | "bad_signature" | "wrong_issuer" | "wrong_audience" | "expired";

export type IdTokenResult =
  { ok: true; token: VerifiedIdToken } | { ok: false; code: IdTokenError };

interface RawClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  given_name?: string;
  family_name?: string;
  name?: string;
}

function decodeSegment<T>(segment: string): T | null {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

const truthy = (v: boolean | string | undefined): boolean => v === true || v === "true";

export async function verifyIdToken(args: {
  token: string;
  /** Accepted `iss` values (Google uses two spellings). */
  issuers: string[];
  audience: string;
  fetchKeys: JwksFetcher;
  now: Date;
}): Promise<IdTokenResult> {
  const parts = args.token.split(".");
  if (parts.length !== 3) return { ok: false, code: "malformed" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeSegment<{ alg?: string; kid?: string }>(headerB64);
  const claims = decodeSegment<RawClaims>(payloadB64);
  if (!header || !claims || header.alg !== "RS256" || !header.kid) {
    return { ok: false, code: "malformed" };
  }

  let jwks = await args.fetchKeys();
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // The issuer may have rotated keys since the cache filled.
    jwks = await args.fetchKeys({ force: true });
    jwk = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return { ok: false, code: "unknown_key" };

  let signatureOk: boolean;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    signatureOk = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    // A malformed key or signature is a failed verification, not a crash.
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, code: "bad_signature" };

  if (!claims.iss || !args.issuers.includes(claims.iss)) return { ok: false, code: "wrong_issuer" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(args.audience)) return { ok: false, code: "wrong_audience" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= args.now.getTime()) {
    return { ok: false, code: "expired" };
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { ok: false, code: "malformed" };
  }

  const name =
    claims.name ?? ([claims.given_name, claims.family_name].filter(Boolean).join(" ") || undefined);
  return {
    ok: true,
    token: {
      sub: claims.sub,
      ...(claims.email ? { email: claims.email.toLowerCase() } : {}),
      emailVerified: truthy(claims.email_verified),
      isPrivateEmail: truthy(claims.is_private_email),
      ...(name ? { name } : {}),
    },
  };
}

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
