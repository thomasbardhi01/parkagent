/**
 * Saved conversations (device test: "conversations persist on the server
 * already; the app shows none"). Pinned here: every turn records a title
 * and a readable transcript; the history list (newest first, with what
 * each conversation came to), opening one, deleting one or all; the model
 * context is cut only where a user message starts (a resumed conversation
 * must stay valid for the Messages API); 90-day retention; and Activity
 * rows linking back to the conversation they were made in.
 */

import { describe, expect, test } from "vitest";

import { makeConversationRetention } from "../src/jobs/conversationRetentionTick.js";
import type { ModelClient, ModelResponse, ModelTurn } from "../src/services/assistant/loop.js";
import { trimTurns } from "../src/services/assistant/history.js";
import type { GarageOption, GarageProvider } from "../src/services/garage/garageProvider.js";
import {
  API_KEY,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeFakeDb,
  makeTestApp,
  seedSession,
  setFakeRowClock,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const OTHER = { "x-api-key": NONADMIN_API_KEY, "content-type": "application/json" };
/** A bodyless DELETE carries no content type (Fastify refuses an empty JSON body). */
const MINE = { "x-api-key": API_KEY };
const THEIRS = { "x-api-key": NONADMIN_API_KEY };

function scripted(responses: ModelResponse[]): ModelClient {
  let call = 0;
  return {
    async create() {
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return response;
    },
  };
}

const text = (t: string): ModelResponse => ({
  content: [{ type: "text", text: t }],
  stopReason: "end_turn",
});
const tool = (id: string, name: string, input: unknown): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const GARAGE: GarageOption = {
  id: "g1",
  provider: "spothero",
  name: "Underground Deck",
  address: "1 Test St",
  priceUsd: 18,
  distanceM: 240,
  walkMinutes: 3,
  entryType: "self",
  deepLink: "https://spothero.com/checkout/1",
};

function garage(): GarageProvider {
  return {
    id: "spothero",
    canReserve: false,
    search: async () => ({ ok: true, options: [GARAGE], fromCache: false }),
    optionById: (id) => (id === "g1" ? GARAGE : null),
    book: async () => ({ kind: "deeplink_handoff", option: GARAGE, deepLink: GARAGE.deepLink }),
  };
}

/** A turn that quotes a garage and proposes it. */
const PROPOSE_GARAGE: ModelResponse[] = [
  tool("t1", "search_garages", {
    lat: 40.7784,
    lng: -73.9819,
    starts_at: "2026-01-05T15:00:00-05:00",
    ends_at: "2026-01-05T17:00:00-05:00",
  }),
  tool("t2", "propose_plan", {
    plan: {
      kind: "single_spot",
      options: [
        {
          id: "garage-g1",
          type: "garage",
          label: "Underground Deck",
          priceUsd: 18,
          durationMinutes: 120,
          garageOptionId: "g1",
          recommended: true,
        },
      ],
    },
  }),
];

async function say(
  app: ReturnType<typeof makeTestApp>["app"],
  message: string,
  conversationId?: string,
  headers = HEADERS,
) {
  const res = await app.inject({
    method: "POST",
    url: "/assistant/message",
    headers,
    payload: { text: message, ...(conversationId ? { conversation_id: conversationId } : {}) },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { conversationId: string; reply: string; plan: { planId: string } | null };
}

describe("what a turn records", () => {
  test("the first request titles it; each turn appends the transcript as the user saw it", async () => {
    const t = makeTestApp({
      assistantModel: scripted([text("Where to?"), text("Got it.")]),
    });
    const one = await say(t.app, "Find me parking near Fenway tonight");
    await say(t.app, "for three hours", one.conversationId);
    const row = t.state.conversations[0]!;
    expect(row.title).toBe("Find me parking near Fenway tonight");
    const display = row.display as { role: string; text: string }[];
    expect(display.map((e) => [e.role, e.text])).toEqual([
      ["user", "Find me parking near Fenway tonight"],
      ["assistant", "Where to?"],
      ["user", "for three hours"],
      ["assistant", "Got it."],
    ]);
  });

  test("a proposed plan and a question's chips are on the assistant's entry", async () => {
    const t = makeTestApp({ assistantModel: scripted(PROPOSE_GARAGE), garage: garage() });
    const one = await say(t.app, "garage near the museum");
    const last = (t.state.conversations[0]!.display as { planId?: string }[]).at(-1)!;
    expect(last.planId).toBe(one.plan!.planId);
  });
});

describe("the model context is cut only where a user message starts", () => {
  const user = (c: string): ModelTurn => ({ role: "user", content: c });
  const use = (id: string): ModelTurn => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "quote_street", input: {} }],
  });
  const result = (id: string): ModelTurn => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "{}" }],
  });
  const reply = (c: string): ModelTurn => ({
    role: "assistant",
    content: [{ type: "text", text: c }],
  });

  test("a cut inside a tool round-trip moves forward to the next user message", () => {
    // 22 messages; the last 20 would start on a tool_result whose tool_use
    // was cut away — a context the Messages API refuses.
    const turns: ModelTurn[] = [
      user("q1"),
      use("a"),
      result("a"),
      use("b"),
      result("b"),
      reply("r1"),
    ];
    for (let i = 2; i <= 5; i += 1)
      turns.push(user(`q${i}`), use(`x${i}`), result(`x${i}`), reply(`r${i}`));
    expect(turns).toHaveLength(22);
    const naive = turns.slice(-20)[0]!;
    expect(Array.isArray(naive.content) && naive.content[0]!.type).toBe("tool_result");
    const kept = trimTurns(turns, 20);
    expect(kept[0]).toEqual(user("q2"));
    expect(kept.length).toBeLessThanOrEqual(20);
  });

  test("short contexts are kept whole", () => {
    const turns = [user("q"), reply("r")];
    expect(trimTurns(turns, 20)).toBe(turns);
  });
});

