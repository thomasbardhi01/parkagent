/**
 * Street parking that tells the truth (2026-09-25 device test): "no
 * metered street parking within reach of Seaport center" at 7 PM, while
 * our data has six metered blocks within 400 m of that centroid — the
 * nearest 33 m away — and most of the Seaport is free after 6 PM. The
 * quote looked for a zone within 25 m of one point.
 *
 * Pinned here: the words for a block's state during the window, the
 * walking-radius search over the REAL zones around LoLa 42 (fixture dumped
 * from the dev DB), the quote_street contract (since FR-43: the request's
 * place and window, no arguments), and the facts a street card carries.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { SingleSpotPlan } from "../src/services/assistant/plans.js";
import { applyPlaceResolution, emptyState } from "../src/services/assistant/requestState.js";
import {
  clockText,
  describeStreetWindow,
  displayStreet,
  nearestPointOn,
  streetOptionsNear,
} from "../src/services/assistant/streetOptions.js";
import type { StreetOption } from "../src/services/assistant/streetOptions.js";
import { AssistantTools } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import { metersBetween } from "../src/services/assistant/geocoder.js";
import type { LookupQuery, NearbyZone } from "../src/services/zoneLookup.js";
import { DEFAULT_POLICY, makeFakeDb, makePolicyService } from "./helpers.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/seaport-lola42-zones.json", import.meta.url), "utf8"),
) as { destination: { lat: number; lng: number }; zones: NearbyZone[] };
const LOLA_42 = FIXTURE.destination;

/** Saturday 26 Sep 2026, 7 PM ET — the device test's evening. */
const SAT_7PM = new Date("2026-09-26T19:00:00-04:00");
const MON_SAT_8_TO_6 = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "18:00" },
];
const MON_SAT_8_TO_8 = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];
const RATES = { rateFirstHourUsd: 3.75, rateAdditionalHourUsd: 3.75, maxStayMinutes: 120 };

describe("a block's state during the stay, in words", () => {
  test("free after the meters stop (Seaport Blvd at 7 PM)", () => {
    expect(describeStreetWindow({ ...RATES, hours: MON_SAT_8_TO_6 }, SAT_7PM, 180, true)).toEqual({
      state: "free",
      stateText: "Free after 6 PM",
      enforcedMinutes: 0,
    });
  });

  test("metered until 8 PM, then free", () => {
    expect(describeStreetWindow({ ...RATES, hours: MON_SAT_8_TO_8 }, SAT_7PM, 180, true)).toEqual({
      state: "metered_then_free",
      stateText: "Metered until 8 PM, then free",
      enforcedMinutes: 60,
    });
  });

  test("metered the whole stay: rate and max stay", () => {
    const sat2pm = new Date("2026-09-26T14:00:00-04:00");
    expect(describeStreetWindow({ ...RATES, hours: MON_SAT_8_TO_6 }, sat2pm, 120, true)).toEqual({
      state: "metered",
      stateText: "$3.75/hr, 2 hr max",
      enforcedMinutes: 120,
    });
  });

  test("free until the meters start, then the rate", () => {
    const sat7am = new Date("2026-09-26T07:00:00-04:00");
    expect(
      describeStreetWindow({ ...RATES, hours: MON_SAT_8_TO_6 }, sat7am, 120, true),
    ).toMatchObject({
      state: "free_then_metered",
      stateText: "Free until 8 AM, then $3.75/hr",
    });
  });

  test("no meters that day", () => {
    const sun7pm = new Date("2026-09-27T19:00:00-04:00");
    expect(
      describeStreetWindow({ ...RATES, hours: MON_SAT_8_TO_8 }, sun7pm, 180, true).stateText,
    ).toBe("Free all day Sunday");
  });

  test("a meter that outruns the max stay says so", () => {
    const sat5pm = new Date("2026-09-26T17:00:00-04:00");
    expect(
      describeStreetWindow({ ...RATES, hours: MON_SAT_8_TO_8 }, sat5pm, 240, true).stateText,
    ).toBe("Metered until 8 PM (2 hr max), then free");
  });

  test("clock and street words", () => {
    expect([clockText(18 * 60), clockText(20 * 60 + 30), clockText(0), clockText(720)]).toEqual([
      "6 PM",
      "8:30 PM",
      "midnight",
      "noon",
    ]);
    expect(displayStreet("SEAPORT BLVD")).toBe("Seaport Blvd");
    expect(displayStreet("W 42ND ST")).toBe("W 42nd St");
    expect(displayStreet("Broadway")).toBe("Broadway");
    expect(displayStreet("CANAL ST V-C")).toBe("Canal St");
    expect(displayStreet("BOYLSTON ST D-C")).toBe("Boylston St");
  });
});

