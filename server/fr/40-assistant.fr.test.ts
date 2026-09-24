/**
 * FR-21 / FR-23 / FR-24 / FR-25 / FR-27 — the assistant surface with REAL
 * model calls (the server's configured Anthropic model), counted against
 * the per-run budget in client.ts. These tests assert STRUCTURE and
 * GROUNDING — plan shape, option counts, numeric sanity, dates relative
 * to now — never exact wording: the model phrases, the tools enforce.
 *
 * The itinerary flow, the 600 m named-area guarantee, and the full
 * confirm-token enforcement matrix are pinned by the unit suites
 * (assistantItinerary / assistantGeocode / assistantAccuracy /
 * assistantPlanEnforcement); this file proves the deployed loop is wired:
 * model reachable, tools grounded, plans validated, gates closed.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  assistantMessage,
  frFetch,
  gate,
  mostRecentEasternAt,
  NYC_AUTOPAY,
  parkedBody,
} from "./client.js";

const BOSTON_CENTER = { lat: 42.3554, lng: -71.0605 };

beforeAll(async () => {
  await gate();
});

describe("FR-21 / FR-23 single spot for a named place", () => {
  it("FR-21 FR-23 'parking near Newbury Street' yields a validated single_spot plan with grounded options", async () => {
    let res = await assistantMessage(
      "Find me street or garage parking near Newbury Street in Boston tomorrow at 2pm, for about 2 hours. Propose the options as a plan.",
      { location: BOSTON_CENTER },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body["conversationId"]).toBe("string");
    expect(typeof res.body["reply"]).toBe("string");

    if (res.body["plan"] === null) {
      // The model asked a clarifying question; answer once and insist.
      res = await assistantMessage("Yes — go ahead and propose the plan now.", {
        conversationId: res.body["conversationId"] as string,
      });
      expect(res.status).toBe(200);
    }
    const planEnvelope = res.body["plan"] as Record<string, unknown> | null;
    expect(
      planEnvelope,
      `no plan proposed; assistant said: ${JSON.stringify(res.body["reply"])}`,
    ).not.toBeNull();
    expect(typeof planEnvelope!["planId"]).toBe("string");
    const plan = planEnvelope!["plan"] as Record<string, unknown>;
    expect(plan["kind"]).toBe("single_spot");

    const options = plan["options"] as Record<string, unknown>[];
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options.length).toBeLessThanOrEqual(3);
    // Exactly one recommendation — the card's badge is unambiguous.
    expect(options.filter((o) => o["recommended"] === true)).toHaveLength(1);
    for (const option of options) {
      expect(["street", "garage"]).toContain(option["type"]);
      expect(typeof option["priceUsd"]).toBe("number");
      expect(option["priceUsd"] as number).toBeGreaterThanOrEqual(0);
      expect((option["durationMinutes"] as number) > 0).toBe(true);
      if (option["type"] === "street") {
        // FR-26: a street option must be grounded in a quoted zone.
        expect(typeof option["zoneId"]).toBe("string");
        expect((option["zoneId"] as string).startsWith("bos")).toBe(true);
      }
      if (typeof option["walkMinutes"] === "number") {
        // The 600 m named-area guarantee (unit-pinned) shows up here as a
        // short walk; 15 minutes is far outside 600 m.
        expect(option["walkMinutes"] as number).toBeLessThanOrEqual(15);
      }
      if (typeof option["startsAt"] === "string") {
        // "tomorrow" must land in the future — dates relative to now.
        expect(Date.parse(option["startsAt"] as string)).toBeGreaterThan(Date.now());
      }
    }
  }, 180_000);
});

describe("FR-24 past-date guard", () => {
  it("FR-24 a request to plan parking for yesterday mints no plan", async () => {
    const res = await assistantMessage(
      "Plan parking near Fenway in Boston for yesterday at 2pm for 2 hours.",
      { location: BOSTON_CENTER },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body["reply"]).toBe("string");
    expect(res.body["plan"]).toBeNull();
  }, 180_000);
});

describe("FR-25 confirm gate", () => {
  it("FR-25 confirming a plan that was never proposed is refused", async () => {
    const res = await frFetch("POST", "/assistant/confirm", { planId: "fr-nonexistent-plan" });
    expect(res.status).toBe(404);
    expect(res.body["error"]).toBe("plan_not_found");
  });
});

describe("FR-27 explanations", () => {
  it("FR-27 the assistant renders a fresh decisions row in plain language", async () => {
    const parked = await frFetch(
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: mostRecentEasternAt(14, 0) }),
    );
    expect(parked.status).toBe(200);
    const decisionId = parked.body["decisionId"] as string;

    const res = await assistantMessage(
      `Explain decision ${decisionId} to me — what did the system decide and why?`,
    );
    expect(res.status).toBe(200);
    const reply = res.body["reply"] as string;
    expect(reply.length).toBeGreaterThan(20);
    expect(res.body["plan"]).toBeNull();
  }, 180_000);
});

describe("FR-22 itineraries surface", () => {
  it("FR-22 GET /assistant/itineraries answers the signed-off-days list", async () => {
    const res = await frFetch("GET", "/assistant/itineraries");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body["itineraries"])).toBe(true);
  });
});