describe("GET /assistant/conversations", () => {
  test("newest first, titled, with what each came to, and the retention period", async () => {
    const t = makeTestApp({
      assistantModel: scripted([text("Where to?"), ...PROPOSE_GARAGE]),
      garage: garage(),
    });
    setFakeRowClock(() => new Date("2026-01-05T10:00:00-05:00"));
    const first = await say(t.app, "first question");
    setFakeRowClock(() => new Date("2026-01-05T11:00:00-05:00"));
    const second = await say(t.app, "garage near the museum");

    const res = await t.app.inject({
      method: "GET",
      url: "/assistant/conversations",
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.retentionDays).toBe(90);
    expect(body.conversations.map((c: { id: string }) => c.id)).toEqual([
      second.conversationId,
      first.conversationId,
    ]);
    expect(body.conversations[0]).toMatchObject({
      title: "garage near the museum",
      messageCount: 2,
      outcome: { kind: "proposed", label: "1 option proposed, from $18.00" },
    });
    expect(body.conversations[1].outcome).toBeNull();
  });

  test("a confirmed garage is what the conversation came to", async () => {
    const t = makeTestApp({ assistantModel: scripted(PROPOSE_GARAGE), garage: garage() });
    const one = await say(t.app, "garage near the museum");
    const confirm = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: one.plan!.planId, optionId: "garage-g1" },
    });
    expect(confirm.statusCode).toBe(200);
    const list = (
      await t.app.inject({ method: "GET", url: "/assistant/conversations", headers: HEADERS })
    ).json();
    expect(list.conversations[0].outcome).toMatchObject({
      kind: "garage",
      label: "Garage — Underground Deck",
      amountUsd: 18,
    });
  });

  test("pages by cursor", async () => {
    const t = makeTestApp({ assistantModel: scripted([text("ok")]) });
    for (let i = 0; i < 3; i += 1) {
      setFakeRowClock(() => new Date(Date.UTC(2026, 0, 5, 15, i)));
      await say(t.app, `q${i}`);
    }
    const page1 = (
      await t.app.inject({
        method: "GET",
        url: "/assistant/conversations?limit=2",
        headers: HEADERS,
      })
    ).json();
    expect(page1.conversations.map((c: { title: string }) => c.title)).toEqual(["q2", "q1"]);
    const page2 = (
      await t.app.inject({
        method: "GET",
        url: `/assistant/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
        headers: HEADERS,
      })
    ).json();
    expect(page2.conversations.map((c: { title: string }) => c.title)).toEqual(["q0"]);
    expect(page2.nextCursor).toBeNull();
  });

  test("another user's conversations are neither listed nor readable", async () => {
    const t = makeTestApp({ assistantModel: scripted([text("ok")]) });
    const mine = await say(t.app, "mine");
    const list = (
      await t.app.inject({ method: "GET", url: "/assistant/conversations", headers: OTHER })
    ).json();
    expect(list.conversations).toEqual([]);
    const read = await t.app.inject({
      method: "GET",
      url: `/assistant/conversations/${mine.conversationId}`,
      headers: OTHER,
    });
    expect(read.statusCode).toBe(404);
  });

  test("a conversation saved before titles and transcripts reads from its context", async () => {
    const t = makeTestApp({ assistantModel: scripted([text("ok")]) });
    t.state.conversations.push({
      id: "conv_old",
      userId: "u1",
      turns: [
        { role: "user", content: "old question\n\n[current time: Mon 2026-01-05 14:00 ET]" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      title: null,
      display: [],
      createdAt: new Date("2026-01-01T12:00:00Z"),
      updatedAt: new Date("2026-01-01T12:00:00Z"),
    });
    const read = (
      await t.app.inject({
        method: "GET",
        url: "/assistant/conversations/conv_old",
        headers: HEADERS,
      })
    ).json();
    expect(read.title).toBe("old question");
    expect(read.messages.map((m: { text: string }) => m.text)).toEqual([
      "old question",
      "old answer",
    ]);
  });
});

describe("GET /assistant/conversations/:id", () => {
  test("the transcript and the plans in it, to read or resume", async () => {
    const t = makeTestApp({ assistantModel: scripted(PROPOSE_GARAGE), garage: garage() });
    const one = await say(t.app, "garage near the museum");
    const read = (
      await t.app.inject({
        method: "GET",
        url: `/assistant/conversations/${one.conversationId}`,
        headers: HEADERS,
      })
    ).json();
    expect(read.messages).toHaveLength(2);
    expect(read.messages[1].planId).toBe(one.plan!.planId);
    expect(read.plans).toHaveLength(1);
    expect(read.plans[0]).toMatchObject({ planId: one.plan!.planId, confirmedAt: null });
    expect(read.plans[0].plan.options[0].label).toBe("Underground Deck");
  });
});

describe("DELETE", () => {
  test("one: gone for its owner, untouchable by anyone else", async () => {
    const t = makeTestApp({ assistantModel: scripted([text("ok")]) });
    const keep = await say(t.app, "keep me");
    const drop = await say(t.app, "delete me");
    const foreign = await t.app.inject({
      method: "DELETE",
      url: `/assistant/conversations/${drop.conversationId}`,
      headers: THEIRS,
    });
    expect(foreign.statusCode).toBe(404);
    expect(t.state.conversations).toHaveLength(2);
    const res = await t.app.inject({
      method: "DELETE",
      url: `/assistant/conversations/${drop.conversationId}`,
      headers: MINE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 1 });
    expect(t.state.conversations.map((c) => c.id)).toEqual([keep.conversationId]);
    expect(
      t.state.decisions.some(
        (d) => d.kind === "assistant_history" && d.rule === "conversation_deleted",
      ),
    ).toBe(true);
  });

  test("all: every one of mine, none of anyone else's", async () => {
    const t = makeTestApp({ assistantModel: scripted([text("ok")]) });
    await say(t.app, "one");
    await say(t.app, "two");
    await say(t.app, "theirs", undefined, OTHER);
    const res = await t.app.inject({
      method: "DELETE",
      url: "/assistant/conversations",
      headers: MINE,
    });
    expect(res.json()).toEqual({ deleted: 2 });
    expect(t.state.conversations.map((c) => c.title)).toEqual(["theirs"]);
  });
});

describe("a deleted conversation stays deleted", () => {
  test("continuing a deleted conversation starts a new one, without the old plans", async () => {
    const t = makeTestApp({
      assistantModel: scripted([...PROPOSE_GARAGE, text("Anything else?")]),
      garage: garage(),
    });
    const one = await say(t.app, "garage near the museum");
    await t.app.inject({
      method: "DELETE",
      url: `/assistant/conversations/${one.conversationId}`,
      headers: MINE,
    });
    const again = await say(t.app, "and tomorrow?", one.conversationId);
    expect(again.conversationId).not.toBe(one.conversationId);
    const list = (
      await t.app.inject({ method: "GET", url: "/assistant/conversations", headers: HEADERS })
    ).json();
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]).toMatchObject({ title: "and tomorrow?", outcome: null });
  });
});

describe("retention", () => {
  test("conversations idle past the period are deleted; recent ones and the money records stay", async () => {
    const { db, state } = makeFakeDb();
    const conv = (id: string, updatedAt: string) => ({
      id,
      userId: "u1",
      turns: [],
      title: id,
      display: [],
      createdAt: new Date(updatedAt),
      updatedAt: new Date(updatedAt),
    });
    state.conversations.push(
      conv("old", "2026-06-01T12:00:00Z"),
      conv("recent", "2026-09-20T12:00:00Z"),
    );
    state.assistantPlans.push({
      id: "p-old",
      userId: "u1",
      conversationId: "old",
      kind: "single_spot",
      plan: { kind: "single_spot", options: [] },
      createdAt: new Date("2026-06-01T12:00:00Z"),
      confirmedAt: null,
      confirmedOptionId: null,
    });
    const job = makeConversationRetention({
      db,
      retentionDays: 90,
      log: { info: () => {}, warn: () => {} },
      now: () => new Date("2026-09-25T12:00:00Z"),
    });
    expect(await job.tick()).toBe(1);
    expect(state.conversations.map((c) => c.id)).toEqual(["recent"]);
    expect(state.assistantPlans).toHaveLength(1);
    const row = state.decisions.find((d) => d.rule === "retention_purge")!;
    expect(row.outcome).toEqual({ deleted: 1 });
    // Nothing to do → no row.
    expect(await job.tick()).toBe(0);
    expect(state.decisions.filter((d) => d.rule === "retention_purge")).toHaveLength(1);
  });
});

describe("Activity links back to the conversation", () => {
  test("a garage confirmed in chat carries its conversation, until the conversation is deleted", async () => {
    const t = makeTestApp({ assistantModel: scripted(PROPOSE_GARAGE), garage: garage() });
    const one = await say(t.app, "garage near the museum");
    await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: one.plan!.planId, optionId: "garage-g1" },
    });
    const activity = async () =>
      (await t.app.inject({ method: "GET", url: "/wallet/activity", headers: HEADERS })).json()
        .items as { kind: string; conversationId: string | null }[];
    expect((await activity()).find((i) => i.kind === "garage")!.conversationId).toBe(
      one.conversationId,
    );
    await t.app.inject({
      method: "DELETE",
      url: `/assistant/conversations/${one.conversationId}`,
      headers: MINE,
    });
    expect((await activity()).find((i) => i.kind === "garage")!.conversationId).toBeNull();
  });

  test("a street spot confirmed in chat is a plan row in Activity", async () => {
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: scripted([
        tool("t1", "quote_street", {
          lat: 40.7784,
          lng: -73.9819,
          duration_minutes: 60,
          when: "2026-01-05T14:00:00-05:00",
        }),
        tool("t2", "propose_plan", {
          plan: {
            kind: "single_spot",
            options: [
              {
                id: "street-1",
                type: "street",
                label: "Steinway St",
                priceUsd: 2.15,
                durationMinutes: 60,
                zoneId: STEINWAY_A.zoneId,
                recommended: true,
              },
            ],
          },
        }),
      ]),
    });
    const one = await say(t.app, "park me here for an hour");
    const confirm = await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: one.plan!.planId, optionId: "street-1" },
    });
    expect(confirm.statusCode).toBe(200);
    const items = (
      await t.app.inject({ method: "GET", url: "/wallet/activity", headers: HEADERS })
    ).json().items as {
      kind: string;
      planKind: string;
      conversationId: string;
      explanation: string;
    }[];
    const plan = items.find((i) => i.kind === "plan")!;
    expect(plan).toMatchObject({
      planKind: "street",
      conversationId: one.conversationId,
      explanation: "Chosen in the assistant — it pays when you park there.",
    });
  });
});

describe("review fixes: legacy conversations", () => {
  test("a conversation saved before titles existed gets one on its next turn, from its first request", async () => {
    const t = makeTestApp({ assistantModel: scripted([text("ok")]) });
    t.state.conversations.push({
      id: "conv_legacy",
      userId: "u1",
      turns: [
        {
          role: "user",
          content: "the original question\n\n[current time: Mon 2026-01-05 14:00 ET]",
        },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      title: null,
      display: [],
      createdAt: new Date("2026-01-01T12:00:00Z"),
      updatedAt: new Date("2026-01-01T12:00:00Z"),
    });
    await say(t.app, "a follow-up", "conv_legacy");
    const row = t.state.conversations.find((c) => c.id === "conv_legacy")!;
    expect(row.title).toBe("the original question");
    expect((row.display as { text: string }[]).map((e) => e.text)).toEqual([
      "the original question",
      "old answer",
      "a follow-up",
      "ok",
    ]);
  });
});

describe("independent review fixes: trimming and Activity", () => {
  test("the loop's own reminder is never where a stored context starts", () => {
    const u = (c: string): ModelTurn => ({ role: "user", content: c });
    const a = (c: string): ModelTurn => ({
      role: "assistant",
      content: [{ type: "text", text: c }],
    });
    const turns = [
      u("q1"),
      a("r1"),
      u("[system reminder] Call propose_plan NOW"),
      a("r2"),
      u("q2"),
      a("r3"),
    ];
    expect(trimTurns(turns, 4)[0]).toEqual(u("q2"));
  });

  test("a street plan gives way to its session once the car parks there; plan rows carry no charge", async () => {
    const t = makeTestApp({
      candidates: [STEINWAY_A],
      assistantModel: scripted([
        tool("t1", "quote_street", {
          lat: 40.7784,
          lng: -73.9819,
          duration_minutes: 60,
          when: "2026-01-05T14:00:00-05:00",
        }),
        tool("t2", "propose_plan", {
          plan: {
            kind: "single_spot",
            options: [
              {
                id: "street-1",
                type: "street",
                label: "Steinway St",
                priceUsd: 2.15,
                durationMinutes: 60,
                zoneId: STEINWAY_A.zoneId,
                recommended: true,
              },
            ],
          },
        }),
      ]),
    });
    const one = await say(t.app, "park me here for an hour");
    await t.app.inject({
      method: "POST",
      url: "/assistant/confirm",
      headers: HEADERS,
      payload: { planId: one.plan!.planId, optionId: "street-1" },
    });
    const activity = async () =>
      (await t.app.inject({ method: "GET", url: "/wallet/activity", headers: HEADERS })).json()
        .items as Record<string, unknown>[];
    const plan = (await activity()).find((i) => i["kind"] === "plan")!;
    expect(plan["totalUsd"]).toBeUndefined();
    expect(plan["plannedUsd"]).toBe(2.15);
    // The car parks there: the session row is the record now.
    seedSession(t.state, {
      userId: "u1",
      zoneId: STEINWAY_A.zoneId,
      createdAt: new Date("2026-01-05T19:30:00Z"),
    });
    expect((await activity()).some((i) => i["kind"] === "plan")).toBe(false);
  });
});
