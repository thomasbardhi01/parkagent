/**
 * FR-43 / FR-26: what stands between the model's propose_plan and the
 * user. Every option must come from the latest search at the request's
 * current version (V1); its price, walk, zone, and link are the search's,
 * never the model's (V2); an option that breaks a limit can only be shown
 * as a near-miss (V3); with nothing satisfying, the only plan is the "no"
 * (V4); the itinerary cap recompute stays (V5); and every dollar amount in
 * the reply must be one the card stands behind (V6). The loop no longer
 * builds a plan the model didn't propose.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { scrubUngroundedAmounts } from "../src/services/assistant/loop.js";
import { noneMeetsPlanSchema, planSchema } from "../src/services/assistant/plans.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import type { NearbyZone } from "../src/services/zoneLookup.js";
import { API_KEY, makeTestApp, seedSession } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };

const COMMON = { lat: 42.3765, lng: -71.119 };
const MON_SAT_8_TO_8 = [
  { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" },
];

function zone(zoneId: string, street: string, ratePerHour: number, distanceM: number): NearbyZone {
  return {
    zoneId,
    city: "bos",
    providerZoneNumber: "",
    street,
    rateFirstHourUsd: ratePerHour,
    rateAdditionalHourUsd: ratePerHour,
    maxStayMinutes: 240,
    hours: MON_SAT_8_TO_8,
    distanceM,
    containsPoint: false,
    centerline: [
      [
        [COMMON.lng, COMMON.lat + distanceM / 111_000],
        [COMMON.lng + 0.001, COMMON.lat + distanceM / 111_000],
      ],
    ],
  };
}

/** One hour: $4.50 and $6.00 with Boston's $0.35 fee; two hours: $8.65 and $11.65. */
const MASS_AVE = zone("bos-mass-ave-1", "MASS AVE", 4.15, 300);
const GARDEN_ST = zone("bos-garden-st-1", "GARDEN ST", 5.65, 150);

const DECK: GarageOption = {
  id: "g-deck",
  provider: "spothero",
  name: "Common Deck",
  address: "1 Garden St",
  priceUsd: 25,
  distanceM: 200,
  walkMinutes: 3,
  entryType: "self",
  deepLink: "https://spothero.com/checkout/g-deck",
  lat: COMMON.lat + 0.001,
  lng: COMMON.lng,
};

function garages(options: GarageOption[]): GarageProvider {
  return {
    id: "spothero",
    canReserve: false,
    search: async () => ({ ok: true, options, fromCache: false }),
    optionById: (id) => options.find((o) => o.id === id) ?? null,
    book: async (id) => {
      const option = options.find((o) => o.id === id);
      if (!option) throw new Error("unknown option");
      return { kind: "deeplink_handoff", option, deepLink: option.deepLink };
    },
  };
}

function scriptedModel(
  responses: ModelResponse[],
): ModelClient & { calls: number; seen: ModelTurn[][] } {
  const model = {
    calls: 0,
    seen: [] as ModelTurn[][],
    async create(args: { messages: ModelTurn[] }) {
      model.seen.push(args.messages);
      const response = responses[Math.min(model.calls, responses.length - 1)]!;
      model.calls += 1;
      return response;
    },
  };
  return model as ModelClient & { calls: number; seen: ModelTurn[][] };
}

const use = (id: string, name: string, input: unknown = {}): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const say = (text: string): ModelResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

const ctxAt = (): ToolContext => ({ userId: "u1", conversationId: "c1", location: COMMON });

interface CardOption {
  id: string;
  type: string;
  priceUsd: number;
  walkMinutes: number;
  zoneId?: string;
  deepLink?: string;
  nearMiss?: boolean;
  violates?: { field: string; actual: unknown; limit: unknown }[];
  recommended: boolean;
}

const send = (t: ReturnType<typeof makeTestApp>, payload: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: "/assistant/message", headers: HEADERS, payload });

