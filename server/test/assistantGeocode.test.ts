/**
 * Part C — assistant accuracy for NAMED areas. A request that names a
 * place ("a garage on Newbury Street", "near India Street", "in South
 * Boston", "near Fenway") must resolve THAT place, not fall back to the
 * phone's dot, and every option it surfaces must be within 600 m of it.
 * Street quotes for named areas must use provider-observed terms where a
 * driver has reported them.
 *
 * These drive the tools directly (AssistantTools.execute) with a fake
 * geocoder and fake garage provider — deterministic, offline, no model.
 * The end-to-end model wiring is covered by assistantLoop.test.ts; here we
 * pin the tool behavior the accuracy depends on.
 */

import { beforeEach, describe, expect, test } from "vitest";

import { AssistantTools } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GeocoderProvider, GeocodeResult } from "../src/services/assistant/geocoder.js";
import {
  METRO_BBOX,
  metersBetween,
  NominatimGeocoder,
} from "../src/services/assistant/geocoder.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { makeFakeDb } from "./helpers.js";
import { makePolicyService } from "./helpers.js";
import type { Candidate } from "../src/services/zoneLookup.js";

/** Fresh per test: the tools write this conversation's grounding onto the
 * context, and a module-level object would carry one test's geocode into
 * the next test's plan. */
let CTX: ToolContext;
beforeEach(() => {
  CTX = { userId: "u1", conversationId: "c1" };
});
const NOW = () => new Date("2026-09-23T14:00:00-04:00");

/** Four real Boston places and their coordinates, as our fake geocoder
 * "knows" them (values are the actual OSM points, rounded). */
const PLACES: Record<string, GeocodeResult> = {
  "newbury street": {
    lat: 42.3503,
    lng: -71.0811,
    displayName: "Newbury Street, Back Bay",
    city: "bos",
  },
  "india street": { lat: 42.3593, lng: -71.0521, displayName: "India Street, Boston", city: "bos" },
  "south boston": { lat: 42.3331, lng: -71.0492, displayName: "South Boston, Boston", city: "bos" },
  fenway: { lat: 42.3467, lng: -71.0972, displayName: "Fenway, Boston", city: "bos" },
};

function fakeGeocoder(): GeocoderProvider {
  return {
    async geocode(q) {
      const hit = PLACES[q.query.trim().toLowerCase()];
      if (!hit) return { ok: true, results: [] };
      return { ok: true, results: [hit] };
    },
  };
}

/** A garage a given number of metres due north of a point. */
function garageAt(id: string, fromLat: number, fromLng: number, metresNorth: number): GarageOption {
  return {
    id,
    provider: "spothero",
    name: `Garage ${id}`,
    address: `${id} Test St`,
    priceUsd: 15,
    distanceM: metresNorth,
    walkMinutes: Math.round(metresNorth / 80),
    entryType: "self",
    deepLink: `https://spothero.com/search?lat=${fromLat + metresNorth / 111_000}&lng=${fromLng}`,
  };
}

/** Garage provider that returns one option within 600 m and one well
 * beyond it, both anchored to the search point it's given. */
function fakeGarage(): GarageProvider {
  let last: GarageOption[] = [];
  return {
    id: "spothero",
    canReserve: false,
    async search({ lat, lng }) {
      last = [garageAt("near", lat, lng, 300), garageAt("far", lat, lng, 1500)];
      return { ok: true, fromCache: false, options: last };
    },
    // Like the real cache: what the last search returned, by id.
    optionById: (id) => last.find((o) => o.id === id) ?? null,
    book: async () => {
      throw new Error("not used");
    },
  };
}

