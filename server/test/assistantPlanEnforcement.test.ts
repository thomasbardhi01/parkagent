/**
 * Regression suite for the prod bug (2026-09-21): the model quoted street
 * parking in prose, never called propose_plan, invited a verbal
 * "confirm", and duplicated its opener. A turn that searches is reminded
 * once to end in a plan card; future street options carry payOnArrival
 * and no confirmable path; the reply never invites a verbal confirm;
 * repeated segments dedupe.
 *
 * Since FR-43 the loop no longer builds the card itself when the model
 * won't (that synthesized plan could re-propose what the user had just
 * ruled out): a quote left in prose is dropped from the reply instead,
 * and every option on a card is one the latest search returned, by id.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse } from "../src/services/assistant/loop.js";
import {
  SYSTEM_PROMPT,
  joinReplySegments,
  scrubVerbalConfirm,
} from "../src/services/assistant/loop.js";
import type { SingleSpotPlan } from "../src/services/assistant/plans.js";
import type { ToolContext } from "../src/services/assistant/tools.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import { API_KEY, BOYLSTON_BOS, MONDAY_2PM, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);
/** "2pm tomorrow" relative to the fixture Monday. */
const TOMORROW_2PM = "2026-01-06T14:00:00-05:00";
const PROD_REQUEST =
  "find me street parking near Boylston and Dartmouth for an hour at 2pm tomorrow";
/** The phone, at Boylston and Dartmouth. */
const HERE = { lat: 42.3495, lng: -71.0798 };

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

/** One model message that puts the hour at 2 PM tomorrow on the request
 * and searches the street for it (→ request version 1). */
const requestAndQuote = (opener?: string): ModelResponse => ({
  content: [
    ...(opener ? [{ type: "text" as const, text: opener }] : []),
    {
      type: "tool_use",
      id: "t0",
      name: "update_request",
      input: { startsAt: TOMORROW_2PM, durationMinutes: 60 },
    },
    { type: "tool_use", id: "t1", name: "quote_street", input: {} },
  ],
  stopReason: "tool_use",
});

/** The prod transcript, verbatim shape: quote in prose, no plan, verbal
 * confirm invite, opener repeated. */
function buggyModelResponses(): ModelResponse[] {
  const opener = "Let me check street parking near Boylston and Dartmouth.";
  return [
    requestAndQuote(opener),
    {
      content: [
        {
          type: "text",
          text: `${opener} It's $4.10 for the hour at Zone 81234 — just say confirm and I'll get it going.`,
        },
      ],
      stopReason: "end_turn",
    },
    // The one-shot reminder is ignored too.
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

/** The one street block, by the id a search at request version 1 gives it. */
const STREET_ID = `v1-${BOYLSTON_BOS.zoneId}`;

const proposeStreet = (option: Record<string, unknown> = {}): ModelResponse => ({
  content: [
    {
      type: "tool_use",
      id: "t2",
      name: "propose_plan",
      input: { plan: { kind: "single_spot", options: [{ id: STREET_ID, ...option }] } },
    },
  ],
  stopReason: "tool_use",
});

const send = (t: ReturnType<typeof makeTestApp>, payload: Record<string, unknown>) =>
  t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: HEADERS,
    payload: { location: HERE, ...payload },
  });

/** A context that has put a window on the request and searched the street. */
async function quoted(
  t: ReturnType<typeof makeTestApp>,
  window: Record<string, unknown>,
): Promise<ToolContext> {
  const ctx: ToolContext = { userId: "u1", conversationId: "c1", location: HERE };
  await t.deps.assistantTools!.execute(ctx, "update_request", window);
  await t.deps.assistantTools!.execute(ctx, "quote_street", {});
  return ctx;
}