describe("street options within a walk of LoLa 42 (real zones)", () => {
  const deps = (queries: LookupQuery[] = []) => ({
    db: makeFakeDb().db,
    policy: DEFAULT_POLICY,
    findCandidates: async () => [],
    findNearbyZones: async (q: LookupQuery) => {
      queries.push(q);
      return { zones: FIXTURE.zones.filter((z) => z.distanceM <= q.radiusM), truncated: false };
    },
  });

  test("7 PM for three hours: free blocks first, each in words, nothing called 'none'", async () => {
    const queries: LookupQuery[] = [];
    const search = await streetOptionsNear(deps(queries), {
      ...LOLA_42,
      when: SAT_7PM,
      minutes: 180,
    });
    expect(queries[0]).toMatchObject({ radiusM: 400 });
    expect(search.zonesInRadius).toBe(6);
    expect(search.options.map((o) => o.summary)).toEqual([
      "Free after 5 PM on Northern Av — 3 min walk",
      "Free after 6 PM on Seaport Blvd — 4 min walk",
      "Free after 6 PM on Boston Wharf Rd — 5 min walk",
      "Metered until 8 PM, then free on Northern Av — 3 min walk",
    ]);
    // Metered 7–8 PM only: one hour at $3.75 plus the city's $0.35 fee.
    const metered = search.options[3]!;
    expect(metered).toMatchObject({
      costUsd: 4.1,
      meterUsd: 3.75,
      feeUsd: 0.35,
      enforcedMinutes: 60,
    });
    expect(metered.exceedsMaxStay).toBe(false);
    expect(search.options.slice(0, 3).every((o) => o.costUsd === 0 && o.state === "free")).toBe(
      true,
    );
  });

  test("both sides of Seaport Blvd saying the same thing are one option, at the nearer side", async () => {
    const search = await streetOptionsNear(deps(), { ...LOLA_42, when: SAT_7PM, minutes: 180 });
    const seaportBlvd = search.options.filter((o) => o.street === "Seaport Blvd");
    expect(seaportBlvd).toHaveLength(1);
    expect(seaportBlvd[0]!.zoneId).toBe("bos-seaport-blvd-de413d-01");
  });

  test("each option pins the curb nearest the destination, not the destination", async () => {
    const search = await streetOptionsNear(deps(), { ...LOLA_42, when: SAT_7PM, minutes: 180 });
    const blvd = search.options.find((o) => o.street === "Seaport Blvd")!;
    const pinToDestination = metersBetween(blvd.lat, blvd.lng, LOLA_42.lat, LOLA_42.lng);
    // The pin is on the block: as far from the destination as the block is.
    expect(Math.abs(pinToDestination - blvd.distanceM)).toBeLessThan(15);
  });

  test("the hours of the stay's day ride along for the card", async () => {
    const search = await streetOptionsNear(deps(), { ...LOLA_42, when: SAT_7PM, minutes: 180 });
    expect(search.options.find((o) => o.street === "Seaport Blvd")!.hoursToday).toEqual([
      { start: "08:00", end: "18:00" },
    ]);
  });

  test("a smaller radius holds fewer blocks", async () => {
    const search = await streetOptionsNear(deps(), {
      ...LOLA_42,
      when: SAT_7PM,
      minutes: 180,
      radiusM: 200,
    });
    expect(search.radiusM).toBe(200);
    expect(search.options.map((o) => o.street)).toEqual(["Northern Av", "Northern Av"]);
  });

  test("nearest point on a line", () => {
    const line = [
      [
        [-71.0, 42.0],
        [-71.0, 42.001],
      ],
    ];
    const p = nearestPointOn(line, 42.0005, -70.999)!;
    expect(p.lng).toBeCloseTo(-71.0, 6);
    expect(p.lat).toBeCloseTo(42.0005, 6);
  });
});

// ---------------------------------------------------------------------------
// quote_street and the plan
// ---------------------------------------------------------------------------