function toolsWith(opts: {
  geocoder?: GeocoderProvider;
  garage?: GarageProvider;
  candidates?: Candidate[];
  seedObserved?: {
    city: string;
    zoneNumber: string;
    ratePerHourUsd: number | null;
    maxStayMinutes: number | null;
  };
}) {
  const { db, state } = makeFakeDb();
  if (opts.seedObserved) {
    state.zoneTermsObserved.push({
      city: opts.seedObserved.city,
      zoneNumber: opts.seedObserved.zoneNumber,
      ratePerHourUsd: opts.seedObserved.ratePerHourUsd,
      maxStayMinutes: opts.seedObserved.maxStayMinutes,
      rawText: "$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm",
      hoursJson: null,
      zoneId: null,
      firstSeenAt: NOW(),
      lastSeenAt: NOW(),
    });
  }
  const tools = new AssistantTools({
    db,
    policy: makePolicyService(),
    findCandidates: async () => opts.candidates ?? [],
    garage: opts.garage ?? fakeGarage(),
    ...(opts.geocoder ? { geocoder: opts.geocoder } : {}),
    now: NOW,
  });
  return { tools, state };
}

describe("geocode_place resolves the named area, biased to our cities", () => {
  test.each(Object.keys(PLACES))("resolves %s to its Boston coordinates", async (place) => {
    const { tools } = toolsWith({ geocoder: fakeGeocoder() });
    const out = await tools.execute(CTX, "geocode_place", { query: place });
    const result = out.result as { found: boolean; results: GeocodeResult[] };
    expect(result.found).toBe(true);
    expect(result.results[0]!.city).toBe("bos");
    // The resolved point is the place, not (say) the phone's NYC default.
    expect(
      metersBetween(
        result.results[0]!.lat,
        result.results[0]!.lng,
        PLACES[place]!.lat,
        PLACES[place]!.lng,
      ),
    ).toBeLessThan(5);
  });

  test("a place in neither city returns found:false, never a fallback point", async () => {
    const { tools } = toolsWith({ geocoder: fakeGeocoder() });
    const out = await tools.execute(CTX, "geocode_place", { query: "Cleveland" });
    expect(out.result).toMatchObject({ found: false });
  });

  test("without a geocoder the tool says so instead of guessing", async () => {
    const { tools } = toolsWith({});
    const out = await tools.execute(CTX, "geocode_place", { query: "Newbury Street" });
    expect(out.result).toMatchObject({ error: "geocoding_unavailable" });
  });

  test("the phone's metro is the default bias when the model names no city", async () => {
    const seen: (string | undefined)[] = [];
    const recorder: GeocoderProvider = {
      async geocode(q) {
        seen.push(q.city);
        return { ok: true, results: [PLACES["fenway"]!] };
      },
    };
    const { tools } = toolsWith({ geocoder: recorder });
    // A phone in Boston (Back Bay): the query is biased "bos".
    await tools.execute({ ...CTX, location: { lat: 42.3505, lng: -71.08 } }, "geocode_place", {
      query: "fenway",
    });
    // The model's explicit choice still wins over the phone.
    await tools.execute({ ...CTX, location: { lat: 42.3505, lng: -71.08 } }, "geocode_place", {
      query: "fenway",
      city: "nyc",
    });
    // No phone location, no explicit city: unbiased.
    await tools.execute(CTX, "geocode_place", { query: "fenway" });
    expect(seen).toEqual(["bos", "nyc", undefined]);
  });
});

