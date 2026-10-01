/**
 * "Say why the recommended option was recommended in one line": the
 * reason is the server's, computed from the options actually on the card
 * after every price and walk has been attached — never model text.
 */

import { describe, expect, test } from "vitest";

import type { SingleSpotOption, SingleSpotPlan } from "../src/services/assistant/plans.js";
import { recommendationReason } from "../src/services/assistant/plans.js";
import { AssistantTools } from "../src/services/assistant/tools.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption } from "../src/services/garage/garageProvider.js";
import { makeFakeDb, makePolicyService } from "./helpers.js";

/** The phone: where a request that names no place is searched. */
const HERE = { lat: 42.3503, lng: -71.0811 };

function option(
  id: string,
  priceUsd: number,
  walkMinutes: number | undefined,
  recommended = false,
) {
  return {
    id,
    type: "garage",
    label: id,
    detail: "",
    priceUsd,
    durationMinutes: 180,
    ...(walkMinutes !== undefined ? { walkMinutes } : {}),
    recommended,
  } as SingleSpotOption;
}

describe("the recommendation's reason", () => {
  test("cheapest and closest", () => {
    expect(recommendationReason([option("a", 0, 4, true), option("b", 24, 5)])).toBe(
      "Cheapest and closest — free, 4 min walk",
    );
  });

  test("cheapest only", () => {
    expect(recommendationReason([option("a", 4.1, 6, true), option("b", 24, 2)])).toBe(
      "Cheapest — $4.10, 6 min walk",
    );
  });

  test("closest only", () => {
    expect(recommendationReason([option("a", 24, 1, true), option("b", 4.1, 6)])).toBe(
      "Closest — $24.00, 1 min walk",
    );
  });

  test("neither: best value, naming what the cheapest would cost", () => {
    expect(
      recommendationReason([option("a", 12, 3, true), option("b", 4.1, 9), option("c", 11, 2)]),
    ).toBe("Best value — $12.00, 3 min walk; the cheapest is $4.10, 9 min walk");
  });

  test("closest is never claimed against an option with no walk to compare", () => {
    expect(recommendationReason([option("a", 24, 1, true), option("b", 4.1, undefined)])).toBe(
      "Best value — $24.00, 1 min walk; the cheapest is $4.10",
    );
  });

  test("one option", () => {
    expect(recommendationReason([option("a", 18, 3, true)])).toBe(
      "The only option found — $18.00, 3 min walk",
    );
  });
});

describe("propose_plan attaches it", () => {
  const GARAGE: GarageOption = {
    id: "g1",
    provider: "spothero",
    name: "Deck",
    address: "1 Test St",
    priceUsd: 18,
    distanceM: 240,
    walkMinutes: 3,
    entryType: "self",
    deepLink: "https://spothero.com/checkout/1",
  };

  test("from the server's final prices, over anything the model wrote", async () => {
    const tools = new AssistantTools({
      db: makeFakeDb().db,
      policy: makePolicyService(),
      findCandidates: async () => [],
      garage: {
        id: "spothero",
        canReserve: false,
        search: async () => ({ ok: true, options: [GARAGE], fromCache: false }),
        optionById: (id) => (id === "g1" ? GARAGE : null),
        book: async () => ({ kind: "deeplink_handoff", option: GARAGE, deepLink: GARAGE.deepLink }),
      },
    });
    const ctx: ToolContext = { userId: "u1", conversationId: "c1", location: HERE };
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        recommendedReason: "Because I said so",
        options: [
          {
            id: "v0-g1",
            label: "Deck",
            // The model's price is replaced by the search's $18.
            priceUsd: 1,
            recommended: true,
          },
        ],
      },
    });
    const plan = out.endTurn!.plan as SingleSpotPlan;
    expect(plan.recommendedReason).toBe("The only option found — $18.00, 3 min walk");
  });
});

describe("independent review fixes", () => {
  test("a garage's walk is the search's, so 'closest' is never a model's number", async () => {
    const far: GarageOption = { ...GARAGE_BASE, id: "g-far", walkMinutes: 9, priceUsd: 18 };
    const near: GarageOption = { ...GARAGE_BASE, id: "g-near", walkMinutes: 2, priceUsd: 24 };
    const byId = new Map([far, near].map((g) => [g.id, g]));
    const tools = new AssistantTools({
      db: makeFakeDb().db,
      policy: makePolicyService(),
      findCandidates: async () => [],
      garage: {
        id: "spothero",
        canReserve: false,
        search: async () => ({ ok: true, options: [far, near], fromCache: false }),
        optionById: (id) => byId.get(id) ?? null,
        book: async () => ({ kind: "deeplink_handoff", option: far, deepLink: far.deepLink }),
      },
    });
    const ctx: ToolContext = { userId: "u1", conversationId: "c1", location: HERE };
    await tools.execute(ctx, "search_garages", {});
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        options: [
          // The model claims the far garage is a 1-minute walk. A walk it
          // types isn't even read: the option is the search's, by id.
          { id: "v0-g-far", label: "Far", walkMinutes: 1, recommended: true },
          { id: "v0-g-near", label: "Near", walkMinutes: 2 },
        ],
      },
    });
    const plan = out.endTurn!.plan as SingleSpotPlan;
    expect(plan.options[0]!.walkMinutes).toBe(9);
    expect(plan.recommendedReason).toBe("Cheapest — $18.00, 9 min walk");
  });
});

const GARAGE_BASE: GarageOption = {
  id: "g",
  provider: "spothero",
  name: "Deck",
  address: "1 Test St",
  priceUsd: 18,
  distanceM: 240,
  walkMinutes: 3,
  entryType: "self",
  deepLink: "https://spothero.com/checkout/1",
};
