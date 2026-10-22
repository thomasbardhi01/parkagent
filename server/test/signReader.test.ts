/**
 * The parking-sign reader (Issue N): advisory only. The golden set runs
 * grounding and the comparison over hand-written model outputs (the live model is the manual sign:eval); the route
 * runs with a scripted model. A reading can warn, or offer a shorter max
 * stay that applies only on the driver's accept and only ever tightens;
 * it never changes a price, starts, stops or extends anything.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { ZoneTermsRow } from "../src/db.js";
import { makeConversationRetention } from "../src/jobs/conversationRetentionTick.js";
import { deleteAccount } from "../src/services/accountDeletion.js";
import type {
  ModelClient,
  ModelResponse,
  ModelTurn,
} from "../src/services/assistant/modelClient.js";
import type { SignRule, SignRules } from "../src/services/signs/signRules.js";
import {
  compareWithZone,
  groundRules,
  SIGN_RULES_JSON_SCHEMA,
  signRulesSchema,
  tightenedMaxStay,
} from "../src/services/signs/signRules.js";
import {
  API_KEY,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  makeTestApp,
  seedProviderAccount,
  seedSession,
} from "./helpers.js";

const NOW = new Date(MONDAY_2PM);
const U1 = { "x-api-key": API_KEY };
const U2 = { "x-api-key": NONADMIN_API_KEY };

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/signs-golden.json", import.meta.url), "utf8"),
) as {
  zoneHours: { days: string[]; start: string; end: string }[];
  samples: {
    name: string;
    text: string;
    zoneMaxStayMinutes: number | null;
    at: string;
    modelOutput: SignRules;
    expected: {
      verdict: string;
      offerMaxStayMinutes: number | null;
      kinds: string[];
      dropped?: string[];
    };
  }[];
};

describe("the golden set (hand-written model outputs)", () => {
  test.each(golden.samples.map((s) => [s.name, s] as const))("%s", (_name, sample) => {
    const reading = signRulesSchema.parse(sample.modelOutput);
    const zone = {
      zoneId: "z",
      maxStayMinutes: sample.zoneMaxStayMinutes,
      hours: golden.zoneHours,
    };
    const grounded = groundRules(reading.rules, {
      text: sample.text,
      zoneMaxStayMinutes: zone.maxStayMinutes,
      zoneHours: zone.hours,
    });
    const comparison = compareWithZone(
      { rules: grounded.rules, unreadable: reading.unreadable },
      zone,
      new Date(sample.at),
      zone.maxStayMinutes ?? 120,
    );
    expect(comparison.verdict).toBe(sample.expected.verdict);
    expect(comparison.offerMaxStayMinutes).toBe(sample.expected.offerMaxStayMinutes);
    expect(grounded.rules.map((r) => r.kind)).toEqual(sample.expected.kinds);
    expect(grounded.dropped.map((d) => d.why)).toEqual(sample.expected.dropped ?? []);
  });

  test("it is ten Boston samples covering every verdict", () => {
    expect(golden.samples).toHaveLength(10);
    const verdicts = new Set(golden.samples.map((s) => s.expected.verdict));
    expect([...verdicts].sort()).toEqual(["agrees", "conflicts", "stricter", "unreadable"]);
  });
});

describe("the rules", () => {
  test("the structured-output schema is strict: every object closed and fully required", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      if (schema["type"] === "object") {
        expect(schema["additionalProperties"]).toBe(false);
        expect([...(schema["required"] as string[])].sort()).toEqual(
          Object.keys(schema["properties"] as object).sort(),
        );
      }
      Object.values(schema).forEach(walk);
    };
    walk(SIGN_RULES_JSON_SCHEMA);
  });

  test("a time the sign doesn't show is dropped; an amount it doesn't show is scrubbed", () => {
    const rule = {
      kind: "time_limit" as const,
      days: [],
      start: "07:00",
      end: "19:00",
      limitMinutes: 120,
      permitZone: "ZONE 9",
      exceptions: ["Fine $100 if over."],
    };
    const text = "2 HOUR PARKING 8AM-8PM FINE $50";
    expect(groundRules([rule], { text, zoneMaxStayMinutes: null, zoneHours: [] }).dropped).toEqual([
      { index: 0, why: "time_not_on_sign" },
    ]);
    const shown = groundRules([{ ...rule, start: "08:00", end: "20:00" }], {
      text,
      zoneMaxStayMinutes: null,
      zoneHours: [],
    });
    expect(shown.rules).toHaveLength(1);
    expect(shown.rules[0]!.exceptions).toEqual([]);
    expect(shown.rules[0]!.permitZone).toBeNull();
  });

  const rule = (over: Partial<SignRule>): SignRule => ({
    kind: "no_parking",
    days: [],
    start: null,
    end: null,
    limitMinutes: null,
    permitZone: null,
    exceptions: [],
    ...over,
  });
  const ground = (rules: SignRule[], text: string) =>
    groundRules(rules, { text, zoneMaxStayMinutes: 120, zoneHours: [] });

  test("a bare number is never a clock time: the 2 of 2 HOUR grounds no 14:00", () => {
    const made = rule({ start: "14:00", end: "20:00" });
    const grounded = ground([made], "2 HOUR PARKING 8AM - 8PM");
    expect(grounded.dropped).toEqual([{ index: 0, why: "time_not_on_sign" }]);
    const zone = { zoneId: "z", maxStayMinutes: 120, hours: [] };
    const at = new Date("2026-01-05T14:00:00-05:00");
    expect(
      compareWithZone({ rules: grounded.rules, unreadable: false }, zone, at, 120).verdict,
    ).toBe("unreadable");
  });

  test.each([
    ["8AM-6PM", ["08:00", "18:00"]],
    ["4PM - 6:30 P.M.", ["16:00", "18:30"]],
    ["8 - 6PM", ["08:00", "18:00"]],
    ["12PM - 4PM", ["12:00", "16:00"]],
    ["14:00 TO 16:00", ["14:00", "16:00"]],
    ["NOON TO MIDNIGHT", ["12:00", "00:00"]],
  ])("times read as times: %s", (text, [start, end]) => {
    expect(ground([rule({ start: start!, end: end! })], text).rules).toHaveLength(1);
  });

  test("the meridiem must match: 8AM grounds 08:00, not 20:00", () => {
    expect(ground([rule({ start: "20:00", end: "22:00" })], "NO PARKING 8AM-10AM").rules).toEqual(
      [],
    );
  });

  describe("a prohibition later in the stay", () => {
    const zone = { zoneId: "z", maxStayMinutes: 120, hours: [] };
    const cleaning = rule({ kind: "street_cleaning", start: "15:00", end: "17:00" });
    const compare = (at: string) =>
      compareWithZone({ rules: [cleaning], unreadable: false }, zone, new Date(at), 120);

    test("street cleaning in 40 minutes: stricter, leave 5 minutes before it starts", () => {
      expect(compare("2026-01-05T14:20:00-05:00")).toMatchObject({
        verdict: "stricter",
        offerMaxStayMinutes: 35,
        reasons: ["street_cleaning_later"],
      });
    });

    test("already in force when the check is made: conflicts, nothing offered", () => {
      expect(compare("2026-01-05T15:10:00-05:00")).toMatchObject({
        verdict: "conflicts",
        offerMaxStayMinutes: null,
      });
    });

    test("starting in under the margin: conflicts, nothing offered", () => {
      expect(compare("2026-01-05T14:57:00-05:00")).toMatchObject({
        verdict: "conflicts",
        offerMaxStayMinutes: null,
      });
    });

    test("the shorter of a posted limit and the window wins", () => {
      const limit = rule({ kind: "time_limit", limitMinutes: 60 });
      const at = new Date("2026-01-05T14:20:00-05:00");
      expect(
        compareWithZone({ rules: [cleaning, limit], unreadable: false }, zone, at, 120),
      ).toMatchObject({ verdict: "stricter", offerMaxStayMinutes: 35 });
    });
  });

  test("an accepted stay only ever tightens", () => {
    expect(tightenedMaxStay(120, 60)).toBe(60);
    expect(tightenedMaxStay(60, 120)).toBe(60);
    expect(tightenedMaxStay(null, 45)).toBe(45);
    expect(tightenedMaxStay(90, null)).toBe(90);
  });

  test("never longer than the stay it tightens, never below what's paid", () => {
    // A running session that bought 90 of a 120 max, offered 60: held at 90.
    expect(tightenedMaxStay(120, 60, 90)).toBe(90);
    expect(tightenedMaxStay(120, 60, 45)).toBe(60);
    expect(tightenedMaxStay(null, 45, 90)).toBe(90);
    // Paid past the stay already (it can't be, but): still never longer.
    expect(tightenedMaxStay(60, 30, 90)).toBe(60);
    const stays = [null, 0, 30, 60, 120, 600];
    for (const current of stays) {
      for (const accepted of stays) {
        for (const paid of [0, 15, 60, 90, 150]) {
          const held = tightenedMaxStay(current, accepted, paid);
          const at = `${current} / ${accepted} / ${paid}`;
          if (accepted === null) expect(held, at).toBe(current);
          if (current !== null) expect(held!, at).toBeLessThanOrEqual(current);
          if (accepted !== null) {
            expect(held!, at).toBeGreaterThanOrEqual(Math.min(current ?? Infinity, paid));
          }
        }
      }
    }
  });
});

// ------------------------------------------------------------ the route

const HOURS = [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00" }];
const ZONE: ZoneTermsRow = {
  zoneId: "bos-boylston-st-e-d-819305",
  city: "bos",
  street: "BOYLSTON ST",
  providerZoneNumber: "81234",
  rateFirstHour: 3.75,
  rateAdditionalHour: 3.75,
  maxStayMinutes: 120,
  hoursJson: HOURS,
};
const CANDIDATE = {
  zoneId: ZONE.zoneId,
  city: "bos",
  providerZoneNumber: "81234",
  rateFirstHourUsd: 3.75,
  rateAdditionalHourUsd: 3.75,
  maxStayMinutes: 120,
  hours: HOURS,
  distanceM: 6,
  containsPoint: true,
};
const ONE_HOUR = golden.samples[1]!;
const FIX = { lat: 42.3495, lng: -71.0798, accuracy: 8 };

/** A sign model that answers each call in turn, and records what it saw. */
function scripted(answers: (Partial<ModelResponse> | Error)[]) {
  const seen: { messages: ModelTurn[]; outputSchema: unknown; effort: unknown }[] = [];
  const model: ModelClient = {
    async create(args) {
      seen.push({ messages: args.messages, outputSchema: args.outputSchema, effort: args.effort });
      const next = answers.shift();
      if (!next) throw new Error("no scripted answer left");
      if (next instanceof Error) throw next;
      return {
        content: [],
        stopReason: "end_turn",
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 900, outputTokens: 120 },
        ...next,
      };
    },
  };
  return { model, seen };
}

