/**
 * The /auth/* surface: Sign in with Apple and Google verified against
 * REAL RS256 signatures (test-generated keys through the same
 * verifyIdToken the server uses), email one-time codes (expiry, attempt
 * cap, per-address throttle), refresh rotation with reuse detection, and
 * verified-email account merging.
 */

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { describe, expect, test } from "vitest";

import { APPLE_ISSUER, GOOGLE_ISSUERS, verifyIdToken } from "../src/services/idToken.js";
import type { Jwk } from "../src/services/idToken.js";
import type { EmailSender } from "../src/services/emailer.js";
import { MONDAY_2PM, makeTestApp } from "./helpers.js";

const AUDIENCE = "com.thomasbardhi.parkagent";
const DEVICE = "device-abcdef1234";

// One RSA pair for the whole file — signing is the slow part.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey: strangerPublic, privateKey: strangerPrivate } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
void strangerPublic;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

function jwkFor(key: KeyObject, kid: string): Jwk {
  return { ...(key.export({ format: "jwk" }) as { kty: string; n: string; e: string }), kid };
}

function signIdToken(
  claims: Record<string, unknown>,
  { kid = "k1", key = privateKey }: { kid?: string; key?: KeyObject } = {},
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    key,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const baseNow = new Date(MONDAY_2PM).getTime();

function appleClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: APPLE_ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(baseNow / 1000) + 3600,
    sub: "apple-sub-1",
    email: "thomas@example.com",
    email_verified: "true",
    ...overrides,
  };
}

/** A test app with real signature verification and a mutable clock. */
function makeAuthApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const clock = { ms: baseNow };
  const now = () => new Date(clock.ms);
  const sentCodes: { to: string; code: string }[] = [];
  const emailSender: EmailSender = {
    sendLoginCode: async (to, code) => {
      sentCodes.push({ to, code });
      return { ok: true };
    },
  };
  const fetchKeys = async () => ({ keys: [jwkFor(publicKey, "k1")] });
  const harness = makeTestApp({
    now,
    ...options,
    auth: {
      emailSender,
      verifyAppleToken: (token, at) =>
        verifyIdToken({ token, issuers: [APPLE_ISSUER], audience: AUDIENCE, fetchKeys, now: at }),
      ...options.auth,
    },
  });
  return { ...harness, clock, sentCodes };
}

const post = (
  app: ReturnType<typeof makeTestApp>["app"],
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) => app.inject({ method: "POST", url, payload: payload as object, headers });

