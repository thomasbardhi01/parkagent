/**
 * Regression suite for the prod bug (2026-09-21): the model quoted street
 * parking in prose, never called propose_plan, invited a verbal
 * "confirm", and duplicated its opener. A quoting turn must now always
 * end in a plan card; future street options carry payOnArrival and no
 * confirmable path; the reply never invites a verbal confirm; repeated
 * segments dedupe.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import {
  SYSTEM_PROMPT,
  joinReplySegments,
  scrubVerbalConfirm,
  streetQuotesIn,
} from "../src/services/assistant/loop.js";
import type { SingleSpotOption, SingleSpotPlan } from "../src/services/assistant/plans.js";
import { groundStreetOptions } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { API_KEY, BOYLSTON_BOS, MONDAY_2PM, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);
/** "2pm tomorrow" relative to the fixture Monday. */
const TOMORROW_2PM = "2026-01-06T14:00:00-05:00";
const PROD_REQUEST =
  "find me street parking near Boylston and Dartmouth for an hour at 2pm tomorrow";

function scriptedModel(responses: ModelResponse[]): ModelClient & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async create() {
      const response = responses[Math.min(state.calls, responses.length - 1)]!;
      state.calls += 1;
      return response;
    },
  };
}

/** The prod transcript, verbatim shape: quote in prose, no plan, verbal
 * confirm invite, opener repeated. */
function buggyModelResponses(): ModelResponse[] {
  const opener = "Let me check street parking near Boylston and Dartmouth.";
  return [
    {
      content: [
        { type: "text", text: opener },
        {
          type: "tool_use",
          id: "t1",
          name: "quote_street",
          input: { lat: 42.3495, lng: -71.0798, duration_minutes: 60, when: TOMORROW_2PM },
        },
      ],
      stopReason: "tool_use",
    },
    {
      content: [
        {
          type: "text",
          text: `${opener} It's $4.10 for the hour at Zone 81234 — just say confirm and I'll get it going.`,
        },
      ],
      stopReason: "end_turn",
    },
    // The one-shot reminder is also ignored — synthesis must kick in.
    {
      content: [{ type: "text", text: "It's $4.10 for the hour." }],
      stopReason: "end_turn",
    },
  ];
}

const REPORTED_ZONE = { ...BOYLSTON_BOS, providerZoneNumber: "81234" };

const GARAGE: GarageOption = {
  id: "g1",
  provider: "spothero",
  name: "Seaport Deck",
  address: "1 Seaport Ln",
  priceUsd: 27.13,
  distanceM: 240,
  walkMinutes: 3,
  entryType: "self",
  deepLink: "https://spothero.com/search?latitude=42.3503",
};

const SINGLE_SPOT_PLAN = {
  kind: "single_spot",
  options: [
    {
      id: "opt-garage",
      type: "garage",
      label: "Seaport Deck",
      detail: "Self park",
      priceUsd: 27.13,
      durationMinutes: 240,
      garageOptionId: "g1",
      deepLink: GARAGE.deepLink,
      recommended: true,
    },
  ],
};

