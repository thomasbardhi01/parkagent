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
import {
  issueSession,
  rotateRefreshToken,
  startEmailLogin,
  verifyEmailLogin,
} from "../src/services/authService.js";
import {
  MONDAY_2PM,
  TEST_JWT_SECRET,
  makeFakeDb,
  makeFakeGateway,
  makeTestApp,
} from "./helpers.js";

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
  const signature = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString(
    "base64url",
  );
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

describe("GET /auth/methods", () => {
  test("Apple only by default — email and Google are off until switched on", async () => {
    // makeTestApp wires no email sender and no Google verifier, exactly
    // like a deployment without EMAIL_SIGNIN_ENABLED / GOOGLE_SIGNIN_ENABLED.
    const { app } = makeTestApp({});
    const res = await app.inject({ method: "GET", url: "/auth/methods" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apple: true, email: false, google: false });
  });

  test("reports each method the deployment wired, and needs no credential", async () => {
    const { app } = makeAuthApp({
      auth: { verifyGoogleToken: async () => ({ ok: false, code: "bad_signature" }) },
    });
    const res = await app.inject({ method: "GET", url: "/auth/methods" });
    expect(res.json()).toEqual({ apple: true, email: true, google: true });
  });

  test("what it reports matches what the routes do", async () => {
    const { app } = makeTestApp({});
    const methods = (await app.inject({ method: "GET", url: "/auth/methods" })).json();
    expect(methods.email).toBe(false);
    expect(methods.google).toBe(false);
    const email = await post(app, "/auth/email/start", { email: "a@b.co" });
    const google = await post(app, "/auth/google", { idToken: "x", deviceId: DEVICE });
    expect([email.json().error, google.json().error]).toEqual([
      "email_signin_disabled",
      "google_signin_disabled",
    ]);
  });
});

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

  function googleApp() {
    const fetchKeys = async () => ({ keys: [jwkFor(publicKey, "k1")] });
    return makeAuthApp({
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
  }

  test("an UNVERIFIED IdP email is never stored — it can't squat the owner's address", async () => {
    const harness = googleApp();
    // The squatter: a Google token claiming the victim's address, unverified.
    const squat = await post(harness.app, "/auth/google", {
      idToken: signIdToken(
        googleClaims({ sub: "squatter", email: "victim@example.com", email_verified: false }),
      ),
      deviceId: DEVICE,
    });
    expect(squat.statusCode).toBe(200);
    const squatter = harness.state.users.find((u) => u.googleSub === "squatter")!;
    expect(squatter.email).toBeNull();

    // The owner proves the mailbox by code: their OWN new account, not the
    // squatter's (which would hand them a stranger's cars and links, and
    // leave the stranger signed in to whatever they add).
    await post(harness.app, "/auth/email/start", { email: "victim@example.com" });
    const owner = await post(harness.app, "/auth/email/verify", {
      email: "victim@example.com",
      code: harness.sentCodes.at(-1)!.code,
      deviceId: DEVICE,
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().created).toBe(true);
    expect(owner.json().user.id).not.toBe(squatter.id);

    // And the owner's verified Apple sign-in with that address lands there
    // too — it used to collide on the unique email index and 500 forever.
    const apple = await post(harness.app, "/auth/apple", {
      identityToken: signIdToken(appleClaims({ sub: "owner-apple", email: "victim@example.com" })),
      deviceId: DEVICE,
    });
    expect(apple.statusCode).toBe(200);
    expect(apple.json().user.id).toBe(owner.json().user.id);
  });

  test("an account already holding an address unverified gives it up to the prover", async () => {
    const harness = googleApp();
    // Backstop for rows that predate the rule above.
    harness.state.users.push({
      ...harness.state.users[1]!,
      id: "u-squat",
      name: "Squatter",
      email: "legacy@example.com",
      emailVerified: false,
    });
    await post(harness.app, "/auth/email/start", { email: "legacy@example.com" });
    const owner = await post(harness.app, "/auth/email/verify", {
      email: "legacy@example.com",
      code: harness.sentCodes.at(-1)!.code,
      deviceId: DEVICE,
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().user.id).not.toBe("u-squat");
    expect(harness.state.users.find((u) => u.id === "u-squat")!.email).toBeNull();
  });

  test("a merge never replaces a different subject already on the account", async () => {
    const harness = googleApp();
    const first = await post(harness.app, "/auth/google", {
      idToken: signIdToken(googleClaims({ sub: "google-A", email: "pat@example.com" })),
      deviceId: DEVICE,
    });
    const second = await post(harness.app, "/auth/google", {
      idToken: signIdToken(googleClaims({ sub: "google-B", email: "pat@example.com" })),
      deviceId: DEVICE,
    });
    // The verified address lets B in, as an email code would…
    expect(second.json().user.id).toBe(first.json().user.id);
    // …but A's link stays put instead of flipping to B (and back, forever).
    const row = harness.state.users.find((u) => u.id === first.json().user.id)!;
    expect(row.googleSub).toBe("google-A");
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
    // Exactly five: four ordinary misses, and the fifth is told it's over.
    // (A cap of 1, or of 50, would fail here.)
    const errors: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await post(app, "/auth/email/verify", {
        email: "guess@example.com",
        code: wrong,
        deviceId: DEVICE,
      });
      expect(res.statusCode).toBe(401);
      errors.push(res.json().error);
    }
    expect(errors).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
    ]);
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

  test("four misses, then the right code still works — the cap is five, not fewer", async () => {
    const { app, sentCodes } = makeAuthApp();
    await post(app, "/auth/email/start", { email: "typo@example.com" });
    const wrong = sentCodes[0]!.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 4; i += 1) {
      await post(app, "/auth/email/verify", {
        email: "typo@example.com",
        code: wrong,
        deviceId: DEVICE,
      });
    }
    const right = await post(app, "/auth/email/verify", {
      email: "typo@example.com",
      code: sentCodes[0]!.code,
      deviceId: DEVICE,
    });
    expect(right.statusCode).toBe(200);
  });

  test("concurrent guesses can't share an attempt: a burst still gets five, total", async () => {
    // Service-level with a barrier: every guess reads the code row before
    // any of them writes, which is exactly what a burst does. Reading
    // `attempts` and writing it back +1 let all ten through at attempts=1.
    const { db, state } = makeFakeDb();
    const sent: string[] = [];
    const deps = {
      db,
      jwtSecret: TEST_JWT_SECRET,
      now: () => new Date(MONDAY_2PM),
      emailSender: {
        sendLoginCode: async (_to: string, code: string) => {
          sent.push(code);
          return { ok: true as const };
        },
      },
    };
    await startEmailLogin(deps, "burst@example.com");
    const wrong = sent[0] === "000000" ? "000001" : "000000";

    let arrived = 0;
    let release!: () => void;
    const allRead = new Promise<void>((resolve) => (release = resolve));
    const findFirst = db.emailLoginCode.findFirst.bind(db.emailLoginCode);
    db.emailLoginCode.findFirst = async (args) => {
      const row = await findFirst(args);
      arrived += 1;
      if (arrived === 10) release();
      await allRead;
      return row;
    };
    await Promise.all(
      Array.from({ length: 10 }, () => verifyEmailLogin(deps, "burst@example.com", wrong, DEVICE)),
    );
    db.emailLoginCode.findFirst = findFirst;

    expect(state.emailLoginCodes[0]!.attempts).toBe(5);
    const right = await verifyEmailLogin(deps, "burst@example.com", sent[0]!, DEVICE);
    expect(right).toEqual({ ok: false, code: "too_many_attempts" });
  });

  test("per-address daily cap: the eleventh code in a day refuses, however spaced", async () => {
    // Service-level: the per-IP limiter would stop an inject loop first,
    // and this cap is about the ADDRESS, whatever IPs ask.
    const { db } = makeFakeDb();
    const clock = { ms: baseNow };
    let sends = 0;
    const deps = {
      db,
      jwtSecret: TEST_JWT_SECRET,
      now: () => new Date(clock.ms),
      emailSender: {
        sendLoginCode: async () => {
          sends += 1;
          return { ok: true as const };
        },
      },
    };
    for (let i = 0; i < 10; i += 1) {
      expect(await startEmailLogin(deps, "target@example.com")).toEqual({ ok: true });
      clock.ms += 20 * 60_000; // always outside the 15-minute window
    }
    expect(await startEmailLogin(deps, "target@example.com")).toEqual({
      ok: false,
      code: "email_rate_limited",
    });
    expect(sends).toBe(10);
    // A day after the first, the window has moved on.
    clock.ms = baseNow + 24 * 60 * 60_000 + 60_000;
    expect(await startEmailLogin(deps, "target@example.com")).toEqual({ ok: true });
  });

  test("switched off (no sender wired), both email routes answer 403 and nothing is sent", async () => {
    const { app, sentCodes, state } = makeAuthApp({ auth: { emailSender: undefined } });
    const start = await post(app, "/auth/email/start", { email: "a@b.co" });
    expect(start.statusCode).toBe(403);
    expect(start.json()).toEqual({ error: "email_signin_disabled" });
    expect(sentCodes).toHaveLength(0);
    expect(state.emailLoginCodes).toHaveLength(0);

    // Verify refuses too, even for a code left over from when it was on.
    state.emailLoginCodes.push({
      id: "leftover",
      email: "a@b.co",
      codeHash: "x",
      expiresAt: new Date(baseNow + 60_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(baseNow),
    });
    const verify = await post(app, "/auth/email/verify", {
      email: "a@b.co",
      code: "123456",
      deviceId: DEVICE,
    });
    expect(verify.statusCode).toBe(403);
    expect(verify.json()).toEqual({ error: "email_signin_disabled" });
    expect(state.emailLoginCodes[0]!.attempts).toBe(0);
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
    // Refused because it was REVOKED — not merely unknown.
    expect(harness.state.refreshTokens).toHaveLength(2);
    expect(harness.state.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
  });

  test("two refreshes racing with one token can't both win — the family dies", async () => {
    // Service-level on purpose: app.inject dispatches the second request
    // only after the first has run to completion on the fake DB, so two
    // injects never overlap and would pass without the fix. Here a barrier
    // holds both callers after their "not yet rotated" read until both
    // have made it — the interleaving a real double-submit produces.
    const { db, state } = makeFakeDb();
    const deps = { db, jwtSecret: TEST_JWT_SECRET, now: () => new Date(MONDAY_2PM) };
    const user = state.users.find((u) => u.id === "u1")!;
    const issued = await issueSession(deps, user as never, DEVICE);

    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const findUnique = db.refreshToken.findUnique.bind(db.refreshToken);
    db.refreshToken.findUnique = async (args) => {
      const row = await findUnique(args);
      arrived += 1;
      if (arrived === 2) release();
      await bothRead;
      return row;
    };

    const results = await Promise.all([
      rotateRefreshToken(deps, issued.refreshToken, DEVICE),
      rotateRefreshToken(deps, issued.refreshToken, DEVICE),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "token_reused" });
    // One successor was minted, and reuse revoked it with its family.
    expect(state.refreshTokens).toHaveLength(2);
    expect(state.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
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

  test("the 60-day expiry slides with use", async () => {
    const harness = makeAuthApp();
    let token = (await signedIn(harness)).refreshToken;
    // Used every 59 days, the session outlives any fixed 60-day window…
    for (let i = 0; i < 2; i += 1) {
      harness.clock.ms += 59 * 24 * 60 * 60 * 1000;
      const res = await post(harness.app, "/auth/refresh", {
        refreshToken: token,
        deviceId: DEVICE,
      });
      expect(res.statusCode).toBe(200);
      token = res.json().refreshToken;
    }
    // …and 61 idle days end it.
    harness.clock.ms += 61 * 24 * 60 * 60 * 1000;
    const idle = await post(harness.app, "/auth/refresh", {
      refreshToken: token,
      deviceId: DEVICE,
    });
    expect(idle.statusCode).toBe(401);
    expect(idle.json().error).toBe("token_expired");
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

  test("an issued card is frozen, never canceled", async () => {
    const statuses: string[] = [];
    const harness = makeAuthApp({
      stripe: makeFakeGateway({
        setCardStatus: async (_id, status) => {
          statuses.push(status);
          return status;
        },
      }),
    });
    const signIn = await post(harness.app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    const { accessToken, user } = signIn.json();
    harness.state.issuingCards.push({ stripeCardId: "ic_1", userId: user.id, status: "active" });

    const res = await harness.app.inject({
      method: "DELETE",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(statuses).toEqual(["inactive"]);
    const decision = harness.state.decisions.find((d) => d.kind === "account_delete")!;
    expect(decision.outcome).toMatchObject({ cardFrozen: true });
  });

  test("a Stripe failure while freezing leaves the account whole and the delete retryable", async () => {
    let stripeUp = false;
    const harness = makeAuthApp({
      stripe: makeFakeGateway({
        setCardStatus: async (_id, status) => {
          if (!stripeUp) throw new Error("stripe down");
          return status;
        },
      }),
    });
    const signIn = await post(harness.app, "/auth/apple", {
      identityToken: signIdToken(appleClaims()),
      deviceId: DEVICE,
    });
    const { accessToken, refreshToken, user } = signIn.json();
    const bearer = { authorization: `Bearer ${accessToken}` };
    const { state } = harness;
    state.issuingCards.push({ stripeCardId: "ic_1", userId: user.id, status: "active" });
    state.vehicles.push({
      id: "v1",
      userId: user.id,
      plate: "ABC123",
      state: "MA",
      label: null,
      createdAt: new Date(MONDAY_2PM),
    });

    const failed = await harness.app.inject({ method: "DELETE", url: "/me", headers: bearer });
    expect(failed.statusCode).toBe(500);
    // Nothing was torn down: the freeze runs before any local step, so a
    // failure can't leave a half-deleted account with a live card.
    expect(state.users.find((u) => u.id === user.id)!.deletedAt).toBeNull();
    expect(state.vehicles.filter((v) => v.userId === user.id)).toHaveLength(1);
    expect(state.refreshTokens.filter((t) => t.userId === user.id)).toHaveLength(1);
    const stillIn = await harness.app.inject({ method: "GET", url: "/me", headers: bearer });
    expect(stillIn.statusCode).toBe(200);

    stripeUp = true;
    const retried = await harness.app.inject({ method: "DELETE", url: "/me", headers: bearer });
    expect(retried.statusCode).toBe(200);
    expect(state.users.find((u) => u.id === user.id)!.deletedAt).not.toBeNull();
    const refreshed = await post(harness.app, "/auth/refresh", { refreshToken, deviceId: DEVICE });
    expect(refreshed.statusCode).toBe(401);
  });
});
