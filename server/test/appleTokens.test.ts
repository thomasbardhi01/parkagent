/**
 * Sign in with Apple token revocation (App Store 5.1.1(v)): the sign-in's
 * authorization code is exchanged for a refresh token that is stored
 * SEALED; DELETE /me revokes it at Apple; a failed revoke never blocks the
 * delete and is retried by the hourly job until Apple accepts.
 */

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { describe, expect, test } from "vitest";

import { makeAppleRevocationJob } from "../src/jobs/appleRevocationTick.js";
import {
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  makeAppleClientSecret,
  makeAppleTokenClient,
} from "../src/services/appleTokens.js";
import type { AppleTokenClient } from "../src/services/appleTokens.js";
import { APPLE_ISSUER, verifyIdToken } from "../src/services/idToken.js";
import type { Jwk } from "../src/services/idToken.js";
import { MONDAY_2PM, makeTestApp, testStateCrypto } from "./helpers.js";

const AUDIENCE = "com.thomasbardhi.parkagent";
const DEVICE = "device-abcdef1234";
const baseNow = new Date(MONDAY_2PM).getTime();

// The Sign in with Apple key (ES256) that signs our client secret.
const signinKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const CONFIG = {
  key: signinKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  keyId: "SIWAKEY123",
  teamId: "TEAMID1234",
  clientId: AUDIENCE,
};

// Apple's identity-token signing key (RS256), as in auth.test.ts.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const jwkFor = (key: KeyObject, kid: string): Jwk => ({
  ...(key.export({ format: "jwk" }) as { kty: string; n: string; e: string }),
  kid,
});
function identityToken(sub = "apple-sub-1"): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: APPLE_ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(baseNow / 1000) + 3600,
      sub,
      email: "thomas@example.com",
      email_verified: "true",
    }),
  );
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

/** A scripted Apple: records every call, answers what the test says. */
function fakeApple(
  opts: {
    exchange?: Awaited<ReturnType<AppleTokenClient["exchangeCode"]>>;
    revokeOk?: boolean;
  } = {},
) {
  const calls = { exchanged: [] as string[], revoked: [] as string[] };
  let revokeOk = opts.revokeOk ?? true;
  const client: AppleTokenClient = {
    exchangeCode: async (code) => {
      calls.exchanged.push(code);
      return opts.exchange ?? { ok: true, refreshToken: "r.apple-refresh-1", sub: "apple-sub-1" };
    },
    revoke: async (token) => {
      calls.revoked.push(token);
      return revokeOk ? { ok: true } : { ok: false, error: "invalid_client" };
    },
  };
  return { client, calls, setRevokeOk: (ok: boolean) => (revokeOk = ok) };
}

function makeApp(appleTokens?: AppleTokenClient) {
  const fetchKeys = async () => ({ keys: [jwkFor(publicKey, "k1")] });
  return makeTestApp({
    now: () => new Date(baseNow),
    ...(appleTokens ? { appleTokens } : {}),
    auth: {
      verifyAppleToken: (token, at) =>
        verifyIdToken({ token, issuers: [APPLE_ISSUER], audience: AUDIENCE, fetchKeys, now: at }),
    },
  });
}

async function signIn(
  app: ReturnType<typeof makeTestApp>["app"],
  extra: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/apple",
    payload: { identityToken: identityToken(), deviceId: DEVICE, ...extra },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; user: { id: string } };
}

describe("the client secret", () => {
  test("is an ES256 JWT Apple can verify: our team, our app, Apple's audience, short-lived", () => {
    const jwt = makeAppleClientSecret(CONFIG, baseNow);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "SIWAKEY123",
    });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "TEAMID1234",
      sub: AUDIENCE,
      aud: "https://appleid.apple.com",
    });
    expect(claims.exp - claims.iat).toBe(300);
    const valid = cryptoVerify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: signinKey.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(valid).toBe(true);
  });
});

describe("the Apple token client", () => {
  const recordingFetch = (status: number, body: unknown) => {
    const sent: { url: string; form: URLSearchParams }[] = [];
    const impl = async (url: string, init: { body: string }) => {
      sent.push({ url, form: new URLSearchParams(init.body) });
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    };
    return { sent, impl };
  };

  test("exchanges the code for the refresh token and reads the sub it belongs to", async () => {
    const idToken = `x.${b64url(JSON.stringify({ sub: "apple-sub-1" }))}.y`;
    const { sent, impl } = recordingFetch(200, { refresh_token: "r.1", id_token: idToken });
    const client = makeAppleTokenClient(CONFIG, impl, () => new Date(baseNow));
    expect(await client.exchangeCode("c.code")).toEqual({
      ok: true,
      refreshToken: "r.1",
      sub: "apple-sub-1",
    });
    expect(sent[0]!.url).toBe(APPLE_TOKEN_URL);
    expect(Object.fromEntries(sent[0]!.form)).toMatchObject({
      client_id: AUDIENCE,
      code: "c.code",
      grant_type: "authorization_code",
    });
    expect(sent[0]!.form.get("client_secret")!.split(".")).toHaveLength(3);
  });

  test("an Apple error comes back as its code, never the body", async () => {
    const { impl } = recordingFetch(400, { error: "invalid_grant", echo: "c.code" });
    const client = makeAppleTokenClient(CONFIG, impl);
    expect(await client.exchangeCode("c.code")).toEqual({ ok: false, error: "invalid_grant" });
  });

  test("revokes a refresh token with the right hint", async () => {
    const { sent, impl } = recordingFetch(200, {});
    const client = makeAppleTokenClient(CONFIG, impl);
    expect(await client.revoke("r.1")).toEqual({ ok: true });
    expect(sent[0]!.url).toBe(APPLE_REVOKE_URL);
    expect(Object.fromEntries(sent[0]!.form)).toMatchObject({
      client_id: AUDIENCE,
      token: "r.1",
      token_type_hint: "refresh_token",
    });
  });
});