describe("plan cards carry destination, coordinates, and provenance", () => {
  test("propose_plan backfills what the model dropped, from this conversation's grounding", async () => {
    const { tools, state } = toolsWith({ geocoder: fakeGeocoder(), garage: fakeGarage() });
    const anchor = PLACES["newbury street"]!;
    await tools.execute(CTX, "geocode_place", { query: "newbury street" });
    await tools.execute(CTX, "search_garages", {
      lat: anchor.lat,
      lng: anchor.lng,
      starts_at: "2026-09-23T15:00:00-04:00",
      ends_at: "2026-09-23T17:00:00-04:00",
      within_m: 600,
    });
    // The model proposes without destination, provenance, or coords —
    // the usual case for optional schema fields.
    const out = await tools.execute(CTX, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "g-near",
            type: "garage",
            label: "Garage near",
            detail: "",
            priceUsd: 15,
            durationMinutes: 120,
            garageOptionId: "near",
            recommended: true,
          },
        ],
      },
    });
    expect(out.endTurn).toBeDefined();
    const plan = out.endTurn!.plan as {
      destination?: { lat: number; lng: number; label: string };
      provenance?: { provider: string; searchedAt: string };
    };
    expect(plan.destination).toMatchObject({ label: "Newbury Street, Back Bay" });
    expect(plan.destination!.lat).toBeCloseTo(anchor.lat, 4);
    expect(plan.provenance).toMatchObject({ provider: "spothero" });
    expect(plan.provenance!.searchedAt).toBe(NOW().toISOString());
    // The stored row carries the same enriched plan.
    expect(state.assistantPlans).toHaveLength(1);
  });

  test("provenance credits only the sources whose options made the card", async () => {
    // A merged search returns one option from each provider; the plan
    // surfaces only the SpotHero one, so ParkWhiz must not be credited.
    const merged: GarageProvider = {
      id: "parkwhiz+spothero",
      canReserve: false,
      async search({ lat, lng }) {
        return {
          ok: true,
          fromCache: false,
          options: [
            { ...garageAt("sh-1", lat, lng, 200), provider: "spothero" },
            { ...garageAt("pw-1", lat, lng, 250), provider: "parkwhiz" },
          ],
        };
      },
      optionById: (id) =>
        id === "sh-1"
          ? { ...garageAt("sh-1", 42.3503, -71.0811, 200), provider: "spothero" }
          : id === "pw-1"
            ? { ...garageAt("pw-1", 42.3503, -71.0811, 250), provider: "parkwhiz" }
            : null,
      book: async () => {
        throw new Error("not used");
      },
    };
    const { tools } = toolsWith({ garage: merged });
    await tools.execute(CTX, "search_garages", {
      lat: 42.3503,
      lng: -71.0811,
      starts_at: "2026-09-23T15:00:00-04:00",
      ends_at: "2026-09-23T17:00:00-04:00",
    });
    const out = await tools.execute(CTX, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "g1",
            type: "garage",
            label: "Garage sh-1",
            detail: "",
            priceUsd: 15,
            durationMinutes: 120,
            garageOptionId: "sh-1",
            recommended: true,
          },
        ],
      },
    });
    const plan = out.endTurn!.plan as { provenance?: { provider: string } };
    expect(plan.provenance?.provider).toBe("spothero");

    // Both shown → both credited, in a stable order.
    const both = await tools.execute(CTX, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "g1",
            type: "garage",
            label: "Garage sh-1",
            detail: "",
            priceUsd: 15,
            durationMinutes: 120,
            garageOptionId: "sh-1",
            recommended: true,
          },
          {
            id: "g2",
            type: "garage",
            label: "Garage pw-1",
            detail: "",
            priceUsd: 16,
            durationMinutes: 120,
            garageOptionId: "pw-1",
            recommended: false,
          },
        ],
      },
    });
    expect((both.endTurn!.plan as { provenance?: { provider: string } }).provenance?.provider).toBe(
      "parkwhiz+spothero",
    );
  });

  test("street options pin at the quoted point", async () => {
    const { tools } = toolsWith({
      candidates: [
        {
          zoneId: "bos-newbury-a",
          city: "bos",
          providerZoneNumber: "789",
          rateFirstHourUsd: 3.75,
          rateAdditionalHourUsd: 3.75,
          maxStayMinutes: 120,
          hours: [
            { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
          ],
          distanceM: 5,
          containsPoint: true,
        },
      ],
    });
    await tools.execute(CTX, "quote_street", {
      lat: 42.3503,
      lng: -71.0811,
      duration_minutes: 60,
      when: "2026-09-23T15:00:00-04:00",
    });
    const out = await tools.execute(CTX, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "s1",
            type: "street",
            label: "Street — Zone 789",
            detail: "",
            priceUsd: 3.75,
            durationMinutes: 60,
            zoneId: "bos-newbury-a",
            recommended: true,
          },
        ],
      },
    });
    const option = (out.endTurn!.plan as { options: { lat?: number; lng?: number }[] }).options[0]!;
    expect(option.lat).toBeCloseTo(42.3503, 4);
    expect(option.lng).toBeCloseTo(-71.0811, 4);
  });
});

