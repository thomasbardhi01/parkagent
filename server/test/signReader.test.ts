/**
 * The parking-sign reader (Issue N): advisory only. The golden set runs
 * grounding and the comparison over recorded model outputs; the route
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
import type { SignRules } from "../src/services/signs/signRules.js";
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

describe("the golden set (recorded model outputs)", () => {
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

  test("an accepted stay only ever tightens", () => {
    expect(tightenedMaxStay(120, 60)).toBe(60);
    expect(tightenedMaxStay(60, 120)).toBe(60);
    expect(tightenedMaxStay(null, 45)).toBe(45);
    expect(tightenedMaxStay(90, null)).toBe(90);
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
  const seen: { messages: ModelTurn[]; outputSchema: unknown }[] = [];
  const model: ModelClient = {
    async create(args) {
      seen.push({ messages: args.messages, outputSchema: args.outputSchema });
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
    expect(queue.json().checks[0].photo).toMatch(/^data:image\/jpeg;base64,/);
    const notAdmin = await t.app.inject({ method: "GET", url: "/admin/sign-checks", headers: U2 });
    expect(notAdmin.statusCode).toBe(403);
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
    const start = await s.t.app.inject({
      method: "POST",
      url: "/session/start",
      headers: U1,
      payload: { parkedEventId: "pe1", zoneId: ZONE.zoneId, minutes: 90 },
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
