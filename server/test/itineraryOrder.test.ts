/**
 * Itinerary stop order: stops show — and are stored — in arrival order;
 * a stop with no set time keeps the slot the user put it in; clearing a
 * time is an edit (PATCH), never something the model can do.
 */

import { describe, expect, test } from "vitest";

import { makeItineraryWorker } from "../src/jobs/itineraryTick.js";
import type { ItineraryPlan } from "../src/services/assistant/plans.js";
import { itineraryTotalUsd, orderStopsByArrival } from "../src/services/assistant/plans.js";
import { API_KEY, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const GARAGE_LINK = "https://spothero.com/search?x=1";

function stop(id: string, arrival: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `Stop ${id}`,
    address: `${id} Main St`,
    lat: 42.35,
    lng: -71.08,
    arrival,
    durationMinutes: 60,
    choice: "street" as const,
    costUsd: 5,
    zoneId: "bos-x",
    ...overrides,
  };
}

const at = (hhmm: string) => `2026-01-05T${hhmm}:00-05:00`;

/** Every ordering of `items` (small n only). */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

/** A later timed stop never sits above an earlier one. */
function timedAscending(stops: { arrival: string | null }[]): boolean {
  const times = stops.filter((s) => s.arrival).map((s) => new Date(s.arrival!).getTime());
  return times.every((t, i) => i === 0 || times[i - 1]! <= t);
}

describe("orderStopsByArrival", () => {
  // Two untimed, three timed, and a tie between two of the timed ones.
  const mixed = [
    stop("a", at("09:00")),
    stop("b", at("11:00")),
    stop("c", at("11:00")),
    stop("u1", null),
    stop("u2", null),
  ];

  test("every input order comes out ascending, untimed stops in their own slots", () => {
    for (const input of permutations(mixed)) {
      const out = orderStopsByArrival(input);
      expect(out).toHaveLength(input.length);
      expect(new Set(out.map((s) => s.id))).toEqual(new Set(input.map((s) => s.id)));
      expect(timedAscending(out)).toBe(true);
      input.forEach((s, i) => {
        if (s.arrival === null) expect(out[i]!.id).toBe(s.id);
      });
      // Ties keep their relative order.
      const tie = input.filter((s) => s.id === "b" || s.id === "c").map((s) => s.id);
      expect(out.filter((s) => s.id === "b" || s.id === "c").map((s) => s.id)).toEqual(tie);
    }
  });

  test("offsets are honored: 10:30 ET sorts before 16:00Z (11:00 ET)", () => {
    const out = orderStopsByArrival([
      stop("late", "2026-01-05T16:00:00Z"),
      stop("early", "2026-01-05T10:30:00-05:00"),
    ]);
    expect(out.map((s) => s.id)).toEqual(["early", "late"]);
  });
});

