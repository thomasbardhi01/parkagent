/**
 * FR-21 / FR-23 / FR-24 / FR-25 / FR-27 / FR-35 / FR-36 / FR-38 / FR-40 —
 * the assistant surface with REAL
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
/** The 2026-09-25 device test was sent from Braintree: outside the Boston
 * box, 15 km from its center. */
const BRAINTREE = { lat: 42.2206, lng: -71.0041 };
/** The real places the device-test phrases name (OSM/Apple points). */
const LOLA_42 = { lat: 42.35458, lng: -71.04526 }; // 22 Liberty Dr
const MOOO_SEAPORT = { lat: 42.34945, lng: -71.05034 }; // 49 Melcher St

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const s =
    Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

const etClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Whether posted hours enforce the meter at an instant (ET), the way the
 * server reads them: empty hours are always enforced. Independent of the
 * server's own code — the check the plan's state is compared against. */
function enforcedAt(hours: { days: string[]; start: string; end: string }[], at: Date): boolean {
  if (hours.length === 0) return true;
  const parts = Object.fromEntries(etClock.formatToParts(at).map((p) => [p.type, p.value]));
  const minute = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  const toMin = (c: string) => Number(c.split(":")[0]) * 60 + Number(c.split(":")[1]);
  return hours.some(
    (h) => h.days.includes(parts["weekday"]!) && minute >= toMin(h.start) && minute < toMin(h.end),
  );
}

/** free | metered | metered_then_free | free_then_metered | mixed. */
function expectedState(
  hours: { days: string[]; start: string; end: string }[],
  startsAt: Date,
  minutes: number,
): string {
  const profile = Array.from({ length: minutes }, (_, i) =>
    enforcedAt(hours, new Date(startsAt.getTime() + i * 60_000)),
  );
  const runs = profile.filter((v, i) => i === 0 || v !== profile[i - 1]);
  if (!profile.some(Boolean)) return "free";
  if (profile.every(Boolean)) return "metered";
  if (runs.length === 2) return runs[0] ? "metered_then_free" : "free_then_metered";
  return "mixed";
}

/** Did the reply ask which city? (The device test: "Boston or NYC?") */
function asksWhichCity(body: Record<string, unknown>): boolean {
  const reply = String(body["reply"] ?? "");
  const chips = ((body["suggestions"] as { label: string }[] | null) ?? []).map((s) => s.label);
  return (
    /\bwhich city\b|boston or (nyc|new york)|(nyc|new york)[^?]* or boston/i.test(reply) ||
    (chips.includes("Boston") && chips.includes("New York City"))
  );
}

/** One turn; a clarifying reply (not a city question) is answered once,
 * the way a person would, so the test judges the grounding, not whether
 * the model asked. */
async function planFor(text: string, location: { lat: number; lng: number }) {
  let res = await assistantMessage(text, { location });
  expect(res.status).toBe(200);
  expect(asksWhichCity(res.body), `asked which city: ${JSON.stringify(res.body["reply"])}`).toBe(
    false,
  );
  if (res.body["plan"] === null) {
    res = await assistantMessage("Go ahead — propose the options now.", {
      conversationId: res.body["conversationId"] as string,
      location,
    });
    expect(res.status).toBe(200);
    expect(asksWhichCity(res.body)).toBe(false);
  }
  return res;
}

/** Conversations this run made, for the history test to open and delete. */
const madeConversations: string[] = [];

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
        // FR-26: a street option must be grounded in a quoted zone. The
        // option rides along so a failure names the shape prod sent.
        const sent = `street option: ${JSON.stringify(option)}`;
        expect(typeof option["zoneId"], sent).toBe("string");
        expect((option["zoneId"] as string).startsWith("bos"), sent).toBe(true);
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