describe("sign-in stores Apple's refresh token, sealed", () => {
  test("the code is exchanged and the token kept sealed — never in plaintext", async () => {
    const apple = fakeApple();
    const { app, state } = makeApp(apple.client);
    const { user } = await signIn(app, { authorizationCode: "c.code-1" });

    expect(apple.calls.exchanged).toEqual(["c.code-1"]);
    const row = state.users.find((u) => u.id === user.id)!;
    expect(row.appleRefreshTokenSealed).toEqual(expect.any(String));
    expect(row.appleRefreshTokenSealed).not.toContain("apple-refresh-1");
    expect(testStateCrypto().open(row.appleRefreshTokenSealed!)).toBe("r.apple-refresh-1");
    expect(state.decisions.at(-1)).toMatchObject({ rule: "apple_refresh_token_stored" });
  });

  test("a failed exchange still signs the user in; nothing is stored", async () => {
    const apple = fakeApple({ exchange: { ok: false, error: "invalid_grant" } });
    const { app, state } = makeApp(apple.client);
    const { user } = await signIn(app, { authorizationCode: "c.stale" });
    expect(state.users.find((u) => u.id === user.id)!.appleRefreshTokenSealed ?? null).toBeNull();
    expect(state.decisions.at(-1)).toMatchObject({
      rule: "apple_code_exchange_failed",
      outcome: { ok: false, error: "invalid_grant" },
    });
  });

  test("a code that belongs to a different Apple ID is never stored", async () => {
    const apple = fakeApple({
      exchange: { ok: true, refreshToken: "r.someone-else", sub: "apple-sub-OTHER" },
    });
    const { app, state } = makeApp(apple.client);
    const { user } = await signIn(app, { authorizationCode: "c.code" });
    expect(state.users.find((u) => u.id === user.id)!.appleRefreshTokenSealed ?? null).toBeNull();
    expect(state.decisions.at(-1)).toMatchObject({ rule: "apple_code_sub_mismatch" });
  });

  test("without the Apple key (or without a code) sign-in is exactly as before", async () => {
    const { app } = makeApp();
    await signIn(app, { authorizationCode: "c.code" });
    const apple = fakeApple();
    const { app: withKey } = makeApp(apple.client);
    await signIn(withKey);
    expect(apple.calls.exchanged).toEqual([]);
  });
});

describe("DELETE /me revokes the Apple token", () => {
  const del = (app: ReturnType<typeof makeTestApp>["app"], token: string) =>
    app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${token}` } });

  test("revoked at Apple with the stored token, and the sealed copy is gone", async () => {
    const apple = fakeApple();
    const { app, state } = makeApp(apple.client);
    const { accessToken, user } = await signIn(app, { authorizationCode: "c.code" });

    const res = await del(app, accessToken);
    expect(res.statusCode).toBe(200);
    expect(apple.calls.revoked).toEqual(["r.apple-refresh-1"]);
    const row = state.users.find((u) => u.id === user.id)!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.appleRefreshTokenSealed ?? null).toBeNull();
    expect(state.decisions.find((d) => d.kind === "account_delete")).toMatchObject({
      outcome: { appleRevoked: true },
    });
  });

  test("Apple down: the delete still succeeds, the sealed token waits, and the hourly retry clears it", async () => {
    const apple = fakeApple({ revokeOk: false });
    const { app, state, deps } = makeApp(apple.client);
    const { accessToken, user } = await signIn(app, { authorizationCode: "c.code" });

    expect((await del(app, accessToken)).statusCode).toBe(200);
    const row = state.users.find((u) => u.id === user.id)!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.appleRefreshTokenSealed).toEqual(expect.any(String));
    expect(state.decisions.find((d) => d.kind === "account_delete")).toMatchObject({
      outcome: { appleRevoked: false },
    });

    let clock = new Date();
    const job = makeAppleRevocationJob({
      db: deps.db,
      appleTokens: apple.client,
      stateCrypto: testStateCrypto(),
      log: { info: () => {}, warn: () => {} },
      now: () => clock,
    });
    await job.tick(); // still down: kept, with the next try an hour out
    expect(row.appleRefreshTokenSealed).toEqual(expect.any(String));

    apple.setRevokeOk(true);
    await job.tick(); // not due yet: backoff, not a hammer
    expect(row.appleRefreshTokenSealed).toEqual(expect.any(String));
    clock = new Date(clock.getTime() + 61 * 60_000);
    await job.tick();
    expect(row.appleRefreshTokenSealed ?? null).toBeNull();
    expect(apple.calls.revoked).toEqual([
      "r.apple-refresh-1",
      "r.apple-refresh-1",
      "r.apple-refresh-1",
    ]);
    expect(state.decisions.at(-1)).toMatchObject({ rule: "apple_token_revoked", userId: user.id });
  });

  test("the retry never touches a live account's token", async () => {
    const apple = fakeApple();
    const { app, deps } = makeApp(apple.client);
    await signIn(app, { authorizationCode: "c.code" });
    const job = makeAppleRevocationJob({
      db: deps.db,
      appleTokens: apple.client,
      stateCrypto: testStateCrypto(),
      log: { info: () => {}, warn: () => {} },
    });
    await job.tick();
    expect(apple.calls.revoked).toEqual([]);
  });
});
