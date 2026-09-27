/**
 * Boot configuration. Only the core (database, JWT secret, api-key pepper,
 * a malformed provider state key) refuses boot; every optional feature
 * with a missing, partial, or malformed setting comes back switched off,
 * named, and listed as degraded. The 2026-09-26 outage was a misnamed Maps
 * secret refusing boot (docs/incidents.md).
 */

import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import { bootLog, checkEnv, inspectP8, loadEnv, suggestName } from "../src/env.js";
import type { FeatureId } from "../src/env.js";

/** What a deployment must have — and no optional settings at all. */
const MINIMAL = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  DRY_RUN: "true",
  API_KEY_PEPPER: "pepper-pepper-pepper",
  AUTH_JWT_SECRET: "x".repeat(32),
};

const p8 = (namedCurve = "prime256v1") =>
  generateKeyPairSync("ec", { namedCurve }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

const STATE_KEY = Buffer.alloc(32, 7).toString("base64");

/** Every optional feature on, with well-formed values (boot-check's "on"). */
function everythingOn() {
  return {
    ...MINIMAL,
    DRY_RUN: "false",
    PROVIDER_STATE_KEY: STATE_KEY,
    STRIPE_SECRET_KEY: "sk_test_abc123",
    STRIPE_WEBHOOK_SECRET: "whsec_abc123",
    ISSUING_LIVE: "true",
    APNS_KEY: p8(),
    APNS_KEY_ID: "APNSKEY001",
    APNS_TEAM_ID: "TEAMID0001",
    APNS_BUNDLE_ID: "com.thomasbardhi.parkagent",
    APPLE_SIGNIN_KEY: p8(),
    APPLE_SIGNIN_KEY_ID: "SIWAKEY001",
    APPLE_SIGNIN_TEAM_ID: "TEAMID0001",
    APPLE_MAPS_KEY: p8(),
    APPLE_MAPS_KEY_ID: "MAPSKEY001",
    APPLE_MAPS_TEAM_ID: "TEAMID0001",
    EMAIL_SIGNIN_ENABLED: "true",
    RESEND_API_KEY: "re_abc123",
    GOOGLE_SIGNIN_ENABLED: "true",
    GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    ANTHROPIC_API_KEY: "sk-ant-abc123",
    PARKWHIZ_ENABLED: "true",
    LINK_CLIENT_ID: "link_client",
    LINK_CLIENT_SECRET: "link_secret",
    LINK_PUBLISHABLE_KEY: "pk_test_abc123",
    LINK_REDIRECT_URI: "https://example.com/link/callback",
    LINK_TEST_MODE: "true",
  };
}

const stateOf = (source: Record<string, string>, id: FeatureId) =>
  checkEnv(source).features.find((f) => f.id === id);

describe("the core", () => {
  test("boots with the core alone: nothing fatal, nothing degraded, optional features off", () => {
    const report = checkEnv(MINIMAL);
    expect(report.fatal).toEqual([]);
    expect(report.degraded).toEqual([]);
    expect(report.env.EMAIL_SIGNIN_ENABLED).toBe("false");
    expect(report.env.GOOGLE_SIGNIN_ENABLED).toBe("false");
    expect(report.env.DRY_RUN).toBe("true");
    expect(report.features.filter((f) => f.state === "on").map((f) => f.id)).toEqual(["parkwhiz"]);
  });

  test.each([
    ["DATABASE_URL", { DATABASE_URL: undefined }, "required"],
    ["DATABASE_URL", { DATABASE_URL: "mysql://u@h/db" }, "postgres"],
    ["AUTH_JWT_SECRET", { AUTH_JWT_SECRET: "short" }, "at least 32"],
    ["API_KEY_PEPPER", { API_KEY_PEPPER: undefined }, "required"],
    ["API_KEY_PEPPER", { API_KEY_PEPPER: "short" }, "at least 16"],
    ["PROVIDER_STATE_KEY", { PROVIDER_STATE_KEY: "dG9vIHNob3J0" }, "32 bytes"],
  ])("a bad %s is fatal (%j)", (name, patch, message) => {
    const fatal = checkEnv({ ...MINIMAL, ...patch }).fatal;
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatch(new RegExp(`^${name}: .*${message}`));
  });

  test("an unset PROVIDER_STATE_KEY only switches provider linking off", () => {
    const report = checkEnv(MINIMAL);
    expect(report.fatal).toEqual([]);
    expect(report.features.find((f) => f.id === "provider_accounts")?.state).toBe("off");
    expect(checkEnv({ ...MINIMAL, PROVIDER_STATE_KEY: STATE_KEY }).env.PROVIDER_STATE_KEY).toBe(
      STATE_KEY,
    );
  });

  test("an unreadable DRY_RUN runs in dry run and says so; it never reads as live", () => {
    for (const value of [undefined, "False", "no", "0", ""]) {
      const report = checkEnv({ ...MINIMAL, DRY_RUN: value });
      expect(report.fatal).toEqual([]);
      expect(report.env.DRY_RUN).toBe("true");
      expect(report.degraded).toEqual(["live_payments"]);
    }
    expect(checkEnv({ ...MINIMAL, DRY_RUN: "false" }).env.DRY_RUN).toBe("false");
  });
});

describe("optional features never refuse boot", () => {
  test("the 2026-09-26 outage: APPLE_MAPS_PRIVATE_KEY instead of APPLE_MAPS_KEY", () => {
    const report = checkEnv({
      ...MINIMAL,
      APPLE_MAPS_PRIVATE_KEY: p8(),
      APPLE_MAPS_KEY_ID: "MAPSKEY001",
      APPLE_MAPS_TEAM_ID: "TEAMID0001",
    });
    expect(report.fatal).toEqual([]);
    expect(report.degraded).toEqual(["apple_maps"]);
    const maps = report.features.find((f) => f.id === "apple_maps")!;
    expect(maps.detail).toMatch(/^APPLE_MAPS_KEY is not set, but APPLE_MAPS_KEY_ID and/);
    expect(maps.detail).toContain("APPLE_MAPS_PRIVATE_KEY is set");
    expect(report.warnings).toContain(
      "APPLE_MAPS_PRIVATE_KEY is set, but the server doesn't read it — did you mean APPLE_MAPS_KEY?",
    );
    // The wiring can't switch it on behind the report's back.
    expect(report.env.APPLE_MAPS_KEY_ID).toBeUndefined();
    expect(report.env.APPLE_MAPS_TEAM_ID).toBeUndefined();
  });

  test("every feature well-formed: all on, nothing degraded", () => {
    const report = checkEnv(everythingOn());
    expect(report.fatal).toEqual([]);
    expect(report.degraded).toEqual([]);
    expect(report.features.every((f) => f.state === "on")).toBe(true);
    expect(report.env.APPLE_MAPS_KEY).toBeDefined();
    expect(report.env.LINK_TEST_MODE).toBe("true");
  });

  const rsaKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

  test.each<[FeatureId, Record<string, string | undefined>, RegExp]>([
    ["push", { APNS_KEY: "AuthKey_APNSKEY001.p8" }, /^APNS_KEY isn't a PEM key.*contents/],
    ["push", { APNS_BUNDLE_ID: undefined }, /APNS_BUNDLE_ID is not set/],
    ["push", { APNS_KEY_ID: "apnskey1" }, /^APNS_KEY_ID isn't a 10-character Apple id/],
    ["stripe", { STRIPE_WEBHOOK_SECRET: undefined }, /STRIPE_WEBHOOK_SECRET is not set/],
    ["stripe", { STRIPE_SECRET_KEY: "pk_live_abc" }, /^STRIPE_SECRET_KEY doesn't look like/],
    ["issuing", { ISSUING_LIVE: "TRUE" }, /^ISSUING_LIVE is "TRUE"; expected true or false/],
    ["link_wallet", { LINK_REDIRECT_URI: undefined }, /LINK_REDIRECT_URI is not set/],
    ["link_wallet", { LINK_REDIRECT_URI: "http://example.com/cb" }, /must be an https URL/],
    ["link_wallet", { LINK_TEST_MODE: "yes" }, /^LINK_TEST_MODE is "yes"/],
    [
      "apple_signin_revoke",
      { APPLE_SIGNIN_KEY: rsaKey },
      /^APPLE_SIGNIN_KEY is not an EC key \(it's RSA\)/,
    ],
    ["apple_signin_revoke", { APPLE_SIGNIN_TEAM_ID: "team" }, /^APPLE_SIGNIN_TEAM_ID isn't/],
    [
      "apple_maps",
      { APPLE_MAPS_KEY: p8("secp384r1") },
      /^APPLE_MAPS_KEY is an EC key on secp384r1/,
    ],
    ["apple_maps", { APPLE_MAPS_KEY: "-----BEGIN PRIVATE KEY-----\nnope\n" }, /doesn't parse/],
    ["email_signin", { RESEND_API_KEY: undefined }, /RESEND_API_KEY is not set/],
    ["email_signin", { RESEND_API_KEY: "sk_abc" }, /^RESEND_API_KEY doesn't look like/],
    ["email_signin", { EMAIL_SIGNIN_ENABLED: "on" }, /^EMAIL_SIGNIN_ENABLED is "on"/],
    ["email_signin", { RESEND_FROM: "not an address" }, /^RESEND_FROM isn't a From address/],
    ["google_signin", { GOOGLE_CLIENT_ID: undefined }, /GOOGLE_CLIENT_ID is not set/],
    ["google_signin", { GOOGLE_CLIENT_ID: "12345" }, /^GOOGLE_CLIENT_ID doesn't look like/],
    ["parkwhiz", { PARKWHIZ_ENABLED: "off" }, /^PARKWHIZ_ENABLED is "off"/],
    ["assistant", { ANTHROPIC_API_KEY: "sk-proj-abc" }, /^ANTHROPIC_API_KEY doesn't look like/],
  ])("%s: %j → degraded, named, and off", (id, patch, detail) => {
    const report = checkEnv({ ...everythingOn(), ...patch });
    expect(report.fatal).toEqual([]);
    expect(report.degraded).toContain(id);
    const status = report.features.find((f) => f.id === id)!;
    expect(status.state).toBe("degraded");
    expect(status.detail).toMatch(detail);
  });

  test("a degraded feature's settings are gone from env, so nothing wires it", () => {
    const env = checkEnv({ ...everythingOn(), STRIPE_WEBHOOK_SECRET: undefined }).env;
    // Stripe without its webhook secret would accept unsigned events.
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    // …and Issuing, which stands on Stripe, goes with it.
    expect(env.ISSUING_LIVE).toBe("false");
    expect(checkEnv({ ...everythingOn(), APNS_KEY_ID: "bad" }).env.APNS_KEY).toBeUndefined();
    expect(
      checkEnv({ ...everythingOn(), EMAIL_SIGNIN_ENABLED: "yes" }).env.EMAIL_SIGNIN_ENABLED,
    ).toBe("false");
  });

  test("features that seal with the state key degrade without it", () => {
    const report = checkEnv({ ...everythingOn(), PROVIDER_STATE_KEY: undefined });
    expect(report.fatal).toEqual([]);
    expect(report.degraded).toEqual(["link_wallet", "apple_signin_revoke"]);
    expect(
      stateOf({ ...everythingOn(), PROVIDER_STATE_KEY: "" }, "apple_signin_revoke")?.detail,
    ).toMatch(/needs PROVIDER_STATE_KEY/);
  });

  test("a switch that's off doesn't need its settings: no degraded, no fatal", () => {
    const report = checkEnv({ ...MINIMAL, RESEND_API_KEY: "re_x", GOOGLE_CLIENT_ID: "x" });
    expect(report.degraded).toEqual([]);
    expect(report.fatal).toEqual([]);
  });

  test("tuning values fall back to their defaults with a warning", () => {
    const report = checkEnv({
      ...MINIMAL,
      PORT: "http",
      EXECUTOR_CONCURRENCY: "20",
      ASSISTANT_DAILY_SPEND_CAP_USD: "-1",
      EXPLAIN_MODEL: "gpt-4",
      APPLE_AUDIENCE: "not a bundle",
    });
    expect(report.fatal).toEqual([]);
    expect(report.degraded).toEqual([]);
    expect(report.env.PORT).toBe(3000);
    expect(report.env.EXECUTOR_CONCURRENCY).toBe(2);
    expect(report.env.ASSISTANT_DAILY_SPEND_CAP_USD).toBe(5);
    expect(report.env.EXPLAIN_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(report.env.APPLE_AUDIENCE).toBe("com.thomasbardhi.parkagent");
    expect(report.warnings).toHaveLength(5);
    expect(report.warnings[0]).toMatch(/^APPLE_AUDIENCE isn't a bundle id/);
  });
});

describe("key contents", () => {
  test("a .p8 with \\n escapes (how some shells carry it) parses", () => {
    const escaped = p8().replace(/\n/g, "\\n");
    expect(inspectP8(escaped).ok).toBe(true);
  });

  test("a public key or certificate is not a .p8", () => {
    const pub = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    const inspected = inspectP8(pub);
    expect(inspected.ok).toBe(false);
  });

  test("the same key in two slots is named, whatever its line endings", () => {
    const shared = p8();
    const warnings = checkEnv({
      ...everythingOn(),
      APNS_KEY: shared,
      APPLE_MAPS_KEY: shared.replace(/\n/g, "\\n"),
      APPLE_MAPS_KEY_ID: "APNSKEY001",
    }).warnings;
    expect(warnings).toEqual([
      "APPLE_MAPS_KEY is the same key as APNS_KEY. One Apple key can carry several services, " +
        "so this works only if that key has Maps enabled as well as Apple Push Notifications",
    ]);
  });

  test("the same key under two different key ids: one of the ids is wrong", () => {
    const shared = p8();
    const [warning] = checkEnv({
      ...everythingOn(),
      APNS_KEY: shared,
      APPLE_MAPS_KEY: shared,
    }).warnings;
    expect(warning).toContain(
      "APPLE_MAPS_KEY_ID (MAPSKEY001) differs from APNS_KEY_ID (APNSKEY001)",
    );
  });

  test("two secrets with one value are named (never printed)", () => {
    const warnings = checkEnv({ ...MINIMAL, API_KEY_PEPPER: MINIMAL.AUTH_JWT_SECRET }).warnings;
    expect(warnings).toEqual([
      "API_KEY_PEPPER has the same value as AUTH_JWT_SECRET; each should be its own secret",
    ]);
    expect(warnings.join()).not.toContain(MINIMAL.AUTH_JWT_SECRET);
  });
});

describe("unknown names", () => {
  test.each([
    ["APPLE_MAPS_PRIVATE_KEY", "APPLE_MAPS_KEY"],
    ["APPLE_MAPS_KEYID", "APPLE_MAPS_KEY_ID"],
    ["APPLE_SIGN_IN_KEY", "APPLE_SIGNIN_KEY"],
    ["APNS_PRIVATE_KEY", "APNS_KEY"],
    ["APNS_AUTH_KEY", "APNS_KEY"],
    ["STRIPE_API_KEY", "STRIPE_SECRET_KEY"],
    ["STRIPE_WEBHOOK_KEY", "STRIPE_WEBHOOK_SECRET"],
    ["GOOGLE_CLIENTID", "GOOGLE_CLIENT_ID"],
    ["RESEND_KEY", "RESEND_API_KEY"],
    ["LINK_SECRET", "LINK_CLIENT_SECRET"],
    ["ANTHROPIC_KEY", "ANTHROPIC_API_KEY"],
  ])("%s → did you mean %s?", (typo, meant) => {
    expect(suggestName(typo)).toBe(meant);
    expect(checkEnv({ ...MINIMAL, [typo]: "x" }).warnings).toContain(
      `${typo} is set, but the server doesn't read it — did you mean ${meant}?`,
    );
  });

  test("no guess when nothing is close; nothing said outside our prefixes", () => {
    expect(suggestName("STRIPE_TERMINAL_LOCATION_GROUP")).toBeUndefined();
    expect(checkEnv({ ...MINIMAL, STRIPE_TERMINAL_LOCATION_GROUP: "x" }).warnings).toEqual([
      "STRIPE_TERMINAL_LOCATION_GROUP is set, but the server doesn't read it",
    ]);
    expect(checkEnv({ ...MINIMAL, FLY_APP_NAME: "x", HOME: "/root" }).warnings).toEqual([]);
    expect(checkEnv({ ...MINIMAL, EXECUTOR_CAPTURE_DIR: "/tmp" }).warnings).toEqual([]);
  });
});

describe("check-secrets' view: names set, values unavailable", () => {
  test("unchecked names count as present and aren't content-checked", () => {
    const report = checkEnv(
      { ...MINIMAL, APPLE_MAPS_KEY: p8(), APPLE_MAPS_KEY_ID: "?", APPLE_MAPS_TEAM_ID: "?" },
      { unchecked: new Set(["APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID"]) },
    );
    expect(report.degraded).toEqual([]);
    expect(report.features.find((f) => f.id === "apple_maps")?.state).toBe("on");
  });
});

describe("boot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loadEnv returns a degraded report instead of exiting", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const report = loadEnv({ ...MINIMAL, APPLE_MAPS_KEY_ID: "MAPSKEY001" });
    expect(report.degraded).toEqual(["apple_maps"]);
    expect(exit).not.toHaveBeenCalled();
  });

  test("loadEnv exits on a core problem, listing it", () => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadEnv({ ...MINIMAL, AUTH_JWT_SECRET: undefined })).toThrow("exited");
    expect(error.mock.calls[0]![0]).toContain("AUTH_JWT_SECRET: required");
  });

  test("the boot log: one line per degraded feature, naming the variable, then what's on", () => {
    const log = bootLog(checkEnv({ ...MINIMAL, APPLE_MAPS_KEY_ID: "MAPSKEY001", X_Y: "z" }));
    expect(log.warn).toEqual([
      "config: apple_maps is off — APPLE_MAPS_KEY and APPLE_MAPS_TEAM_ID are not set, " +
        "but APPLE_MAPS_KEY_ID is; set all three or none",
    ]);
    expect(log.info).toMatch(/^config: on: parkwhiz; off: provider_accounts, live_payments, /);
  });
});
