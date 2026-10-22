/**
 * The nightly audit (L): each invariant fires on a seeded case and stays
 * quiet on a clean day run through the real routes; the summary is the
 * model's only when grounded, and the template's otherwise; GET
 * /admin/audit is admin only and changes nothing but its own ledger row.
 */

import { afterEach, expect, test } from "vitest";

import type { PendingParkRow, ZoneTermsRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import type { ModelClient, ModelResponse } from "../src/services/assistant/loop.js";
import type { AuditWindow, Finding } from "../src/services/audit/invariants.js";
import { INVARIANTS, runAudit } from "../src/services/audit/invariants.js";
import {
  AUDIT_MODEL,
  SUMMARY_SCHEMA,
  summarize,
  templateSummary,
  ungrounded,
} from "../src/services/audit/summary.js";
import { estimateCostUsd } from "../src/services/assistant/loop.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
  seedProviderAccount,
  seedSession,
  setFakeRowClock,
} from "./helpers.js";

const U1 = { "x-api-key": API_KEY };
const U2 = { "x-api-key": NONADMIN_API_KEY };
const PARKED_AT = new Date(MONDAY_2PM);
const CAR = { lat: 40.7784, lng: -73.9819 };
const OUTCOMES = ["garage", "nopay", "walk_away"];
const HOUR = 60 * 60_000;
const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  street: "30th Ave",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};
const WINDOW: AuditWindow = {
  from: new Date(PARKED_AT.getTime() - HOUR),
  to: new Date(PARKED_AT.getTime() + 12 * HOUR),
  now: new Date(PARKED_AT.getTime() + 12 * HOUR),
};

afterEach(() => setFakeRowClock(() => new Date(MONDAY_2PM)));

function makeApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const clock = { now: new Date(PARKED_AT) };
  const t = makeTestApp({
    candidates: [STEINWAY_A],
    zones: [STEINWAY_ZONE],
    now: () => clock.now,
    ...options,
  });
  setFakeRowClock(() => clock.now);
  const tick = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  const post = (url: string, body: object = {}, headers = U1) =>
    t.app.inject({ method: "POST", url, headers, payload: body });
  const fix = (distanceM: number, extra: Record<string, unknown> = {}) => ({
    lat: CAR.lat + distanceM / 111_320,
    lng: CAR.lng,
    accuracy: 8,
    ts: clock.now.toISOString(),
    ...extra,
  });
  return { ...t, clock, tick, post, fix };
}

const findingOf = (findings: Finding[], name: string) =>
  findings.find((f) => f.invariant === name)!;

/** A pending_parks row as /parked holds it, for seeding. */
function heldPark(overrides: Partial<PendingParkRow>): PendingParkRow {
  return {
    id: "pp-seed",
    userId: "u1",
    parkedEventId: "pe-seed",
    status: "at_car",
    candidates: [{ zoneId: "nyc-417371" }],
    quote: null,
    prompt: null,
    shownDryRun: true,
    zoneId: null,
    carLat: CAR.lat,
    carLng: CAR.lng,
    parkedAt: PARKED_AT,
    leftCarAt: null,
    farAt: null,
    farDistanceM: null,
    nearSince: null,
    atCarSince: null,
    backAt: null,
    driveAt: null,
    driveDistanceM: null,
    driveSpeedMps: null,
    promptedAt: null,
    confirmedAt: null,
    startingAt: null,
    sessionId: null,
    carMovedAt: null,
    closedAt: null,
    createdAt: PARKED_AT,
    ...overrides,
  };
}

function decision(
  t: ReturnType<typeof makeApp>,
  row: {
    kind: string;
    rule: string;
    inputs?: Record<string, unknown>;
    outcome?: Record<string, unknown>;
    parkedEventId?: string;
    sessionId?: string;
  },
) {
  t.state.decisions.push({ inputs: {}, outcome: {}, createdAt: PARKED_AT, ...row });
}

// ------------------------------------------------------------ a clean day

