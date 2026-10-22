/**
 * An agent's street confirm meets the phone (WS-4 E3). The agent's
 * confirm (`pending_arrival`) creates no park; the park comes only from
 * the phone. When the phone's next /parked is in the zone /parked would
 * itself pay without asking (its candidates agree, the number known), that
 * zone is the plan's, inside the mandate's window, under the dry run the
 * agent was shown, for the plan's own person, it is held `confirmed` from
 * the start — the agent's confirm was the tap — with the phone's fix as
 * the car and the plan's stay quoted here, within the plan's price. It
 * then pays on the app's left_car, with no prompt. Anywhere else, later,
 * dearer, under another dry run, or for someone else: the ordinary prompt.
 * A plan binds once.
 */

import { describe, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import type { Quote } from "../src/services/quote.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  MOTT_A,
  MOTT_B,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
} from "./helpers.js";
import type { FakeDbState } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const U1 = { "x-api-key": API_KEY };
const OUTCOMES = ["garage", "nopay", "walk_away"];
const CAR = { lat: 40.7784, lng: -73.9819 };
/** Steinway's first hour ($2.00) and the pay-by-app fee ($0.15). */
const STEINWAY_HOUR_USD = 2.15;

/** The zone row a start prices from (as in parkedLifecycle.test.ts). */
const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  street: "30th Ave",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

function makeApp(opts: { candidates?: Candidate[]; dryRun?: boolean } = {}) {
  const clock = { now: new Date(NOW) };
  const real = opts.dryRun === false;
  const t = makeTestApp({
    candidates: opts.candidates ?? [STEINWAY_A],
    zones: [STEINWAY_ZONE],
    now: () => clock.now,
    ...(real ? { envDryRun: false, policy: { dry_run: false } } : {}),
  });
  return {
    ...t,
    clock,
    tick: (s: number) => (clock.now = new Date(clock.now.getTime() + s * 1000)),
  };
}

/** An agent of `userId` confirmed `zoneId` for an hour at `priceUsd`; its
 * mandate, consumed, minted under `dryRun`, expires `expiresInMs` from
 * now. */
function seedAgentPlan(
  state: FakeDbState,
  opts: {
    userId?: string;
    zoneId?: string;
    priceUsd?: number;
    expiresInMs?: number;
    dryRun?: boolean | null;
  } = {},
) {
  const userId = opts.userId ?? "u1";
  state.assistantPlans.push({
    id: "plan-a",
    userId,
    conversationId: "agent:ak1",
    kind: "single_spot",
    plan: {
      kind: "single_spot",
      options: [
        {
          id: "o1",
          type: "street",
          zoneId: opts.zoneId ?? STEINWAY_A.zoneId,
          priceUsd: opts.priceUsd ?? 3,
          durationMinutes: 60,
        },
      ],
    },
    createdAt: NOW,
    confirmedAt: NOW,
    confirmedOptionId: "o1",
  });
  state.mandates.push({
    token: "hash-plan-a",
    userId,
    planId: "plan-a",
    optionId: "o1",
    agentKeyId: "ak1",
    planHash: null,
    scopes: ["confirm"],
    capsSnapshot:
      opts.dryRun === null
        ? null
        : { sessionCapUsd: 45, dailyCapUsd: 60, dryRun: opts.dryRun ?? true },
    expiresAt: new Date(NOW.getTime() + (opts.expiresInMs ?? 10 * 60_000)),
    consumedAt: NOW,
    createdAt: NOW,
  });
}

