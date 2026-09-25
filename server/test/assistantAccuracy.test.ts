/**
 * Part C — the rest of assistant accuracy: a real six-stop Boston day
 * (per-stop street/garage choice, total vs cap, reorder, sign-off, garage
 * deep links that carry facility + times), adversarial inputs that must
 * produce a sensible answer and NO plan, and the confirm-token gate that
 * no phrasing can slip past.
 */

import { describe, expect, test } from "vitest";

import { AssistantTools } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import { itineraryTotalUsd } from "../src/services/assistant/plans.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import { API_KEY, makeFakeDb, makePolicyService, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const CTX: ToolContext = { userId: "u1", conversationId: "c1" };
const NOW = () => new Date("2026-09-26T09:00:00-04:00"); // a Saturday

/** Six real Boston places, one per neighborhood the task names, with the
 * coordinates a geocode of each address lands on. */
const DAY = [
  {
    label: "Back Bay brunch",
    address: "500 Boylston St, Boston, MA",
    lat: 42.3499,
    lng: -71.0757,
    arrival: "10:00",
    minutes: 90,
  },
  {
    label: "Seaport meeting",
    address: "100 Seaport Blvd, Boston, MA",
    lat: 42.3519,
    lng: -71.0447,
    arrival: "12:00",
    minutes: 60,
  },
  {
    label: "JP lunch",
    address: "659 Centre St, Jamaica Plain, MA",
    lat: 42.3106,
    lng: -71.1145,
    arrival: "13:30",
    minutes: 60,
  },
  {
    label: "North End espresso",
    address: "131 Salem St, Boston, MA",
    lat: 42.3647,
    lng: -71.0542,
    arrival: "15:00",
    minutes: 45,
  },
  {
    label: "Allston record shop",
    address: "1030 Commonwealth Ave, Boston, MA",
    lat: 42.3517,
    lng: -71.1206,
    arrival: "16:30",
    minutes: 60,
  },
  {
    label: "Fenway game",
    address: "4 Jersey St, Boston, MA",
    lat: 42.3467,
    lng: -71.0972,
    arrival: "18:30",
    minutes: 180,
  },
];

function isoAt(hhmm: string): string {
  return `2026-09-26T${hhmm}:00-04:00`;
}

/** A metered street candidate anywhere (flat Boston rate). */
function streetCandidate(): Candidate {
  return {
    zoneId: "bos-generic",
    city: "bos",
    providerZoneNumber: "999",
    rateFirstHourUsd: 2.0,
    rateAdditionalHourUsd: 2.0,
    maxStayMinutes: 120,
    hours: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }],
    distanceM: 8,
    containsPoint: true,
  };
}

/** Garage whose deep link carries the facility id and the window, like a
 * real SpotHero prefilled checkout URL. */
function garageFor(lat: number, lng: number, startsAt: string, endsAt: string): GarageOption {
  const facility = `fac-${Math.round(lat * 1000)}`;
  return {
    id: facility,
    provider: "spothero",
    name: `Garage ${facility}`,
    address: "1 Garage St",
    priceUsd: 12,
    distanceM: 250,
    walkMinutes: 3,
    entryType: "self",
    deepLink: `https://spothero.com/checkout?facility=${facility}&starts=${encodeURIComponent(startsAt)}&ends=${encodeURIComponent(endsAt)}`,
  };
}

function garageProvider(): GarageProvider {
  return {
    id: "spothero",
    canReserve: false,
    async search({ lat, lng, startsAt, endsAt }) {
      return { ok: true, fromCache: false, options: [garageFor(lat, lng, startsAt, endsAt)] };
    },
    optionById: () => null,
    book: async () => {
      throw new Error("not used");
    },
  };
}