test("a clean day through the real routes: every invariant checked, none fires", async () => {
  const t = makeApp();
  seedProviderAccount(t.state, { userId: "u2" });
  // Driver 1: walks away, is asked, taps Pay, walks on; the phone reports
  // every ten minutes, and the worker extends near the end, away.
  const p1 = (await t.post("/parked", parkedBody({ outcomes: OUTCOMES }))).json().parkedEventId;
  t.tick(40);
  await t.post("/location", t.fix(60));
  t.tick(20);
  await t.post("/location", t.fix(90));
  t.tick(10);
  expect((await t.post(`/parked/${p1}/confirm`)).json()).toMatchObject({ status: "started" });
  const session = t.state.sessions[0]!;
  for (let i = 0; i < 8; i += 1) {
    t.tick(10 * 60);
    await t.post("/location", t.fix(400 + i * 200, { speedMps: 1.2 }));
  }
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await t.post("/location", t.fix(2_500, { speedMps: 1.2 }));
  await makeExtender({ ...t.deps, log: { info() {}, warn() {} } }).tick();
  // The day's audit ends a few minutes after the phone last reported.
  const endOfDay = new Date(t.clock.now.getTime() + 5 * 60_000);
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)!.rule).toBe("extend");

  // Driver 2: Pay at the car, started by the app's on-foot report.
  t.clock.now = new Date(PARKED_AT.getTime() + 10 * 60_000);
  const p2 = (
    await t.post("/parked", parkedBody({ outcomes: OUTCOMES, ts: t.clock.now.toISOString() }), U2)
  ).json().parkedEventId;
  await t.post(`/parked/${p2}/confirm`, {}, U2);
  t.tick(40);
  await t.post("/location", t.fix(60), U2);
  t.tick(20);
  const left = await t.post("/location", t.fix(90, { event: "left_car" }), U2);
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  t.tick(60);
  await t.post("/location", t.fix(5), U2);
  t.tick(61);
  await t.post("/location", t.fix(4), U2);

  const findings = await runAudit(t.deps.db, {
    ...WINDOW,
    now: endOfDay,
    to: endOfDay,
  });
  expect(findings.map((f) => f.invariant)).toEqual(INVARIANTS.map((i) => i.name));
  expect(findings.filter((f) => f.count > 0).map((f) => [f.invariant, f.examples])).toEqual([]);
});

// ------------------------------------------------------------ each invariant

test("extended_at_car: the worker extended a phone it read as at the car", async () => {
  const t = makeApp();
  decision(t, {
    kind: "extend_tick",
    rule: "extend",
    inputs: { position: "at_car" },
    outcome: { action: "extend", minutes: 15 },
    sessionId: "s-at-car",
  });
  decision(t, {
    kind: "extend_tick",
    rule: "extend",
    inputs: { position: "away" },
    outcome: { action: "extend", minutes: 15 },
    sessionId: "s-away",
  });
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "extended_at_car");
  expect(f).toMatchObject({ count: 1, examples: ["s-at-car"], severity: "high" });
});

test("confirmed_started_without_left_car: an early Pay started with no on-foot report anywhere", async () => {
  const t = makeApp();
  const started = (parkedEventId: string, fix: Record<string, unknown>) =>
    decision(t, {
      kind: "session_start_walkaway",
      rule: "started",
      inputs: { trigger: "walk_away", fix },
      parkedEventId,
    });
  started("pe-bare", { distanceM: 90 });
  started("pe-event", { distanceM: 90, event: "left_car" });
  // Its start fix carried none, but the park kept one from before it.
  started("pe-kept", { distanceM: 95 });
  t.state.pendingParks.push(
    heldPark({ id: "pp-kept", parkedEventId: "pe-kept", status: "started" }),
  );
  t.state.parkFixes.push({
    id: "pf-kept",
    pendingParkId: "pp-kept",
    measuredAt: PARKED_AT,
    reportedAt: PARKED_AT,
    receivedAt: PARKED_AT,
    lat: CAR.lat,
    lng: CAR.lng,
    accuracyM: 8,
    speedMps: null,
    event: "left_car",
    motionActivity: null,
    motionConfidence: null,
    btHint: null,
    rejected: null,
  });
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "confirmed_started_without_left_car");
  expect(f).toMatchObject({ count: 1, examples: ["pe-bare"] });
});

test("dry_run_mismatch: a start that wasn't the dry run the prompt said", async () => {
  const t = makeApp();
  decision(t, {
    kind: "session_start_walkaway",
    rule: "started",
    inputs: { shownDryRun: true, dryRun: false },
    parkedEventId: "pe-real",
  });
  decision(t, {
    kind: "session_start_walkaway",
    rule: "started",
    inputs: { shownDryRun: true, dryRun: true },
    parkedEventId: "pe-dry",
  });
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "dry_run_mismatch");
  expect(f).toMatchObject({ count: 1, examples: ["pe-real"] });
});