describe("POST /auth/apple", () => {
  test("valid identity token creates a user and a working session", async () => {
    const { app, state } = makeAuthApp();
    const res = await post(app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
      fullName: { givenName: "Thomas", familyName: "B" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.user.email).toBe("thomas@example.com");
    expect(body.user.name).toBe("Thomas B");
    expect(body.user.appleLinked).toBe(true);
    expect(body.refreshToken).toEqual(expect.any(String));

    const created = state.users.find((u) => u.appleSub === "apple-sub-1");
    expect(created?.emailVerified).toBe(true);

    // The access token is a real credential on protected routes.
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("thomas@example.com");
  });

  test("second sign-in with the same subject lands on the same user", async () => {
    const { app, state } = makeAuthApp();
    await post(app, "/auth/apple", { identityToken: signIdToken(appleClaims()), deviceId: DEVICE });
    const res = await post(app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    expect(res.json().created).toBe(false);
    expect(state.users.filter((u) => u.appleSub === "apple-sub-1")).toHaveLength(1);
  });

  test("verified-email match merges onto the existing account", async () => {
    const { app, state } = makeAuthApp();
    // u1 (Thomas) already owns this verified address (attach-identity).
    const u1 = state.users.find((u) => u.id === "u1")!;
    u1.email = "thomas@example.com";
    u1.emailVerified = true;

    const res = await post(app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe("u1");
    expect(u1.appleSub).toBe("apple-sub-1");
    // No second account appeared.
    expect(state.users.filter((u) => u.email === "thomas@example.com")).toHaveLength(1);
  });

  test("private-relay email is stored like any other", async () => {
    const { app, state } = makeAuthApp();
    const res = await post(app, "/auth/apple", {
      identityToken: signIdToken(
        appleClaims({ email: "abc123@privaterelay.appleid.com", is_private_email: "true" }),
      ),
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    expect(state.users.at(-1)?.email).toBe("abc123@privaterelay.appleid.com");
  });

  test.each([
    ["wrong audience", appleClaims({ aud: "com.someone.else" }), {}],
    ["expired", appleClaims({ exp: Math.floor(baseNow / 1000) - 10 }), {}],
    ["unknown key", appleClaims(), { kid: "k9" }],
    ["forged signature", appleClaims(), { key: strangerPrivate }],
  ])("rejects a defective token: %s", async (_name, claims, signing) => {
    const { app, state } = makeAuthApp();
    const res = await post(app, "/auth/apple", {
      identityToken: signIdToken(claims as Record<string, unknown>, signing),
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_identity_token");
    expect(state.users).toHaveLength(2); // only the seeds
  });
});

describe("POST /auth/google", () => {
  const googleClaims = (overrides: Record<string, unknown> = {}) => ({
    iss: GOOGLE_ISSUERS[0],
    aud: "google-client-id.apps.googleusercontent.com",
    exp: Math.floor(baseNow / 1000) + 3600,
    sub: "google-sub-1",
    email: "ana@example.com",
    email_verified: true,
    name: "Ana Driver",
    ...overrides,
  });

  test("disabled by default → 403", async () => {
    const { app } = makeAuthApp();
    const res = await post(app, "/auth/google", {
      idToken: signIdToken(googleClaims()),
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("google_signin_disabled");
  });

  test("enabled: verifies the signature and signs the user in", async () => {
    const fetchKeys = async () => ({ keys: [jwkFor(publicKey, "k1")] });
    const { app, state } = makeAuthApp({
      auth: {
        verifyGoogleToken: (token, at) =>
          verifyIdToken({
            token,
            issuers: [...GOOGLE_ISSUERS],
            audience: "google-client-id.apps.googleusercontent.com",
            fetchKeys,
            now: at,
          }),
      },
    });
    const res = await post(app, "/auth/google", {
      idToken: signIdToken(googleClaims()),
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.googleLinked).toBe(true);
    expect(state.users.at(-1)?.googleSub).toBe("google-sub-1");

    const forged = await post(app, "/auth/google", {
      idToken: signIdToken(googleClaims(), { key: strangerPrivate }),
      deviceId: DEVICE,
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe("email one-time codes", () => {
  test("start mails a 6-digit code; verify signs in and reuses the account", async () => {
    const { app, sentCodes, state } = makeAuthApp();
    const start = await post(app, "/auth/email/start", { email: "Driver@Example.com" });
    expect(start.statusCode).toBe(200);
    expect(sentCodes).toHaveLength(1);
    expect(sentCodes[0]!.to).toBe("driver@example.com");
    expect(sentCodes[0]!.code).toMatch(/^\d{6}$/);

    const verify = await post(app, "/auth/email/verify", {
      email: "driver@example.com",
      code: sentCodes[0]!.code,
      deviceId: DEVICE,
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().created).toBe(true);
    expect(verify.json().user.emailVerified).toBe(true);

    // Round two: same mailbox → same account.
    await post(app, "/auth/email/start", { email: "driver@example.com" });
    const second = await post(app, "/auth/email/verify", {
      email: "driver@example.com",
      code: sentCodes[1]!.code,
      deviceId: DEVICE,
    });
    expect(second.json().created).toBe(false);
    expect(state.users.filter((u) => u.email === "driver@example.com")).toHaveLength(1);
  });

  test("a code expires after 10 minutes", async () => {
    const { app, clock, sentCodes } = makeAuthApp();
    await post(app, "/auth/email/start", { email: "late@example.com" });
    clock.ms += 11 * 60_000;
    const res = await post(app, "/auth/email/verify", {
      email: "late@example.com",
      code: sentCodes[0]!.code,
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("code_expired");
  });

  test("five wrong guesses burn the code — the right one no longer works", async () => {
    const { app, sentCodes } = makeAuthApp();
    await post(app, "/auth/email/start", { email: "guess@example.com" });
    const wrong = sentCodes[0]!.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i += 1) {
      const res = await post(app, "/auth/email/verify", {
        email: "guess@example.com",
        code: wrong,
        deviceId: DEVICE,
      });
      expect(res.statusCode).toBe(401);
    }
    const right = await post(app, "/auth/email/verify", {
      email: "guess@example.com",
      code: sentCodes[0]!.code,
      deviceId: DEVICE,
    });
    expect(right.statusCode).toBe(401);
    expect(right.json().error).toBe("too_many_attempts");
  });

  test("per-address throttle: the sixth code in the window refuses", async () => {
    const { app, sentCodes } = makeAuthApp();
    for (let i = 0; i < 5; i += 1) {
      const res = await post(app, "/auth/email/start", { email: "noisy@example.com" });
      expect(res.statusCode).toBe(200);
    }
    const res = await post(app, "/auth/email/start", { email: "noisy@example.com" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("email_rate_limited");
    expect(sentCodes).toHaveLength(5);
  });

  test("without a configured sender, start answers 503", async () => {
    const { app } = makeAuthApp({ auth: { emailSender: undefined } });
    const res = await post(app, "/auth/email/start", { email: "a@b.co" });
    expect(res.statusCode).toBe(503);
  });
});

describe("refresh rotation", () => {
  async function signedIn(harness: ReturnType<typeof makeAuthApp>) {
    const res = await post(harness.app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    return res.json() as { accessToken: string; refreshToken: string };
  }

  test("rotation issues a fresh pair; the old token is retired", async () => {
    const harness = makeAuthApp();
    const first = await signedIn(harness);
    const rotated = await post(harness.app, "/auth/refresh", {
      refreshToken: first.refreshToken,
      deviceId: DEVICE,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refreshToken).not.toBe(first.refreshToken);

    // Replaying the retired token is reuse: the WHOLE family dies,
    // including the fresh token that rotation just issued.
    const replay = await post(harness.app, "/auth/refresh", {
      refreshToken: first.refreshToken,
      deviceId: DEVICE,
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("token_reused");

    const descendant = await post(harness.app, "/auth/refresh", {
      refreshToken: rotated.json().refreshToken,
      deviceId: DEVICE,
    });
    expect(descendant.statusCode).toBe(401);
  });

  test("a refresh token is bound to its device id", async () => {
    const harness = makeAuthApp();
    const first = await signedIn(harness);
    const res = await post(harness.app, "/auth/refresh", {
      refreshToken: first.refreshToken,
      deviceId: "some-other-device",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("device_mismatch");
  });

  test("the 60-day sliding expiry ends a dormant session", async () => {
    const harness = makeAuthApp();
    const first = await signedIn(harness);
    harness.clock.ms += 61 * 24 * 60 * 60 * 1000;
    const res = await post(harness.app, "/auth/refresh", {
      refreshToken: first.refreshToken,
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("token_expired");
  });

  test("logout revokes the family", async () => {
    const harness = makeAuthApp();
    const first = await signedIn(harness);
    const out = await post(harness.app, "/auth/logout", { refreshToken: first.refreshToken });
    expect(out.statusCode).toBe(200);
    const res = await post(harness.app, "/auth/refresh", {
      refreshToken: first.refreshToken,
      deviceId: DEVICE,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("account deletion", () => {
  test("DELETE /me tears down and tombstones; the tokens stop working", async () => {
    const harness = makeAuthApp();
    const signIn = await post(harness.app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    const { accessToken, refreshToken, user } = signIn.json();
    const bearer = { authorization: `Bearer ${accessToken}` };
    const { state } = harness;

    // Give the account things to tear down.
    state.deviceTokens.push({
      id: "dt1",
      userId: user.id,
      token: "tok",
      platform: "ios",
      environment: "development",
    });
    state.conversations.push({ id: "conv1", userId: user.id, turns: [] });
    state.vehicles.push({
      id: "v1",
      userId: user.id,
      plate: "ABC123",
      state: "MA",
      label: null,
      createdAt: new Date(MONDAY_2PM),
    });
    state.providerAccounts.push({
      id: "pa9",
      userId: user.id,
      provider: "passport",
      status: "linked",
      stateEncrypted: "sealed",
      linkedAt: new Date(MONDAY_2PM),
      lastVerifiedAt: new Date(MONDAY_2PM),
      cardAdded: false,
      walletBalanceCents: null,
      createdAt: new Date(MONDAY_2PM),
    });

    const res = await harness.app.inject({ method: "DELETE", url: "/me", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, deleted: true });

    const row = state.users.find((u) => u.id === user.id)!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toBeNull();
    expect(row.appleSub).toBeNull();
    expect(row.name).toBe("Deleted account");
    expect(state.deviceTokens.filter((t) => t.userId === user.id)).toHaveLength(0);
    expect(state.conversations.filter((c) => c.userId === user.id)).toHaveLength(0);
    expect(state.vehicles.filter((v) => v.userId === user.id)).toHaveLength(0);
    const account = state.providerAccounts.find((a) => a.id === "pa9")!;
    expect(account.status).toBe("unlinked");
    expect(account.stateEncrypted).toBeNull();
    expect(state.decisions.some((d) => d.kind === "account_delete")).toBe(true);

    // The still-valid JWT dies with the account; so does the refresh.
    const me = await harness.app.inject({ method: "GET", url: "/me", headers: bearer });
    expect(me.statusCode).toBe(401);
    const refreshed = await post(harness.app, "/auth/refresh", { refreshToken, deviceId: DEVICE });
    expect(refreshed.statusCode).toBe(401);

    // And the identity is free again: a new sign-in makes a NEW account.
    const again = await post(harness.app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().user.id).not.toBe(user.id);
  });
});