describe("garage options for a named area are all within 600 m of it", () => {
  test.each(Object.keys(PLACES))("%s: within_m 600 drops the far option", async (place) => {
    const { tools } = toolsWith({ geocoder: fakeGeocoder(), garage: fakeGarage() });
    const geo = (await tools.execute(CTX, "geocode_place", { query: place })).result as {
      results: GeocodeResult[];
    };
    const anchor = geo.results[0]!;
    const out = await tools.execute(CTX, "search_garages", {
      lat: anchor.lat,
      lng: anchor.lng,
      starts_at: "2026-09-23T15:00:00-04:00",
      ends_at: "2026-09-23T17:00:00-04:00",
      within_m: 600,
    });
    const result = out.result as { options: GarageOption[]; droppedForDistance?: number };
    expect(result.options).toHaveLength(1);
    expect(result.droppedForDistance).toBe(1);
    // The assertion Part C asks for, made explicit: EVERY surfaced option
    // is within 600 m of the named place.
    for (const o of result.options) {
      expect(o.distanceM).toBeLessThanOrEqual(600);
    }
  });

  test("when everything is too far, the result names the nearest distance instead of 'none'", async () => {
    // Both options beyond 600 m: nearest at 800 m, another at 1500 m.
    const farOnly: GarageProvider = {
      id: "spothero",
      canReserve: false,
      async search({ lat, lng }) {
        return {
          ok: true,
          fromCache: false,
          options: [garageAt("near-ish", lat, lng, 800), garageAt("far", lat, lng, 1500)],
        };
      },
      optionById: () => null,
      book: async () => {
        throw new Error("not used");
      },
    };
    const { tools } = toolsWith({ geocoder: fakeGeocoder(), garage: farOnly });
    const out = await tools.execute(CTX, "search_garages", {
      lat: 42.3503,
      lng: -71.0811,
      starts_at: "2026-09-23T15:00:00-04:00",
      ends_at: "2026-09-23T17:00:00-04:00",
      within_m: 600,
    });
    const result = out.result as {
      options: GarageOption[];
      droppedForDistance?: number;
      nearestBeyondM?: number;
      instruction?: string;
    };
    expect(result.options).toHaveLength(0);
    expect(result.droppedForDistance).toBe(2);
    // ±1 m for the metres→degrees round trip.
    expect(result.nearestBeyondM).toBeGreaterThanOrEqual(799);
    expect(result.nearestBeyondM).toBeLessThanOrEqual(801);
    expect(result.instruction).toContain("nearest is about");
    expect(result.instruction).toContain("do not say none were found");
  });

  test("without within_m the far option is kept (phone-location searches don't clip)", async () => {
    const { tools } = toolsWith({ geocoder: fakeGeocoder(), garage: fakeGarage() });
    const out = await tools.execute(CTX, "search_garages", {
      lat: 42.3503,
      lng: -71.0811,
      starts_at: "2026-09-23T15:00:00-04:00",
      ends_at: "2026-09-23T17:00:00-04:00",
    });
    expect((out.result as { options: GarageOption[] }).options).toHaveLength(2);
  });
});

describe("street quotes for a named area use provider-observed terms", () => {
  const BOYLSTON: Candidate = {
    zoneId: "bos-boylston-st-d-c",
    city: "bos",
    providerZoneNumber: "456",
    rateFirstHourUsd: 3.75,
    rateAdditionalHourUsd: 3.75,
    // Dataset assumes a 2-hour cap; the driver-reported term says 5 hours.
    maxStayMinutes: 120,
    hours: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }],
    distanceM: 5,
    containsPoint: true,
  };

  test("the observed Max 5 Hr overrides the dataset's 2-hour cap in the quote", async () => {
    const { tools } = toolsWith({
      candidates: [BOYLSTON],
      seedObserved: { city: "bos", zoneNumber: "456", ratePerHourUsd: 3.75, maxStayMinutes: 300 },
    });
    // Ask for 200 minutes: the dataset would clamp to 120, the observed
    // term allows the full 200.
    const out = await tools.execute(CTX, "quote_street", {
      lat: 42.3503,
      lng: -71.0811,
      duration_minutes: 200,
      when: "2026-09-23T15:00:00-04:00",
    });
    const found = out.result as {
      found: boolean;
      options: { maxStayMinutes: number; clampedMinutes: number; termsSource?: string }[];
    };
    const result = found.options[0]!;
    expect(found.found).toBe(true);
    expect(result.maxStayMinutes).toBe(300);
    expect(result.clampedMinutes).toBe(200);
    expect(result.termsSource).toBe("observed");
  });

  test("without an observed row the dataset cap stands", async () => {
    const { tools } = toolsWith({ candidates: [BOYLSTON] });
    const out = await tools.execute(CTX, "quote_street", {
      lat: 42.3503,
      lng: -71.0811,
      duration_minutes: 200,
      when: "2026-09-23T15:00:00-04:00",
    });
    const result = (
      out.result as {
        options: { maxStayMinutes: number; clampedMinutes: number; termsSource?: string }[];
      }
    ).options[0]!;
    expect(result.maxStayMinutes).toBe(120);
    expect(result.clampedMinutes).toBe(120);
    expect(result.termsSource).toBeUndefined();
  });
});