const answer = (reading: SignRules): Partial<ModelResponse> => ({
  content: [{ type: "text", text: JSON.stringify(reading) }],
});

function setup(model?: ModelClient, opts: { cap?: number } = {}) {
  const t = makeTestApp({
    candidates: [CANDIDATE],
    zones: [ZONE],
    now: () => NOW,
    seedLinkedProvider: false,
    ...(model ? { signReaderModel: model } : {}),
    ...(opts.cap !== undefined ? { assistantDailySpendCapUsd: opts.cap } : {}),
  });
  seedProviderAccount(t.state, { provider: "passport" });
  t.state.parkedEvents.push({
    id: "pe1",
    userId: "u1",
    lat: FIX.lat,
    lng: FIX.lng,
    accuracyM: 8,
    ts: NOW,
    signals: ["motion_stop"],
  });
  const check = (payload: object, headers = U1) =>
    t.app.inject({ method: "POST", url: "/parked/pe1/signs", headers, payload });
  return { t, check };
}

describe("GET /me tells the app whether to offer the check", () => {
  test.each([
    ["off", undefined, false],
    ["on", scripted([]).model, true],
  ])("%s", async (_state, model, signReader) => {
    const { t } = setup(model);
    const me = await t.app.inject({ method: "GET", url: "/me", headers: U1 });
    expect(me.statusCode).toBe(200);
    expect(me.json().signReader).toBe(signReader);
  });
});

