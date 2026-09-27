/**
 * FR-32 — accounts. What the live API can prove without a real Apple or
 * email sign-in (both device-manual; see the FR doc):
 *
 *  - GET /auth/methods agrees with the routes (Apple on; a method reported
 *    off answers "<method>_signin_disabled");
 *  - GET / PATCH /me as this file's own throwaway user;
 *  - the refresh surface refuses a token it never issued;
 *  - with a second throwaway (minted by `pnpm -C server create:fr-throwaway
 *    --pool` — an admin script that needs the target's own DB and JWT
 *    secret, never an API route, so there is no sign-in backdoor to test
 *    through): device binding, rotation, reuse detection revoking the whole
 *    family, and DELETE /me tombstoning the account so its still-valid
 *    access token stops working at once.
 *
 * The lifecycle's requests go through sessionFetch, which never carries
 * the FR key. Both users are deleted however the tests end (client.ts
 * `ownUser`); the lifecycle test deletes its own and proves it gone.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { freshBearer, ownUser, sessionFetch, userFetch } from "./client.js";

/** This file's own throwaway user, for the profile tests. */
const me = ownUser(import.meta.url);
/** A second one whose session the lifecycle burns and whose account it
 * deletes (pool.mjs declares it). */
const life = ownUser(import.meta.url, "lifecycle");

/** Exactly what the app may learn about a user — no credential, hash, or
 * provider subject rides along. */
const PUBLIC_USER_KEYS = [
  "appleLinked",
  "email",
  "emailVerified",
  "googleLinked",
  "id",
  "name",
  "phone",
  "phoneVerified",
].sort();

describe("FR-32 profile", () => {
  it("FR-32 GET /me returns the caller's profile and nothing secret", async () => {
    const res = await userFetch(me, "GET", "/me");
    expect(res.status).toBe(200);
    const user = res.body["user"] as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(typeof user["id"]).toBe("string");
    expect(["provider_card", "issuing_card"]).toContain(res.body["paymentSource"]);
    expect(typeof res.body["issuingLive"]).toBe("boolean");
  });

  it("FR-32 PATCH /me round-trips a name and a phone; a new phone is unverified", async () => {
    const before = await userFetch(me, "GET", "/me");
    const user = before.body["user"] as { name: string; phone: string | null };
    const original = { name: user.name, phone: user.phone };

    const name = `${user.name} (FR check ${Date.now()})`;
    const patched = await userFetch(me, "PATCH", "/me", { name, phone: "+1 617 555 0100" });
    expect(patched.status).toBe(200);
    const after = patched.body["user"] as Record<string, unknown>;
    expect(after["name"]).toBe(name);
    expect(after["phone"]).toBe("+1 617 555 0100");
    // No SMS flow exists: an edited phone is never verified.
    expect(after["phoneVerified"]).toBe(false);

    // The write stuck — a fresh read sees it.
    const reread = await userFetch(me, "GET", "/me");
    expect((reread.body["user"] as Record<string, unknown>)["name"]).toBe(name);

    const restored = await userFetch(me, "PATCH", "/me", original);
    expect(restored.status).toBe(200);
    expect((restored.body["user"] as Record<string, unknown>)["name"]).toBe(original.name);
  });

  it("FR-32 PATCH /me refuses an empty name or a malformed phone", async () => {
    expect((await userFetch(me, "PATCH", "/me", { name: "" })).status).toBe(400);
    expect((await userFetch(me, "PATCH", "/me", { phone: "call me" })).status).toBe(400);
  });
});

describe("FR-32 sign-in methods", () => {
  it("FR-32 GET /auth/methods: Apple is on, and every method reported off refuses as not enabled", async () => {
    const res = await sessionFetch("GET", "/auth/methods");
    expect(res.status).toBe(200);
    expect(res.body["apple"]).toBe(true);
    // Only the methods reported OFF are exercised — an enabled email
    // method would really send mail, which the suite never does.
    if (res.body["email"] === false) {
      const email = await sessionFetch("POST", "/auth/email/start", {
        payload: { email: "fr-never-sent@example.invalid" },
      });
      expect(email.status).toBe(403);
      expect(email.body["error"]).toBe("email_signin_disabled");
    }
    if (res.body["google"] === false) {
      const google = await sessionFetch("POST", "/auth/google", {
        payload: { idToken: "not-a-token", deviceId: "fr-device" },
      });
      expect(google.status).toBe(403);
      expect(google.body["error"]).toBe("google_signin_disabled");
    }
  });
});