/** The Seaport's centroid — what "Seaport" geocodes to. No zone within
 * 25 m; the nearest (D St) is 33 m off, and six are within 400 m. */
const SEAPORT_CENTROID = { lat: 42.3462652, lng: -71.0421584 };
const D_STREET: NearbyZone = {
  zoneId: "bos-d-street-7e4e1b-00",
  city: "bos",
  providerZoneNumber: "",
  street: "D STREET",
  rateFirstHourUsd: 2.5,
  rateAdditionalHourUsd: 2.5,
  maxStayMinutes: 120,
  hours: MON_SAT_8_TO_8,
  distanceM: 33,
  containsPoint: false,
  centerline: [
    [
      [-71.04177, 42.34617],
      [-71.04224, 42.3459],
    ],
  ],
};

function toolsWith(zones: NearbyZone[], seen: LookupQuery[] = [], recordNearby = false) {
  return new AssistantTools({
    db: makeFakeDb().db,
    policy: makePolicyService(),
    // The old path: nearest zone within 25 m of the point.
    findCandidates: async (q) => {
      if (!recordNearby) seen.push(q);
      return zones.filter((z) => z.distanceM <= q.radiusM);
    },
    findNearbyZones: async (q) => {
      if (recordNearby) seen.push(q);
      return { zones: zones.filter((z) => z.distanceM <= q.radiusM), truncated: false };
    },
    garage: {
      id: "none",
      canReserve: false,
      search: async () => ({ ok: true, options: [], fromCache: false }),
      optionById: () => null,
      book: async () => {
        throw new Error("no");
      },
    },
    now: () => new Date("2026-09-26T15:00:00-04:00"),
  });
}

/** A turn whose request is at the Seaport's centroid (version 1). */
const ctx = (): ToolContext => ({
  userId: "u1",
  conversationId: "c1",
  requestState: applyPlaceResolution(
    emptyState(),
    { query: "Seaport", resolved: { ...SEAPORT_CENTROID, label: "Seaport", city: "bos" } },
    "",
    new Date("2026-09-26T15:00:00-04:00"),
  ).state,
});

interface Search {
  stateVersion: number;
  verdict: string;
  satisfying: {
    id: string;
    priceUsd: number;
    summary: string;
    zoneId: string;
    facts: StreetOption;
  }[];
  street: { radiusM: number; zonesInRadius: number };
  instruction: string;
}

/** Put a window on the request (→ version 2), then search the street. */
async function quote(
  tools: AssistantTools,
  c: ToolContext,
  startsAt: string | null,
  minutes: number,
): Promise<Search> {
  await tools.execute(c, "update_request", {
    ...(startsAt ? { startsAt } : {}),
    durationMinutes: minutes,
  });
  return (await tools.execute(c, "quote_street", {})).result as Search;
}

const SAT_7PM_ISO = "2026-09-26T19:00:00-04:00";
const D_STREET_ID = "v2-bos-d-street-7e4e1b-00";