test("starting_too_long: timed out, swept, adopted late, or still starting past 3 minutes", async () => {
  const t = makeApp();
  decision(t, {
    kind: "session_start_walkaway",
    rule: "start_timeout",
    parkedEventId: "pe-timeout",
  });
  decision(t, { kind: "park_lifecycle", rule: "start_stale", parkedEventId: "pe-stale" });
  decision(t, { kind: "session_start_walkaway", rule: "late_success", parkedEventId: "pe-late" });
  t.state.pendingParks.push(
    heldPark({
      id: "pp-stuck",
      parkedEventId: "pe-stuck",
      status: "starting",
      startingAt: new Date(PARKED_AT.getTime() + HOUR),
    }),
    heldPark({
      id: "pp-fresh",
      parkedEventId: "pe-fresh",
      status: "starting",
      startingAt: new Date(WINDOW.now.getTime() - 60_000),
    }),
  );
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "starting_too_long");
  expect(f.count).toBe(4);
  expect(f.examples.sort()).toEqual(["pe-late", "pe-stale", "pe-stuck", "pe-timeout"]);
});

test("transition_skipped: a paid park whose ledger never saw the tap", async () => {
  const t = makeApp();
  t.state.pendingParks.push(
    heldPark({ id: "pp-skip", parkedEventId: "pe-skip", status: "started", sessionId: "s-skip" }),
    // Made for a session started outside the lifecycle: not held, not checked.
    heldPark({ id: "pp-old", parkedEventId: "pe-old", status: "started", candidates: null }),
  );
  seedSession(t.state, { id: "s-skip", parkedEventId: "pe-skip", createdAt: PARKED_AT });
  seedSession(t.state, { id: "s-old", parkedEventId: "pe-old", createdAt: PARKED_AT });
  decision(t, { kind: "street_pending", rule: "auto_pay_ok", parkedEventId: "pe-skip" });
  decision(t, { kind: "session_start_walkaway", rule: "started", parkedEventId: "pe-skip" });
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "transition_skipped");
  expect(f).toMatchObject({ count: 1, examples: ["s-skip"] });
});

test("session_without_fix_30min: a running session the phone went quiet on", async () => {
  const t = makeApp();
  const startedAt = new Date(PARKED_AT.getTime() + HOUR);
  seedSession(t.state, {
    id: "s-quiet",
    status: "active",
    createdAt: startedAt,
    startedAt,
    expiresAt: new Date(startedAt.getTime() + 90 * 60_000),
  });
  seedSession(t.state, {
    id: "s-chatty",
    status: "stopped",
    createdAt: startedAt,
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + 40 * 60_000),
  });
  for (const minutes of [10, 25, 38]) {
    t.state.locationFixes.push({
      id: `lf-${minutes}`,
      sessionId: "s-chatty",
      userId: "u1",
      lat: CAR.lat,
      lng: CAR.lng,
      accuracyM: 8,
      ts: new Date(startedAt.getTime() + minutes * 60_000),
    });
  }
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "session_without_fix_30min");
  expect(f).toMatchObject({ count: 1, examples: ["s-quiet"] });
});

test("prompted_more_than_twice: a park the walk-away kept asking about", async () => {
  const t = makeApp();
  for (let i = 0; i < 3; i += 1)
    decision(t, { kind: "street_prompt", rule: "walk_away", parkedEventId: "pe-thrice" });
  for (let i = 0; i < 2; i += 1)
    decision(t, { kind: "street_prompt", rule: "walk_away", parkedEventId: "pe-twice" });
  const f = findingOf(await runAudit(t.deps.db, WINDOW), "prompted_more_than_twice");
  expect(f).toMatchObject({ count: 1, examples: ["pe-thrice"], severity: "low" });
});

test("rows outside the window are not read", async () => {
  const t = makeApp();
  t.state.decisions.push({
    kind: "extend_tick",
    rule: "extend",
    inputs: { position: "at_car" },
    outcome: { action: "extend" },
    sessionId: "s-yesterday",
    createdAt: new Date(WINDOW.from.getTime() - 60_000),
  });
  expect(findingOf(await runAudit(t.deps.db, WINDOW), "extended_at_car").count).toBe(0);
});

