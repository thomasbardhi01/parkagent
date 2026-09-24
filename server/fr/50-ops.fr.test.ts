/**
 * FR-28 / FR-29 — pushes and the ops dashboard. Delivery to a physical
 * phone stays device-manual; here the live API proves the plumbing: token
 * registration/binding/release, the push-test report, and the admin
 * summary's shape. Admin endpoints self-skip when the FR key isn't admin
 * (create the user with `pnpm -C server create:fr-user` to get admin).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { frFetch, gate } from "./client.js";

// A syntactically plausible, deliberately fake APNs token. Stable across
// runs so re-registration exercises idempotency; bound to the FR user
// only. APNs will reject it if anything ever pushes at it — by design.
const FR_TOKEN = "f".repeat(63) + "0";

beforeAll(async () => {
  await gate();
});

describe("FR-29 admin summary", () => {
  it("FR-29 GET /admin/summary aggregates today's activity per city", async (ctx) => {
    const res = await frFetch("GET", "/admin/summary");
    if (res.status === 403) {
      ctx.skip(); // FR key is not admin on this deployment
      return;
    }
    expect(res.status).toBe(200);
    expect(res.body["dryRun"]).toBe(true);
    expect(typeof res.body["policyHash"]).toBe("string");
    expect(typeof res.body["since"]).toBe("string");
    expect(typeof res.body["now"]).toBe("string");
    expect(typeof res.body["cities"]).toBe("object");
    expect(typeof res.body["decisionCount"]).toBe("number");
    // This suite itself parked several times today — the trail must show.
    expect(res.body["decisionCount"] as number).toBeGreaterThan(0);
  });
});

describe("FR-28 pushes", () => {
  it("FR-28 POST /admin/push-test reports APNs configuration and per-device results", async (ctx) => {
    const res = await frFetch("POST", "/admin/push-test", { types: ["session_started"] });
    if (res.status === 403) {
      ctx.skip(); // FR key is not admin on this deployment
      return;
    }
    if (res.status === 503) {
      // No APNs credentials on this deployment — the endpoint must say so
      // typed, not fall over.
      expect(res.body["error"]).toBe("apns_not_configured");
      return;
    }
    expect(res.status).toBe(200);
    expect(res.body["configured"]).toBe(true);
    const sent = res.body["sent"] as Record<string, unknown>[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!["type"]).toBe("session_started");
  });

  it("FR-28 a device token registers idempotently and releases on delete", async () => {
    const register = await frFetch("POST", "/device", {
      token: FR_TOKEN,
      platform: "ios",
      environment: "development",
    });
    expect(register.status).toBe(200);
    expect(register.body["ok"]).toBe(true);

    // Re-registering the same token for the same user is a no-op success
    // (the app re-sends on every launch).
    const again = await frFetch("POST", "/device", {
      token: FR_TOKEN,
      platform: "ios",
      environment: "development",
    });
    expect(again.status).toBe(200);

    const release = await frFetch("DELETE", "/device", { token: FR_TOKEN });
    expect(release.status).toBe(200);
    expect(release.body["ok"]).toBe(true);

    // Released means gone: deleting again finds nothing bound to us.
    const gone = await frFetch("DELETE", "/device", { token: FR_TOKEN });
    expect(gone.status).toBe(404);
    expect(gone.body["error"]).toBe("token_not_found");
  });
});
