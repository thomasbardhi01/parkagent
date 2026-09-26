/**
 * Clarifying questions render as taps, and every plan states what it
 * assumed (device test: the assistant asked "Boston or NYC?" in prose and
 * never said which window or place it had settled on).
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse } from "../src/services/assistant/loop.js";
import { runAssistantTurn } from "../src/services/assistant/loop.js";
import {
  assumptionsFor,
  suggestionsForQuestion,
  windowText,
} from "../src/services/assistant/clarify.js";
import type { AssistantPlanBody } from "../src/services/assistant/plans.js";
import { AssistantTools } from "../src/services/assistant/tools.js";
import { makeFakeDb, makePolicyService } from "./helpers.js";

/** Friday 25 Sep 2026, 3 PM ET. */
const FRIDAY_3PM = new Date("2026-09-25T15:00:00-04:00");

function single(
  options: Partial<Record<string, unknown>>[],
  destination?: string,
): AssistantPlanBody {
  return {
    kind: "single_spot",
    options: options.map((o, i) => ({
      id: `o${i}`,
      type: "street",
      label: "x",
      detail: "",
      priceUsd: 0,
      durationMinutes: 180,
      recommended: i === 0,
      ...o,
    })),
    ...(destination ? { destination: { lat: 42.35, lng: -71.04, label: destination } } : {}),
  } as AssistantPlanBody;
}

describe("the assumptions line", () => {
  test("a later window and the place: 'Sat 7:00–10:00 PM, near LoLa 42, Seaport'", () => {
    const plan = single([{ startsAt: "2026-09-26T19:00:00-04:00" }], "LoLa 42, Seaport");
    expect(assumptionsFor(plan, FRIDAY_3PM)).toBe("Tomorrow 7:00–10:00 PM, near LoLa 42, Seaport");
    const monday = new Date("2026-09-21T09:00:00-04:00");
    expect(assumptionsFor(plan, monday)).toBe("Sat 7:00–10:00 PM, near LoLa 42, Seaport");
  });

  test("today's window has no day", () => {
    const plan = single([{ startsAt: "2026-09-25T19:00:00-04:00" }], "LoLa 42, Seaport");
    expect(assumptionsFor(plan, FRIDAY_3PM)).toBe("7:00–10:00 PM, near LoLa 42, Seaport");
  });

  test("no start means now, for the recommended option's stay", () => {
    expect(assumptionsFor(single([{ durationMinutes: 90 }]), FRIDAY_3PM)).toBe("Now–4:30 PM");
  });

  test("across noon", () => {
    expect(
      windowText(new Date("2026-09-25T11:30:00-04:00"), new Date("2026-09-25T13:00:00-04:00")),
    ).toBe("11:30 AM–1:00 PM");
  });

  test("an itinerary: the day, the stops, the span", () => {
    const day = {
      kind: "itinerary",
      date: "2026-09-28",
      stops: [
        { arrival: "2026-09-28T16:00:00-04:00", durationMinutes: 30 },
        { arrival: "2026-09-28T10:00:00-04:00", durationMinutes: 60 },
      ].map((s, i) => ({
        id: `s${i}`,
        label: "x",
        address: "",
        lat: 42.35,
        lng: -71.06,
        choice: "street",
        costUsd: 4,
        ...s,
      })),
      totalUsd: 8,
      capUsd: 60,
    } as AssistantPlanBody;
    expect(assumptionsFor(day, FRIDAY_3PM)).toBe("Mon 2 stops, 10:00 AM–4:30 PM");
  });

  test("propose_plan attaches it, over anything the model wrote", async () => {
    const tools = new AssistantTools({
      db: makeFakeDb().db,
      policy: makePolicyService(),
      findCandidates: async () => [],
      garage: {
        id: "none",
        canReserve: false,
        search: async () => ({ ok: true, options: [], fromCache: false }),
        optionById: () => null,
        book: async () => {
          throw new Error("no");
        },
      },
      now: () => FRIDAY_3PM,
    });
    const ctx = {
      userId: "u1",
      conversationId: "c1",
      streetQuotes: [{ zoneId: "bos-seaport-blvd-de413d-01", costUsd: 0 }],
      geocode: { lat: 42.3546, lng: -71.0453, label: "LoLa 42, Seaport" },
    };
    const out = await tools.execute(ctx, "propose_plan", {
      plan: {
        kind: "single_spot",
        assumptions: "whatever the model thought",
        options: [
          {
            id: "street",
            type: "street",
            label: "Seaport Blvd",
            priceUsd: 0,
            durationMinutes: 180,
            zoneId: "bos-seaport-blvd-de413d-01",
            startsAt: "2026-09-25T19:00:00-04:00",
            recommended: true,
          },
        ],
      },
    });
    expect((out.endTurn!.plan as { assumptions: string }).assumptions).toBe(
      "7:00–10:00 PM, near LoLa 42, Seaport",
    );
  });
});

describe("questions asked in prose still get taps", () => {
  test("how long", () => {
    expect(suggestionsForQuestion("How long will you stay?")?.map((s) => s.label)).toEqual([
      "1 hour",
      "2 hours",
      "3 hours",
    ]);
  });

  test("what time", () => {
    expect(suggestionsForQuestion("What time will you arrive?")?.map((s) => s.label)).toEqual([
      "Now",
      "In 30 minutes",
      "Tonight at 7",
    ]);
  });

  test("which city: the covered cities, from the registry", () => {
    expect(suggestionsForQuestion("Is that in Boston or New York City?")).toEqual([
      { label: "Boston", reply: "In Boston" },
      { label: "New York City", reply: "In New York City" },
    ]);
  });

  test("not a question, or not one of these: nothing", () => {
    expect(suggestionsForQuestion("Here are your options.")).toBeNull();
    expect(suggestionsForQuestion("Do you like steak?")).toBeNull();
  });

  test("the loop attaches them to a prose question", async () => {
    const model: ModelClient = {
      async create(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "Got it — how long will you stay?" }],
          stopReason: "end_turn",
        };
      },
    };
    const result = await runAssistantTurn({
      db: makeFakeDb().db,
      model,
      tools: new AssistantTools({
        db: makeFakeDb().db,
        policy: makePolicyService(),
        findCandidates: async () => [],
        garage: {
          id: "none",
          canReserve: false,
          search: async () => ({ ok: true, options: [], fromCache: false }),
          optionById: () => null,
          book: async () => {
            throw new Error("no");
          },
        },
      }),
      userId: "u1",
      conversationId: "c-q",
      text: "park me near Fenway",
    });
    expect(result.suggestions?.map((s) => s.reply)).toEqual([
      "For 1 hour",
      "For 2 hours",
      "For 3 hours",
    ]);
  });
});
