/**
 * Regression suite for the prod bug (2026-09-21): the model quoted street
 * parking in prose, never called propose_plan, invited a verbal
 * "confirm", and duplicated its opener. A quoting turn must now always
 * end in a plan card; future street options carry payOnArrival and no
 * confirmable path; the reply never invites a verbal confirm; repeated
 * segments dedupe.
 */

import { describe, expect, test } from "vitest";

import type { ModelClient, ModelResponse } from "../src/services/assistant/loop.js";
import {
  SYSTEM_PROMPT,
  joinReplySegments,
  scrubVerbalConfirm,
} from "../src/services/assistant/loop.js";
import type { SingleSpotPlan } from "../src/services/assistant/plans.js";
import { API_KEY, BOYLSTON_BOS, MONDAY_2PM, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);
/** "2pm tomorrow" relative to the fixture Monday. */
const TOMORROW_2PM = "2026-01-06T14:00:00-05:00";
const PROD_REQUEST = "find me street parking near Boylston and Dartmouth for an hour at 2pm tomorrow";

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

describe("verbal confirm is a dead end", () => {
  test("typing 'confirm' in chat books nothing — the tool refuses and the reply points at the card", async () => {
    // A model that treats the typed word as authorization and calls the
    // consequential tool without a token.
    const model = scriptedModel([
      {
        content: [
          { type: "tool_use", id: "t1", name: "start_session", input: { zone: "bos-x", duration_minutes: 60 } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          { type: "text", text: "I can't start it from chat — use the Confirm button on the card." },
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