/** The tool results the model was handed, in order, parsed. */
function toolResults(messages: ModelTurn[]): Record<string, unknown>[] {
  return messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content.flatMap((b) =>
          b.type === "tool_result" ? [JSON.parse(b.content) as Record<string, unknown>] : [],
        ),
  );
}

describe("V1: every option comes from the latest search at the current version", () => {
  test("CS-01: after 'make it under $5', a turn-1 option id is stale; the final card's ids are all from the new version", async () => {
    const model = scriptedModel([
      // Turn 1: an hour near the phone, no limit.
      use("u1", "update_request", { durationMinutes: 60 }),
      use("q1", "quote_street"),
      use("p1", "propose_plan", {
        plan: {
          kind: "single_spot",
          options: [{ id: "v1-bos-mass-ave-1", recommended: true }, { id: "v1-bos-garden-st-1" }],
        },
      }),
      // Turn 2: the budget changes; the model searches, then proposes from memory.
      use("u2", "update_request", { maxPriceUsd: 5 }),
      use("q2", "quote_street"),
      use("p2", "propose_plan", {
        plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1", recommended: true }] },
      }),
      use("p3", "propose_plan", {
        plan: { kind: "single_spot", options: [{ id: "v2-bos-mass-ave-1", recommended: true }] },
      }),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST], assistantModel: model });

    const first = (await send(t, { text: "park me for an hour", location: COMMON })).json();
    expect(first.plan.plan.options.map((o: CardOption) => o.id)).toEqual([
      "v1-bos-mass-ave-1",
      "v1-bos-garden-st-1",
    ]);

    const second = (
      await send(t, {
        text: "actually make it under $5",
        conversation_id: first.conversationId,
        location: COMMON,
      })
    ).json();
    // The stale proposal bounced, naming what is current.
    const bounced = toolResults(model.seen.at(-1)!).find(
      (r) => r["error"] === "stale_or_unknown_option",
    );
    expect(bounced).toMatchObject({
      error: "stale_or_unknown_option",
      optionIds: ["v1-bos-mass-ave-1"],
      stateVersion: 2,
    });
    expect(bounced!["validIds"]).toEqual(["v2-bos-mass-ave-1", "v2-bos-garden-st-1"]);
    expect(t.state.decisions.some((d) => d.rule === "stale_or_unknown_option")).toBe(true);

    const options = second.plan.plan.options as CardOption[];
    expect(options.map((o) => o.id)).toEqual(["v2-bos-mass-ave-1"]);
    expect(options.every((o) => o.id.startsWith("v2-"))).toBe(true);
    expect(options.every((o) => o.priceUsd <= 5)).toBe(true);
    // Two plans stored: one per turn, none from the bounce.
    expect(t.state.assistantPlans).toHaveLength(2);
  });

  test("an option the model invented is refused", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "v1-bos-secret-free-lot",
            type: "street",
            label: "Free lot behind the church",
            priceUsd: 0,
            durationMinutes: 60,
            zoneId: "bos-secret-free-lot",
            recommended: true,
          },
        ],
      },
    });
    expect(out.result).toMatchObject({
      error: "stale_or_unknown_option",
      optionIds: ["v1-bos-secret-free-lot"],
      validIds: ["v1-bos-mass-ave-1"],
    });
    expect(out.endTurn).toBeUndefined();
    expect(t.state.assistantPlans).toHaveLength(0);
  });

  test("a real zone under the wrong id is still unknown: the zoneId field doesn't stand in for the id", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "opt-street", zoneId: "bos-mass-ave-1", recommended: true }],
      },
    });
    expect((out.result as { error: string }).error).toBe("stale_or_unknown_option");
  });

  test("with no search at all there is nothing to propose from", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const out = await t.deps.assistantTools!.execute(ctxAt(), "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v0-bos-mass-ave-1", recommended: true }] },
    });
    expect(out.result).toMatchObject({ error: "stale_or_unknown_option", validIds: [] });
  });

  test("an edit after the search makes the search stale, even for an id that would still be there", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    // Two hours now: the same block, another price.
    await tools.execute(ctx, "update_request", { durationMinutes: 120 });
    const stale = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1", recommended: true }] },
    });
    expect(stale.result).toMatchObject({ error: "stale_or_unknown_option", stateVersion: 2 });
    await tools.execute(ctx, "quote_street", {});
    const fresh = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v2-bos-mass-ave-1", recommended: true }] },
    });
    const plan = fresh.endTurn!.plan as unknown as { options: CardOption[] };
    expect(plan.options[0]).toMatchObject({ id: "v2-bos-mass-ave-1", priceUsd: 8.65 });
  });

  test("a search older than ten minutes is stale: prices are for when they were fetched", async () => {
    let now = new Date("2026-01-05T14:00:00-05:00");
    const t = makeTestApp({ nearbyZones: [MASS_AVE], now: () => now });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    now = new Date("2026-01-05T14:11:00-05:00");
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1", recommended: true }] },
    });
    expect(out.result).toMatchObject({ error: "stale_or_unknown_option" });
    expect((out.result as { hint: string }).hint).toMatch(/search again/i);
  });

  test("the latest search survives a restart: the next turn proposes from the stored transcript", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { durationMinutes: 60 }),
      use("q1", "quote_street"),
      say("Want the street spot or should I look at garages?"),
      say("Want the street spot or should I look at garages?"),
      // Next turn, same version: propose what the last turn found.
      use("p1", "propose_plan", {
        plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1", recommended: true }] },
      }),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const first = (await send(t, { text: "park me for an hour", location: COMMON })).json();
    expect(first.plan).toBeNull();
    const second = (
      await send(t, { text: "the street spot", conversation_id: first.conversationId })
    ).json();
    expect(second.plan.plan.options.map((o: CardOption) => o.id)).toEqual(["v1-bos-mass-ave-1"]);
    expect(second.plan.plan.options[0].priceUsd).toBe(4.5);
  });
});