describe("the prod request", () => {
  test("a quoting turn that won't propose: one reminder, then no card, no price in prose, no verbal confirm, no duplicate opener", async () => {
    const model = scriptedModel(buggyModelResponses());
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const res = await send(t, { text: PROD_REQUEST });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // No card: the loop doesn't build a plan the model didn't propose.
    expect(body.plan).toBeNull();
    expect(t.state.assistantPlans).toHaveLength(0);
    expect(t.state.decisions.some((d) => d.kind === "assistant_plan")).toBe(false);
    // No confirmation token exists or was minted anywhere.
    expect(t.state.assistantConfirmations).toHaveLength(0);

    // The reply: opener once, no verbal-confirm invitation, and no price
    // the user has no card to act on.
    const opener = "Let me check street parking near Boylston and Dartmouth.";
    expect(body.reply.split(opener).length - 1).toBe(1);
    expect(body.reply.toLowerCase()).not.toContain("say confirm");
    expect(body.reply.toLowerCase()).not.toMatch(/say|type.*confirm/);
    expect(body.reply).not.toContain("$");
    expect(t.state.decisions.some((d) => d.rule === "ungrounded_number")).toBe(true);
    // The way forward is one tap.
    expect(body.suggestions).toEqual([{ label: "Search again", reply: "Search again" }]);

    // The model got exactly one reminder, and that was the end of it.
    expect(model.calls).toBe(3);
  });

  test("a model that obeys the reminder proposes on the second try", async () => {
    const opener = "Checking Boylston and Dartmouth.";
    const model = scriptedModel([
      requestAndQuote(opener),
      { content: [{ type: "text", text: "It's $4.10 for the hour." }], stopReason: "end_turn" },
      proposeStreet({ label: "Street — Zone 81234" }),
    ]);
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const body = (await send(t, { text: PROD_REQUEST })).json();
    expect(body.plan).not.toBeNull();
    expect((body.plan.plan as SingleSpotPlan).options[0]).toMatchObject({
      type: "street",
      zoneId: REPORTED_ZONE.zoneId,
      durationMinutes: 60,
      startsAt: TOMORROW_2PM,
      // Tomorrow 2pm is future → the card shows auto-pay, no Confirm.
      payOnArrival: true,
      recommended: true,
      priceUsd: 4.1,
    });
    // The price it said is the card's own, so it stays.
    expect(body.reply).toBe(`${opener} It's $4.10 for the hour.`);
    expect(model.calls).toBe(3);
  });

  test("a street option for RIGHT NOW stays confirmable (payOnArrival false)", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const ctx = await quoted(t, { durationMinutes: 60 });
    const outcome = await t.deps.assistantTools!.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: STREET_ID, label: "Street here" }] },
    });
    const plan = outcome.endTurn!.plan as SingleSpotPlan;
    expect(plan.options[0]!.payOnArrival).toBe(false);
    expect(plan.options[0]!.startsAt).toBeUndefined();
  });

  test("confirming a pay-on-arrival street option is refused without minting", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const ctx = await quoted(t, { startsAt: TOMORROW_2PM, durationMinutes: 60 });
    const outcome = await t.deps.assistantTools!.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: STREET_ID, label: "Street tomorrow" }] },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: outcome.endTurn!.planId, optionId: STREET_ID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "street_pay_on_arrival" });
    expect(t.state.assistantConfirmations).toHaveLength(0);
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "street_pay_on_arrival" });
  });
});