describe("the prod request", () => {
  test("a quoting turn always ends in a plan: reminder ignored → synthesized street option, payOnArrival, no token, no verbal confirm, no duplicate opener", async () => {
    const model = scriptedModel(buggyModelResponses());
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: PROD_REQUEST, location: { lat: 42.3495, lng: -71.0798 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Non-null plan with exactly one street option.
    expect(body.plan).not.toBeNull();
    const plan = body.plan.plan as SingleSpotPlan;
    expect(plan.kind).toBe("single_spot");
    expect(plan.options).toHaveLength(1);
    expect(plan.options[0]).toMatchObject({
      type: "street",
      zoneId: REPORTED_ZONE.zoneId,
      durationMinutes: 60,
      startsAt: TOMORROW_2PM,
      // Tomorrow 2pm is future → the card shows auto-pay, no Confirm.
      payOnArrival: true,
      recommended: true,
    });
    expect(plan.options[0]!.priceUsd).toBeGreaterThan(0);

    // No confirmation token exists or was minted anywhere.
    expect(t.state.assistantConfirmations).toHaveLength(0);

    // The reply: opener once, and no verbal-confirm invitation.
    const opener = "Let me check street parking near Boylston and Dartmouth.";
    expect(body.reply.split(opener).length - 1).toBe(1);
    expect(body.reply.toLowerCase()).not.toContain("say confirm");
    expect(body.reply.toLowerCase()).not.toMatch(/say|type.*confirm/);

    // The model got exactly one reminder before synthesis took over.
    expect(model.calls).toBe(3);
    // The synthesized plan went through the audited tool.
    expect(t.state.decisions.some((d) => d.kind === "assistant_plan")).toBe(true);
  });

  test("a model that obeys the reminder proposes on the second try — no synthesis needed", async () => {
    const opener = "Checking Boylston and Dartmouth.";
    const model = scriptedModel([
      {
        content: [
          { type: "text", text: opener },
          {
            type: "tool_use",
            id: "t1",
            name: "quote_street",
            input: { lat: 42.3495, lng: -71.0798, duration_minutes: 60, when: TOMORROW_2PM },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "It's $4.10 for the hour." }], stopReason: "end_turn" },
      {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "propose_plan",
            input: {
              plan: {
                kind: "single_spot",
                options: [
                  {
                    id: "s1",
                    type: "street",
                    label: "Street — Zone 81234",
                    detail: "",
                    priceUsd: 4.1,
                    durationMinutes: 60,
                    zoneId: REPORTED_ZONE.zoneId,
                    startsAt: TOMORROW_2PM,
                    recommended: true,
                  },
                ],
              },
            },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: PROD_REQUEST },
    });
    const body = res.json();
    expect(body.plan).not.toBeNull();
    expect((body.plan.plan as SingleSpotPlan).options[0]).toMatchObject({ payOnArrival: true });
    expect(model.calls).toBe(3);
  });

  test("a street option for RIGHT NOW stays confirmable (payOnArrival false)", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const outcome = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      {
        plan: {
          kind: "single_spot",
          options: [
            {
              id: "s1",
              type: "street",
              label: "Street here",
              detail: "",
              priceUsd: 4.1,
              durationMinutes: 60,
              zoneId: REPORTED_ZONE.zoneId,
              startsAt: MONDAY_2PM,
              recommended: true,
            },
          ],
        },
      },
    );
    const plan = outcome.endTurn!.plan as SingleSpotPlan;
    expect(plan.options[0]!.payOnArrival).toBe(false);
  });

  test("confirming a pay-on-arrival street option is refused without minting", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const outcome = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      {
        plan: {
          kind: "single_spot",
          options: [
            {
              id: "s1",
              type: "street",
              label: "Street tomorrow",
              detail: "",
              priceUsd: 4.1,
              durationMinutes: 60,
              zoneId: REPORTED_ZONE.zoneId,
              startsAt: TOMORROW_2PM,
              recommended: true,
            },
          ],
        },
      },
    );
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: outcome.endTurn!.planId, optionId: "s1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "street_pay_on_arrival" });
    expect(t.state.assistantConfirmations).toHaveLength(0);
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "street_pay_on_arrival" });
  });
});

