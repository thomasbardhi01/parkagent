/**
 * FR-32 — accounts. What the live API can prove without a real Apple or
 * email sign-in (both device-manual; see the FR doc):
 *
 *  - GET /auth/methods agrees with the routes (Apple on; a method reported
 *    off answers "<method>_signin_disabled");
 *  - GET / PATCH /me as the FR user, restored afterwards;
 *  - the refresh surface refuses a token it never issued;
 *  - with a THROWAWAY session minted by `pnpm -C server create:fr-throwaway`
 *    (an admin script that needs the target's own DB and JWT secret —
 *    never an API route, so there is no sign-in backdoor to test through):
 *    device binding, rotation, reuse detection revoking the whole family,
 *    and DELETE /me tombstoning the account so its still-valid access
 *    token stops working at once.
 *
 * The throwaway half self-skips when FR_THROWAWAY_SESSION isn't set. Its
 * requests go through sessionFetch, which never carries the FR key, and
 * the throwaway is deleted however the tests end (the afterAll below).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frFetch, gate, sessionFetch, throwawaySession } from "./client.js";

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

beforeAll(async () => {
  await gate();
});

describe("FR-32 profile", () => {
  let original: { name: string; phone: string | null } | null = null;

  afterAll(async () => {
    // Put the FR user back however the test ended.
    if (original) await frFetch("PATCH", "/me", original);
  });

  it("FR-32 GET /me returns the caller's profile and nothing secret", async () => {
    const res = await frFetch("GET", "/me");
    expect(res.status).toBe(200);
    const user = res.body["user"] as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(typeof user["id"]).toBe("string");
    expect(["provider_card", "issuing_card"]).toContain(res.body["paymentSource"]);
    expect(typeof res.body["issuingLive"]).toBe("boolean");
  });

  it("FR-32 PATCH /me round-trips a name and a phone; a new phone is unverified", async () => {
    const before = await frFetch("GET", "/me");
    const user = before.body["user"] as { name: string; phone: string | null };
    original = { name: user.name, phone: user.phone };

    const name = `${user.name.replace(/ \(FR check .*\)$/, "")} (FR check ${Date.now()})`;
    const patched = await frFetch("PATCH", "/me", { name, phone: "+1 617 555 0100" });
    expect(patched.status).toBe(200);
    const after = patched.body["user"] as Record<string, unknown>;
    expect(after["name"]).toBe(name);
    expect(after["phone"]).toBe("+1 617 555 0100");
    // No SMS flow exists: an edited phone is never verified.
    expect(after["phoneVerified"]).toBe(false);

    // The write stuck — a fresh read sees it.
    const reread = await frFetch("GET", "/me");
    expect((reread.body["user"] as Record<string, unknown>)["name"]).toBe(name);

    const restored = await frFetch("PATCH", "/me", original);
    expect(restored.status).toBe(200);
    expect((restored.body["user"] as Record<string, unknown>)["name"]).toBe(original.name);
    original = null;
  });

  it("FR-32 PATCH /me refuses an empty name or a malformed phone", async () => {
    expect((await frFetch("PATCH", "/me", { name: "" })).status).toBe(400);
    expect((await frFetch("PATCH", "/me", { phone: "call me" })).status).toBe(400);
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

const throwaway = throwawaySession();
/** Set the moment a DELETE /me for the throwaway answers 200 — by its test
 * or by the teardown below. */
let throwawayDeleted = false;
let fresh: { accessToken: string; refreshToken: string } | null = null;

// The throwaway is deleted however the tests end. File level on purpose:
// when this file's gate() beforeAll fails, vitest skips a describe's own
// afterAll but still runs this one — and a failed gate is exactly when the
// throwaway would otherwise be left behind. Either access token works for
// 15 minutes whatever happened to its refresh family; past that, or on a
// run that dies outright, the nightly's purge-fr-throwaways step takes it.
afterAll(async () => {
  if (!throwaway || throwawayDeleted) return;
  for (const bearer of [fresh?.accessToken, throwaway.accessToken]) {
    if (!bearer) continue;
    const res = await sessionFetch("DELETE", "/me", { bearer }).catch(() => null);
    if (res?.status === 200) {
      throwawayDeleted = true;
      return;
    }
  }
  console.warn(
    `FR: couldn't delete throwaway ${throwaway.userId} (its access tokens are dead); ` +
      "purge-fr-throwaways removes it.",
  );
});

describe.skipIf(!throwaway)("FR-32 session lifecycle (throwaway account)", () => {
  // Non-null inside: the block is skipped without it.
  const minted = throwaway!;

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

    const me = await sessionFetch("GET", "/me", { bearer: fresh.accessToken });
    expect(me.status).toBe(200);
    expect((me.body["user"] as Record<string, unknown>)["id"]).toBe(minted.userId);
  });

  it("FR-32 replaying a rotated token is reuse: refused, and the whole family dies", async () => {
    expect(fresh).not.toBeNull();
    const replay = await sessionFetch("POST", "/auth/refresh", {
      payload: { refreshToken: minted.refreshToken, deviceId: minted.deviceId },
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
    if (deleted.status === 200) throwawayDeleted = true;
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, deleted: true });

    const after = await sessionFetch("GET", "/me", { bearer });
    expect(after.status).toBe(401);
  });
});
