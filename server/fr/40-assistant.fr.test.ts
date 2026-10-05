/**
 * FR-21 / FR-23 / FR-24 / FR-25 / FR-27 / FR-35 / FR-36 / FR-38 / FR-40 /
 * FR-43 / FR-45 — the assistant surface with REAL
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
 *
 * FR-45 spends no model call of its own (the run's budget is spoken for):
 * it reads what the FR-21 and FR-43 cards say they answered. The intent's
 * tool gate, the stay question, and V7 are pinned by
 * test/assistantIntentRouter.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
  assistantMessage,
  gate,
  mostRecentEasternAt,
  NYC_AUTOPAY,
  ownUser,
  parkedBody,
  passedClockTime,
  pinnedDay,
  userFetch,
} from "./client.js";

/** This file's own throwaway user (client.ts `ownUser`): its conversations
 * are deleted with it however the tests end, so none carries into another
 * file — or another test here — as history. */
const me = ownUser(import.meta.url);

/** Every request below names this day and a clock time, so a run's
 * scenario is the same at 5 AM as at 8 PM — never "has 7 PM passed yet?"
 * (fr/client.ts pinnedDay). The one test about an hour that has already
 * passed pins that on purpose (passedClockTime). */
const DAY = pinnedDay();

const BOSTON_CENTER = { lat: 42.3554, lng: -71.0605 };
/** The 2026-09-25 device test was sent from Braintree: outside the Boston
 * box, 15 km from its center. */
const BRAINTREE = { lat: 42.2206, lng: -71.0041 };
/** Cambridge Common: inside the Boston box, a kilometre from any meter
 * we have data for, and nowhere near a $2 garage. */
const CAMBRIDGE_COMMON = { lat: 42.3765, lng: -71.119 };
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
  let res = await assistantMessage(me, text, { location });
  expect(res.status).toBe(200);
  expect(asksWhichCity(res.body), `asked which city: ${JSON.stringify(res.body["reply"])}`).toBe(
    false,
  );
  if (res.body["plan"] === null) {
    res = await assistantMessage(me, "Go ahead — propose the options.", {
      conversationId: res.body["conversationId"] as string,
      location,
    });
    expect(res.status).toBe(200);
    expect(asksWhichCity(res.body)).toBe(false);
  }
  return res;
}

/** The request a card says it answered (FR-45, API.md "The card says what
 * it answered"). */
interface RequestSummary {
  intent: string;
  place: { query: string | null; resolved: { label: string } | null };
  window: { startsAt: string | null; durationMinutes: number | null };
  hard: { maxPriceUsd: number | null };
  assumed?: { place?: string; durationMinutes?: number };
}

