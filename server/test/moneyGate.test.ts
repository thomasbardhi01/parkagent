/**
 * The one money gate (services/moneyGate.ts): every rule, for every actor.
 * A person, the owner's key and a background job get the same answer from
 * the same facts; an external agent gets `agents_not_allowed` before any
 * fact is read, until the person has said agents may act, and then the
 * same answer as the person.
 */

import { describe, expect, test } from "vitest";

import type { PendingParkRow } from "../src/db.js";
import { providerForCity } from "../src/providers/registry.js";
import type { GateIntent, GateResult } from "../src/services/moneyGate.js";
import { moneyGate, spentToday } from "../src/services/moneyGate.js";
import type { Principal } from "../src/services/principal.js";
import { jobPrincipal, userPrincipal } from "../src/services/principal.js";
import type { StayPrice } from "../src/services/quote.js";
import {
  MONDAY_2PM,
  makeFakeDb,
  makePolicyService,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";

const AT = new Date(MONDAY_2PM);
const NYC = providerForCity("nyc");

function price(totalUsd: number): StayPrice {
  return { stayMinutes: 60, chargedMinutes: 60, meterUsd: totalUsd, feeUsd: 0, totalUsd };
}

/** A gate over a fresh fake DB: caps $10 per stop and $20 per day, dry run
 * off unless a test says so, u2 with a linked ParkNYC account. */
function makeGate(opts: { dryRun?: boolean } = {}) {
  const { db, state } = makeFakeDb();
  seedProviderAccount(state, { userId: "u2" });
  const policy = makePolicyService(
    {
      session_cap_usd: 10,
      daily_cap_usd: 20,
      auto_pay_max_rate_per_hour: 5,
      dry_run: opts.dryRun ?? false,
    },
    false,
  );
  const deps = { db, policy };
  const spend = (usd: number, dryRun = false) =>
    seedSession(state, { userId: "u2", status: "stopped", amountUsd: usd, dryRun });
  return {
    deps,
    state,
    spend,
    gate: (principal: Principal, intent: GateIntent): Promise<GateResult> =>
      moneyGate(deps, principal, intent, AT),
  };
}

const USER = userPrincipal({ id: "u2", isAdmin: false });
const ADMIN: Principal = { userId: "u2", actor: "admin", scopes: new Set(["read", "confirm"]) };
const JOB = jobPrincipal("u2");
const AGENT: Principal = {
  userId: "u2",
  actor: "external_agent",
  agentKeyId: "k1",
  scopes: new Set(["confirm"]),
};

const start = (over: Partial<Extract<GateIntent, { kind: "start" }>> = {}): GateIntent => ({
  kind: "start",
  provider: NYC,
  zoneNumber: "1234",
  minutes: 60,
  maxStayMinutes: 120,
  price: price(4),
  ...over,
});

/** Every rule, as (intent, the rule it must refuse with, how to set it up). */
const RULES: {
  name: string;
  intent: GateIntent;
  rule: GateResult["rule"];
  setup?: (g: ReturnType<typeof makeGate>) => void;
}[] = [
  {
    name: "start: provider not linked",
    intent: start(),
    rule: "provider_not_linked",
    setup: (g) => g.state.providerAccounts.splice(0),
  },
  {
    name: "start: provider link expired",
    intent: start(),
    rule: "provider_not_linked",
    setup: (g) => {
      g.state.providerAccounts[0]!.status = "expired";
    },
  },
  {
    name: "start: zone number unknown",
    intent: start({ zoneNumber: "" }),
    rule: "needs_zone_number",
  },
  { name: "start: over max stay", intent: start({ minutes: 121 }), rule: "max_stay_exceeded" },
  { name: "start: free window", intent: start({ price: price(0) }), rule: "free_period" },
  {
    name: "start: over the per-stop cap",
    intent: start({ price: price(10.01) }),
    rule: "session_cap_exceeded",
  },
  {
    name: "start: over the daily cap",
    intent: start({ price: price(4) }),
    rule: "daily_cap_exceeded",
    setup: (g) => g.spend(16.5),
  },
  {
    name: "start: costs more than the tap was shown",
    intent: start({ shown: { maxTotalUsd: 3.5 } }),
    rule: "quote_changed",
  },
  {
    name: "start: a different zone number than shown",
    intent: start({ shown: { zoneNumber: "9999" } }),
    rule: "zone_number_changed",
  },
  {
    name: "start: shown as a dry run, would charge",
    intent: start({ shown: { dryRun: true } }),
    rule: "dry_run_changed",
  },
  {
    name: "quote: free window",
    intent: { kind: "quote", totalUsd: 0, ladderMaxRateUsd: 2 },
    rule: "free_period",
  },
  {
    name: "quote: rate above the auto-pay ceiling",
    intent: { kind: "quote", totalUsd: 4, ladderMaxRateUsd: 5.5 },
    rule: "rate_above_ceiling",
  },
  {
    name: "quote: over the per-stop cap",
    intent: { kind: "quote", totalUsd: 11, ladderMaxRateUsd: 2 },
    rule: "session_cap_exceeded",
  },
  {
    name: "quote: over the daily cap",
    intent: { kind: "quote", totalUsd: 4, ladderMaxRateUsd: 2 },
    rule: "daily_cap_exceeded",
    setup: (g) => g.spend(17),
  },
  {
    name: "prompt: provider not linked",
    intent: { kind: "prompt", provider: NYC, zoneNumber: "1234", totalUsd: 4 },
    rule: "provider_not_linked",
    setup: (g) => g.state.providerAccounts.splice(0),
  },
  {
    name: "prompt: zone number unknown",
    intent: { kind: "prompt", provider: NYC, zoneNumber: "", totalUsd: 4 },
    rule: "needs_zone_number",
  },
  {
    name: "prompt: over the per-stop cap",
    intent: { kind: "prompt", provider: NYC, zoneNumber: "1234", totalUsd: 10.5 },
    rule: "session_cap_exceeded",
  },
  {
    name: "prompt: over the daily cap",
    intent: { kind: "prompt", provider: NYC, zoneNumber: "1234", totalUsd: 4 },
    rule: "daily_cap_exceeded",
    setup: (g) => g.spend(17),
  },
  {
    name: "plan: a stop over the per-stop cap",
    intent: { kind: "plan", stopsUsd: [3, 12], totalUsd: 15, perStop: true },
    rule: "session_cap_exceeded",
  },
  {
    name: "plan: the day over the daily cap with pending approvals",
    intent: { kind: "plan", stopsUsd: [8], totalUsd: 8, pendingUsd: 9, perStop: true },
    rule: "daily_cap_exceeded",
    setup: (g) => g.spend(4),
  },
  {
    name: "plan: a day over the daily cap",
    intent: { kind: "plan", stopsUsd: [], totalUsd: 21, perStop: false },
    rule: "daily_cap_exceeded",
  },
  {
    name: "funding: amount over the daily cap",
    intent: { kind: "funding", amountUsd: 20.5 },
    rule: "amount_over_daily_cap",
  },
];

const ALLOWED: { name: string; intent: GateIntent }[] = [
  { name: "start", intent: start() },
  { name: "quote", intent: { kind: "quote", totalUsd: 4, ladderMaxRateUsd: 2 } },
  { name: "prompt", intent: { kind: "prompt", provider: NYC, zoneNumber: "1234", totalUsd: 4 } },
  { name: "plan", intent: { kind: "plan", stopsUsd: [3, 4], totalUsd: 7, perStop: true } },
  { name: "funding", intent: { kind: "funding", amountUsd: 20 } },
  { name: "stop", intent: { kind: "stop" } },
];

describe.each([
  ["a user", USER],
  ["the admin key", ADMIN],
  ["a job", JOB],
])("%s", (_who, principal) => {
  test.each(RULES.map((r) => [r.name, r] as const))("%s", async (_name, r) => {
    const g = makeGate();
    r.setup?.(g);
    const result = await g.gate(principal, r.intent);
    expect(result.ok).toBe(false);
    expect(result.rule).toBe(r.rule);
  });

  test.each(ALLOWED.map((a) => [a.name, a] as const))("%s within every rule", async (_n, a) => {
    const g = makeGate();
    const result = await g.gate(principal, a.intent);
    expect(result).toMatchObject({ ok: true, rule: null, dryRun: false });
    expect(result.policy.session_cap_usd).toBe(10);
  });
});

describe("an external agent", () => {
  test.each(ALLOWED.map((a) => [a.name, a] as const))(
    "is refused a %s before any fact is read, until the person consents",
    async (_n, a) => {
      const g = makeGate();
      const refused = await g.gate(AGENT, a.intent);
      expect(refused).toMatchObject({ ok: false, rule: "agents_not_allowed", spentTodayUsd: 0 });
      g.state.users.find((u) => u.id === "u2")!.agentsMayAct = true;
      const allowed = await g.gate(AGENT, a.intent);
      expect(allowed).toMatchObject({ ok: true, rule: null });
    },
  );

  test("with consent, gets the person's own refusals", async () => {
    const g = makeGate();
    g.state.users.find((u) => u.id === "u2")!.agentsMayAct = true;
    g.spend(17);
    expect((await g.gate(AGENT, start())).rule).toBe("daily_cap_exceeded");
    expect((await g.gate(AGENT, start({ price: price(11) }))).rule).toBe("session_cap_exceeded");
  });

  test("consent is the person's, not another user's", async () => {
    const g = makeGate();
    g.state.users.find((u) => u.id === "u1")!.agentsMayAct = true;
    expect((await g.gate(AGENT, start())).rule).toBe("agents_not_allowed");
  });
});

describe("the gate's order and facts", () => {
  test("a start meets its refusals in the start path's order", async () => {
    // Everything wrong at once: the provider link comes first, then the
    // zone number, max stay, the caps, and only then what was shown.
    const g = makeGate();
    g.spend(19);
    const everything = start({
      zoneNumber: "",
      minutes: 500,
      price: price(11),
      shown: { maxTotalUsd: 1 },
    });
    g.state.providerAccounts.splice(0);
    expect((await g.gate(USER, everything)).rule).toBe("provider_not_linked");
    seedProviderAccount(g.state, { userId: "u2" });
    expect((await g.gate(USER, everything)).rule).toBe("needs_zone_number");
    expect((await g.gate(USER, { ...everything, zoneNumber: "1" })).rule).toBe("max_stay_exceeded");
    expect((await g.gate(USER, { ...everything, zoneNumber: "1", minutes: 60 })).rule).toBe(
      "session_cap_exceeded",
    );
    expect(
      (await g.gate(USER, { ...everything, zoneNumber: "1", minutes: 60, price: price(4) })).rule,
    ).toBe("daily_cap_exceeded");
  });

  test("reports the facts it judged on", async () => {
    const g = makeGate();
    g.spend(3.25);
    const result = await g.gate(USER, start());
    expect(result).toMatchObject({ ok: true, spentTodayUsd: 3.25, accountStatus: "linked" });
  });

  test("under a dry run, dry-run spend counts toward the daily cap (#226)", async () => {
    const g = makeGate({ dryRun: true });
    g.spend(17, true);
    const result = await g.gate(USER, start());
    expect(result).toMatchObject({ ok: false, rule: "daily_cap_exceeded", dryRun: true });
    // For real, only real money counts.
    const real = makeGate();
    real.spend(17, true);
    expect((await real.gate(USER, start())).ok).toBe(true);
    expect(await spentToday(real.deps.db, "u2", AT)).toBe(0);
    expect(await spentToday(real.deps.db, "u2", AT, { dryRun: true })).toBe(17);
  });

  test("a funding move is an amount-only ceiling: today's spend is not read", async () => {
    const g = makeGate();
    g.spend(19.5);
    expect(await g.gate(USER, { kind: "funding", amountUsd: 20 })).toMatchObject({
      ok: true,
      spentTodayUsd: 0,
    });
  });
});

describe("extend", () => {
  function session(g: ReturnType<typeof makeGate>, over: Parameters<typeof seedSession>[1] = {}) {
    return seedSession(g.state, {
      userId: "u2",
      status: "active",
      dryRun: false,
      amountUsd: 6,
      purchasedMinutes: 60,
      maxStayMinutes: 120,
      ...over,
    });
  }
  const extend = (
    s: ReturnType<typeof seedSession>,
    over: Partial<Extract<GateIntent, { kind: "extend" }>> = {},
  ): GateIntent => ({
    kind: "extend",
    session: s,
    minutes: 30,
    price: price(3),
    source: "manual",
    ...over,
  });

  test.each([
    ["a user", USER],
    ["a job", JOB],
  ])(
    "%s: max stay, then the session's own spend against the per-stop cap, then the day",
    async (_w, p) => {
      const g = makeGate();
      const s = session(g);
      expect((await g.gate(p, extend(s, { minutes: 61 }))).rule).toBe("max_stay_exceeded");
      expect((await g.gate(p, extend(s, { price: price(4.01) }))).rule).toBe(
        "session_cap_exceeded",
      );
      g.spend(12);
      expect((await g.gate(p, extend(s))).rule).toBe("daily_cap_exceeded");
      g.state.sessions.splice(1);
      expect((await g.gate(p, extend(s))).ok).toBe(true);
    },
  );

  test("under the lock, an auto extension needs the phone away", async () => {
    const g = makeGate();
    const s = session(g);
    const park: PendingParkRow = {
      id: "p1",
      userId: "u2",
      parkedEventId: null,
      status: "started",
      candidates: null,
      quote: null,
      prompt: null,
      shownDryRun: null,
      zoneId: null,
      carLat: 0,
      carLng: 0,
      parkedAt: AT,
      leftCarAt: AT,
      farAt: null,
      farDistanceM: null,
      nearSince: null,
      atCarSince: null,
      backAt: AT,
      driveAt: null,
      driveDistanceM: null,
      driveSpeedMps: null,
      promptedAt: null,
      confirmedAt: null,
      startingAt: null,
      sessionId: s.id,
      carMovedAt: null,
      closedAt: null,
      createdAt: AT,
    };
    g.state.pendingParks.push(park);
    // Priced before the lock: the phone's position isn't this call's to read.
    expect((await g.gate(JOB, extend(s, { source: "auto" }))).ok).toBe(true);
    // Under it, a phone back at the car buys nothing…
    expect((await g.gate(JOB, extend(s, { source: "auto", underLock: true }))).rule).toBe(
      "phone_not_away",
    );
    // …and a person extending by hand from the seat may.
    expect((await g.gate(USER, extend(s, { source: "manual", underLock: true }))).ok).toBe(true);
    park.backAt = null;
    park.carMovedAt = AT;
    expect((await g.gate(JOB, extend(s, { source: "auto", underLock: true }))).rule).toBe(
      "phone_not_away",
    );
    park.carMovedAt = null;
    expect((await g.gate(JOB, extend(s, { source: "auto", underLock: true }))).ok).toBe(true);
  });
});