describe("V2: the search's numbers, never the model's", () => {
  test("the model sends $3.00 for an option quoted $4.50: the card shows $4.50 and the mismatch is on the record", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "v1-bos-mass-ave-1",
            type: "street",
            label: "Mass Ave meter",
            priceUsd: 3,
            walkMinutes: 1,
            durationMinutes: 240,
            zoneId: "bos-somewhere-else",
            deepLink: "https://evil.example/pay",
            recommended: true,
          },
        ],
      },
    });
    const plan = out.endTurn!.plan as unknown as {
      options: (CardOption & Record<string, unknown>)[];
    };
    expect(plan.options[0]).toMatchObject({
      id: "v1-bos-mass-ave-1",
      priceUsd: 4.5,
      walkMinutes: 5,
      durationMinutes: 60,
      zoneId: "bos-mass-ave-1",
      label: "Mass Ave meter",
    });
    expect(plan.options[0]!.deepLink).toBeUndefined();
    const mismatch = t.state.decisions.find((d) => d.rule === "model_price_mismatch");
    expect(mismatch).toMatchObject({
      kind: "assistant_tool",
      outcome: { optionId: "v1-bos-mass-ave-1", modelPriceUsd: 3, priceUsd: 4.5 },
    });
    // The stored row is what the card shows.
    const stored = t.state.assistantPlans[0]!.plan as { options: CardOption[] };
    expect(stored.options[0]!.priceUsd).toBe(4.5);
  });

  test("a garage's link and price are the search's: a model-typed link never reaches the card", async () => {
    const t = makeTestApp({ garage: garages([{ ...DECK, priceUsd: 12 }]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          {
            id: "v1-g-deck",
            priceUsd: 5,
            deepLink: "https://evil.example/checkout",
            garageOptionId: "g-other",
            recommended: true,
          },
        ],
      },
    });
    const plan = out.endTurn!.plan as unknown as {
      options: (CardOption & Record<string, unknown>)[];
    };
    expect(plan.options[0]).toMatchObject({
      priceUsd: 12,
      deepLink: "https://spothero.com/checkout/g-deck",
      garageOptionId: "g-deck",
      provider: "spothero",
    });
    expect(t.state.decisions.some((d) => d.rule === "model_price_mismatch")).toBe(true);
  });

  test("no mismatch row when the model's price is the search's, or it sent none", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v1-bos-mass-ave-1", priceUsd: 4.5 }, { id: "v1-bos-garden-st-1" }],
      },
    });
    expect(t.state.decisions.some((d) => d.rule === "model_price_mismatch")).toBe(false);
  });
});

