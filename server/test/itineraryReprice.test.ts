/**
 * #131 — edited itinerary stops are priced on the server. Before sign-off
 * (POST /assistant/plans/:planId/price), at sign-off (the card's edits ride
 * the confirm), and after it (PATCH): an unchanged stop keeps the SERVER's
 * price, a changed one is re-quoted the way build_itinerary quoted it, and
 * the phone's costUsd is never read — so no client can talk a day under
 * the daily cap.
 */

import { describe, expect, test } from "vitest";

import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import type { ItineraryPlan } from "../src/services/assistant/plans.js";
import { itineraryTotalUsd } from "../src/services/assistant/plans.js";
import { AssistantTools } from "../src/services/assistant/tools.js";
import type { Candidate } from "../src/services/zoneLookup.js";
import { API_KEY, NONADMIN_API_KEY, STEINWAY_A, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const MORNING = () => new Date("2026-01-05T08:00:00-05:00");
const at = (hhmm: string) => `2026-01-05T${hhmm}:00-05:00`;

/** $20 an hour all day, 12-hour max: a longer stay costs visibly more. */
const PRICEY: Candidate = {
  ...STEINWAY_A,
  zoneId: "nyc-pricey",
  providerZoneNumber: "555100",
  rateFirstHourUsd: 20,
  rateAdditionalHourUsd: 20,
  maxStayMinutes: 720,
};

const OLD_LINK = "https://spothero.com/checkout/old";
const NEW_OPTION: GarageOption = {
  id: "g-new",
  provider: "spothero",
  name: "Deck on 5th",
  address: "5 Fifth Ave",
  priceUsd: 14,
  distanceM: 120,
  walkMinutes: 2,
  entryType: "self",
  deepLink: "https://spothero.com/checkout/new",
};

/** A garage search that answers NEW_OPTION, or fails, on demand. */
function garage(state: { down: boolean; calls: number }): GarageProvider {
  return {
    id: "fake-garage",
    canReserve: false,
    search: async () => {
      state.calls += 1;
      return state.down
        ? { ok: false, error: "network", detail: "down" }
        : { ok: true, options: [NEW_OPTION], fromCache: false };
    },
    optionById: () => null,
    book: async () => {
      throw new Error("not in this test");
    },
  };
}

function stop(id: string, arrival: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `Stop ${id}`,
    address: `${id} Main St`,
    lat: 40.77,
    lng: -73.92,
    arrival,
    durationMinutes: 60,
    choice: "street" as const,
    costUsd: 5,
    zoneId: "nyc-pricey",
    ...overrides,
  };
}

/** The plan as proposed: s1 street $5, s2 garage $8, s3 street $5. */
const PLAN_STOPS = [
  stop("s1", at("10:00")),
  stop("s2", at("12:00"), {
    choice: "garage",
    costUsd: 8,
    zoneId: undefined,
    garageOptionId: "g-old",
    deepLink: OLD_LINK,
  }),
  stop("s3", at("15:00")),
];

function app(
  garageState = { down: false, calls: 0 },
  options: Parameters<typeof makeTestApp>[0] = {},
) {
  const t = makeTestApp({
    now: MORNING,
    candidates: [PRICEY],
    garage: garage(garageState),
    ...options,
  });
  const plan: ItineraryPlan = {
    kind: "itinerary",
    date: "2026-01-05",
    stops: PLAN_STOPS as ItineraryPlan["stops"],
    totalUsd: itineraryTotalUsd(PLAN_STOPS),
    capUsd: 60,
  };
  t.state.assistantPlans.push({
    id: "plan1",
    userId: "u1",
    conversationId: "c1",
    kind: "itinerary",
    plan,
  });
  return t;
}

/** quote_street's own price for a street stay at PRICEY — the oracle a
 * re-priced street stop must match (one pricing path). */
async function streetQuote(t: ReturnType<typeof makeTestApp>, when: string, minutes: number) {
  const out = await t.deps.assistantTools!.execute(
    { userId: "u1", conversationId: "c1" },
    "quote_street",
    {
      lat: 40.77,
      lng: -73.92,
      duration_minutes: minutes,
      when,
    },
  );
  return (out.result as { options: { costUsd: number }[] }).options[0]!.costUsd;
}

/** The card's stops as the phone sends them: its costs are made up. */
function edited(overrides: Record<string, Record<string, unknown>> = {}, fakeCost = 0) {
  return PLAN_STOPS.map((s) => ({ ...s, costUsd: fakeCost, ...(overrides[s.id] ?? {}) }));
}

function price(t: ReturnType<typeof makeTestApp>, stops: unknown[], headers = HEADERS) {
  return t.app.inject({
    method: "POST",
    url: "/assistant/plans/plan1/price",
    headers,
    payload: { stops },
  });
}