describe("FR-26 street options are grounded in a quote (nightly FR 2026-09-24)", () => {
  function streetOption(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "s1",
      type: "street",
      label: "Street near Newbury",
      detail: "",
      priceUsd: 4.1,
      durationMinutes: 60,
      startsAt: TOMORROW_2PM,
      recommended: true,
      ...extra,
    };
  }

  test("a quoted street option the model sent without zoneId reaches the card with the quoted zone", async () => {
    // The nightly failure's shape: the model quoted, then proposed with
    // the zone under a key zod strips — the card got no zoneId.
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "quote_street",
            input: { lat: 42.3495, lng: -71.0798, duration_minutes: 60, when: TOMORROW_2PM },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "propose_plan",
            input: {
              plan: {
                kind: "single_spot",
                options: [streetOption({ zone: REPORTED_ZONE.zoneId })],
              },
            },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: PROD_REQUEST },
    });
    expect(res.statusCode).toBe(200);
    const option = (res.json().plan.plan as SingleSpotPlan).options[0]!;
    expect(option.zoneId).toBe(REPORTED_ZONE.zoneId);
    expect(option).not.toHaveProperty("zone");
    // Proposed on the model's own call — not the synthesis fallback.
    expect(model.calls).toBe(2);
  });

  test("a later turn's re-proposal is grounded in the quote an earlier turn made", async () => {
    const proposal = (id: string, option: Record<string, unknown>): ModelResponse => ({
      content: [
        {
          type: "tool_use",
          id,
          name: "propose_plan",
          input: { plan: { kind: "single_spot", options: [option] } },
        },
      ],
      stopReason: "tool_use",
    });
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "quote_street",
            input: { lat: 42.3495, lng: -71.0798, duration_minutes: 60, when: TOMORROW_2PM },
          },
        ],
        stopReason: "tool_use",
      },
      proposal("t2", streetOption({ zoneId: REPORTED_ZONE.zoneId })),
      // Next turn: no new quote, and the zoneId dropped.
      proposal("t3", streetOption({ label: "Same spot, 60 minutes" })),
    ]);
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const first = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: PROD_REQUEST },
    });
    const second = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "Same again please.", conversation_id: first.json().conversationId },
    });
    expect(second.statusCode).toBe(200);
    const option = (second.json().plan.plan as SingleSpotPlan).options[0]!;
    expect(option.label).toBe("Same spot, 60 minutes");
    expect(option.zoneId).toBe(REPORTED_ZONE.zoneId);
  });

  test("a street option with no quote behind it is refused, audited, and mints no plan", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const outcome = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "propose_plan",
      { plan: { kind: "single_spot", options: [streetOption()] } },
    );
    expect(outcome.endTurn).toBeUndefined();
    expect(outcome.result).toMatchObject({
      error: "street_option_ungrounded",
      optionId: "s1",
      quotedZoneIds: [],
    });
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "ungrounded_street_option" });
    expect(t.state.decisions.some((d) => d.kind === "assistant_plan")).toBe(false);
  });

  test("a quote_street earlier in the same turn grounds a later propose_plan", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const ctx = { userId: "u1", conversationId: "c1" };
    await t.deps.assistantTools!.execute(ctx, "quote_street", {
      lat: 42.3495,
      lng: -71.0798,
      duration_minutes: 60,
      when: TOMORROW_2PM,
    });
    const outcome = await t.deps.assistantTools!.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [streetOption()] },
    });
    expect((outcome.endTurn!.plan as SingleSpotPlan).options[0]!.zoneId).toBe(REPORTED_ZONE.zoneId);
  });

  test("groundStreetOptions: one zone fills; several resolve by price or refuse; a stated zone and garages pass", () => {
    const base = { label: "x", detail: "", durationMinutes: 60, recommended: false };
    const street = (id: string, priceUsd: number, zoneId?: string): SingleSpotOption => ({
      ...base,
      id,
      type: "street",
      priceUsd,
      ...(zoneId ? { zoneId } : {}),
    });
    const garage: SingleSpotOption = {
      ...base,
      id: "g",
      type: "garage",
      priceUsd: 20,
      garageOptionId: "g1",
    };
    const two = [
      { zoneId: "bos-a", costUsd: 4.1 },
      { zoneId: "bos-b", costUsd: 6.2 },
    ];

    // One zone quoted (twice) fills regardless of the option's price.
    const one = groundStreetOptions([street("s", 99)], [two[0]!, two[0]!]);
    expect(one).toMatchObject({ ok: true, options: [{ zoneId: "bos-a" }] });
    // Several zones: the price picks the one quoted at it…
    expect(groundStreetOptions([street("s", 6.2), garage], two)).toMatchObject({
      ok: true,
      options: [{ zoneId: "bos-b" }, { id: "g", garageOptionId: "g1" }],
    });
    // …and a price quoted for neither is ambiguous.
    expect(groundStreetOptions([street("s", 5)], two)).toEqual({ ok: false, optionId: "s" });
    // Nothing quoted: refused. An explicit zoneId is kept as sent.
    expect(groundStreetOptions([street("s", 4.1)], [])).toEqual({ ok: false, optionId: "s" });
    expect(groundStreetOptions([street("s", 5, "bos-z")], two)).toMatchObject({
      ok: true,
      options: [{ zoneId: "bos-z" }],
    });
  });

  test("streetQuotesIn reads found quotes from a stored transcript, skipping misses, other tools, and orphans", () => {
    const turns: ModelTurn[] = [
      { role: "user", content: "parking near Newbury" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "q1", name: "quote_street", input: {} },
          { type: "tool_use", id: "q2", name: "quote_street", input: {} },
          { type: "tool_use", id: "g1", name: "search_garages", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "q1",
            content: JSON.stringify({ found: true, zoneId: "bos-a", costUsd: 4.1 }),
          },
          { type: "tool_result", tool_use_id: "q2", content: JSON.stringify({ found: false }) },
          {
            type: "tool_result",
            tool_use_id: "g1",
            content: JSON.stringify({ found: true, zoneId: "bos-garage" }),
          },
          // Its tool_use was trimmed off the stored history.
          {
            type: "tool_result",
            tool_use_id: "q0",
            content: JSON.stringify({ found: true, zoneId: "bos-old" }),
          },
        ],
      },
    ];
    expect(streetQuotesIn(turns)).toEqual([{ zoneId: "bos-a", costUsd: 4.1 }]);
  });
});

