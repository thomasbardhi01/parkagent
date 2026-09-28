/**
 * A clock time the user asks for is never silently changed.
 *
 * Nightly 36361125345 (Sun 2026-09-27, 8:11 PM ET): "Find me a parking spot
 * at Seaport at 7 PM near Lola 42 for three hours". The past-window guard
 * bounced 7 PM today and told the model to recompute from the current
 * time, and the card read "8:11–11:11 PM". Now the loop states the reading
 * on the message (requestedTime.ts), the quote tools and propose_plan
 * refuse a window that moves it, the card says what it assumed, and a
 * question about it comes with its two answers.
 */
import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { requestedTimeIn } from "../src/services/assistant/requestedTime.js";
import { API_KEY, BOYLSTON_BOS, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const LOLA = { lat: 42.35458, lng: -71.04526, label: "LoLa 42, Seaport" };
const DEVICE_TEST = "Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours";

/** A scripted model that keeps what it was sent on each call. */
function recording(responses: ModelResponse[]): { client: ModelClient; seen: ModelTurn[][] } {
  const seen: ModelTurn[][] = [];
  let call = 0;
  return {
    seen,
    client: {
      async create(args) {
        seen.push(JSON.parse(JSON.stringify(args.messages)) as ModelTurn[]);
        const response = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return response;
      },
    },
  };
}

const tool = (id: string, name: string, input: unknown): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (t: string): ModelResponse => ({
  content: [{ type: "text", text: t }],
  stopReason: "end_turn",
});

const quote = (id: string, when: string, minutes: number) =>
  tool(id, "quote_street", { lat: LOLA.lat, lng: LOLA.lng, duration_minutes: minutes, when });

const propose = (id: string, startsAt: string | null, minutes: number) =>
  tool(id, "propose_plan", {
    plan: {
      kind: "single_spot",
      destination: LOLA,
      options: [
        {
          id: "street-1",
          type: "street",
          label: "Boylston St",
          priceUsd: 0,
          durationMinutes: minutes,
          zoneId: BOYLSTON_BOS.zoneId,
          ...(startsAt ? { startsAt } : {}),
          recommended: true,
        },
      ],
    },
  });

/** The user text the model got on this call (the turn's own message). */
function userMessage(messages: ModelTurn[]): string {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string");
  return String(first?.content ?? "");
}

/** The last tool result the model got on this call, parsed. */
function lastToolResult(messages: ModelTurn[]): Record<string, unknown> {
  for (const turn of [...messages].reverse()) {
    if (turn.role !== "user" || typeof turn.content === "string") continue;
    const block = [...turn.content].reverse().find((b) => b.type === "tool_result");
    if (block && block.type === "tool_result") {
      return JSON.parse(block.content) as Record<string, unknown>;
    }
  }
  throw new Error("no tool result in this call's messages");
}

async function send(
  t: ReturnType<typeof makeTestApp>,
  message: string,
  conversationId?: string,
): Promise<{
  conversationId: string;
  reply: string;
  plan: { plan: { assumptions?: string; options: { startsAt?: string }[] } } | null;
  suggestions: { label: string; reply: string }[] | null;
}> {
  const res = await t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: HEADERS,
    payload: {
      text: message,
      location: { lat: 42.2206, lng: -71.0041 },
      ...(conversationId ? { conversation_id: conversationId } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("a requested time that has already passed today", () => {
  // The nightly's own moment: Sunday 8:11 PM, "at 7 PM".
  const NOW = new Date("2026-09-27T20:11:00-04:00");
  const NOW_ISO = "2026-09-27T20:11:00-04:00";
  const TOMORROW_7 = "2026-09-28T19:00:00-04:00";

  test("is read as tomorrow, never moved to now: both guards refuse now, and the card says it assumed", async () => {
    const model = recording([
      quote("q1", NOW_ISO, 180), // the model reaches for "now"…
      quote("q2", TOMORROW_7, 180), // …is told the next occurrence, and uses it
      propose("p1", NOW_ISO, 180), // a plan for now is refused too
      propose("p2", TOMORROW_7, 180),
      text("Here are your options for tomorrow evening."),
    ]);
    const t = makeTestApp({
      assistantModel: model.client,
      candidates: [BOYLSTON_BOS],
      now: () => NOW,
    });
    const out = await send(t, DEVICE_TEST);

    // What the model was told, before any tool: it has passed, and when
    // it next comes round.
    const told = userMessage(model.seen[0]!);
    expect(told).toContain("[requested time: 7 PM");
    expect(told).toContain("already passed");
    expect(told).toContain(TOMORROW_7);

    // A quote for now is refused with the requested time's next occurrence
    // and the question to ask instead…
    const quoteBounce = lastToolResult(model.seen[1]!);
    expect(quoteBounce["error"]).toBe("requested_time_moved");
    expect(String(quoteBounce["instruction"])).toContain(TOMORROW_7);
    expect(String(quoteBounce["instruction"])).toContain('"Tomorrow at 7 PM" / "Now"');
    expect(String(quoteBounce["instruction"])).not.toContain("from the current time");
    // …and so is a plan that starts now.
    expect(lastToolResult(model.seen[3]!)["error"]).toBe("requested_time_moved");
    expect(t.state.decisions.filter((d) => d.rule === "requested_time_moved")).toHaveLength(2);

    // The card: tomorrow at 7, and it says so.
    expect(out.plan).not.toBeNull();
    expect(out.plan!.plan.options[0]!.startsAt).toBe(TOMORROW_7);
    expect(out.plan!.plan.assumptions).toBe(
      "Assuming tomorrow, 7:00–10:00 PM, near LoLa 42, Seaport",
    );
  });

  test("a question about it comes with its two answers, and choosing Now is the user's call", async () => {
    const model = recording([
      text("7 PM has already passed today — do you want tomorrow at 7 PM, or now?"),
      // The user taps "Now": no time in that message, so now is theirs.
      quote("q1", NOW_ISO, 180),
      propose("p1", null, 180),
      text("Here's what's open now."),
    ]);
    const t = makeTestApp({
      assistantModel: model.client,
      candidates: [BOYLSTON_BOS],
      now: () => NOW,
    });
    const asked = await send(t, DEVICE_TEST);
    expect(asked.plan).toBeNull();
    expect(asked.suggestions).toEqual([
      { label: "Tomorrow at 7 PM", reply: "Tomorrow at 7 PM" },
      { label: "Now", reply: "Now" },
    ]);

    const now = await send(t, "Now", asked.conversationId);
    expect(userMessage(model.seen[1]!.slice(-1))).not.toContain("[requested time");
    expect(now.plan).not.toBeNull();
    expect(now.plan!.plan.assumptions).toBe("Now–11:11 PM, near LoLa 42, Seaport");
    expect(t.state.decisions.some((d) => d.rule === "requested_time_moved")).toBe(false);
  });

  test("a day the user named is theirs: no reading, and the card says the day plainly", async () => {
    const model = recording([
      quote("q1", TOMORROW_7, 180),
      propose("p1", TOMORROW_7, 180),
      text("Here are your options."),
    ]);
    const t = makeTestApp({
      assistantModel: model.client,
      candidates: [BOYLSTON_BOS],
      now: () => NOW,
    });
    const out = await send(t, "Find me parking near Lola 42 tomorrow at 7 PM for three hours");
    expect(userMessage(model.seen[0]!)).not.toContain("[requested time");
    expect(out.plan!.plan.assumptions).toBe("Tomorrow 7:00–10:00 PM, near LoLa 42, Seaport");
  });
});

describe("a requested time later today", () => {
  // Monday 3 PM, "at 7 PM": tonight, as asked.
  const NOW = new Date("2026-09-28T15:00:00-04:00");
  const NOW_ISO = "2026-09-28T15:00:00-04:00";
  const TODAY_7 = "2026-09-28T19:00:00-04:00";

  test("is planned for exactly that time: a quote or plan for now is refused", async () => {
    const model = recording([
      quote("q1", NOW_ISO, 180),
      quote("q2", TODAY_7, 180),
      propose("p1", NOW_ISO, 180),
      propose("p2", TODAY_7, 180),
      text("Here are your options."),
    ]);
    const t = makeTestApp({
      assistantModel: model.client,
      candidates: [BOYLSTON_BOS],
      now: () => NOW,
    });
    const out = await send(t, DEVICE_TEST);

    const told = userMessage(model.seen[0]!);
    expect(told).toContain("[requested time: 7 PM — later today");
    expect(told).toContain(TODAY_7);
    const bounce = lastToolResult(model.seen[1]!);
    expect(bounce["error"]).toBe("requested_time_moved");
    expect(String(bounce["instruction"])).toContain("don't move the time they asked for");
    expect(lastToolResult(model.seen[3]!)["error"]).toBe("requested_time_moved");

    expect(out.plan!.plan.options[0]!.startsAt).toBe(TODAY_7);
    // Today, as asked: no day, nothing assumed.
    expect(out.plan!.plan.assumptions).toBe("7:00–10:00 PM, near LoLa 42, Seaport");
  });
});

describe('"tonight" asked after midnight', () => {
  // Monday 1:30 AM: "tonight" is Monday evening, not the night still going.
  const NOW = new Date("2026-09-28T01:30:00-04:00");
  const NOW_ISO = "2026-09-28T01:30:00-04:00";
  const EVENING_7 = "2026-09-28T19:00:00-04:00";

  test("means this coming evening: now is refused, and the card says it assumed the evening", async () => {
    const model = recording([
      quote("q1", NOW_ISO, 120),
      quote("q2", EVENING_7, 120),
      propose("p1", NOW_ISO, 120),
      propose("p2", EVENING_7, 120),
      text("Here are your options for this evening."),
    ]);
    const t = makeTestApp({
      assistantModel: model.client,
      candidates: [BOYLSTON_BOS],
      now: () => NOW,
    });
    const out = await send(t, "Find me street parking near Lola 42 tonight for two hours");

    const told = userMessage(model.seen[0]!);
    expect(told).toContain('[requested time: "tonight", asked at 1:30 AM');
    expect(told).toContain("this coming evening");
    expect(lastToolResult(model.seen[1]!)["error"]).toBe("requested_time_moved");
    expect(lastToolResult(model.seen[3]!)["error"]).toBe("requested_time_moved");

    expect(out.plan!.plan.options[0]!.startsAt).toBe(EVENING_7);
    expect(out.plan!.plan.assumptions).toBe(
      "Assuming this evening, 7:00–9:00 PM, near LoLa 42, Seaport",
    );
  });

  test("a question about it offers this evening or now", async () => {
    const model = recording([text("Do you mean this evening, or right now?")]);
    const t = makeTestApp({
      assistantModel: model.client,
      candidates: [BOYLSTON_BOS],
      now: () => NOW,
    });
    const asked = await send(t, "parking near Fenway tonight");
    expect(asked.suggestions).toEqual([
      { label: "This evening", reply: "This evening" },
      { label: "Now", reply: "Now" },
    ]);
  });
});

describe("a day's stops keep their own times", () => {
  test("build_itinerary's street quotes aren't held to the message's one requested time", async () => {
    const NOW = new Date("2026-09-28T15:00:00-04:00");
    const t = makeTestApp({ candidates: [BOYLSTON_BOS], now: () => NOW });
    const out = await t.deps.assistantTools!.execute(
      {
        userId: "u1",
        conversationId: "c1",
        timeRequest: requestedTimeIn("dinner at 7 PM", NOW)!,
      },
      "build_itinerary",
      {
        stops: [
          {
            label: "Museum",
            address: "Boylston St",
            lat: LOLA.lat,
            lng: LOLA.lng,
            // Earlier than the requested 7 PM: exactly what the quote guard
            // refuses for a single spot, and fine for a day's first stop.
            arrival: "2026-09-28T16:00:00-04:00",
            duration_minutes: 60,
          },
        ],
      },
    );
    const stops = (out.result as { stops: { street: { found?: boolean; error?: string } }[] })
      .stops;
    expect(stops[0]!.street.error).toBeUndefined();
    expect(stops[0]!.street.found).toBe(true);
  });
});