describe("V3: an option that breaks a limit is a near-miss or it isn't on the card", () => {
  async function searched(maxPriceUsd: number) {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd, durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    return { t, tools, ctx };
  }

  test("a near-miss proposed as a plain option bounces hard_constraint_violation", async () => {
    const { t, tools, ctx } = await searched(5);
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v1-bos-mass-ave-1", recommended: true }, { id: "v1-bos-garden-st-1" }],
      },
    });
    expect(out.result).toMatchObject({
      error: "hard_constraint_violation",
      optionIds: ["v1-bos-garden-st-1"],
    });
    expect(t.state.assistantPlans).toHaveLength(0);
    expect(t.state.decisions.some((d) => d.rule === "hard_constraint_violation")).toBe(true);
  });

  test("flagged nearMiss it rides along, with the server's violates, never recommended", async () => {
    const { tools, ctx } = await searched(5);
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          { id: "v1-bos-mass-ave-1" },
          {
            id: "v1-bos-garden-st-1",
            nearMiss: true,
            recommended: true,
            // Model text: discarded.
            violates: [{ field: "maxWalkMinutes", actual: 1, limit: 99 }],
          },
        ],
      },
    });
    const plan = out.endTurn!.plan as unknown as { options: CardOption[] };
    expect(plan.options.map((o) => [o.id, o.recommended, o.nearMiss ?? false])).toEqual([
      ["v1-bos-mass-ave-1", true, false],
      ["v1-bos-garden-st-1", false, true],
    ]);
    expect(plan.options[1]!.violates).toEqual([{ field: "maxPriceUsd", actual: 6, limit: 5 }]);
    expect(plan.options[0]!.violates).toBeUndefined();
  });

  test("an option that meets every limit can't be dressed as a near-miss either", async () => {
    const { tools, ctx } = await searched(5);
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v1-bos-mass-ave-1", nearMiss: true, recommended: true }],
      },
    });
    const plan = out.endTurn!.plan as unknown as { options: CardOption[] };
    expect(plan.options[0]!.nearMiss).toBeUndefined();
    expect(plan.options[0]!.violates).toBeUndefined();
  });

  test("a near-miss on a card can't be confirmed: the user changes the limit, not the tap", async () => {
    const { t, tools, ctx } = await searched(5);
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [{ id: "v1-bos-mass-ave-1" }, { id: "v1-bos-garden-st-1", nearMiss: true }],
      },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: out.endTurn!.planId, optionId: "v1-bos-garden-st-1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("near_miss_not_confirmable");
    expect(t.state.assistantConfirmations).toHaveLength(0);
    // The option that meets the request confirms as before.
    const ok = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: out.endTurn!.planId, optionId: "v1-bos-mass-ave-1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ kind: "street_confirmed", zoneId: "bos-mass-ave-1" });
  });
});

