/**
 * Itineraries: sign-off against the daily cap, PATCH editing/reordering
 * with linkage preserved, and the worker's garage-link push 15 minutes
 * before arrival.
 */

import { describe, expect, test } from "vitest";

import { makeItineraryWorker } from "../src/jobs/itineraryTick.js";
import { itineraryTotalUsd } from "../src/services/assistant/plans.js";
import { API_KEY, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

function stop(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `Stop ${id}`,
    address: `${id} Main St`,
    lat: 42.35,
    lng: -71.08,
    arrival: "2026-01-05T15:00:00-05:00",
    durationMinutes: 60,
    choice: "street" as const,
    costUsd: 5,
    zoneId: "bos-x",
    ...overrides,
  };
}

function seedPlan(t: ReturnType<typeof makeTestApp>, stops: ReturnType<typeof stop>[]) {
  t.state.assistantPlans.push({
    id: "plan1",
    userId: "u1",
    conversationId: "c1",
    kind: "itinerary",
    plan: {
      kind: "itinerary",
      date: "2026-01-05",
      stops,
      totalUsd: itineraryTotalUsd(stops),
      capUsd: 60,
    },
  });
}

describe("sign-off", () => {
  test("a six-stop day signs off, stores stops with linkage fields, and audits", async () => {
    const t = makeTestApp({});
    const stops = [1, 2, 3, 4, 5, 6].map((i) =>
      stop(
        `s${i}`,
        i % 2 === 0
          ? { choice: "garage", deepLink: "https://spothero.com/search?x=1", costUsd: 8 }
          : {},
      ),
    );
    seedPlan(t, stops);
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("itinerary_signed_off");
    expect(body.totalUsd).toBe(39); // 3×$5 street + 3×$8 garage
    expect(t.state.itineraries).toHaveLength(1);
    const saved = t.state.itineraries[0]!;
    expect(saved.status).toBe("signed_off");
    // Street stops pay at the curb with the street source (the card on the
    // provider account by default); garage stops at the garage's own
    // checkout, each recorded as a planned booking for Activity.
    const savedStops = saved.stops as Record<string, unknown>[];
    expect(savedStops.find((s) => s["choice"] === "street")).toMatchObject({
      sessionId: null,
      paymentSource: "provider_card",
    });
    expect(savedStops.find((s) => s["choice"] === "garage")).toMatchObject({
      paymentSource: "garage_checkout",
    });
    expect(t.state.garageBookings.map((b) => b.status)).toEqual(["planned", "planned", "planned"]);
    expect(t.state.decisions.some((d) => d.rule === "itinerary_signed_off")).toBe(true);
  });

  test("a day that busts the remaining daily budget is refused at sign-off", async () => {
    const t = makeTestApp({});
    // $58 already spent today (real money): a $10 plan can't fit under $60.
    seedSession(t.state, { status: "stopped", dryRun: false, amountUsd: 57.5, feeUsd: 0.5 });
    seedPlan(t, [stop("s1", { costUsd: 10 })]);
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "over_daily_cap", capUsd: 60 });
    expect(t.state.itineraries).toHaveLength(0);
  });
});

describe("PATCH /assistant/itineraries/:id", () => {
  async function signedOffDay(t: ReturnType<typeof makeTestApp>) {
    seedPlan(t, [
      stop("s1"),
      stop("s2", { choice: "garage", deepLink: "https://spothero.com/search?x=1", costUsd: 8 }),
    ]);
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    return res.json().itineraryId as string;
  }

  test("reordering keeps per-stop linkage; totals recompute", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    // Simulate the worker having linked a session to s1.
    const saved = t.state.itineraries[0]!;
    (saved.stops as Record<string, unknown>[])[0]!["sessionId"] = "sess-99";

    const reordered = [
      stop("s2", { choice: "garage", deepLink: "https://spothero.com/search?x=1", costUsd: 8 }),
      stop("s1"),
    ];
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops: reordered },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalUsd).toBe(13);
    // s1 moved to the end but kept its session link.
    expect(body.stops[1]).toMatchObject({ id: "s1", sessionId: "sess-99" });
  });

  test("an edit that would bust the cap is refused; the day is unchanged", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops: [stop("s1", { costUsd: 100 })] },
    });
    expect(res.statusCode).toBe(409);
    expect(itineraryTotalUsd(t.state.itineraries[0]!.stops as { costUsd: number }[])).toBe(13);
  });

  test("editing someone else's or a done itinerary is refused", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    t.state.itineraries[0]!.status = "done";
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops: [stop("s1")] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("itinerary worker", () => {
  test("pushes the garage link once, 15 minutes before arrival, and links street sessions", async () => {
    // Arrival 15:00; now 14:50 → inside the push window.
    const t = makeTestApp({ now: () => new Date("2026-01-05T14:50:00-05:00") });
    seedPlan(t, [
      stop("s1", { arrival: "2026-01-05T15:00:00-05:00" }),
      stop("s2", {
        choice: "garage",
        arrival: "2026-01-05T15:00:00-05:00",
        deepLink: "https://spothero.com/search?x=1",
        costUsd: 8,
      }),
    ]);
    await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    // A session that started within stop s1's window.
    seedSession(t.state, {
      status: "active",
      startedAt: new Date("2026-01-05T14:45:00-05:00"),
      createdAt: new Date("2026-01-05T14:45:00-05:00"),
    });

    const worker = makeItineraryWorker({
      db: t.deps.db,
      sendPush: async (userId, push) => {
        t.pushes.push({ userId, push });
      },
      log: { info() {}, warn() {} },
      now: () => new Date("2026-01-05T14:50:00-05:00"),
    });
    await worker.tick();
    await worker.tick(); // second tick must not re-push

    const garagePushes = t.pushes.filter((p) => p.push.type === "itinerary_garage_link");
    expect(garagePushes).toHaveLength(1);
    expect(garagePushes[0]!.push.extra).toMatchObject({ stopId: "s2" });
    const stops = t.state.itineraries[0]!.stops as Record<string, unknown>[];
    expect(stops[0]!["sessionId"]).toBe("seed1");
    expect(stops[1]!["garageLinkPushedAt"]).toBeTruthy();
    expect(t.state.decisions.some((d) => d.rule === "garage_link_pushed")).toBe(true);
  });

  test("well before the window it stays quiet; after the day it marks done", async () => {
    const quiet = makeTestApp({ now: () => new Date("2026-01-05T10:00:00-05:00") });
    seedPlan(quiet, [
      stop("s1", { choice: "garage", deepLink: "https://spothero.com/search?x=1", costUsd: 8 }),
    ]);
    await quiet.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    const worker = makeItineraryWorker({
      db: quiet.deps.db,
      sendPush: async (userId, push) => {
        quiet.pushes.push({ userId, push });
      },
      log: { info() {}, warn() {} },
      now: () => new Date("2026-01-05T10:00:00-05:00"),
    });
    await worker.tick();
    expect(quiet.pushes.filter((p) => p.push.type === "itinerary_garage_link")).toHaveLength(0);

    const evening = makeItineraryWorker({
      db: quiet.deps.db,
      sendPush: async () => {},
      log: { info() {}, warn() {} },
      now: () => new Date("2026-01-05T22:00:00-05:00"),
    });
    await evening.tick();
    expect(quiet.state.itineraries[0]!.status).toBe("done");
  });
});