describe("POST /parked/:id/signs", () => {
  test("off without SIGN_READER: 503, no model call", async () => {
    const { check } = setup();
    const res = await check({ text: ONE_HOUR.text, fix: FIX });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "sign_reader_off" });
  });

  test("a stricter sign: the shorter stay is offered, the reading is on the record, nothing else changes", async () => {
    const { model, seen } = scripted([answer(ONE_HOUR.modelOutput)]);
    const { t, check } = setup(model);
    const res = await check({ text: ONE_HOUR.text, fix: FIX });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      verdict: "stricter",
      offer: { maxStayMinutes: 60 },
      zone: { zoneId: ZONE.zoneId, maxStayMinutes: 120 },
      advisory: true,
      photoKept: false,
    });
    // One call, held to the schema, no prefill, no photo when none was sent.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.outputSchema).toEqual(SIGN_RULES_JSON_SCHEMA);
    expect(seen[0]!.effort).toBe("low");
    expect(seen[0]!.messages.at(-1)!.role).toBe("user");
    expect(JSON.stringify(seen[0]!.messages)).not.toContain('"image"');
    // On the record, with its cost against the daily budget.
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "sign_check",
      rule: "stricter",
      parkedEventId: "pe1",
      outcome: { estimatedCostUsd: expect.any(Number), offerMaxStayMinutes: 60 },
    });
    expect(t.state.signChecks).toHaveLength(1);
    expect(t.state.signChecks[0]).toMatchObject({ ocrText: ONE_HOUR.text, photo: null });
    // Advisory: no session, no executor call, no money.
    expect(t.state.sessions).toHaveLength(0);
    expect(t.executorCalls).toHaveLength(0);
  });

  test("someone else's park is not found", async () => {
    const { model } = scripted([answer(ONE_HOUR.modelOutput)]);
    const { check } = setup(model);
    const res = await check({ text: ONE_HOUR.text, fix: FIX }, U2);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "parked_event_not_found" });
  });

  test("a photo goes to the model only when sent, and is kept only on the driver's opt-in, for the review queue", async () => {
    const { model, seen } = scripted([answer(ONE_HOUR.modelOutput), answer(ONE_HOUR.modelOutput)]);
    const { t, check } = setup(model);
    const photo = {
      mediaType: "image/jpeg",
      data: Buffer.from("not really a jpeg").toString("base64"),
    };
    await check({ text: ONE_HOUR.text, fix: FIX, photo });
    expect(JSON.stringify(seen[0]!.messages)).toContain('"image"');
    expect(t.state.signChecks[0]!.photo).toBeNull();
    const kept = await check({ text: ONE_HOUR.text, fix: FIX, photo, storePhoto: true });
    expect(kept.json().photoKept).toBe(true);
    const row = t.state.signChecks[1]!;
    expect(row.photoMediaType).toBe("image/jpeg");
    expect(row.photoExpiresAt!.getTime() - NOW.getTime()).toBe(30 * 24 * 60 * 60_000);
    const queue = await t.app.inject({ method: "GET", url: "/admin/sign-checks", headers: U1 });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().checks).toHaveLength(1);
    // The list carries no photo bytes; each photo is its own GET.
    expect(queue.body).not.toContain(photo.data);
    const photoUrl = queue.json().checks[0].photoUrl as string;
    const served = await t.app.inject({ method: "GET", url: photoUrl, headers: U1 });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.rawPayload.toString("base64")).toBe(photo.data);
    for (const url of ["/admin/sign-checks", photoUrl]) {
      const notAdmin = await t.app.inject({ method: "GET", url, headers: U2 });
      expect(notAdmin.statusCode).toBe(403);
    }
  });

  test("the review queue pages: at most 20 a page, `next` to go on", async () => {
    const photo = { mediaType: "image/png", data: Buffer.from("png").toString("base64") };
    const { model } = scripted(Array.from({ length: 3 }, () => answer(ONE_HOUR.modelOutput)));
    let at = NOW;
    const t = makeTestApp({
      candidates: [CANDIDATE],
      zones: [ZONE],
      now: () => at,
      seedLinkedProvider: false,
      signReaderModel: model,
    });
    t.state.parkedEvents.push({
      id: "pe1",
      userId: "u1",
      lat: FIX.lat,
      lng: FIX.lng,
      accuracyM: 8,
      ts: NOW,
      signals: ["motion_stop"],
    });
    for (let i = 0; i < 3; i++) {
      at = new Date(NOW.getTime() + i * 60_000);
      const res = await t.app.inject({
        method: "POST",
        url: "/parked/pe1/signs",
        headers: U1,
        payload: { text: ONE_HOUR.text, photo, storePhoto: true },
      });
      expect(res.statusCode).toBe(200);
    }
    const get = (q: string) =>
      t.app.inject({ method: "GET", url: `/admin/sign-checks${q}`, headers: U1 });
    const first = (await get("?limit=2")).json();
    expect(first.checks).toHaveLength(2);
    expect(first.next).toBe(first.checks[1].createdAt);
    const second = (await get(`?limit=2&before=${encodeURIComponent(first.next)}`)).json();
    expect(second.checks).toHaveLength(1);
    expect(second.next).toBeNull();
    expect((await get("?limit=50")).statusCode).toBe(400);
  });

  test.each([
    ["older than the park TTL, no session", { ageMs: 61 * 60_000 }],
    ["declined", { held: "declined" }],
    ["replaced by a newer park", { held: "superseded" }],
  ] as const)("a closed park: %s → 409 park_closed, no model call", async (_why, how) => {
    const { model, seen } = scripted([answer(ONE_HOUR.modelOutput)]);
    const { t, check } = setup(model);
    if ("ageMs" in how) t.state.parkedEvents[0]!.ts = new Date(NOW.getTime() - how.ageMs);
    if ("held" in how) {
      await t.deps.db.pendingPark.create({
        data: {
          userId: "u1",
          parkedEventId: "pe1",
          status: how.held,
          carLat: FIX.lat,
          carLng: FIX.lng,
          candidates: [],
          quote: null,
          shownDryRun: true,
          parkedAt: NOW,
        },
      });
    }
    const res = await check({ text: ONE_HOUR.text, fix: FIX });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "park_closed" });
    expect(seen).toHaveLength(0);
  });

  test("a park past the TTL with its session still running stays open", async () => {
    const { model } = scripted([answer(ONE_HOUR.modelOutput)]);
    const { t, check } = setup(model);
    t.state.parkedEvents[0]!.ts = new Date(NOW.getTime() - 3 * 60 * 60_000);
    seedSession(t.state, { status: "active", parkedEventId: "pe1", zoneId: ZONE.zoneId });
    expect((await check({ text: ONE_HOUR.text, fix: FIX })).statusCode).toBe(200);
  });

  test.each([
    ["the call fails", new Error("network down"), "model_error"],
    ["a refusal", { stopReason: "refusal" }, "stop_refusal"],
    [
      "an answer off the schema",
      { content: [{ type: "text" as const, text: '{"rules": "no"}' }] },
      "off_schema",
    ],
    ["a low confidence", answer({ ...ONE_HOUR.modelOutput, confidence: 0.2 }), "low_confidence"],
  ])("%s: unreadable, nothing offered", async (_why, reply, fallback) => {
    const { model } = scripted([reply as Partial<ModelResponse> | Error]);
    const { t, check } = setup(model);
    const res = await check({ text: ONE_HOUR.text, fix: FIX });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: "unreadable", offer: null, rules: [] });
    expect(t.state.decisions.at(-1)).toMatchObject({ rule: "unreadable", outcome: { fallback } });
  });

  test("a photo with no recognized text: no call, unreadable (nothing to ground it on)", async () => {
    const { model, seen } = scripted([answer(golden.samples[2]!.modelOutput)]);
    const { t, check } = setup(model);
    const photo = { mediaType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") };
    const res = await check({ text: "  ", fix: FIX, photo });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: "unreadable", offer: null, rules: [] });
    expect(seen).toHaveLength(0);
    expect(t.state.decisions.at(-1)).toMatchObject({ outcome: { fallback: "no_text" } });
  });

  test("over the daily model budget (shared with the assistant): 429 before any call", async () => {
    const { model, seen } = scripted([answer(ONE_HOUR.modelOutput), answer(ONE_HOUR.modelOutput)]);
    const { check } = setup(model, { cap: 0.002 });
    expect((await check({ text: ONE_HOUR.text, fix: FIX })).statusCode).toBe(200);
    const over = await check({ text: ONE_HOUR.text, fix: FIX });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: "assistant_budget_exhausted" });
    expect(seen).toHaveLength(1);
  });
});