describe("V4: the server decides the no", () => {
  test("must_say_no and options_available are each other's mirror", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 2, durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const spot = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1", nearMiss: true }] },
    });
    expect((spot.result as { error: string }).error).toBe("must_say_no");

    await tools.execute(ctx, "update_request", { maxPriceUsd: 5 });
    await tools.execute(ctx, "quote_street", {});
    const no = await tools.execute(ctx, "propose_plan", { plan: { kind: "none_meets" } });
    expect((no.result as { error: string }).error).toBe("options_available");
  });

  test("the none_meets shape parses on its own and inside the plan union", () => {
    const card = {
      kind: "none_meets",
      headline: "Nothing under $2.00 near here.",
      constraintsFailed: [{ field: "maxPriceUsd", limit: 2, nearestActual: 4.5 }],
      nearMisses: [],
      relaxSuggestions: [
        {
          field: "maxPriceUsd",
          to: 7,
          wouldYield: 2,
          label: "Allow up to $7.00",
          reply: "Allow up to $7.00",
        },
      ],
    };
    expect(noneMeetsPlanSchema.safeParse(card).success).toBe(true);
    expect(planSchema.safeParse(card).success).toBe(true);
    // More than three near-misses is not a card.
    const option = {
      id: "a",
      type: "street",
      label: "Meter",
      priceUsd: 4.5,
      durationMinutes: 60,
      nearMiss: true,
      violates: [{ field: "maxPriceUsd", actual: 4.5, limit: 2 }],
    };
    expect(
      planSchema.safeParse({ ...card, nearMisses: [option, option, option, option] }).success,
    ).toBe(false);
  });
});

describe("V5: the itinerary cap recompute stays, against the caller's own cap", () => {
  const stop = (id: string, costUsd: number) => ({
    id,
    label: `Stop ${id}`,
    address: "1 Test St",
    lat: COMMON.lat,
    lng: COMMON.lng,
    arrival: "2026-01-05T16:00:00-05:00",
    durationMinutes: 60,
    choice: "street",
    costUsd,
    zoneId: "bos-mass-ave-1",
  });

  test("a day over the remaining daily cap is refused; the total is the server's sum", async () => {
    const t = makeTestApp({ policy: { daily_cap_usd: 20 } });
    const tools = t.deps.assistantTools!;
    const over = await tools.execute(ctxAt(), "propose_plan", {
      plan: {
        kind: "itinerary",
        date: "2026-01-05",
        stops: [stop("s1", 12), stop("s2", 12)],
        totalUsd: 5,
        capUsd: 999,
      },
    });
    expect(over.result).toMatchObject({ error: "plan_over_daily_cap", totalUsd: 24, capUsd: 20 });

    const fits = await tools.execute(ctxAt(), "propose_plan", {
      plan: {
        kind: "itinerary",
        date: "2026-01-05",
        stops: [stop("s1", 8), stop("s2", 8)],
        totalUsd: 5,
        capUsd: 999,
      },
    });
    expect(fits.endTurn!.plan).toMatchObject({ kind: "itinerary", totalUsd: 16, capUsd: 20 });
  });

  test("there is no per-plan cap: one option may cost anything up to what a search returns", async () => {
    // Decision 9: per-trip caps are dropped. A $58 garage under a $60 day
    // is a plan like any other.
    const t = makeTestApp({ garage: garages([{ ...DECK, priceUsd: 58 }]) });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { durationMinutes: 60 });
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: "v1-g-deck", recommended: true }] },
    });
    expect(out.endTurn).toBeDefined();
    expect(JSON.stringify(t.state.decisions)).not.toContain("per_plan_cap");
  });
});