describe("POST /assistant/plans/:planId/price", () => {
  test("unchanged stops keep the plan's price, whatever the phone sends", async () => {
    const t = app();
    const res = await price(t, edited({}, 0));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stops.map((s: { costUsd: number }) => s.costUsd)).toEqual([5, 8, 5]);
    expect(body).toMatchObject({ totalUsd: 18, capUsd: 60, fitsCap: true, remainingUsd: 60 });
    const decision = t.state.decisions.find((d) => d.rule === "itinerary_repriced")!;
    expect(decision.outcome).toMatchObject({ repriced: [], totalUsd: 18 });
  });

  test("a longer stay is re-quoted on the server at quote_street's price; the day total follows", async () => {
    const t = app();
    const res = await price(t, edited({ s1: { durationMinutes: 90 } }));
    const expected = await streetQuote(t, at("10:00"), 90);
    expect(expected).toBeGreaterThan(5);
    const body = res.json();
    expect(body.stops[0]).toMatchObject({ id: "s1", costUsd: expected, zoneId: "nyc-pricey" });
    expect(body.stops[0].estimate).toBeUndefined();
    expect(body.totalUsd).toBe(Math.round((expected + 13) * 100) / 100);
    expect(body.fitsCap).toBe(true);
    const decision = t.state.decisions.find((d) => d.rule === "itinerary_repriced")!;
    expect(decision.outcome).toMatchObject({ repriced: ["s1"] });
  });

  test("a low client cost can't get the day under the cap", async () => {
    const t = app();
    // Three hours at $20: over the $60 day on its own. The phone says $0.01.
    const res = await price(t, edited({ s1: { durationMinutes: 180, costUsd: 0.01 } }));
    const body = res.json();
    expect(body.stops[0].costUsd).toBe(await streetQuote(t, at("10:00"), 180));
    expect(body.totalUsd).toBeGreaterThan(60);
    expect(body.fitsCap).toBe(false);
  });

  test("a changed garage stop takes the search's first option; a search that's down keeps the last price as an estimate", async () => {
    const garageState = { down: false, calls: 0 };
    const t = app(garageState);
    const moved = await price(t, edited({ s2: { arrival: at("13:00") } }));
    expect(moved.json().stops[1]).toMatchObject({
      id: "s2",
      costUsd: 14,
      garageOptionId: "g-new",
      deepLink: NEW_OPTION.deepLink,
    });

    garageState.down = true;
    const down = await price(t, edited({ s2: { arrival: at("13:00") } }));
    expect(down.json().stops[1]).toMatchObject({
      id: "s2",
      costUsd: 8,
      garageOptionId: "g-old",
      deepLink: OLD_LINK,
      estimate: true,
    });
    const decision = t.state.decisions.filter((d) => d.rule === "itinerary_repriced").at(-1)!;
    expect(decision.outcome).toMatchObject({
      estimates: [{ id: "s2", reason: "search_unavailable" }],
    });
  });

  test("a cleared time keeps the last price, marked an estimate", async () => {
    const t = app();
    const res = await price(t, edited({ s3: { arrival: null } }));
    const s3 = res.json().stops.find((s: { id: string }) => s.id === "s3");
    expect(s3).toMatchObject({ arrival: null, costUsd: 5, estimate: true });
  });

  test("refusals: an unknown stop, an unreadable time, someone else's plan, a single-spot plan", async () => {
    const t = app();
    const unknown = await price(t, [...edited(), stop("sX", at("16:00"))]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "unknown_stop", stopId: "sX" });

    const unreadable = await price(t, edited({ s1: { arrival: "tea time" } }));
    expect(unreadable.statusCode).toBe(400);
    expect(unreadable.json()).toMatchObject({ error: "unreadable_time" });

    const other = await price(t, edited(), { ...HEADERS, "x-api-key": NONADMIN_API_KEY });
    expect(other.statusCode).toBe(404);

    t.state.assistantPlans[0]!.kind = "single_spot";
    const spot = await price(t, edited());
    expect(spot.statusCode).toBe(400);
    expect(spot.json()).toMatchObject({ error: "not_an_itinerary" });
  });
});