describe("accepting a shorter stay: only ever tighter", () => {
  async function stricterCheck() {
    const { model } = scripted([
      answer(ONE_HOUR.modelOutput),
      answer(golden.samples[0]!.modelOutput),
    ]);
    const s = setup(model);
    const res = await s.check({ text: ONE_HOUR.text, fix: FIX });
    return { ...s, checkId: res.json().checkId as string };
  }
  const accept = (s: Awaited<ReturnType<typeof stricterCheck>>, checkId: string, headers = U1) =>
    s.t.app.inject({ method: "POST", url: `/parked/pe1/signs/${checkId}/accept`, headers });

  test("a running session for this park drops to it; the extend gates read the session's max stay", async () => {
    const s = await stricterCheck();
    // 45 bought: under the 60 offered, so the stay drops all the way.
    const start = await s.t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: ZONE.zoneId, minutes: 45 },
    });
    expect(start.statusCode, start.body).toBe(200);
    expect(s.t.state.sessions.at(-1)!.maxStayMinutes).toBe(120);
    const res = await accept(s, s.checkId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, maxStayMinutes: 60 });
    expect(s.t.state.sessions.at(-1)!.maxStayMinutes).toBe(60);
    // Accepting again changes nothing and writes nothing new.
    const rows = s.t.state.decisions.length;
    expect((await accept(s, s.checkId)).statusCode).toBe(200);
    expect(s.t.state.decisions.length).toBe(rows);
  });

  test("a session that bought more than the offer is held at what it bought, and extends no further", async () => {
    const s = await stricterCheck();
    const start = await s.t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: ZONE.zoneId, minutes: 90 },
    });
    expect(start.statusCode, start.body).toBe(200);
    const session = s.t.state.sessions.at(-1)!;
    expect(session.purchasedMinutes).toBe(90);
    const res = await accept(s, s.checkId);
    expect(res.statusCode).toBe(200);
    // Down from the zone's 120, but never under the 90 paid for.
    expect(s.t.state.sessions.at(-1)!.maxStayMinutes).toBe(90);
    expect(s.t.state.decisions.at(-1)).toMatchObject({
      rule: "accepted_shorter_stay",
      outcome: { maxStayMinutes: 60, sessionMaxStayMinutes: 90, paidMinutes: 90 },
    });
    // And no more time on top of it.
    const extend = await s.t.app.inject({
      method: "POST",
      url: "/session/extend",
      headers: U1,
      payload: { sessionId: session.id, minutes: 15 },
    });
    expect(extend.statusCode, extend.body).not.toBe(200);
    expect(s.t.state.sessions.at(-1)!.purchasedMinutes).toBe(90);
  });

  test("accepting never lengthens a stay already held shorter", async () => {
    const s = await stricterCheck();
    const start = await s.t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: ZONE.zoneId, minutes: 20 },
    });
    expect(start.statusCode, start.body).toBe(200);
    // Held to 30 already (an earlier, stricter reading); offered 60.
    s.t.state.sessions.at(-1)!.maxStayMinutes = 30;
    expect((await accept(s, s.checkId)).statusCode).toBe(200);
    expect(s.t.state.sessions.at(-1)!.maxStayMinutes).toBe(30);
    expect(s.t.state.decisions.at(-1)).toMatchObject({
      outcome: { tightenedSession: null, sessionMaxStayMinutes: 30 },
    });
  });

  test("a session started later for this park starts under it", async () => {
    const s = await stricterCheck();
    expect((await accept(s, s.checkId)).statusCode).toBe(200);
    const over = await s.t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: ZONE.zoneId, minutes: 90 },
    });
    expect(over.statusCode).not.toBe(200);
    expect(s.t.state.sessions.filter((x) => x.status === "active")).toHaveLength(0);
    const within = await s.t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: ZONE.zoneId, minutes: 60 },
    });
    expect(within.statusCode, within.body).toBe(200);
    expect(s.t.state.sessions.at(-1)!.maxStayMinutes).toBe(60);
  });

  test("a check with nothing to offer can't be accepted; another driver's can't be either", async () => {
    const s = await stricterCheck();
    const agrees = await s.check({ text: golden.samples[0]!.text, fix: FIX });
    expect(agrees.json().verdict).toBe("agrees");
    expect((await accept(s, agrees.json().checkId)).statusCode).toBe(409);
    expect((await accept(s, s.checkId, U2)).statusCode).toBe(404);
  });
});