describe("FR-26 street options come from a search (nightly FR 2026-09-24)", () => {
  test("the card's zone is the search's, whatever keys the model sent it under", async () => {
    // The nightly failure's shape: the model quoted, then proposed with
    // the zone under a key zod strips — the card got no zoneId. Now the
    // zone isn't the model's to send at all: the id names the option.
    const model = scriptedModel([
      requestAndQuote(),
      proposeStreet({ zone: "bos-somewhere-else", zoneId: "bos-somewhere-else" }),
    ]);
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const res = await send(t, { text: PROD_REQUEST });
    expect(res.statusCode).toBe(200);
    const option = (res.json().plan.plan as SingleSpotPlan).options[0]!;
    expect(option.zoneId).toBe(REPORTED_ZONE.zoneId);
    expect(option).not.toHaveProperty("zone");
    // Proposed on the model's own call.
    expect(model.calls).toBe(2);
  });

  test("a later turn's re-proposal is taken from the search an earlier turn made", async () => {
    const model = scriptedModel([
      requestAndQuote(),
      proposeStreet(),
      // Next turn: no new search — the request hasn't changed, so the
      // earlier one is still its latest.
      proposeStreet({ label: "Same spot, 60 minutes" }),
    ]);
    const t = makeTestApp({ candidates: [REPORTED_ZONE], assistantModel: model, now: () => NOW });
    const first = await send(t, { text: PROD_REQUEST });
    const second = await send(t, {
      text: "Same again please.",
      conversation_id: first.json().conversationId,
    });
    expect(second.statusCode).toBe(200);
    const option = (second.json().plan.plan as SingleSpotPlan).options[0]!;
    expect(option.label).toBe("Same spot, 60 minutes");
    expect(option.zoneId).toBe(REPORTED_ZONE.zoneId);
    expect(option.priceUsd).toBe(4.1);
  });

  test("a street option with no search behind it is refused, audited, and mints no plan", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const outcome = await t.deps.assistantTools!.execute(
      { userId: "u1", conversationId: "c1", location: HERE },
      "propose_plan",
      {
        plan: {
          kind: "single_spot",
          options: [
            {
              id: "s1",
              type: "street",
              label: "Street near Newbury",
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
    expect(outcome.endTurn).toBeUndefined();
    expect(outcome.result).toMatchObject({
      error: "stale_or_unknown_option",
      optionIds: ["s1"],
      validIds: [],
    });
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "stale_or_unknown_option" });
    expect(t.state.decisions.some((d) => d.kind === "assistant_plan")).toBe(false);
  });

  test("a quote_street earlier in the same turn is what a later propose_plan proposes from", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const ctx = await quoted(t, { startsAt: TOMORROW_2PM, durationMinutes: 60 });
    const outcome = await t.deps.assistantTools!.execute(ctx, "propose_plan", {
      plan: { kind: "single_spot", options: [{ id: STREET_ID }] },
    });
    expect((outcome.endTurn!.plan as SingleSpotPlan).options[0]).toMatchObject({
      zoneId: REPORTED_ZONE.zoneId,
      // With no words from the model, the label and the detail are the
      // search's own.
      label: "Street — Zone 81234",
      detail: "$3.75/hr, 2 hr max in zone 81234 — 1 min walk",
    });
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
    const edit = (id: string, input: Record<string, unknown>): ModelResponse => ({
      content: [{ type: "tool_use", id, name: "update_request", input }],
      stopReason: "tool_use",
    });
    const search = (id: string): ModelResponse => ({
      content: [{ type: "tool_use", id, name: "search_garages", input: {} }],
      stopReason: "tool_use",
    });
    const model = scriptedModel([
      // The prod transcript: "tonight" rendered as a 2024 date.
      edit("u1", { startsAt: "2024-01-09T18:00:00", durationMinutes: 240 }),
      search("t1"),
      // The corrective tool error names the current time; retry right.
      edit("u2", { startsAt: "2026-01-05T18:00:00" }),
      search("t2"),
      {
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "propose_plan",
            input: { plan: { kind: "single_spot", options: [{ id: "v2-g1" }] } },
          },
        ],
        stopReason: "tool_use",
      },
    ]);
    const t = makeTestApp({ assistantModel: model, garage: goodGarage, now: () => NOW });
    const res = await send(t, { text: "I need a garage near here from 6 to 10 tonight" });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).not.toBeNull();

    // The bounce was audited and never reached the provider…
    expect(t.state.decisions.some((d) => d.rule === "past_window")).toBe(true);
    expect(t.state.decisions.some((d) => d.rule === "garage_search_error")).toBe(false);
    // …the model saw the corrective error with the real clock, and where
    // the start lives now…
    const turns = JSON.stringify(t.state.conversations[0]!.turns);
    expect(turns).toContain("window_in_the_past");
    expect(turns).toContain("2026-01-05 14:00 ET");
    expect(turns).toContain("update_request (startsAt)");
    // …and the retry succeeded.
    expect(t.state.decisions.some((d) => d.kind === "assistant_tool" && d.rule === "ok")).toBe(
      true,
    );
  });

  test("quote_street gets the same guard", async () => {
    const t = makeTestApp({ candidates: [REPORTED_ZONE], now: () => NOW });
    const tools = t.deps.assistantTools!;
    const ctx: ToolContext = { userId: "u1", conversationId: "c1", location: HERE };
    await tools.execute(ctx, "update_request", {
      startsAt: "2024-01-09T18:00:00",
      durationMinutes: 60,
    });
    const outcome = await tools.execute(ctx, "quote_street", {});
    expect((outcome.result as { error: string }).error).toBe("window_in_the_past");
    // A slightly-stale "now" (within the hour) still quotes.
    await tools.execute(ctx, "update_request", {
      startsAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    });
    const fresh = await tools.execute(ctx, "quote_street", {});
    expect((fresh.result as { verdict: string }).verdict).toBe("meets");
  });
});
