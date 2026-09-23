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

import { describe, expect, test } from "vitest";

import { AssistantTools } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GeocoderProvider, GeocodeResult } from "../src/services/assistant/geocoder.js";
import { metersBetween, NominatimGeocoder } from "../src/services/assistant/geocoder.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { makeFakeDb } from "./helpers.js";
import { makePolicyService } from "./helpers.js";
import type { Candidate } from "../src/services/zoneLookup.js";

const CTX: ToolContext = { userId: "u1", conversationId: "c1" };
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
  return {
    id: "spothero",
    canReserve: false,
    async search({ lat, lng }) {
      return {
        ok: true,
        fromCache: false,
        options: [garageAt("near", lat, lng, 300), garageAt("far", lat, lng, 1500)],
      };
    },
    optionById: () => null,
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
    const result = out.result as {
      found: boolean;
      maxStayMinutes: number;
      clampedMinutes: number;
      termsSource?: string;
    };
    expect(result.found).toBe(true);
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
    const result = out.result as {
      maxStayMinutes: number;
      clampedMinutes: number;
      termsSource?: string;
    };
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
