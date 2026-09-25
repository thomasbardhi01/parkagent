/**
 * Sign in with Apple's REST side: the refresh token behind a sign-in, and
 * revoking it when the account is deleted (App Store Review 5.1.1(v): an
 * app that offers Sign in with Apple must revoke the user's tokens on
 * account deletion, so the app drops off Settings → Apple ID → Sign in
 * with Apple).
 *
 * - At sign-in the app forwards Apple's one-time `authorizationCode`; the
 *   server exchanges it at /auth/token for a refresh token, which is
 *   stored SEALED (users.apple_refresh_token_sealed, AES-256-GCM under
 *   PROVIDER_STATE_KEY). Never logged, never returned.
 * - At DELETE /me the token is revoked at /auth/revoke. A failure never
 *   blocks the delete: the sealed token stays on the tombstone and the
 *   hourly job (jobs/appleRevocationTick.ts) retries until Apple accepts.
 *
 * Both calls authenticate with a client secret: an ES256 JWT signed with
 * a Sign in with Apple key (APPLE_SIGNIN_KEY / _KEY_ID / _TEAM_ID), `sub`
 * the app's bundle id (APPLE_AUDIENCE). Without that key group nothing
 * here runs and sign-in works exactly as before.
 */

import { createPrivateKey, sign } from "node:crypto";

export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

export interface AppleSignInConfig {
  /** Contents of the .p8 key ("\n" escapes accepted for env transport). */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id — the identity token's audience. */
  clientId: string;
}

export type AppleExchangeResult =
  { ok: true; refreshToken: string; sub: string | null } | { ok: false; error: string };

export type AppleRevokeResult = { ok: true } | { ok: false; error: string };

export interface AppleTokenClient {
  /** Trade a sign-in's one-time authorization code for a refresh token. */
  exchangeCode(code: string): Promise<AppleExchangeResult>;
  /** Revoke a refresh token (and the grant behind it). */
  revoke(refreshToken: string): Promise<AppleRevokeResult>;
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 8_000;

/** The client secret Apple's token endpoints want: a short-lived ES256 JWT
 * (Apple allows up to six months; five minutes is plenty per call). */
export function makeAppleClientSecret(config: AppleSignInConfig, nowMs: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const iat = Math.floor(nowMs / 1000);
  const unsigned =
    b64({ alg: "ES256", kid: config.keyId }) +
    "." +
    b64({
      iss: config.teamId,
      iat,
      exp: iat + 5 * 60,
      aud: "https://appleid.apple.com",
      sub: config.clientId,
    });
  const key = createPrivateKey(config.key.replace(/\\n/g, "\n"));
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return unsigned + "." + signature.toString("base64url");
}

/** `sub` from an id_token Apple returned to us directly over TLS — read,
 * not re-verified; it's only compared against the identity token the
 * sign-in already verified. */
function subOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

export function makeAppleTokenClient(
  config: AppleSignInConfig,
  fetchImpl: Fetch = fetch as unknown as Fetch,
  now: () => Date = () => new Date(),
): AppleTokenClient {
  const post = async (url: string, form: Record<string, string>) => {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: makeAppleClientSecret(config, now().getTime()),
      ...form,
    }).toString();
    return fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
  // Apple answers errors as {"error": "invalid_grant"} etc.; keep the code,
  // never the body (it can echo what we sent).
  const errorOf = async (res: { status: number; text(): Promise<string> }) => {
    try {
      const parsed = JSON.parse(await res.text()) as { error?: unknown };
      return typeof parsed.error === "string" ? parsed.error : `http_${res.status}`;
    } catch {
      return `http_${res.status}`;
    }
  };

  return {
    async exchangeCode(code) {
      try {
        const res = await post(APPLE_TOKEN_URL, { code, grant_type: "authorization_code" });
        if (!res.ok) return { ok: false, error: await errorOf(res) };
        const json = JSON.parse(await res.text()) as {
          refresh_token?: unknown;
          id_token?: unknown;
        };
        if (typeof json.refresh_token !== "string" || !json.refresh_token) {
          return { ok: false, error: "no_refresh_token" };
        }
        return { ok: true, refreshToken: json.refresh_token, sub: subOf(json.id_token) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.name : "network" };
      }
    },
    async revoke(refreshToken) {
      try {
        const res = await post(APPLE_REVOKE_URL, {
          token: refreshToken,
          token_type_hint: "refresh_token",
        });
        return res.ok ? { ok: true } : { ok: false, error: await errorOf(res) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.name : "network" };
      }
    },
  };
}