describe("verbal confirm is a dead end", () => {
  test("typing 'confirm' in chat books nothing — the tool refuses and the reply points at the card", async () => {
    // A model that treats the typed word as authorization and calls the
    // consequential tool without a token.
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "start_session",
            input: { zone: "bos-x", duration_minutes: 60 },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          {
            type: "text",
            text: "I can't start it from chat — use the Confirm button on the card.",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const t = makeTestApp({ assistantModel: model, now: () => NOW });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "confirm" },
    });
    expect(res.statusCode).toBe(200);
    // Refused at the tool gate, audited, nothing started or minted.
    expect(
      t.state.decisions.some((d) => d.kind === "assistant_tool" && d.rule === "needs_confirmation"),
    ).toBe(true);
    expect(t.state.sessions).toHaveLength(0);
    expect(t.state.assistantConfirmations).toHaveLength(0);
  });

  test("the system prompt forbids verbal confirmation and explains the future-street card", () => {
    expect(SYSTEM_PROMPT).toContain("never invite a verbal confirmation");
    expect(SYSTEM_PROMPT).toContain("pay automatically when you park here");
    expect(SYSTEM_PROMPT).toContain("TAPPING a card");
  });
});

describe("reply hygiene units", () => {
  test("joinReplySegments drops exact repeats and repeated-prefix openers", () => {
    const opener = "Let me check street parking.";
    expect(joinReplySegments([opener, `${opener} It's $4.10 for the hour.`])).toBe(
      `${opener} It's $4.10 for the hour.`,
    );
    expect(joinReplySegments([opener, opener])).toBe(opener);
    expect(joinReplySegments(["A.", "B.", "A. C."])).toBe("A. B. C.");
    expect(joinReplySegments(["", "  ", "Only."])).toBe("Only.");
  });

  test("scrubVerbalConfirm strips the invitation and points at the card", () => {
    const scrubbed = scrubVerbalConfirm(
      "It's $4.10 for the hour. Just say confirm and I'll get it going.",
      true,
    );
    expect(scrubbed).toContain("$4.10");
    expect(scrubbed.toLowerCase()).not.toContain("say confirm");
    expect(scrubbed).toContain("Tap Confirm on a card");
    // Variants.
    for (const invite of [
      "Type 'confirm' to proceed.",
      "Reply confirm to book it.",
      "Tell me to confirm and it's done.",
    ]) {
      const out = scrubVerbalConfirm(`Price is $5.00. ${invite}`, true);
      expect(out.toLowerCase()).not.toContain("confirm to");
      expect(out).toContain("$5.00");
    }
    // Clean replies pass through untouched.
    const clean = "Here are your options.";
    expect(scrubVerbalConfirm(clean, true)).toBe(clean);
  });
});