describe("quote_street at a destination", () => {
  test("the Seaport centroid finds the block 33 m away (the bug: '25 m, none')", async () => {
    const result = await quote(toolsWith([D_STREET]), ctx(), SAT_7PM_ISO, 180);
    expect(result.verdict).toBe("meets");
    expect(result.street.radiusM).toBe(400);
    expect(result.satisfying[0]).toMatchObject({
      id: D_STREET_ID,
      zoneId: "bos-d-street-7e4e1b-00",
      summary: "Metered until 8 PM, then free on D Street — 1 min walk",
      priceUsd: 2.85,
      facts: { street: "D Street", state: "metered_then_free", costUsd: 2.85 },
    });
  });

  test("without geometry, the candidate search still covers the walking radius", async () => {
    const seen: LookupQuery[] = [];
    const tools = new AssistantTools({
      db: makeFakeDb().db,
      policy: makePolicyService(),
      findCandidates: async (q) => {
        seen.push(q);
        return q.radiusM >= 33 ? [D_STREET] : [];
      },
      garage: {
        id: "none",
        canReserve: false,
        search: async () => ({ ok: true, options: [], fromCache: false }),
        optionById: () => null,
        book: async () => {
          throw new Error("no");
        },
      },
      now: () => new Date("2026-09-26T15:00:00-04:00"),
    });
    const result = await quote(tools, ctx(), SAT_7PM_ISO, 60);
    expect(seen[0]!.radiusM).toBe(400);
    expect(result.satisfying).toHaveLength(1);
  });

  test("nothing within the usual walk tries the widest one, and is said with that radius", async () => {
    const seen: LookupQuery[] = [];
    const result = await quote(toolsWith([], seen, true), ctx(), SAT_7PM_ISO, 180);
    expect(seen.map((q) => q.radiusM)).toEqual([400, 800]);
    expect(result.satisfying).toEqual([]);
    expect(result.street).toEqual({ radiusM: 800, zonesInRadius: 0 });
    expect(result.instruction).toContain(
      "No metered street parking in our data within 800 m (about a 13-minute walk) of the place",
    );
    expect(result.instruction).toContain("say the radius");
  });

  test("a block past the usual walk is found by the wider one", async () => {
    const far = { ...D_STREET, zoneId: "bos-far-st-1", street: "FAR ST", distanceM: 650 };
    const result = await quote(toolsWith([far]), ctx(), SAT_7PM_ISO, 180);
    expect(result.street.radiusM).toBe(800);
    expect(result.satisfying.map((o) => o.zoneId)).toEqual(["bos-far-st-1"]);
  });

  test("the plan's street option carries the search's facts, not the model's", async () => {
    const tools = toolsWith([D_STREET]);
    const c = ctx();
    await quote(tools, c, SAT_7PM_ISO, 180);
    const out = await tools.execute(c, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: D_STREET_ID,
            label: "D Street",
            detail: "Meter",
            // A model's guess at the price, walk, stay, and start: none
            // of them is read.
            priceUsd: 9.99,
            walkMinutes: 12,
            durationMinutes: 30,
            startsAt: "2026-09-26T15:00:00-04:00",
            recommended: true,
          },
        ],
      },
    });
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    expect(option).toMatchObject({
      priceUsd: 2.85,
      walkMinutes: 1,
      durationMinutes: 180,
      startsAt: SAT_7PM_ISO,
      zoneId: "bos-d-street-7e4e1b-00",
      street: "D Street",
      streetState: "metered_then_free",
      streetSummary: "Metered until 8 PM, then free on D Street — 1 min walk",
      priceBreakdown: { meterUsd: 2.5, feeUsd: 0.35 },
      hoursToday: [{ start: "08:00", end: "20:00" }],
      maxStayMinutes: 120,
      exceedsMaxStay: false,
      payOnArrival: true,
    });
    // The pin is the curb, not the centroid.
    expect(option.lat).not.toBe(SEAPORT_CENTROID.lat);
  });

  test("a stay the search didn't quote can't be proposed: the new stay is searched, and the card is for it", async () => {
    // Before FR-43 a plan could keep the user's new stay over an older
    // quote, with the model's price. Now the stay is the request's, and
    // an edit makes the search stale.
    const tools = toolsWith([D_STREET]);
    const c = ctx();
    await quote(tools, c, SAT_7PM_ISO, 60);
    await tools.execute(c, "update_request", { durationMinutes: 90 });
    const stale = await tools.execute(c, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: D_STREET_ID, priceUsd: 2.85 }] },
    });
    expect(stale.result).toMatchObject({ error: "stale_or_unknown_option", stateVersion: 3 });

    await tools.execute(c, "quote_street", {});
    const out = await tools.execute(c, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v3-bos-d-street-7e4e1b-00" }] },
    });
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    expect(option.durationMinutes).toBe(90);
    expect(option.streetSummary).toBe("Metered until 8 PM, then free on D Street — 1 min walk");
    expect(option.street).toBe("D Street");
  });
});