// ------------------------------------------------------------ the summary

const REPORT = {
  window: { from: "2026-01-05T05:00:00.000Z", to: "2026-01-06T05:00:00.000Z" },
  findings: INVARIANTS.map((inv): Finding => ({
    invariant: inv.name,
    severity: inv.severity,
    description: inv.description,
    count: inv.name === "extended_at_car" ? 2 : inv.name === "prompted_more_than_twice" ? 4 : 0,
    examples: inv.name === "extended_at_car" ? ["s1", "s2"] : [],
  })),
};
const GOOD_LINES = [
  "2 of 7 invariants fired overnight.",
  "high: extended_at_car fired 2 times.",
  "low: prompted_more_than_twice fired 4 times.",
  "Everything else was quiet.",
  "No money moved wrongly as far as the audit can see.",
];

function model(reply: Partial<ModelResponse> | (() => Promise<ModelResponse>)) {
  const calls: Parameters<ModelClient["create"]>[0][] = [];
  const client: ModelClient = {
    create: async (args) => {
      calls.push(args);
      if (typeof reply === "function") return reply();
      return {
        content: [{ type: "text", text: JSON.stringify({ lines: GOOD_LINES }) }],
        stopReason: "end_turn",
        model: "claude-haiku-5-5",
        usage: { inputTokens: 900, outputTokens: 300 },
        ...reply,
      };
    },
  };
  return { client, calls };
}

test("the template: five lines naming each invariant that fired, with its count", () => {
  const lines = templateSummary(REPORT);
  expect(lines).toHaveLength(5);
  expect(lines[0]).toContain("2 of 7 invariants fired (1 high, 0 medium, 1 low)");
  expect(lines[1]).toContain("extended_at_car ×2");
  expect(lines[2]).toContain("prompted_more_than_twice ×4");
  const quiet = templateSummary({
    ...REPORT,
    findings: REPORT.findings.map((f) => ({ ...f, count: 0 })),
  });
  expect(quiet[0]).toContain("no invariant fired (7 checked)");
  expect(quiet).toHaveLength(5);
});

test("a grounded model summary is the report's, asked with the findings only and a strict schema, on the ledger with its cost", async () => {
  const t = makeApp();
  const { client, calls } = model({});
  const summary = await summarize(
    { db: t.deps.db, model: client, capUsd: 5, now: PARKED_AT },
    REPORT,
  );
  expect(summary).toEqual({ lines: GOOD_LINES, source: "model" });
  expect(calls[0]!.outputSchema).toEqual(SUMMARY_SCHEMA);
  expect(calls[0]!.tools).toBeUndefined();
  expect(JSON.parse(calls[0]!.messages[0]!.content as string)).toEqual(REPORT);
  expect(t.state.decisions.at(-1)).toMatchObject({
    kind: "audit_summary",
    rule: "model",
    userId: null,
    outcome: { source: "model", model: "claude-haiku-5-5", inputTokens: 900, outputTokens: 300 },
  });
  expect(
    (t.state.decisions.at(-1)!.outcome as { estimatedCostUsd: number }).estimatedCostUsd,
  ).toBeGreaterThan(0);
});

test("the template stands in for a model that is off, refuses, fails, or writes anything ungrounded", async () => {
  const cases: [string, Partial<ModelResponse> | (() => Promise<ModelResponse>) | null][] = [
    ["off", null],
    ["refused", { stopReason: "refusal", content: [] }],
    ["failed", () => Promise.reject(new Error("overloaded"))],
    [
      "ungrounded: the number 17",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              lines: GOOD_LINES.map((l, i) => (i === 3 ? "17 parks looked odd." : l)),
            }),
          },
        ],
      },
    ],
    [
      "ungrounded: a dollar amount",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              lines: GOOD_LINES.map((l, i) => (i === 4 ? "It cost $4.00." : l)),
            }),
          },
        ],
      },
    ],
    [
      "ungrounded: no mention of prompted_more_than_twice",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              lines: GOOD_LINES.map((l, i) => (i === 2 ? "One more fired." : l)),
            }),
          },
        ],
      },
    ],
    [
      "ungrounded: not five lines",
      { content: [{ type: "text", text: JSON.stringify({ lines: GOOD_LINES.slice(0, 3) }) }] },
    ],
    ["failed", { content: [{ type: "text", text: "not json" }] }],
  ];
  for (const [reason, reply] of cases) {
    const t = makeApp();
    const summary = await summarize(
      {
        db: t.deps.db,
        model: reply === null ? undefined : model(reply).client,
        capUsd: 5,
        now: PARKED_AT,
      },
      REPORT,
    );
    expect({ reason, source: summary.source }).toEqual({ reason, source: "template" });
    expect(summary.reason?.startsWith(reason.split(":")[0]!)).toBe(true);
    if (reason.startsWith("ungrounded")) expect(summary.reason).toBe(reason);
    expect(summary.lines).toEqual(templateSummary(REPORT));
    expect(t.state.decisions.at(-1)).toMatchObject({
      kind: "audit_summary",
      outcome: { source: "template" },
    });
  }
});

