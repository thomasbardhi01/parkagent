/**
 * FR-31 / FR-10 / FR-11 — the run gate. Everything else in fr/ shares
 * gate(); this file makes the gate's guarantees themselves assertions, so
 * a run against a misconfigured server fails loudly on the first file.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { frFetch, gate } from "./client.js";

let policyPayload: Record<string, unknown>;

beforeAll(async () => {
  policyPayload = await gate();
});

describe("FR-31 dry-run discipline", () => {
  it("FR-31 the target server reports effective dry run ON", () => {
    // gate() already threw if not; pin it as a test so the report shows it.
    expect(policyPayload["dryRun"]).toBe(true);
  });

  it("FR-31 /health answers without auth and echoes the dry-run switch", async () => {
    const res = await frFetch("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["dryRun"]).toBe(true);
  });
});

describe("FR-10 / FR-11 budget caps are configured", () => {
  it("FR-10 FR-11 the active policy carries the session cap, daily cap, and rate ceiling", () => {
    const policy = policyPayload["policy"] as Record<string, unknown>;
    expect(typeof policy["session_cap_usd"]).toBe("number");
    expect(typeof policy["daily_cap_usd"]).toBe("number");
    expect(typeof policy["auto_pay_max_rate_per_hour"]).toBe("number");
    expect(policy["session_cap_usd"] as number).toBeGreaterThan(0);
    expect(policy["daily_cap_usd"] as number).toBeGreaterThan(0);
    expect(typeof policyPayload["hash"]).toBe("string");
  });
});