describe("review fixes: street words and grounding", () => {
  test("a midday gap says when the meters come back, not when they stopped", () => {
    const split = [
      { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "12:00" },
      { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "16:00", end: "20:00" },
    ];
    const sat1230 = new Date("2026-09-26T12:30:00-04:00");
    expect(describeStreetWindow({ ...RATES, hours: split }, sat1230, 120, true)).toMatchObject({
      state: "free",
      stateText: "Free until 4 PM",
    });
  });

  test("two free blocks at one price are told apart by id — never by a label or a price", async () => {
    const blvd = {
      ...D_STREET,
      zoneId: "bos-seaport-blvd-1",
      street: "SEAPORT BLVD",
      distanceM: 120,
      hours: MON_SAT_8_TO_6,
    };
    const northern = {
      ...D_STREET,
      zoneId: "bos-northern-av-1",
      street: "NORTHERN AV",
      distanceM: 150,
      hours: MON_SAT_8_TO_6,
    };
    const tools = toolsWith([blvd, northern]);
    const c = ctx();
    const search = await quote(tools, c, SAT_7PM_ISO, 180);
    // Both blocks are free at 7 PM: the price can't tell them apart.
    expect(search.satisfying.map((o) => [o.zoneId, o.priceUsd])).toEqual([
      ["bos-seaport-blvd-1", 0],
      ["bos-northern-av-1", 0],
    ]);
    // The model names Northern Av's id under Seaport Blvd's words.
    const out = await tools.execute(c, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v2-bos-northern-av-1", label: "Seaport Blvd — free after 6 PM" }],
      },
    });
    const options = (out.endTurn!.plan as SingleSpotPlan).options;
    // The closest free block leads the card on its own (it is both the
    // cheapest and the closest); the one the model named follows, as the
    // block its id says it is.
    expect(options.map((o) => [o.zoneId, o.street])).toEqual([
      ["bos-seaport-blvd-1", "Seaport Blvd"],
      ["bos-northern-av-1", "Northern Av"],
    ]);
    expect(options[1]!.streetSummary).toBe("Free after 6 PM on Northern Av — 2 min walk");
  });

  test("a stay past the max is a card for the max: the search's price, and it says so", async () => {
    // Metered 3–8 PM with a 2-hour max: a 3-hour stay at 3 PM clamps to 2.
    const tools = toolsWith([{ ...D_STREET, hours: MON_SAT_8_TO_8 }]);
    const c = ctx();
    await quote(tools, c, "2026-09-26T15:00:00-04:00", 180);
    const out = await tools.execute(c, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: D_STREET_ID, priceUsd: 99 }] },
    });
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    // What the price buys is the two hours the meter allows.
    expect(option).toMatchObject({ priceUsd: 5.35, durationMinutes: 120, exceedsMaxStay: true });
    // The card's window is still the three hours asked for.
    expect((out.endTurn!.plan as SingleSpotPlan).assumptions).toBe("3:00–6:00 PM, near Seaport");
  });
});

describe("independent review fixes", () => {
  test("an option's start is its search's: a 7 PM search can't become a Confirm-now option", async () => {
    // Before FR-43 the model set each option's start, and one it left off
    // made a 7 PM quote's option a Confirm-now one.
    const tools = toolsWith([D_STREET]);
    const c = ctx();
    await quote(tools, c, SAT_7PM_ISO, 180);
    const out = await tools.execute(c, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: D_STREET_ID, priceUsd: 11.6 }] },
    });
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    expect(option.startsAt).toBe(SAT_7PM_ISO);
    expect(option.payOnArrival).toBe(true);
    expect(option.priceUsd).toBe(2.85);
  });

  test("a request with no start is a Confirm-now option, priced from now", async () => {
    const tools = toolsWith([D_STREET]);
    const c = ctx();
    // 3 PM, three hours, two-hour max: two hours of meter from now.
    await quote(tools, c, null, 180);
    const out = await tools.execute(c, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: D_STREET_ID }] },
    });
    const option = (out.endTurn!.plan as SingleSpotPlan).options[0]!;
    expect(option.startsAt).toBeUndefined();
    expect(option.payOnArrival).toBe(false);
    expect(option.priceUsd).toBe(5.35);
  });

  test("a stay that starts free and runs past the max is priced for the max of meter", async () => {
    // Metered from 8 AM, 2-hour max; 7 AM for 5 hours: two metered hours.
    const search = await streetOptionsNear(
      {
        db: makeFakeDb().db,
        policy: DEFAULT_POLICY,
        findCandidates: async () => [],
        findNearbyZones: async () => ({
          zones: [
            {
              ...D_STREET,
              rateFirstHourUsd: 3.75,
              rateAdditionalHourUsd: 3.75,
              hours: MON_SAT_8_TO_8,
            },
          ],
          truncated: false,
        }),
      },
      { ...SEAPORT_CENTROID, when: new Date("2026-09-26T07:00:00-04:00"), minutes: 300 },
    );
    expect(search.options[0]).toMatchObject({
      state: "free_then_metered",
      exceedsMaxStay: true,
      meterUsd: 7.5,
      costUsd: 7.85,
    });
  });
});