test("the summary's model is priced as Haiku 5.5, not as the Haiku 4.5 row", () => {
  expect(estimateCostUsd(AUDIT_MODEL, 1_000_000, 1_000_000)).toBeCloseTo(0.6);
  expect(estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(6);
});

test("over the daily budget, the model isn't asked", async () => {
  const t = makeApp();
  decision(t, { kind: "audit_summary", rule: "model", outcome: { estimatedCostUsd: 5 } });
  const { client, calls } = model({});
  const summary = await summarize(
    { db: t.deps.db, model: client, capUsd: 5, now: PARKED_AT },
    REPORT,
  );
  expect(summary).toMatchObject({ source: "template", reason: "over_budget" });
  expect(calls).toEqual([]);
});

test("the grounding check reads numbers, dollar amounts and the fired invariants", () => {
  expect(ungrounded(GOOD_LINES, REPORT)).toBeNull();
  // The descriptions' "30 minutes" and "3-minute" and the window's date
  // ground nothing: only the counts and their tallies do.
  for (const made of [
    "30 sessions went quiet.",
    "3 starts were slow.",
    "It was 2026.",
    "On the 05th.",
  ]) {
    expect(
      ungrounded(
        GOOD_LINES.map((l, i) => (i === 3 ? made : l)),
        REPORT,
      ),
    ).toMatch(/^the number /);
  }
  // A name with digits in it is not a number it says.
  const withName = GOOD_LINES.map((l, i) =>
    i === 3 ? "session_without_fix_30min stayed quiet." : l,
  );
  expect(ungrounded(withName, REPORT)).toBeNull();
  expect(
    ungrounded(
      GOOD_LINES.map((l) => l.replace("2 times", "12 times")),
      REPORT,
    ),
  ).toBe("the number 12");
});

// ------------------------------------------------------------ the route

test("GET /admin/audit: admin only, one New York day or the last 24 hours, findings and a summary", async () => {
  const t = makeApp();
  const get = (query: string, headers = U1) =>
    t.app.inject({ method: "GET", url: `/admin/audit${query}`, headers });
  expect((await get("", U2)).statusCode).toBe(403);
  expect((await get("?date=yesterday")).statusCode).toBe(400);

  decision(t, { kind: "street_prompt", rule: "walk_away", parkedEventId: "pe-x" });
  decision(t, { kind: "street_prompt", rule: "walk_away", parkedEventId: "pe-x" });
  decision(t, { kind: "street_prompt", rule: "walk_away", parkedEventId: "pe-x" });
  const res = await get("?date=2026-01-05");
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.window).toEqual({ from: "2026-01-05T05:00:00.000Z", to: "2026-01-06T05:00:00.000Z" });
  expect(body.findings).toHaveLength(INVARIANTS.length);
  expect(findingOf(body.findings, "prompted_more_than_twice")).toMatchObject({
    count: 1,
    examples: ["pe-x"],
  });
  expect(body.summary).toMatchObject({ source: "template", reason: "off" });
  expect(body.summary.lines).toHaveLength(5);
  // The day before has nothing.
  expect(
    findingOf((await get("?date=2026-01-04")).json().findings, "prompted_more_than_twice").count,
  ).toBe(0);
  // Without a date, the last 24 hours (the clock is the park's afternoon).
  t.tick(60);
  expect(findingOf((await get("")).json().findings, "prompted_more_than_twice").count).toBe(1);
  // It reads; the only row it writes is its own.
  expect(new Set(t.state.decisions.slice(3).map((d) => d.kind))).toEqual(
    new Set(["audit_summary"]),
  );
  expect(t.state.sessions).toEqual([]);
});