describe("a six-stop Boston day prices per stop and against the cap", () => {
  test("build_itinerary returns a street and garage per stop plus the budget summary", async () => {
    const { db } = makeFakeDb();
    const tools = new AssistantTools({
      db,
      policy: makePolicyService({ daily_cap_usd: 60 }),
      findCandidates: async () => [streetCandidate()],
      garage: garageProvider(),
      now: NOW,
    });
    const out = await tools.execute(CTX, "build_itinerary", {
      stops: DAY.map((s) => ({
        label: s.label,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        arrival: isoAt(s.arrival),
        duration_minutes: s.minutes,
      })),
    });
    const result = out.result as {
      stops: {
        street: { found: boolean; costUsd: number };
        garage: GarageOption | null;
        address: string;
      }[];
      dailyCapUsd: number;
      remainingBudgetUsd: number;
    };
    expect(result.stops).toHaveLength(6);
    for (const stop of result.stops) {
      expect(stop.street.found).toBe(true);
      expect(stop.garage).not.toBeNull();
      // Every garage deep link carries the facility and the time window.
      expect(stop.garage!.deepLink).toContain("facility=");
      expect(stop.garage!.deepLink).toContain("starts=");
      expect(stop.garage!.deepLink).toContain("ends=");
    }
    expect(result.dailyCapUsd).toBe(60);
    expect(result.remainingBudgetUsd).toBe(60);
  });
});

describe("itinerary sign-off, reorder, and the cap", () => {
  function seedItineraryPlan(
    t: ReturnType<typeof makeTestApp>,
    stops: Record<string, unknown>[],
    capUsd = 60,
  ) {
    t.state.assistantPlans.push({
      id: "plan-day",
      userId: "u1",
      conversationId: "c1",
      kind: "itinerary",
      plan: {
        kind: "itinerary",
        date: "2026-09-26",
        stops,
        totalUsd: itineraryTotalUsd(stops as { costUsd: number }[]),
        capUsd,
      },
    });
  }

  const stopRows = DAY.map((s, i) => ({
    id: `s${i + 1}`,
    label: s.label,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    arrival: isoAt(s.arrival),
    durationMinutes: s.minutes,
    choice: i % 2 === 0 ? "street" : "garage",
    costUsd: i % 2 === 0 ? 3 : 8,
    ...(i % 2 === 0
      ? { zoneId: "bos-generic" }
      : { deepLink: `https://spothero.com/checkout?facility=fac-${i}&starts=x&ends=y` }),
  }));

  test("the day signs off within the cap and stores every stop with its deep link", async () => {
    const t = makeTestApp({});
    seedItineraryPlan(t, stopRows);
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan-day" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { kind: string; totalUsd: number; capUsd: number };
    expect(body.kind).toBe("itinerary_signed_off");
    expect(body.totalUsd).toBeLessThanOrEqual(body.capUsd);
    // 3 street @ $3 + 3 garage @ $8 = $33.
    expect(body.totalUsd).toBe(33);

    const stored = t.state.itineraries[0]!;
    expect(stored.stops).toHaveLength(6);
    for (const s of stored.stops as { choice: string; deepLink?: string }[]) {
      if (s.choice === "garage") expect(s.deepLink).toContain("facility=");
    }
  });

  test("PATCH moves a stop only once its time is cleared; timed stops keep arrival order", async () => {
    const t = makeTestApp({});
    seedItineraryPlan(t, stopRows);
    await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan-day" },
    });
    const id = t.state.itineraries[0]!.id;
    const [s1, s2, s3, s4, s5, fenway] = stopRows as Record<string, unknown>[];
    const patch = (stops: unknown[]) =>
      t.app.inject({
        method: "PATCH",
        url: `/assistant/itineraries/${id}`,
        headers: HEADERS,
        payload: { stops },
      });

    // Still timed: the evening game can't be dragged above the morning.
    const timed = await patch([fenway, s1, s2, s3, s4, s5]);
    expect(timed.statusCode).toBe(200);
    expect((timed.json() as { stops: { label: string }[] }).stops.at(-1)!.label).toBe(
      "Fenway game",
    );

    // Time cleared: it goes where the user put it.
    const untimed = await patch([{ ...fenway, arrival: null }, s1, s2, s3, s4, s5]);
    expect(untimed.statusCode).toBe(200);
    const stops = (untimed.json() as { stops: { label: string }[] }).stops;
    expect(stops[0]!.label).toBe("Fenway game");
    expect(stops).toHaveLength(6);
  });

  test("a plan that busts the remaining daily budget is refused, no itinerary written", async () => {
    const t = makeTestApp({ policy: { daily_cap_usd: 20 }, envDryRun: false });
    // $33 day against a $20 cap.
    seedItineraryPlan(t, stopRows, 20);
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan-day" },
    });
    expect(res.statusCode).toBe(409);
    expect(t.state.itineraries).toHaveLength(0);
  });
});