describe("the walk-away prompt quotes the accepted stay", () => {
  // A park held for the walk-away (FR-55): the prompt is quoted when the
  // phone leaves the car, from the terms the start path would read then.
  test.each([
    ["accepted", true, 60],
    ["not accepted (control): the default stay", false, 90],
  ])("%s", async (_case, accepting, minutes) => {
    const { model } = scripted([answer(ONE_HOUR.modelOutput)]);
    const t = makeTestApp({
      candidates: [CANDIDATE],
      zones: [ZONE],
      now: () => NOW,
      seedLinkedProvider: false,
      signReaderModel: model,
    });
    seedProviderAccount(t.state, { provider: "passport" });
    const post = (url: string, payload?: object) =>
      t.app.inject({ method: "POST", url, headers: U1, ...(payload ? { payload } : {}) });
    const parked = await post("/parked", {
      lat: FIX.lat,
      lng: FIX.lng,
      accuracy: 8,
      ts: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      signals: ["motion_stop"],
      outcomes: ["garage", "nopay", "walk_away"],
    });
    expect(parked.json()).toMatchObject({ action: "pay", awaitsWalkAway: true });
    const id = parked.json().parkedEventId as string;
    const check = await post(`/parked/${id}/signs`, { text: ONE_HOUR.text });
    expect(check.json().verdict).toBe("stricter");
    if (accepting) {
      expect((await post(`/parked/${id}/signs/${check.json().checkId}/accept`)).statusCode).toBe(
        200,
      );
    }
    // Two fixes well clear of the car, a minute apart at a walking pace:
    // the phone has left it.
    let answered;
    for (const [back, north] of [
      [60_000, 0.002],
      [0, 0.0022],
    ] as const) {
      answered = await post("/location", {
        lat: FIX.lat + north,
        lng: FIX.lng,
        accuracy: 5,
        ts: new Date(NOW.getTime() - back).toISOString(),
      });
      expect(answered.statusCode).toBe(200);
    }
    const prompt = answered!.json().prompt;
    expect(prompt).toMatchObject({ kind: "confirm", minutes });
    // $3.75/hr flat plus the city fee, for the stay quoted.
    const meter = Math.round(3.75 * (minutes / 60) * 100) / 100;
    expect(prompt.amountUsd).toBeCloseTo(meter + prompt.quote.feeUsd, 2);
    expect(prompt.quote.stayMinutes).toBe(minutes);
  });
});