describe("FR-21 / FR-23 / FR-45 single spot for a named place", () => {
  it("FR-21 FR-23 FR-45 'parking near Newbury Street' yields a validated single_spot plan with grounded options, and the card says what it answered", async () => {
    let res = await assistantMessage(
      me,
      `Find me street or garage parking near Newbury Street in Boston ${DAY.phrase} at 2 PM, for about 2 hours. Propose the options as a plan.`,
      { location: BOSTON_CENTER },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body["conversationId"]).toBe("string");
    expect(typeof res.body["reply"]).toBe("string");

    if (res.body["plan"] === null) {
      // The model asked a clarifying question; answer once and insist.
      res = await assistantMessage(me, "Yes — go ahead and propose the plan.", {
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
        // The pinned day, at the time asked — dates relative to now.
        expect(option["startsAt"] as string).toMatch(new RegExp(`^${DAY.date}T14:00`));
      }
    }

    // FR-45: the card says what it answered. A request for a later day is
    // park_later; the place, the start, and the stay are the user's, so
    // nothing was assumed.
    const sent = `plan: ${JSON.stringify(plan)}`;
    expect(plan["verdict"], sent).toBe("meets");
    const request = plan["requestSummary"] as RequestSummary | undefined;
    expect(request, sent).toBeDefined();
    expect(request!.intent, sent).toBe("park_later");
    expect(request!.window.startsAt, sent).toMatch(new RegExp(`^${DAY.date}T14:00`));
    expect(request!.window.durationMinutes, sent).toBe(120);
    expect(typeof request!.place.resolved?.label, sent).toBe("string");
    expect(request!.assumed ?? {}, sent).toEqual({});
    // What leads is the server's: the option that honors an ask, or the
    // cheapest and the closest together — first on the card, and one of
    // them the recommendation.
    const primary = options.filter((o) => o["primary"] === true);
    expect(primary.length, sent).toBeGreaterThanOrEqual(1);
    expect(primary.length, sent).toBeLessThanOrEqual(2);
    expect(
      options.slice(0, primary.length).every((o) => o["primary"] === true),
      sent,
    ).toBe(true);
    expect(
      primary.filter((o) => o["recommended"] === true),
      sent,
    ).toHaveLength(1);
    // An option over the policy's approval threshold says so, and no other.
    const policy = (await gate())["policy"] as Record<string, unknown>;
    const warnOverUsd = (policy["confirm_warn_usd"] as number | undefined) ?? 15;
    for (const option of options) {
      expect(option["warn"] === true, `option: ${JSON.stringify(option)}`).toBe(
        (option["priceUsd"] as number) > warnOverUsd,
      );
    }
  }, 180_000);
});

describe("FR-24 past-date guard", () => {
  it("FR-24 a request to plan parking for yesterday mints no plan", async () => {
    const res = await assistantMessage(
      me,
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
    const res = await userFetch(me, "POST", "/assistant/confirm", {
      planId: "fr-nonexistent-plan",
    });
    expect(res.status).toBe(404);
    expect(res.body["error"]).toBe("plan_not_found");
  });
});

describe("FR-27 explanations", () => {
  it("FR-27 the assistant renders a fresh decisions row in plain language", async () => {
    const parked = await userFetch(
      me,
      "POST",
      "/parked",
      parkedBody(NYC_AUTOPAY, { ts: mostRecentEasternAt(14, 0) }),
    );
    expect(parked.status).toBe(200);
    const decisionId = parked.body["decisionId"] as string;

    const res = await assistantMessage(
      me,
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
    const res = await userFetch(me, "GET", "/assistant/itineraries");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body["itineraries"])).toBe(true);
  });
});

describe("FR-35 / FR-36 / FR-40 the device-test phrases", () => {
  it("FR-35 FR-36 FR-40 'at Seaport at 7 PM near Lola 42 for three hours' from Braintree", async () => {
    const res = await planFor(
      `Find me a parking spot at Seaport ${DAY.phrase} at 7 PM near Lola 42 for three hours`,
      BRAINTREE,
    );
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

    // FR-40: what it assumed, in one line — the window asked for, on the
    // day asked for, never moved.
    expect(typeof plan["assumptions"]).toBe("string");
    expect(plan["assumptions"] as string).toMatch(/7:00–10:00 PM/);
    for (const option of plan["options"] as Record<string, unknown>[]) {
      if (typeof option["startsAt"] !== "string") continue;
      expect(option["startsAt"] as string, JSON.stringify(option)).toMatch(
        new RegExp(`^${DAY.date}T19:00`),
      );
    }

    // FR-36: street options, each in the right state for ITS window,
    // checked against the zone's posted hours from /zones/near.
    const options = plan["options"] as Record<string, unknown>[];
    const street = options.filter((o) => o["type"] === "street");
    expect(street.length, `no street option: ${JSON.stringify(options)}`).toBeGreaterThanOrEqual(1);
    for (const option of street) {
      const sent = `street option: ${JSON.stringify(option)}`;
      expect(typeof option["streetSummary"], sent).toBe("string");
      expect(typeof option["startsAt"], sent).toBe("string");
      const near = await userFetch(
        me,
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
      `Find me parking near Moo steakhouse in Seaport Boston ${DAY.phrase} at 6 PM for two hours`,
      BRAINTREE,
    );
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

describe("FR-43 / FR-45 nothing meets the request", () => {
  // IM-01 (docs/research/1-assistant-spec.md §3): "under $2 near Cambridge
  // Common for 2h". One turn and no follow-up — the run's whole assistant
  // budget (FR_ASSISTANT_MAX_CALLS) is 12, and the tests above can use 11
  // of it — so the phone IS at Cambridge Common and the request says
  // "here": "Cambridge Common" by name is also a restaurant up the avenue,
  // and the place search rightly asks which.
  it("FR-43 FR-45 'under $2 here for 2 hours' at Cambridge Common ends in a none_meets card, never an option over the limit", async () => {
    const res = await assistantMessage(
      me,
      `Find me parking under $2 right here where I am ${DAY.phrase} at 2 PM, for 2 hours`,
      { location: CAMBRIDGE_COMMON },
    );
    expect(res.status).toBe(200);
    const said = `assistant said: ${JSON.stringify(res.body["reply"])}`;
    const envelope = res.body["plan"] as Record<string, unknown> | null;
    expect(envelope, `no card; ${said}`).not.toBeNull();
    const plan = envelope!["plan"] as Record<string, unknown>;
    const sent = `plan: ${JSON.stringify(plan)}`;
    // The server's verdict: a "no", as its own kind — not a single_spot
    // with the nearest thing dressed as an option.
    expect(plan["kind"], sent).toBe("none_meets");

    // FR-45: the card says what it answered — the verdict, the limit it was
    // held to, and that "right here" was taken as the phone's location.
    expect(plan["verdict"], sent).toBe("none_meets");
    const request = plan["requestSummary"] as RequestSummary | undefined;
    expect(request, sent).toBeDefined();
    expect(request!.hard.maxPriceUsd, sent).toBe(2);
    expect(request!.window.durationMinutes, sent).toBe(120);
    expect(request!.assumed?.place, sent).toBe("phone_location");

    // The limit that failed is the one asked for.
    const failed = plan["constraintsFailed"] as Record<string, unknown>[];
    const price = failed.find((c) => c["field"] === "maxPriceUsd");
    expect(price, sent).toBeDefined();
    expect(price!["limit"], sent).toBe(2);

    // Near-misses: at most three, each breaking the price limit, with the
    // server's numbers saying by how much. None is confirmable.
    const nearMisses = plan["nearMisses"] as Record<string, unknown>[];
    expect(nearMisses.length, sent).toBeLessThanOrEqual(3);
    for (const option of nearMisses) {
      const shown = `near-miss: ${JSON.stringify(option)}`;
      expect(option["nearMiss"], shown).toBe(true);
      expect(option["priceUsd"] as number, shown).toBeGreaterThan(2);
      const violates = option["violates"] as Record<string, unknown>[];
      const over = violates.find((v) => v["field"] === "maxPriceUsd");
      expect(over, shown).toBeDefined();
      expect(over!["limit"], shown).toBe(2);
      expect(over!["actual"], shown).toBe(option["priceUsd"]);
      if (typeof option["startsAt"] === "string") {
        expect(option["startsAt"] as string, shown).toMatch(new RegExp(`^${DAY.date}T14:00`));
      }
    }
    if (nearMisses.length > 0) {
      const confirm = await userFetch(me, "POST", "/assistant/confirm", {
        planId: envelope!["planId"],
        optionId: nearMisses[0]!["id"],
      });
      expect(confirm.status).toBe(409);
      expect(confirm.body["error"]).toBe("nothing_to_confirm");
    }

    // Relaxing is offered as the user's tap, with what it would yield;
    // when a near-miss exists, raising the price a step is among them.
    const relax = plan["relaxSuggestions"] as Record<string, unknown>[];
    for (const suggestion of relax) {
      expect(typeof suggestion["wouldYield"], sent).toBe("number");
      expect(typeof suggestion["reply"], sent).toBe("string");
    }
    if (nearMisses.length > 0) {
      expect(
        relax.find((r) => r["field"] === "maxPriceUsd"),
        sent,
      ).toMatchObject({ to: 7 });
    }

    // The reply is the card's own sentence: the server says the no.
    expect(res.body["reply"], said).toBe(plan["headline"]);
  }, 240_000);
});

describe("FR-40 a requested time that has already passed", () => {
  // Deliberately asked AFTER the time (nightly 36361125345 asked "at 7 PM"
  // at 8:11 PM and got "8:11–11:11 PM"): the plan must be for its next
  // occurrence and say so, or the assistant must ask — tomorrow, or now.
  // Never a plan quietly moved to now.
  it("FR-40 a clock time that passed today is planned for tomorrow and said so, or asked about — never moved to now", async (ctx) => {
    const passed = passedClockTime();
    if (!passed) {
      ctx.skip(); // within 90 minutes of midnight Eastern: nothing has passed that long today
      return;
    }
    const res = await assistantMessage(
      me,
      `Find me a parking spot at Seaport at ${passed.label} near Lola 42 for two hours`,
      { location: BRAINTREE },
    );
    expect(res.status).toBe(200);
    const envelope = res.body["plan"] as Record<string, unknown> | null;
    if (envelope === null) {
      // It asked instead: with the two answers, one tap each.
      const chips = ((res.body["suggestions"] as { label: string }[] | null) ?? []).map(
        (s) => s.label,
      );
      const said = `asked ${JSON.stringify(res.body["reply"])} with ${JSON.stringify(chips)}`;
      expect(
        chips.some((label) => /^tomorrow\b/i.test(label)),
        said,
      ).toBe(true);
      expect(
        chips.some((label) => /^(right )?now\b/i.test(label)),
        said,
      ).toBe(true);
      return;
    }
    const plan = envelope["plan"] as Record<string, unknown>;
    const options = plan["options"] as Record<string, unknown>[];
    const starts = options.map((o) => o["startsAt"]).filter((s): s is string => !!s);
    const sent = `plan: ${JSON.stringify(plan)}`;
    // A plan for later carries its start — tomorrow at the time asked.
    expect(starts.length, sent).toBeGreaterThan(0);
    for (const start of starts) {
      expect(Date.parse(start), sent).toBe(Date.parse(passed.tomorrowIso));
    }
    expect(plan["assumptions"] as string, sent).toMatch(/^Assuming tomorrow, /);
    expect(plan["assumptions"] as string, sent).toContain(passed.clock);
  }, 240_000);
});

describe("FR-38 saved conversations", () => {
  it("FR-38 lists, opens, and deletes the caller's conversations by their first request; unknown ones are 404", async () => {
    const missing = await userFetch(me, "GET", "/assistant/conversations/fr-no-such-conversation");
    expect(missing.status).toBe(404);
    const missingDelete = await userFetch(
      me,
      "DELETE",
      "/assistant/conversations/fr-no-such-conversation",
    );
    expect(missingDelete.status).toBe(404);

    // Its own conversation, two requests long: nightly 36339460721 listed a
    // conversation under a later request's words. Titles are the FIRST
    // request, for good — the second must not retitle it.
    // Short enough to be its own title: a title is the first request cut
    // at 80 characters with "…" (history.ts titleFrom), and the pinned day
    // made the device-test phrase 95 (nightly 36367998113).
    const first = `Parking near Lola 42 ${DAY.phrase} at 7 PM for three hours`;
    expect(first.length).toBeLessThanOrEqual(80);
    const opened1 = await assistantMessage(me, first, { location: BRAINTREE });
    expect(opened1.status).toBe(200);
    const id = opened1.body["conversationId"] as string;
    const second = await assistantMessage(me, "Find me parking near Moo steakhouse instead", {
      conversationId: id,
      location: BRAINTREE,
    });
    expect(second.status).toBe(200);
    expect(second.body["conversationId"]).toBe(id);

    const list = await userFetch(me, "GET", "/assistant/conversations?limit=50");
    expect(list.status).toBe(200);
    expect(list.body["retentionDays"]).toBe(90);
    const listed = (list.body["conversations"] as { id: string; title: string }[]).find(
      (c) => c.id === id,
    );
    expect(listed?.title).toBe(first);

    const opened = await userFetch(me, "GET", `/assistant/conversations/${id}`);
    expect(opened.status).toBe(200);
    expect(opened.body["title"]).toBe(first);
    const messages = opened.body["messages"] as { role: string; text: string }[];
    expect(messages[0]).toMatchObject({ role: "user", text: first });
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      first,
      "Find me parking near Moo steakhouse instead",
    ]);

    const deleted = await userFetch(me, "DELETE", `/assistant/conversations/${id}`);
    expect(deleted.status).toBe(200);
    const gone = await userFetch(me, "GET", `/assistant/conversations/${id}`);
    expect(gone.status).toBe(404);
  }, 240_000);
});