describe("V6: every dollar amount in the reply is one the card stands behind", () => {
  test("prose with a price and no plan: one reminder, then no amount, no card, nothing synthesized", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { durationMinutes: 60 }),
      use("q1", "quote_street"),
      say("It's $4.50 on Mass Ave."),
      say("It's $4.50 on Mass Ave. Just say confirm."),
      say("SHOULD NEVER RUN"),
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST], assistantModel: model });
    const body = (await send(t, { text: "park me for an hour", location: COMMON })).json();
    // update, search, prose, the one reminder's prose: no fifth call.
    expect(model.calls).toBe(4);
    const reminders = model.seen
      .at(-1)!
      .filter((m) => typeof m.content === "string" && m.content.startsWith("[system reminder]"));
    expect(reminders).toHaveLength(1);

    expect(body.plan).toBeNull();
    expect(t.state.assistantPlans).toHaveLength(0);
    expect(t.state.decisions.some((d) => d.kind === "assistant_plan")).toBe(false);
    expect(body.reply).not.toMatch(/\$\s?\d/);
    expect(body.reply).not.toMatch(/confirm/i);
    expect(body.reply.length).toBeGreaterThan(0);
    expect(body.suggestions).toEqual([{ label: "Search again", reply: "Search again" }]);

    const audit = t.state.decisions.find((d) => d.rule === "ungrounded_number");
    expect(audit).toMatchObject({
      kind: "assistant_reply",
      outcome: { amounts: [4.5], hasPlan: false },
    });
    const turn = t.state.decisions.find((d) => d.kind === "assistant_turn")!;
    expect(turn.outcome).toMatchObject({ proposedPlan: false });
  });

  test("with a card, the card's prices stay and an invented one goes", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { durationMinutes: 60 }),
      use("q1", "quote_street"),
      {
        content: [
          {
            type: "text",
            text: "Mass Ave is $4.50 for the hour. Garages nearby run about $30.00. Tap one to go ahead.",
          },
          {
            type: "tool_use",
            id: "p1",
            name: "propose_plan",
            input: {
              plan: { kind: "single_spot", options: [{ id: "v1-bos-mass-ave-1" }] },
            },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const body = (await send(t, { text: "park me for an hour", location: COMMON })).json();
    expect(body.reply).toBe("Mass Ave is $4.50 for the hour. Tap one to go ahead.");
    expect(t.state.decisions.find((d) => d.rule === "ungrounded_number")).toMatchObject({
      outcome: { amounts: [30], hasPlan: true },
    });
  });

  test("a near-miss's price is the card's to say, with what it breaks: never the prose's", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { maxPriceUsd: 5, durationMinutes: 60 }),
      use("q1", "quote_street"),
      {
        content: [
          {
            type: "text",
            text: "Mass Ave is $4.50. Garden St at $6.00 also fits your budget.",
          },
          {
            type: "tool_use",
            id: "p1",
            name: "propose_plan",
            input: {
              plan: {
                kind: "single_spot",
                options: [
                  { id: "v1-bos-mass-ave-1" },
                  { id: "v1-bos-garden-st-1", nearMiss: true },
                ],
              },
            },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST], assistantModel: model });
    const body = (await send(t, { text: "an hour, under $5", location: COMMON })).json();
    expect(body.reply).toBe("Mass Ave is $4.50.");
    expect(body.plan.plan.options).toHaveLength(2);
  });

  test("what streams while the turn runs is held to the same line: no amount, and nothing after a search", async () => {
    const model: ModelClient = (() => {
      const responses: ModelResponse[] = [
        {
          content: [
            { type: "text", text: "Let me look. It's usually about $9.00 there. " },
            { type: "tool_use", id: "u1", name: "update_request", input: { durationMinutes: 60 } },
          ],
          stopReason: "tool_use",
        },
        use("q1", "quote_street"),
        say("Mass Ave fits you nicely."),
        say("It's $4.50 on Mass Ave."),
      ];
      let call = 0;
      return {
        async create(_args, onText) {
          const response = responses[Math.min(call, responses.length - 1)]!;
          call += 1;
          for (const block of response.content) {
            // In small pieces, as a real stream arrives.
            if (block.type === "text")
              for (const piece of block.text.match(/.{1,7}/gs) ?? []) onText?.(piece);
          }
          return response;
        },
      };
    })();
    const t = makeTestApp({ nearbyZones: [MASS_AVE], assistantModel: model });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: { ...HEADERS, accept: "text/event-stream" },
      payload: { text: "park me for an hour", location: COMMON },
    });
    const streamed = res.body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event: text"))
      .map((chunk) => (JSON.parse(chunk.split("\n")[1]!.slice(6)) as { delta: string }).delta)
      .join("");
    // Before any search, an amount-free sentence streams; the one with an
    // amount doesn't. After the search, nothing does.
    expect(streamed.trim()).toBe("Let me look.");
    expect(res.body).toContain("event: done");
  });

  test("the model's words on a card are held to it too: a label, a detail, or a note quoting another price falls back to the server's", async () => {
    const t = makeTestApp({ nearbyZones: [MASS_AVE, GARDEN_ST] });
    const tools = t.deps.assistantTools!;
    const ctx = ctxAt();
    await tools.execute(ctx, "update_request", { maxPriceUsd: 5, durationMinutes: 60 });
    await tools.execute(ctx, "quote_street", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        note: "Mass Ave is $4.50. Garden St is only $2.00 today!",
        options: [
          {
            id: "v1-bos-mass-ave-1",
            label: "Mass Ave — just $1.00",
            detail: "$4.15/hr on Mass Ave",
          },
          {
            id: "v1-bos-garden-st-1",
            nearMiss: true,
            label: "Garden St — within your budget",
            detail: "A great fit",
          },
        ],
      },
    });
    const plan = out.endTurn!.plan as unknown as {
      note?: string;
      options: { label: string; detail: string }[];
    };
    // A wrong price in the label: the server's label. Its own rate in the
    // detail: kept.
    expect(plan.options[0]).toMatchObject({
      label: "Street — Mass Ave",
      detail: "$4.15/hr on Mass Ave",
    });
    // A near-miss is named by the server, never by the model.
    expect(plan.options[1]).toMatchObject({
      label: "Street — Garden St",
      detail: "$5.65/hr, 4 hr max on Garden St — 2 min walk",
    });
    expect(plan.note).toBe("Mass Ave is $4.50.");
  });

  test("the request's own limit is always sayable", async () => {
    const model = scriptedModel([
      use("u1", "update_request", { maxPriceUsd: 20, durationMinutes: 60 }),
      say("Got it — under $20. Where are you headed?"),
    ]);
    const t = makeTestApp({ assistantModel: model });
    const body = (await send(t, { text: "under $20 for an hour" })).json();
    expect(body.reply).toBe("Got it — under $20. Where are you headed?");
    expect(t.state.decisions.some((d) => d.rule === "ungrounded_number")).toBe(false);
  });

  test("amounts another tool reported this turn are grounded: history keeps its numbers, an invented one goes", async () => {
    const t = makeTestApp({
      assistantModel: scriptedModel([
        use("h1", "get_history", { days: 7 }),
        say("Your last session cost $4.10. That's about $16.40 a week."),
      ]),
    });
    seedSession(t.state, {
      userId: "u1",
      amountUsd: 3.75,
      feeUsd: 0.35,
      createdAt: new Date("2026-01-04T15:00:00-05:00"),
    });
    const body = (await send(t, { text: "what did I spend last time?" })).json();
    expect(body.reply).toBe("Your last session cost $4.10.");
    expect(body.suggestions).toBeNull();
  });

  test("the scrub itself: sentences, decimals, and what counts as the same amount", () => {
    const grounded = new Set([450, 2000]);
    expect(scrubUngroundedAmounts("It's $4.50. Or $9.00 in a garage!", grounded)).toEqual({
      text: "It's $4.50.",
      dropped: [9],
    });
    // "$20" and "$20.00" are the same amount; a thousands comma reads through.
    expect(scrubUngroundedAmounts("Under $20, or $1,000.00?", grounded)).toEqual({
      text: "",
      dropped: [1000],
    });
    expect(scrubUngroundedAmounts("Under $20.00 it is.", grounded).text).toBe(
      "Under $20.00 it is.",
    );
    // A decimal point is not a sentence end.
    expect(scrubUngroundedAmounts("Pay $4.50 now. Then walk.", new Set()).text).toBe("Then walk.");
    // No amounts, nothing touched.
    expect(scrubUngroundedAmounts("Where are you headed?", new Set())).toEqual({
      text: "Where are you headed?",
      dropped: [],
    });
  });
});