describe("account deletion", () => {
  test("a deleted account's sign checks go with it, text and photo", async () => {
    const { model } = scripted([answer(ONE_HOUR.modelOutput)]);
    const s = setup(model);
    await s.check({ text: ONE_HOUR.text, fix: FIX });
    expect(s.t.state.signChecks).toHaveLength(1);
    await deleteAccount({ db: s.t.deps.db, now: () => NOW }, "u1");
    expect(s.t.state.signChecks).toHaveLength(0);
  });
});

describe("retention", () => {
  test("the OCR text and a kept photo go after 30 days, on the record; the reading stays", async () => {
    const { model } = scripted([answer(ONE_HOUR.modelOutput)]);
    const s = setup(model);
    const photo = { mediaType: "image/png", data: Buffer.from("png").toString("base64") };
    await s.check({ text: ONE_HOUR.text, fix: FIX, photo, storePhoto: true });
    let at = NOW;
    const retention = makeConversationRetention({
      db: s.t.deps.db,
      retentionDays: 90,
      log: { info: () => {}, warn: () => {} },
      now: () => at,
    });
    await retention.tick();
    expect(s.t.state.signChecks[0]!.ocrText).toBe(ONE_HOUR.text);
    at = new Date(NOW.getTime() + 31 * 24 * 60 * 60_000);
    await retention.tick();
    expect(s.t.state.signChecks[0]).toMatchObject({
      ocrText: null,
      photo: null,
      photoExpiresAt: null,
    });
    expect(s.t.state.signChecks[0]!.verdict).toBe("stricter");
    expect(s.t.state.decisions.at(-1)).toMatchObject({
      kind: "sign_check",
      rule: "retention_purge",
      outcome: { texts: 1, photos: 1 },
    });
    // Nothing left to clear: no second row.
    const rows = s.t.state.decisions.length;
    await retention.tick();
    expect(s.t.state.decisions.length).toBe(rows);
  });
});