describe("the model can't time-travel (Seaport prod bug #2)", () => {
  test("every user turn carries the current time line", async () => {
    const model = scriptedModel([
      { content: [{ type: "text", text: "Which neighborhood?" }], stopReason: "end_turn" },
    ]);
    const t = makeTestApp({ assistantModel: model, now: () => NOW });
    await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "garage tonight" },
    });
    const turns = JSON.stringify(t.state.conversations[0]!.turns);
    // Monday 2026-01-05 14:00 ET — the fixture clock, injected verbatim.
    expect(turns).toContain("[current time: Mon 2026-01-05 14:00 ET]");
  });

  test("a hallucinated past window bounces with the current time and the model self-corrects", async () => {
    const goodGarage: GarageProvider = {
      id: "spothero",
      canReserve: false,
      search: async (q) =>
        q.startsAt.startsWith("2026")
          ? { ok: true, options: [GARAGE], fromCache: false }
          : { ok: false, error: "parse_failed", detail: "HTTP 400" },
      optionById: (id) => (id === "g1" ? GARAGE : null),
      book: async () => {
        throw new Error("unreachable");
      },
    };
    const model = scriptedModel([
      // The prod transcript: "tonight" rendered as a 2024 date.
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "search_garages",
            input: {
              lat: 42.3503,
              lng: -71.04,
              starts_at: "2024-01-09T18:00:00",
              ends_at: "2024-01-09T22:00:00",
              budget_usd: 50,
            },
          },
        ],
        stopReason: "tool_use",
      },
      // The corrective tool error names the current time; retry right.
      {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "search_garages",
            input: {
              lat: 42.3503,
              lng: -71.04,
              starts_at: "2026-01-05T18:00:00",
              ends_at: "2026-01-05T22:00:00",
              budget_usd: 50,
            },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          { type: "tool_use", id: "t3", name: "propose_plan", input: { plan: SINGLE_SPOT_PLAN } },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ assistantModel: model, garage: goodGarage, now: () => NOW });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/message",
      headers: HEADERS,
      payload: { text: "I need a garage near the Seaport from 6 to 10 tonight" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).not.toBeNull();

    // The bounce was audited and never reached the provider…
    expect(t.state.decisions.some((d) => d.rule === "past_window")).toBe(true);
    expect(t.state.decisions.some((d) => d.rule === "garage_search_error")).toBe(false);
    // …the model saw the corrective error with the real clock…
    const turns = JSON.stringify(t.state.conversations[0]!.turns);
    expect(turns).toContain("window_in_the_past");
    expect(turns).toContain("2026-01-05 14:00 ET");
    // …and the retry succeeded.
    expect(t.state.decisions.some((d) => d.kind === "assistant_tool" && d.rule === "ok")).toBe(
      true,
    );
  });

  test("quote_street gets the same guard", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const outcome = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "quote_street",
      { lat: 42.3495, lng: -71.0798, duration_minutes: 60, when: "2024-01-09T18:00:00" },
    );
    expect((outcome.result as { error: string }).error).toBe("window_in_the_past");
    // A slightly-stale "now" (within the hour) still quotes.
    const fresh = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1" },
      "quote_street",
      {
        lat: 42.3495,
        lng: -71.0798,
        duration_minutes: 60,
        when: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      },
    );
    expect((fresh.result as { found: boolean }).found).toBe(true);
  });
});