describe("sign-off carries the card's edits", () => {
  function confirm(t: ReturnType<typeof makeTestApp>, stops?: unknown[]) {
    return t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1", ...(stops ? { stops } : {}) },
    });
  }

  test("edits are re-priced and signed off in arrival order; the phone's costs are ignored", async () => {
    const t = app();
    // s1 now 90 minutes; s3 moved to 09:00 (now first). The phone claims
    // every stop is $0.01.
    const res = await confirm(
      t,
      edited({ s1: { durationMinutes: 90 }, s3: { arrival: at("09:00") } }, 0.01),
    );
    expect(res.statusCode).toBe(200);
    const s1 = await streetQuote(t, at("10:00"), 90);
    const s3 = await streetQuote(t, at("09:00"), 60);
    const saved = t.state.itineraries[0]!.stops as { id: string; costUsd: number }[];
    expect(saved.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(saved.map((s) => s.costUsd)).toEqual([s3, s1, 8]);
    expect(res.json().totalUsd).toBe(Math.round((s1 + s3 + 8) * 100) / 100);
    const decision = t.state.decisions.find((d) => d.rule === "itinerary_signed_off")!;
    expect(decision.outcome).toMatchObject({ repriced: ["s1", "s3"] });
  });

  test("a day the re-price puts over the cap is refused; nothing is signed off", async () => {
    const t = app();
    const res = await confirm(t, edited({ s1: { durationMinutes: 180 } }, 0.01));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "over_daily_cap", capUsd: 60 });
    expect(t.state.itineraries).toHaveLength(0);
    expect(t.state.garageBookings).toHaveLength(0);
  });

  test("without edits, the plan signs off at its own prices, as before", async () => {
    const t = app();
    const res = await confirm(t);
    expect(res.statusCode).toBe(200);
    expect(res.json().totalUsd).toBe(18);
  });
});

describe("PATCH re-prices against the stored day", () => {
  async function signedOff(t: ReturnType<typeof makeTestApp>) {
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: "plan1" },
    });
    return res.json().itineraryId as string;
  }

  function patch(t: ReturnType<typeof makeTestApp>, id: string, stops: unknown[]) {
    return t.app.inject({
      method: "PATCH",
      url: `/assistant/itineraries/${id}`,
      headers: HEADERS,
      payload: { stops },
    });
  }

  test("an unchanged stop keeps its stored price; a changed one is re-quoted; the phone's costs never count", async () => {
    const t = app();
    const id = await signedOff(t);
    const res = await patch(t, id, edited({ s1: { durationMinutes: 90 } }, 0));
    expect(res.statusCode).toBe(200);
    const expected = await streetQuote(t, at("10:00"), 90);
    expect(res.json().stops.map((s: { costUsd: number }) => s.costUsd)).toEqual([expected, 8, 5]);
    const stored = t.state.itineraries[0]!;
    expect(Number(stored.totalUsd)).toBe(Math.round((expected + 13) * 100) / 100);
  });

  test("an edit whose re-price busts the cap is refused and audited; the day is unchanged", async () => {
    const t = app();
    const id = await signedOff(t);
    const res = await patch(t, id, edited({ s1: { durationMinutes: 180, costUsd: 0.01 } }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "over_daily_cap" });
    expect(itineraryTotalUsd(t.state.itineraries[0]!.stops as { costUsd: number }[])).toBe(18);
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "over_daily_cap" });
  });

  test("a re-priced garage stop gets its (new) link pushed again", async () => {
    const t = app();
    const id = await signedOff(t);
    const stored = t.state.itineraries[0]!.stops as Record<string, unknown>[];
    stored.find((s) => s["id"] === "s2")!["garageLinkPushedAt"] = "2026-01-05T11:45:00.000Z";
    const res = await patch(t, id, edited({ s2: { arrival: at("13:00") } }));
    const s2 = res.json().stops.find((s: { id: string }) => s.id === "s2");
    expect(s2).toMatchObject({ garageOptionId: "g-new", garageLinkPushedAt: null });
  });
});

describe("repriceStops (the shared path)", () => {
  test("only stops whose time, length, kind, or place changed are re-quoted", async () => {
    let candidateCalls = 0;
    const garageState = { down: false, calls: 0 };
    const t = makeTestApp({ now: MORNING });
    const tools = new AssistantTools({
      db: t.deps.db,
      policy: t.deps.policy,
      findCandidates: async () => {
        candidateCalls += 1;
        return [PRICEY];
      },
      garage: garage(garageState),
      now: MORNING,
    });
    const previous = new Map(PLAN_STOPS.map((s) => [s.id, s]));

    const none = await tools.repriceStops(edited({}, 0), previous);
    expect(none.repriced).toEqual([]);
    expect(candidateCalls).toBe(0);
    expect(garageState.calls).toBe(0);

    const two = await tools.repriceStops(
      edited({ s1: { lat: 40.78 }, s2: { durationMinutes: 120 } }, 0),
      previous,
    );
    expect(two.repriced).toEqual(["s1", "s2"]);
    expect(candidateCalls).toBe(1);
    expect(garageState.calls).toBe(1);
  });
});