describe("NominatimGeocoder bias and box filtering (offline, fake fetch)", () => {
  function fetchReturning(rows: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
  }

  test("keeps only points inside a covered metro box", async () => {
    // One point in Back Bay, one in Ohio — the Ohio row is dropped.
    const geo = new NominatimGeocoder({
      fetchFn: fetchReturning([
        {
          lat: "42.3503",
          lon: "-71.0811",
          display_name: "Newbury Street, Back Bay, Boston, MA, USA",
        },
        { lat: "41.4993", lon: "-81.6944", display_name: "Newbury Street, Cleveland, OH, USA" },
      ]),
      now: NOW,
    });
    const out = await geo.geocode({ query: "Newbury Street", city: "bos" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results.length).toBeGreaterThanOrEqual(1);
      for (const r of out.results) expect(r.city).toBe("bos");
      expect(out.results[0]!.displayName).toContain("Newbury Street");
    }
  });

  test("a biased search that finds nothing falls through to the other metro", async () => {
    // The bos-viewbox query returns nothing; the nyc query finds Times
    // Square. The bias orders the search, it doesn't blind it.
    // The fake answers by the viewbox it was ASKED about, so a fallback
    // that re-queried Boston (or skipped it) can't pass by call count.
    const boxes: string[] = [];
    const nycBox = METRO_BBOX.nyc.join(",");
    const bosBox = METRO_BBOX.bos.join(",");
    const geo = new NominatimGeocoder({
      fetchFn: (async (url: string) => {
        const box = new URL(url).searchParams.get("viewbox") ?? "";
        boxes.push(box);
        const rows =
          box === nycBox
            ? [{ lat: "40.7580", lon: "-73.9855", display_name: "Times Square, Manhattan, NYC" }]
            : [];
        return new Response(JSON.stringify(rows), { status: 200 });
      }) as unknown as typeof fetch,
      now: NOW,
    });
    const out = await geo.geocode({ query: "Times Square", city: "bos" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results).toHaveLength(1);
      expect(out.results[0]!.city).toBe("nyc");
    }
    // The biased metro first, then the fallback.
    expect(boxes).toEqual([bosBox, nycBox]);
  });

  test("a biased search that matches stays in its metro — no fallback query", async () => {
    const boxes: string[] = [];
    const geo = new NominatimGeocoder({
      fetchFn: (async (url: string) => {
        boxes.push(new URL(url).searchParams.get("viewbox") ?? "");
        const rows = [
          { lat: "42.3503", lon: "-71.0811", display_name: "Newbury Street, Back Bay" },
        ];
        return new Response(JSON.stringify(rows), { status: 200 });
      }) as unknown as typeof fetch,
      now: NOW,
    });
    const out = await geo.geocode({ query: "Newbury Street", city: "bos" });
    expect(out.ok && out.results[0]!.city).toBe("bos");
    expect(boxes).toEqual([METRO_BBOX.bos.join(",")]);
  });

  test("a transport failure returns ok:false, never throws", async () => {
    const geo = new NominatimGeocoder({
      fetchFn: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      now: NOW,
    });
    const out = await geo.geocode({ query: "Fenway" });
    expect(out.ok).toBe(false);
  });
});