describe("propose_plan stores an itinerary in arrival order", () => {
  test("stops the model listed out of order come back sorted", async () => {
    const t = makeTestApp({ now: () => new Date("2026-01-05T08:00:00-05:00") });
    const stops = [stop("s3", at("15:00")), stop("s1", at("09:00")), stop("s2", at("12:00"))];
    const out = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      {
        plan: {
          kind: "itinerary",
          date: "2026-01-05",
          stops,
          totalUsd: itineraryTotalUsd(stops),
          capUsd: 60,
        },
      },
    );
    const plan = out.endTurn!.plan as ItineraryPlan;
    expect(plan.stops.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("PATCH clears a time and keeps the day in order", () => {
  async function signedOffDay(t: ReturnType<typeof makeTestApp>) {
    const stops = [
      stop("s1", at("09:00")),
      stop("s2", at("12:00"), { choice: "garage", deepLink: GARAGE_LINK, costUsd: 8 }),
      stop("s3", at("15:00")),
    ];
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
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    return res.json().itineraryId as string;
  }

  test("a cleared time is stored as null, where the user placed it", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    // s2 lost its time and was dragged to the top.
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: {
        stops: [
          stop("s2", null, { choice: "garage", deepLink: GARAGE_LINK, costUsd: 8 }),
          stop("s1", at("09:00")),
          stop("s3", at("15:00")),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stops.map((s: { id: string }) => s.id)).toEqual(["s2", "s1", "s3"]);
    const saved = t.state.itineraries[0]!.stops as Record<string, unknown>[];
    expect(saved[0]).toMatchObject({ id: "s2", arrival: null });
    const decision = t.state.decisions.find((d) => d.rule === "itinerary_edited");
    expect(decision?.inputs).toMatchObject({ untimedStops: 1 });
  });

  test("an omitted arrival is a cleared time too", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    const untimed: Record<string, unknown> = stop("s1", null);
    delete untimed["arrival"];
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops: [untimed, stop("s3", at("15:00"))] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stops[0]).toMatchObject({ id: "s1", arrival: null });
  });

  test("a client can't store a later stop above an earlier one", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    // s1's time moved to 16:00; the client sent it still on top.
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: {
        stops: [
          stop("s1", at("16:00")),
          stop("s2", at("12:00"), { choice: "garage", deepLink: GARAGE_LINK, costUsd: 8 }),
          stop("s3", at("15:00")),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stops.map((s: { id: string }) => s.id)).toEqual(["s2", "s3", "s1"]);
    // Stored in the canonical ET form sign-off uses, whatever the client sent.
    const utc = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops: [stop("s1", "2026-01-05T21:00:00Z")] },
    });
    expect(utc.json().stops[0].arrival).toBe("2026-01-05T16:00:00-05:00");
  });

  test("an unreadable time is refused; the day is unchanged", async () => {
    const t = makeTestApp({});
    const id = await signedOffDay(t);
    const res = await t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops: [stop("s1", "after lunch")] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unreadable_time", stopId: "s1" });
    expect((t.state.itineraries[0]!.stops as unknown[]).length).toBe(3);
  });

  test("GET returns a day stored out of order in arrival order", async () => {
    const t = makeTestApp({});
    await signedOffDay(t);
    const saved = t.state.itineraries[0]!;
    saved.stops = [...(saved.stops as unknown[])].reverse();
    const res = await t.app.inject({
      method: "GET",
      url: "/assistant/itineraries",
      headers: HEADERS,
    });
    const day = res.json().itineraries[0] as { stops: { id: string }[] };
    expect(day.stops.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("the worker skips stops with no set time", () => {
  async function dayWith(t: ReturnType<typeof makeTestApp>, stops: ReturnType<typeof stop>[]) {
    t.state.assistantPlans.push({
      id: "plan1",
      userId: "u1",
      conversationId: "c1",
      kind: "itinerary",
      plan: {
        kind: "itinerary",
        date: "2026-01-05",
        stops: stops.map((s) => ({ ...s, arrival: s.arrival ?? at("12:00") })),
        totalUsd: itineraryTotalUsd(stops),
        capUsd: 60,
      },
    });
    await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    // The user then cleared the times the fixture asks for (null).
    const saved = t.state.itineraries[0]!.stops as Record<string, unknown>[];
    stops.forEach((s, i) => {
      if (s.arrival === null) saved[i]!["arrival"] = null;
    });
  }

  function worker(t: ReturnType<typeof makeTestApp>, now: string) {
    return makeItineraryWorker({
      db: t.deps.db,
      sendPush: async (userId, push) => {
        t.pushes.push({ userId, push });
      },
      log: { info() {}, warn() {} },
      now: () => new Date(now),
    });
  }

  test("no garage push and no session attached for an untimed stop", async () => {
    const t = makeTestApp({});
    await dayWith(t, [
      stop("g", null, { choice: "garage", deepLink: GARAGE_LINK, costUsd: 8 }),
      stop("s", null),
      stop("twin", at("12:00"), { choice: "garage", deepLink: GARAGE_LINK, costUsd: 8 }),
    ]);
    seedSession(t.state, {
      status: "active",
      startedAt: new Date(at("11:55")),
      createdAt: new Date(at("11:55")),
    });
    await worker(t, at("11:50")).tick();
    const pushes = t.pushes.filter((p) => p.push.type === "itinerary_garage_link");
    // The timed twin fired — proving this tick would have pushed — and
    // only the twin did.
    expect(pushes.map((p) => (p.push.extra as { stopId: string }).stopId)).toEqual(["twin"]);
    const stops = t.state.itineraries[0]!.stops as Record<string, unknown>[];
    expect(stops.find((s) => s["id"] === "s")!["sessionId"]).toBeNull();
    expect(stops.find((s) => s["id"] === "g")!["garageLinkPushedAt"]).toBeNull();
  });

  test("an untimed stop keeps the day open until the end of its date", async () => {
    const t = makeTestApp({});
    await dayWith(t, [stop("s1", at("09:00")), stop("u", null)]);
    // Past the last timed stop, but the untimed one could still happen.
    await worker(t, at("15:00")).tick();
    expect(t.state.itineraries[0]!.status).toBe("signed_off");
    await worker(t, "2026-01-06T00:30:00-05:00").tick();
    expect(t.state.itineraries[0]!.status).toBe("done");
  });

  test("a day of only untimed stops isn't closed the moment it's saved", async () => {
    const t = makeTestApp({});
    await dayWith(t, [stop("u1", null), stop("u2", null)]);
    await worker(t, at("15:00")).tick();
    expect(t.state.itineraries[0]!.status).toBe("signed_off");
    await worker(t, "2026-01-06T00:30:00-05:00").tick();
    expect(t.state.itineraries[0]!.status).toBe("done");
  });

  test("a day with only timed stops still closes after its last stop", async () => {
    const t = makeTestApp({});
    await dayWith(t, [stop("s1", at("09:00"))]);
    await worker(t, at("15:00")).tick();
    expect(t.state.itineraries[0]!.status).toBe("done");
  });
});