describe("FR-35 / FR-36 / FR-40 the device-test phrases", () => {
  it("FR-35 FR-36 FR-40 'at Seaport at 7 PM near Lola 42 for three hours' from Braintree", async () => {
    const res = await planFor(
      "Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours",
      BRAINTREE,
    );
    madeConversations.push(res.body["conversationId"] as string);
    const envelope = res.body["plan"] as Record<string, unknown> | null;
    expect(
      envelope,
      `no plan; assistant said: ${JSON.stringify(res.body["reply"])}`,
    ).not.toBeNull();
    const plan = envelope!["plan"] as Record<string, unknown>;
    expect(plan["kind"]).toBe("single_spot");

    // FR-35: the restaurant itself, not the neighborhood's centroid.
    const destination = plan["destination"] as
      { lat: number; lng: number; label: string } | undefined;
    expect(destination, "the plan names no destination").toBeDefined();
    const off = Math.round(metersBetween(destination!, LOLA_42));
    expect(
      off,
      `destination "${destination!.label}" is ${off} m from LoLa 42 (22 Liberty Dr) — is APPLE_MAPS_* set on the target? (docs/apple-maps-setup.md)`,
    ).toBeLessThanOrEqual(300);

    // FR-40: what it assumed, in one line.
    expect(typeof plan["assumptions"]).toBe("string");
    expect(plan["assumptions"] as string).toMatch(/7:00/);

    // FR-36: street options, each in the right state for ITS window,
    // checked against the zone's posted hours from /zones/near.
    const options = plan["options"] as Record<string, unknown>[];
    const street = options.filter((o) => o["type"] === "street");
    expect(street.length, `no street option: ${JSON.stringify(options)}`).toBeGreaterThanOrEqual(1);
    for (const option of street) {
      const sent = `street option: ${JSON.stringify(option)}`;
      expect(typeof option["streetSummary"], sent).toBe("string");
      expect(typeof option["startsAt"], sent).toBe("string");
      const near = await frFetch(
        "GET",
        `/zones/near?lat=${option["lat"]}&lng=${option["lng"]}&radius=60`,
      );
      expect(near.status).toBe(200);
      const zone = (near.body["zones"] as Record<string, unknown>[]).find(
        (z) => z["zoneId"] === option["zoneId"],
      );
      expect(zone, `${sent} — its zone isn't near its own pin`).toBeDefined();
      const want = expectedState(
        zone!["hours"] as { days: string[]; start: string; end: string }[],
        new Date(option["startsAt"] as string),
        option["durationMinutes"] as number,
      );
      expect(option["streetState"], sent).toBe(want);
      if (want === "free") {
        expect(option["priceUsd"], sent).toBe(0);
        expect(option["streetSummary"] as string, sent).toMatch(/^Free/);
      }
      if (want === "metered_then_free") {
        expect(option["streetSummary"] as string, sent).toMatch(/^Metered until/);
      }
      // Within the walking radius of the destination.
      expect(
        metersBetween(option as { lat: number; lng: number }, destination!),
      ).toBeLessThanOrEqual(820);
    }
  }, 240_000);

  it("FR-35 'near Moo steakhouse in Seaport Boston' is the Seaport Mooo, within 300 m", async () => {
    const res = await planFor(
      "Find me parking near Moo steakhouse in Seaport Boston tomorrow at 6 PM for two hours",
      BRAINTREE,
    );
    madeConversations.push(res.body["conversationId"] as string);
    const envelope = res.body["plan"] as Record<string, unknown> | null;
    expect(
      envelope,
      `no plan; assistant said: ${JSON.stringify(res.body["reply"])}`,
    ).not.toBeNull();
    const destination = (envelope!["plan"] as Record<string, unknown>)["destination"] as
      { lat: number; lng: number; label: string } | undefined;
    expect(destination).toBeDefined();
    const off = Math.round(metersBetween(destination!, MOOO_SEAPORT));
    expect(
      off,
      `destination "${destination!.label}" is ${off} m from Mooo.... (49 Melcher St) — is APPLE_MAPS_* set on the target?`,
    ).toBeLessThanOrEqual(300);
  }, 240_000);
});

describe("FR-38 saved conversations", () => {
  it("FR-38 lists, opens, and deletes the FR user's conversations; others' are 404", async () => {
    const list = await frFetch("GET", "/assistant/conversations?limit=50");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body["conversations"])).toBe(true);
    expect(list.body["retentionDays"]).toBe(90);

    const missing = await frFetch("GET", "/assistant/conversations/fr-no-such-conversation");
    expect(missing.status).toBe(404);
    const missingDelete = await frFetch(
      "DELETE",
      "/assistant/conversations/fr-no-such-conversation",
    );
    expect(missingDelete.status).toBe(404);

    // A conversation this run made (when the model tests ran): titled by
    // its first request, readable, deletable — and gone after.
    const id = madeConversations[0];
    if (!id) return;
    const listed = (list.body["conversations"] as { id: string; title: string }[]).find(
      (c) => c.id === id,
    );
    expect(listed?.title).toBe(
      "Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours",
    );
    const opened = await frFetch("GET", `/assistant/conversations/${id}`);
    expect(opened.status).toBe(200);
    const messages = opened.body["messages"] as { role: string; text: string }[];
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours",
    });
    for (const made of madeConversations) {
      const deleted = await frFetch("DELETE", `/assistant/conversations/${made}`);
      expect(deleted.status).toBe(200);
    }
    const gone = await frFetch("GET", `/assistant/conversations/${id}`);
    expect(gone.status).toBe(404);
  });
});