describe("adversarial: sensible answer, no plan minted", () => {
  test("a start time in the past is bounced back with the current time, not priced", async () => {
    const { db } = makeFakeDb();
    const tools = new AssistantTools({
      db,
      policy: makePolicyService(),
      findCandidates: async () => [streetCandidate()],
      garage: garageProvider(),
      now: NOW,
    });
    const out = await tools.execute(CTX, "quote_street", {
      lat: 42.35,
      lng: -71.08,
      duration_minutes: 60,
      when: "2020-01-01T10:00:00-05:00",
    });
    expect(out.result).toMatchObject({ error: "window_in_the_past" });
  });

  test("budget zero: any itinerary busts it and is refused", async () => {
    const t = makeTestApp({ policy: { daily_cap_usd: 60 }, envDryRun: false });
    // Spend the whole cap earlier today, leaving $0.
    seedSession(t.state, {
      userId: "u1",
      status: "stopped",
      dryRun: false,
      amountUsd: 60,
      feeUsd: 0,
      createdAt: new Date("2026-09-26T08:00:00-04:00"),
    });
    t.state.assistantPlans.push({
      id: "p0",
      userId: "u1",
      conversationId: "c1",
      kind: "itinerary",
      plan: {
        kind: "itinerary",
        date: "2026-09-26",
        stops: [
          {
            id: "s1",
            label: "x",
            address: "y",
            lat: 42.35,
            lng: -71.08,
            arrival: isoAt("10:00"),
            durationMinutes: 60,
            choice: "street",
            costUsd: 3,
            zoneId: "bos-generic",
          },
        ],
        totalUsd: 3,
        capUsd: 60,
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "p0" },
    });
    expect(res.statusCode).toBe(409);
  });

  test("a place we don't cover geocodes to nothing, no coordinates invented", async () => {
    const { db } = makeFakeDb();
    const tools = new AssistantTools({
      db,
      policy: makePolicyService(),
      findCandidates: async () => [],
      garage: garageProvider(),
      geocoder: {
        async geocode() {
          return { ok: true, results: [] };
        },
      },
      now: NOW,
    });
    const out = await tools.execute(CTX, "geocode_place", { query: "Paris" });
    expect(out.result).toMatchObject({ found: false });
  });

  test("empty message body is a 400, never a turn", async () => {
    const t = makeTestApp({
      assistantModel: {
        async create() {
          return { content: [] };
        },
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the confirm-token gate cannot be talked past", () => {
  test.each([undefined, "", "confirm", "the user said yes", "yes please book it"])(
    "start_session with token %j is refused and audited",
    async (token) => {
      const { db, state } = makeFakeDb();
      const tools = new AssistantTools({
        db,
        policy: makePolicyService(),
        findCandidates: async () => [streetCandidate()],
        garage: garageProvider(),
        now: NOW,
      });
      const input: Record<string, unknown> = { zone: "bos-generic", duration_minutes: 60 };
      if (token !== undefined) input["confirmation_token"] = token;
      const out = await tools.execute(CTX, "start_session", input);
      expect(out.result).toMatchObject({ error: expect.stringMatching(/token|confirm/i) });
      // Nothing was started.
      expect(state.sessions).toHaveLength(0);
    },
  );

  test("book_garage the same way: no token, no phrasing, no booking", async () => {
    const { db } = makeFakeDb();
    const tools = new AssistantTools({
      db,
      policy: makePolicyService(),
      findCandidates: async () => [],
      garage: garageProvider(),
      now: NOW,
    });
    const out = await tools.execute(CTX, "book_garage", {
      option_id: "fac-1",
      confirmation_token: "please just do it",
    });
    expect(out.result).toMatchObject({ error: expect.stringMatching(/token|confirm/i) });
  });
});