describe("FR-32 refresh surface", () => {
  it("FR-32 POST /auth/refresh refuses a token it never issued", async () => {
    const res = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: "fr-never-issued-token", deviceId: "fr-device" },
    });
    expect(res.status).toBe(401);
    expect(res.body["error"]).toBe("invalid_token");
  });

  it("FR-32 a protected route refuses a forged bearer instead of falling back", async () => {
    const res = await sessionFetch("GET", "/me", { bearer: "a.b.c" });
    expect(res.status).toBe(401);
  });
});

// One story, told in order: each step spends what the one before issued.
describe("FR-32 session lifecycle (throwaway account)", { shuffle: false }, () => {
  /** The session as this story starts: whatever the harness last held (it
   * refreshes one about to expire), so the pair is unspent either way. */
  let minted: { userId: string; deviceId: string; refreshToken: string; accessToken: string };
  let fresh: { accessToken: string; refreshToken: string } | null = null;

  beforeAll(async () => {
    await freshBearer(life);
    minted = {
      userId: life.userId,
      deviceId: life.deviceId,
      refreshToken: life.refreshToken,
      accessToken: life.accessToken,
    };
  });

  it("FR-32 a refresh token only works from the device it was issued to", async () => {
    const res = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: minted.refreshToken, deviceId: "fr-some-other-device" },
    });
    expect(res.status).toBe(401);
    expect(res.body["error"]).toBe("device_mismatch");
  });

  it("FR-32 rotation issues a fresh pair that authenticates as the same account", async () => {
    // Also proves the device-mismatch refusal above didn't burn the token.
    const res = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: minted.refreshToken, deviceId: minted.deviceId },
    });
    expect(res.status).toBe(200);
    fresh = {
      accessToken: res.body["accessToken"] as string,
      refreshToken: res.body["refreshToken"] as string,
    };
    expect(fresh.refreshToken).not.toBe(minted.refreshToken);
    // The harness cleans up with the newest access token if a later step
    // fails before the delete.
    life.accessToken = fresh.accessToken;
    life.refreshToken = fresh.refreshToken;

    const me = await sessionFetch("GET", "/me", { bearer: fresh.accessToken });
    expect(me.status).toBe(200);
    expect((me.body["user"] as Record<string, unknown>)["id"]).toBe(minted.userId);
  });

  it("FR-32 FR-41 the same phone re-asking right after a rotation (its answer was lost) gets a session", async () => {
    expect(fresh).not.toBeNull();
    const again = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: minted.refreshToken, deviceId: minted.deviceId },
    });
    expect(again.status).toBe(200);
    expect(typeof again.body["refreshToken"]).toBe("string");
    expect(again.body["refreshToken"]).not.toBe(fresh!.refreshToken);
  });

  it("FR-32 replaying a rotated token from anywhere else is reuse: refused, and the whole family dies", async () => {
    expect(fresh).not.toBeNull();
    const replay = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: minted.refreshToken, deviceId: `${minted.deviceId}-elsewhere` },
    });
    expect(replay.status).toBe(401);
    expect(replay.body["error"]).toBe("token_reused");

    // The descendant rotation just issued is revoked with its family.
    const descendant = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: fresh!.refreshToken, deviceId: minted.deviceId },
    });
    expect(descendant.status).toBe(401);
  });

  it("FR-32 DELETE /me tombstones the account; its live access token stops at once", async () => {
    // The access JWT outlives its refresh family by design (15 minutes);
    // it is the account's deletion, not the revocation, that must end it.
    const bearer = fresh?.accessToken ?? minted.accessToken;
    const before = await sessionFetch("GET", "/me", { bearer });
    expect(before.status).toBe(200);

    const deleted = await sessionFetch("DELETE", "/me", { bearer });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, deleted: true });

    const after = await sessionFetch("GET", "/me", { bearer });
    expect(after.status).toBe(401);
    // Deleted and proven gone: the harness has nothing left to clean up.
    life.deleted = true;
  });
});
