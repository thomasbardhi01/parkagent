/**
 * An agent's street confirm meets the phone (WS-4 E3). The agent's
 * confirm (`pending_arrival`) is consent and a cap for a spot, never a
 * park; the park comes only from the phone. When the phone's next /parked
 * is at that spot (within SAME_SPOT_M of the plan's zone) and inside the
 * mandate's window, for the plan's own person, it is held `confirmed`
 * from the start — the agent's confirm was the tap — with the phone's fix
 * as the car and the lower of the plan's amount and the quote as the
 * shown cap. It then starts only on the app's left_car, like any
 * confirmed park. Anywhere else, later, or for someone else: the ordinary
 * prompt. A plan binds once.
 */

import { describe, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import type { Quote } from "../src/services/quote.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
} from "./helpers.js";
import type { FakeDbState } from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const U1 = { "x-api-key": API_KEY };
const OUTCOMES = ["garage", "nopay", "walk_away"];
const CAR = { lat: 40.7784, lng: -73.9819 };

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

function makeApp(candidates = [STEINWAY_A]) {
  const clock = { now: new Date(NOW) };
  const t = makeTestApp({ candidates, zones: [STEINWAY_ZONE], now: () => clock.now });
  return {
    ...t,
    clock,
    tick: (s: number) => (clock.now = new Date(clock.now.getTime() + s * 1000)),
  };
}

/** An agent of `userId` confirmed the Steinway spot for `priceUsd`; its
 * mandate, consumed, expires `expiresInMs` from now. */
function seedAgentPlan(
  state: FakeDbState,
  opts: { userId?: string; priceUsd?: number; expiresInMs?: number; id?: string } = {},
) {
  const id = opts.id ?? "plan-a";
  const userId = opts.userId ?? "u1";
  state.assistantPlans.push({
    id,
    userId,
    conversationId: "agent:ak1",
    kind: "single_spot",
    plan: {
      kind: "single_spot",
      options: [
        {
          id: "o1",
          type: "street",
          zoneId: STEINWAY_A.zoneId,
          priceUsd: opts.priceUsd ?? 1.5,
          durationMinutes: 60,
        },
      ],
    },
    createdAt: NOW,
    confirmedAt: NOW,
    confirmedOptionId: "o1",
  });
  state.mandates.push({
    token: `hash-${id}`,
    userId,
    planId: id,
    optionId: "o1",
    agentKeyId: "ak1",
    planHash: null,
    scopes: ["confirm"],
    capsSnapshot: null,
    expiresAt: new Date(NOW.getTime() + (opts.expiresInMs ?? 10 * 60_000)),
    consumedAt: NOW,
    createdAt: NOW,
  });
}

async function park(t: ReturnType<typeof makeApp>, headers = U1) {
  const res = await t.app.inject({
    method: "POST",
    url: "/parked",
    headers,
    payload: parkedBody({ outcomes: OUTCOMES, ts: t.clock.now.toISOString() }),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { parkedEventId: string };
}

const fix = (t: ReturnType<typeof makeApp>, northM: number, extra: object = {}) => ({
  lat: CAR.lat + northM / 111_320,
  lng: CAR.lng,
  accuracy: 8,
  ts: t.clock.now.toISOString(),
  ...extra,
});

describe("binding the phone's park to an agent's confirmed spot", () => {
  test("inside the window, at the spot: held confirmed, capped, on the record, bound once", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { priceUsd: 0.75 });
    const { parkedEventId } = await park(t);
    const held = t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!;
    expect(held.status).toBe("confirmed");
    expect(held.zoneId).toBe(STEINWAY_A.zoneId);
    // The phone's fix is the car, never the plan's spot.
    expect(held.carLat).toBeCloseTo(parkedBody().lat as number, 6);
    // The shown cap is the lower of the plan's amount and the quote.
    expect((held.quote as Quote).totalUsd).toBe(0.75);
    const row = t.state.decisions.find((d) => d.rule === "agent_plan_bound")!;
    expect(row.inputs).toMatchObject({ planId: "plan-a", mandateId: "hash-plan-a" });
    const plan = t.state.assistantPlans.find((p) => p.id === "plan-a")!;
    expect(plan.boundParkedEventId).toBe(parkedEventId);
    // A second park, even at the same spot, is the ordinary one.
    t.tick(120);
    const second = await park(t);
    const again = t.state.pendingParks.find((p) => p.parkedEventId === second.parkedEventId)!;
    expect(again.status).toBe("at_car");
    expect(t.state.assistantPlans.find((p) => p.id === "plan-a")!.boundParkedEventId).toBe(
      parkedEventId,
    );
  });

  test("the cap is the quote when the plan said more", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { priceUsd: 99 });
    const { parkedEventId } = await park(t);
    const held = t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!;
    const quoted = t.state.decisions.find(
      (d) => d.kind === "parked_quote" && d.parkedEventId === parkedEventId,
    )!.outcome["quote"] as Quote;
    expect((held.quote as Quote).totalUsd).toBe(quoted.totalUsd);
  });

  test("beyond SAME_SPOT_M of the plan's zone: the ordinary prompt", async () => {
    const t = makeApp([{ ...STEINWAY_A, distanceM: 150 }]);
    seedAgentPlan(t.state);
    const { parkedEventId } = await park(t);
    expect(t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!.status).toBe(
      "at_car",
    );
    expect(t.state.assistantPlans[0]!.boundParkedEventId ?? null).toBeNull();
  });

  test("after the mandate's window: the ordinary prompt", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { expiresInMs: -1 });
    const { parkedEventId } = await park(t);
    expect(t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!.status).toBe(
      "at_car",
    );
  });

  test("another person's agent plan binds nothing", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { userId: "u2" });
    const { parkedEventId } = await park(t);
    expect(t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!.status).toBe(
      "at_car",
    );
    expect(t.state.assistantPlans[0]!.boundParkedEventId ?? null).toBeNull();
    void NONADMIN_API_KEY;
  });

  test("an app tap's plan (no agent key) binds nothing", async () => {
    const t = makeApp();
    seedAgentPlan(t.state);
    t.state.assistantPlans[0]!.conversationId = "c1";
    t.state.mandates[0]!.agentKeyId = null;
    const { parkedEventId } = await park(t);
    expect(t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!.status).toBe(
      "at_car",
    );
  });

  test("the bound park starts only on the app's left_car, like any confirmed park", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { priceUsd: 5 });
    const { parkedEventId } = await park(t);
    const post = (body: object) =>
      t.app.inject({ method: "POST", url: "/location", headers: U1, payload: body });
    // A walk-away by distance alone asks again; it never pays.
    t.tick(40);
    await post(fix(t, 60));
    t.tick(20);
    await post(fix(t, 90));
    const after = t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!;
    expect(after.status).toBe("prompted");
    expect(t.state.sessions).toHaveLength(0);
  });

  test("…and the app's left_car starts it, for no more than the cap", async () => {
    const t = makeApp();
    seedAgentPlan(t.state, { priceUsd: 5 });
    const { parkedEventId } = await park(t);
    const post = (body: object) =>
      t.app.inject({ method: "POST", url: "/location", headers: U1, payload: body });
    t.tick(40);
    await post(fix(t, 60));
    t.tick(20);
    const res = await post(fix(t, 90, { event: "left_car" }));
    expect(res.statusCode).toBe(200);
    const after = t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)!;
    expect(after.status).toBe("started");
    expect(t.state.sessions).toHaveLength(1);
  });
});