async function park(t: ReturnType<typeof makeApp>, at: { lat?: number; lng?: number } = {}) {
  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: U1,
    payload: parkedBody({ outcomes: OUTCOMES, ts: t.clock.now.toISOString(), ...at }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const { parkedEventId } = res.json() as { parkedEventId: string };
  return t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!;
}

const fix = (t: ReturnType<typeof makeApp>, northM: number, extra: object = {}) => ({
  lat: CAR.lat + northM / 111_320,
  lng: CAR.lng,
  accuracy: 8,
  ts: t.clock.now.toISOString(),
  ...extra,
});

const bound = (t: ReturnType<typeof makeApp>) =>
  t.state.assistantPlans.find((p) => p.id === "plan-a")!.boundParkedEventId ?? null;

describe("binding the phone's park to an agent's confirmed spot", () => {
  test("the zone /parked would pay, in the window: held confirmed for the plan's stay, on the record, once", async () => {
    const t = makeApp();
    seedAgentPlan(t.state);
    const held = await park(t);
    expect(held.status).toBe("confirmed");
    expect(held.zoneId).toBe(STEINWAY_A.zoneId);
    // The phone's fix is the car, never the plan's spot.
    expect(held.carLat).toBeCloseTo(parkedBody().lat as number, 6);
    // The plan's hour, priced here now — not /parked's default stay.
    expect(held.quote as Quote).toMatchObject({ stayMinutes: 60, totalUsd: STEINWAY_HOUR_USD });
    expect(held.shownDryRun).toBe(true);
    const row = t.state.decisions.find((d) => d.rule === "agent_plan_bound")!;
    expect(row.inputs).toMatchObject({ planId: "plan-a", mandateId: "hash-plan-a" });
    expect(bound(t)).toBe(held.parkedEventId);
    // A second park, even at the same spot, is the ordinary one.
    t.tick(120);
    const again = await park(t);
    expect(again.status).toBe("at_car");
    expect(bound(t)).toBe(held.parkedEventId);
  });

  test("a spot dearer now than the plan said: the ordinary prompt, at its real price", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { priceUsd: 1 });
    expect((await park(t)).status).toBe("at_car");
    expect(bound(t)).toBeNull();
  });

  test("candidates that disagree never bind, on either side (#262 review)", async () => {
    for (const zoneId of [MOTT_B.zoneId, MOTT_A.zoneId]) {
      const t = makeApp({ candidates: [MOTT_A, MOTT_B] });
      seedAgentPlan(t.state, { zoneId, priceUsd: 40 });
      const held = await park(t, { lat: 40.718, lng: -73.9975 });
      expect(held.status, zoneId).toBe("at_car");
      expect(bound(t), zoneId).toBeNull();
    }
  });

  test("another zone than the plan's, even next door: the ordinary prompt", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { zoneId: "nyc-425957" });
    expect((await park(t)).status).toBe("at_car");
    expect(bound(t)).toBeNull();
  });

  test("minted under dry run, arriving under a real run: the ordinary prompt (#262 review)", async () => {
    const t = makeApp({ dryRun: false });
    seedAgentPlan(t.state, { dryRun: true });
    const held = await park(t);
    expect(held.status).toBe("at_car");
    expect(held.shownDryRun).toBe(false);
    expect(bound(t)).toBeNull();
  });

  test("a mandate that recorded no dry run binds nothing", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { dryRun: null });
    expect((await park(t)).status).toBe("at_car");
  });

  test("after the mandate's window: the ordinary prompt", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { expiresInMs: -1 });
    expect((await park(t)).status).toBe("at_car");
  });

  test("another person's agent plan binds nothing", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { userId: "u2" });
    expect((await park(t)).status).toBe("at_car");
    expect(bound(t)).toBeNull();
  });

  test("an app tap's plan (no agent key) binds nothing", async () => {
    const t = makeApp();
    seedAgentPlan(t.state);
    t.state.assistantPlans[0]!.conversationId = "c1";
    t.state.mandates[0]!.agentKeyId = null;
    expect((await park(t)).status).toBe("at_car");
  });

  test("a park that can't be written leaves the plan unbound", async () => {
    const t = makeApp();
    seedAgentPlan(t.state);
    const create = t.deps.db.pendingPark.create.bind(t.deps.db.pendingPark);
    t.deps.db.pendingPark.create = async () => {
      throw new Error("write failed");
    };
    const res = await t.app.inject({
      method: "POST",
      url: "/parked",
      headers: U1,
      payload: parkedBody({ outcomes: OUTCOMES, ts: t.clock.now.toISOString() }),
    });
    expect(res.statusCode).toBe(500);
    expect(bound(t)).toBeNull();
    t.deps.db.pendingPark.create = create;
  });

  test("a walk-away by distance alone asks; it never pays", async () => {
    const t = makeApp();
    seedAgentPlan(t.state);
    const held = await park(t);
    const post = (body: object) =>
      t.app.inject({ method: "POST", url: "/location", headers: U1, payload: body });
    t.tick(40);
    await post(fix(t, 60));
    t.tick(20);
    await post(fix(t, 90));
    expect(t.state.pendingParks.find((p) => p.id === held.id)!.status).toBe("prompted");
    expect(t.state.sessions).toHaveLength(0);
  });

  test("the app's left_car pays it, with no prompt: the plan's hour at its price (#262 review)", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { priceUsd: STEINWAY_HOUR_USD });
    const held = await park(t);
    const post = (body: object) =>
      t.app.inject({ method: "POST", url: "/location", headers: U1, payload: body });
    t.tick(40);
    await post(fix(t, 60));
    t.tick(20);
    const res = await post(fix(t, 90, { event: "left_car" }));
    expect(res.statusCode).toBe(200);
    expect(t.state.pendingParks.find((p) => p.id === held.id)!.status).toBe("started");
    expect(t.state.sessions).toHaveLength(1);
    const session = t.state.sessions[0]!;
    expect(session.zoneId).toBe(STEINWAY_A.zoneId);
    expect(session.expiresAt!.getTime() - session.startedAt!.getTime()).toBe(60 * 60_000);
    expect(Number(session.amountUsd) + Number(session.feeUsd)).toBeCloseTo(STEINWAY_HOUR_USD, 2);
  });
});
