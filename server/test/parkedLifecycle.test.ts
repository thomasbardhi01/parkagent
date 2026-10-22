/**
 * The street session lifecycle (FR-55), from /parked to the tap: nothing
 * is asked or paid while the phone is at the car; the walk-away (seen
 * through POST /location) is what asks; one tap on the quoted amount pays,
 * once; and a park that is over is never paid from again.
 *
 * One park at 30th Ave & Steinway ($2/$3, 120 min max): the default
 * 90-minute stay quotes $3.50 + $0.15.
 */

import { afterEach, expect, test, vi } from "vitest";

import type { PendingParkRow, ZoneTermsRow } from "../src/db.js";
import { makeExtender } from "../src/jobs/extendTick.js";
import { confirmedStartedWithoutLeftCar, loadAuditData } from "../src/services/audit/invariants.js";
import type { Executor, ExecutorResult } from "../src/services/executor.js";
import { DryRunExecutor } from "../src/services/executor.js";
import type { ParkStarter } from "../src/services/pendingSession.js";
import type { Quote } from "../src/services/quote.js";
import {
  LIFECYCLE_FIX_MAX_AGE_MS,
  START_DEADLINE_MS,
  STARTING_STALE_MS,
  mayBeAtTheDoor,
  startParkSession,
} from "../src/services/pendingSession.js";
import type { FakeDbState } from "./helpers.js";
import {
  API_KEY,
  HOURS_MON_SAT,
  MONDAY_2PM,
  MOTT_A,
  MOTT_B,
  NONADMIN_API_KEY,
  STEINWAY_A,
  makeTestApp,
  parkedBody,
  seedProviderAccount,
  seedSession,
  setFakeRowClock,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const OTHER = { "x-api-key": NONADMIN_API_KEY };
const PARKED_AT = new Date(MONDAY_2PM);
/** What a build that waits for the walk-away lists (ParkedRequest.outcomes). */
const OUTCOMES = ["garage", "nopay", "walk_away"];
const CAR = { lat: 40.7784, lng: -73.9819 };

const STEINWAY_ZONE: ZoneTermsRow = {
  zoneId: "nyc-417371",
  providerZoneNumber: "417371",
  street: "30th Ave",
  rateFirstHour: 2.0,
  rateAdditionalHour: 3.0,
  maxStayMinutes: 120,
  hoursJson: HOURS_MON_SAT,
};

type App = ReturnType<typeof makeTestApp>["app"];

/** What the driver had been shown for a park when its start ran. */
interface ShownAtStart {
  quote: Quote;
  dryRun: boolean;
}

/** Every app this file makes, for the check after each test. */
const apps: ReturnType<typeof makeApp>[] = [];

/** A test app whose clock the test moves, and an executor that counts. */
function makeApp(options: Parameters<typeof makeTestApp>[0] = {}) {
  const clock = { now: new Date(PARKED_AT) };
  const calls = { start: 0, stop: 0, extend: 0 };
  const dry = new DryRunExecutor(
    () => {},
    () => clock.now,
  );
  const counted: Executor = {
    startSession: (args) => {
      calls.start += 1;
      return dry.startSession(args);
    },
    extendSession: (args) => {
      calls.extend += 1;
      return dry.extendSession(args);
    },
    stopSession: (args) => {
      calls.stop += 1;
      return dry.stopSession(args);
    },
  };
  const { executor: given, ...rest } = options;
  const inner = given ?? counted;
  const shownAtStart: ShownAtStart[] = [];
  const executor: Executor = {
    startSession: (args) => {
      shownAtStart.push(shownFor(t.state));
      return inner.startSession(args);
    },
    extendSession: (args) => inner.extendSession(args),
    stopSession: (args) => inner.stopSession(args),
  };
  const t = makeTestApp({
    candidates: [STEINWAY_A],
    zones: [STEINWAY_ZONE],
    now: () => clock.now,
    executor,
    ...rest,
  });
  const tick = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  const made = { ...t, clock, calls, tick, shownAtStart };
  apps.push(made);
  return made;
}

/**
 * What the session being started was shown as, read when the executor is
 * asked: its park's quote and dry run, or (a build that doesn't wait for
 * the walk-away) what /parked answered.
 */
function shownFor(state: FakeDbState): ShownAtStart {
  const session = state.sessions.at(-1)!;
  const park = state.pendingParks.find(
    (p: PendingParkRow) => p.parkedEventId === session.parkedEventId,
  );
  if (park) return structuredClone({ quote: park.quote as Quote, dryRun: park.shownDryRun! });
  const parked = state.decisions.find(
    (d) => d.kind === "parked_quote" && d.parkedEventId === session.parkedEventId,
  )!;
  return structuredClone({
    quote: parked.outcome["quote"] as Quote,
    dryRun: parked.inputs["dryRun"] as boolean,
  });
}

// Every start, in every test here: the provider is asked for the zone
// number, the minutes and the amount the driver was shown, and through the
// dry-run executor exactly when the driver was told it is a dry run.
afterEach(() => setFakeRowClock(() => new Date(MONDAY_2PM)));

afterEach(() => {
  for (const t of apps.splice(0)) {
    const starts = t.executorCalls.filter((c) => c.op === "start");
    expect(starts).toHaveLength(t.shownAtStart.length);
    starts.forEach((call, i) => {
      const { quote, dryRun } = t.shownAtStart[i]!;
      expect(call).toEqual({
        op: "start",
        userId: "u1",
        city: "nyc",
        dryRun,
        zoneNumber: quote.providerZoneNumber,
        minutes: quote.stayMinutes,
        amountUsd: quote.meterUsd,
        feeUsd: quote.feeUsd,
      });
    });
  }
});

function post(app: App, url: string, body: unknown, headers = HEADERS) {
  return app.inject({ method: "POST", url, headers, payload: body as object });
}

async function park(app: App, overrides: Record<string, unknown> = {}, headers = HEADERS) {
  const res = await post(app, "/parked", parkedBody({ outcomes: OUTCOMES, ...overrides }), headers);
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown> & { parkedEventId: string };
}

/** A phone fix `distanceM` north of the car, stamped with the app's clock. */
function fix(t: { clock: { now: Date } }, distanceM: number, extra: Record<string, unknown> = {}) {
  return {
    lat: CAR.lat + distanceM / 111_320,
    lng: CAR.lng,
    accuracy: 8,
    ts: t.clock.now.toISOString(),
    ...extra,
  };
}

/** Two fixes clearly away from the car, 20 s apart: the phone has left. */
async function walkAway(t: ReturnType<typeof makeApp>, headers = HEADERS) {
  t.tick(40);
  await post(t.app, "/location", fix(t, 60), headers);
  t.tick(20);
  return post(t.app, "/location", fix(t, 90), headers);
}

/** The same, with the app's own on-foot report on the second fix: the only
 * thing that starts a Pay tapped at the car. */
async function walkOff(t: ReturnType<typeof makeApp>, headers = HEADERS) {
  t.tick(40);
  await post(t.app, "/location", fix(t, 60), headers);
  t.tick(20);
  return post(t.app, "/location", fix(t, 90, { event: "left_car" }), headers);
}

const kinds = (state: FakeDbState) => state.decisions.map((d) => d.kind);
const count = (state: FakeDbState, kind: string) => kinds(state).filter((k) => k === kind).length;
/** The rows for what moved a park without the phone or a tap. */
const lifecycleRows = (state: FakeDbState) =>
  state.decisions.filter((d) => d.kind === "park_lifecycle");

// ------------------------------------------------------------ at the car

test("a park with the phone still at the car: nothing asked, nothing started, a street_pending row", async () => {
  const t = makeApp();
  const parked = await park(t.app);

  expect(parked["action"]).toBe("pay");
  expect(parked["awaitsWalkAway"]).toBe(true);
  expect(t.state.pendingParks).toHaveLength(1);
  expect(t.state.pendingParks[0]).toMatchObject({
    userId: "u1",
    parkedEventId: parked.parkedEventId,
    status: "at_car",
    leftCarAt: null,
  });
  const pending = t.state.decisions.find((d) => d.kind === "street_pending")!;
  expect(pending.parkedEventId).toBe(parked.parkedEventId);
  expect((pending.outcome["quote"] as { totalUsd: number }).totalUsd).toBe(3.65);

  // The phone reports from the driver's seat for five minutes.
  for (let i = 0; i < 5; i += 1) {
    t.tick(60);
    const res = await post(t.app, "/location", fix(t, 4));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, park: { status: "at_car" } });
    expect(res.json()["prompt"]).toBeUndefined();
  }
  expect(t.pushes).toEqual([]);
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  expect(count(t.state, "street_prompt")).toBe(0);
});

test("a build that doesn't list walk_away is answered as before: no pending park", async () => {
  const t = makeApp();
  const parked = await park(t.app, { outcomes: ["garage", "nopay"] });
  expect(parked["action"]).toBe("pay");
  expect(parked["awaitsWalkAway"]).toBeUndefined();
  expect(t.state.pendingParks).toEqual([]);
  expect(count(t.state, "street_pending")).toBe(0);
  // …and its start goes straight through, as it always has.
  const started = await post(t.app, "/session/start", {
    parkedEventId: parked.parkedEventId,
    zoneId: "nyc-417371",
  });
  expect(started.statusCode).toBe(200);
});

test("a free period, or no zone, records no pending park", async () => {
  const t = makeApp({ candidates: [] });
  const none = await park(t.app);
  expect(none["action"]).toBe("unknown_zone");
  expect(none["awaitsWalkAway"]).toBeUndefined();
  expect(t.state.pendingParks).toEqual([]);
});

test("one fix away from the car is not a walk-away: GPS jumps, and it takes two", async () => {
  const t = makeApp();
  await park(t.app);
  t.tick(30);
  const jump = await post(t.app, "/location", fix(t, 120));
  expect(jump.json()).toMatchObject({ park: { status: "at_car" } });
  t.tick(20);
  // Back in the seat: the jump is forgotten.
  await post(t.app, "/location", fix(t, 3));
  t.tick(20);
  const again = await post(t.app, "/location", fix(t, 120));
  expect(again.json()).toMatchObject({ park: { status: "at_car" } });
  expect(again.json()["prompt"]).toBeUndefined();
  expect(count(t.state, "street_prompt")).toBe(0);
});

test("a blurry fix says nothing: far away by a fix that could be at the car is not a walk-away", async () => {
  const t = makeApp();
  await park(t.app);
  for (let i = 0; i < 3; i += 1) {
    t.tick(20);
    // 70 m out, give or take 60: the car is inside that circle.
    const res = await post(t.app, "/location", fix(t, 70, { accuracy: 60 }));
    expect(res.json()).toMatchObject({ park: { status: "at_car" } });
  }
  expect(count(t.state, "street_prompt")).toBe(0);
});

// ------------------------------------------------------------ walk-away

test("walk-away: exactly one confirm prompt, with the amount the server quoted", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  const left = await walkAway(t);

  expect(left.statusCode).toBe(200);
  const prompt = left.json()["prompt"] as Record<string, unknown>;
  expect(prompt).toMatchObject({
    kind: "confirm",
    parkedEventId: parked.parkedEventId,
    zoneId: "nyc-417371",
    zoneNumber: "417371",
    amountUsd: 3.65,
    minutes: 90,
    title: "Pay $3.65 for zone 417371?",
  });
  // 90 minutes from the walk-away, a minute after the car stopped.
  expect(prompt["body"]).toBe("1 h 30 m on 30th Ave · ends 3:31 PM · Dry run, nothing is charged");
  expect(left.json()).toMatchObject({ park: { status: "prompted" } });

  const asked = t.state.decisions.filter((d) => d.kind === "street_prompt");
  expect(asked).toHaveLength(1);
  expect(asked[0]!.rule).toBe("walk_away");
  expect(asked[0]!.parkedEventId).toBe(parked.parkedEventId);
  expect((asked[0]!.outcome["prompt"] as { amountUsd: number }).amountUsd).toBe(3.65);
  // The fixes that showed it, on the row.
  const fixes = asked[0]!.inputs["fix"] as { distanceM: number };
  expect(fixes.distanceM).toBeGreaterThan(80);

  // The phone keeps reporting (and a lost reply is asked for again): the
  // same prompt comes back, and nothing is asked a second time.
  for (let i = 0; i < 4; i += 1) {
    t.tick(15);
    const again = await post(t.app, "/location", fix(t, 120 + i * 20));
    expect(again.json()["prompt"]).toEqual(prompt);
  }
  expect(count(t.state, "street_prompt")).toBe(1);
  // Asking moved nothing.
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
});

test("the app's own left_car report is a walk-away too, unless its fix is at the car door", async () => {
  const t = makeApp();
  await park(t.app);
  t.tick(30);
  // On foot, but the fix is two metres from the car and sharp.
  const door = await post(t.app, "/location", fix(t, 2, { accuracy: 5, event: "left_car" }));
  expect(door.json()).toMatchObject({ park: { status: "at_car" } });
  t.tick(20);
  // On foot into the shop the car is parked in front of. (22 m with 8 m of
  // error clears the door; 18 m, as this once read, reaches within 10 m of
  // the car, refused now: #264.)
  const left = await post(t.app, "/location", fix(t, 22, { event: "left_car" }));
  expect(left.json()).toMatchObject({ park: { status: "prompted" } });
  expect((left.json()["prompt"] as { kind: string }).kind).toBe("confirm");
  expect(t.state.decisions.find((d) => d.kind === "street_prompt")!.rule).toBe("left_car_event");
});

test("a left_car on a blurry seat fix never starts a Pay tapped at the car; the app's next, clearer one does (#264)", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(t.state.pendingParks[0]!.status).toBe("confirmed");

  // In the seat between tall buildings: 35 m off, 35 m blurry. The phone
  // may be in the car, so the app's left_car on it is no walk-away.
  t.tick(30);
  const seat = await post(t.app, "/location", fix(t, 35, { accuracy: 35, event: "left_car" }));
  expect(seat.json()).toMatchObject({ park: { status: "confirmed" } });
  expect(t.state.pendingParks[0]!.leftCarAt).toBeNull();
  // Too blurry to place the phone at all is no walk-away either.
  t.tick(20);
  const lost = await post(t.app, "/location", fix(t, 300, { accuracy: 80, event: "left_car" }));
  expect(lost.json()).toMatchObject({ park: { status: "confirmed" } });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);

  // The app says it again with the next fix while the driver is still on
  // foot: 70 m off, 30 m blurry, so not within reach of the door.
  t.tick(20);
  const away = await post(t.app, "/location", fix(t, 70, { accuracy: 30, event: "left_car" }));
  expect(away.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
});

test("a short walk in an urban canyon starts a Pay tapped at the car: the walk said at the door is taken by the next fix off it (#264 review, R5)", async () => {
  const t = makeApp();
  // Decisions are stamped when they're made, as Postgres stamps them.
  setFakeRowClock(() => t.clock.now);
  const parked = await park(t.app);
  await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  // Walking 40 m to a door on the same block, every fix 40 m blurry: the
  // app's left_car rides each, and each may have the phone at the door.
  for (const d of [15, 30, 45]) {
    t.tick(15);
    await post(t.app, "/location", fix(t, d, { accuracy: 40, event: "left_car", speedMps: 1.3 }));
  }
  expect(t.state.pendingParks[0]).toMatchObject({ status: "confirmed", leftCarAt: null });
  expect(t.state.pendingParks[0]!.walkSaidAt).not.toBeNull();
  expect(t.calls.start).toBe(0);
  // Each is on the park's trace with why it didn't count.
  expect(t.state.parkFixes.map((f) => f.rejected)).toEqual([
    "may_be_at_door",
    "may_be_at_door",
    "may_be_at_door",
  ]);
  // Indoors and seated: motion still, so the app says no more; Wi-Fi fixes
  // 40 m ± 15 m, which no error reaches the door from.
  t.tick(60);
  const inside = await post(t.app, "/location", fix(t, 40, { accuracy: 15 }));
  expect(inside.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
  expect(t.state.pendingParks[0]!.walkSaidAt).toBeNull();
  // The nightly audit sees the left_car the start came from.
  const window = {
    from: new Date(t.clock.now.getTime() - 3_600_000),
    to: new Date(t.clock.now.getTime() + 60_000),
    now: t.clock.now,
  };
  expect(confirmedStartedWithoutLeftCar(await loadAuditData(t.deps.db, window))).toEqual([]);
});

test("a walk said at the door is forgotten back within reach of the car, or at driving speed", async () => {
  for (const [label, after] of [
    ["near", { distance: 20, accuracy: 8 }],
    ["driving", { distance: 60, accuracy: 10, speedMps: 9 }],
  ] as const) {
    const t = makeApp();
    const parked = await park(t.app);
    await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
    t.tick(30);
    await post(t.app, "/location", fix(t, 35, { accuracy: 35, event: "left_car" }));
    expect(t.state.pendingParks[0]!.walkSaidAt, label).not.toBeNull();
    t.tick(30);
    const { distance, ...rest } = after;
    await post(t.app, "/location", fix(t, distance, rest));
    expect(t.state.pendingParks[0]!.walkSaidAt, label).toBeNull();
    // A fix off the car with no word from the app now starts nothing.
    t.tick(30);
    await post(t.app, "/location", fix(t, 80, { accuracy: 15 }));
    expect(t.state.pendingParks[0]!.status, label).toBe("confirmed");
    expect(t.calls.start, label).toBe(0);
  }
});

test("a walk whose every fix is worse than 65 m never starts the Pay: no fix can show it (#264 review, R6, kept)", async () => {
  // The residual: a fix too blurry to read can't show the phone has left,
  // and a seat that pays is worse than a walk that waits. It starts once a
  // readable fix comes; until then the park stays confirmed.
  const t = makeApp();
  const parked = await park(t.app);
  await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  for (const d of [40, 120, 250, 400]) {
    t.tick(20);
    await post(t.app, "/location", fix(t, d, { accuracy: 80, event: "left_car", speedMps: 1.3 }));
  }
  expect(t.state.pendingParks[0]!.status).toBe("confirmed");
  expect(t.calls.start).toBe(0);
  t.tick(20);
  await post(t.app, "/location", fix(t, 420, { accuracy: 30 }));
  expect(t.calls.start).toBe(1);
});

test("after the walk-away, a left_car on a seat fix doesn't release the hold: a tap from the seat waits (#264 review, R1)", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  expect(t.state.pendingParks[0]!.status).toBe("prompted");
  // Back in the seat on sharp fixes: the hold is armed.
  t.tick(120);
  await post(t.app, "/location", fix(t, 5));
  t.tick(20);
  await post(t.app, "/location", fix(t, 4));
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  // In the car, GPS degrades, and a late walking reading sends left_car on
  // a 35 m ± 35 m seat fix: it may have the phone at the door.
  t.tick(30);
  await post(t.app, "/location", fix(t, 35, { accuracy: 35, event: "left_car" }));
  expect(t.state.pendingParks[0]!.backAt).not.toBeNull();
  t.tick(5);
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
  expect(t.calls.start).toBe(0);
});

test("no accuracy cliff at the door: 25 m ± 20 m and 25 m ± 21 m are both refused (#264 review, R3)", async () => {
  for (const accuracy of [20, 21]) {
    const t = makeApp();
    const parked = await park(t.app);
    await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
    t.tick(30);
    const r = await post(t.app, "/location", fix(t, 25, { accuracy, event: "left_car" }));
    expect(r.json(), `±${accuracy}`).toMatchObject({ park: { status: "confirmed" } });
    expect(t.calls.start, `±${accuracy}`).toBe(0);
  }
});

test("a left_car on a blurry fix within reach of the car asks nothing; one clear of the door asks", async () => {
  const t = makeApp();
  await park(t.app);
  t.tick(30);
  const seat = await post(t.app, "/location", fix(t, 30, { accuracy: 45, event: "left_car" }));
  expect(seat.json()).toMatchObject({ park: { status: "at_car" } });
  expect(seat.json()["prompt"]).toBeUndefined();
  t.tick(20);
  const left = await post(t.app, "/location", fix(t, 60, { accuracy: 45, event: "left_car" }));
  expect(left.json()).toMatchObject({ park: { status: "prompted" } });
  expect(t.state.decisions.find((d) => d.kind === "street_prompt")!.rule).toBe("left_car_event");
});

test.each([
  // [distance, accuracy, may be at the door]: its error reaches within
  // 10 m of the car, sharp or blurry alike, or it is too blurry to read.
  [10, 0, true],
  [11, 0, false],
  [30, 20, true], // the old sharp exception: refused now, as 30 m ± 21 m
  [31, 21, true],
  [32, 21, false],
  [35, 35, true], // the urban seat fix of #264
  [46, 35, false],
  [75, 65, true],
  [76, 65, false],
  [300, 66, true], // too blurry to read: never shows the phone has left
])("mayBeAtTheDoor(%i m, ±%i m) is %s", (distanceM, accuracyM, expected) => {
  expect(mayBeAtTheDoor({ distanceM, accuracyM })).toBe(expected);
});

test("candidates that disagree get the side question at walk-away, and Pay needs the side", async () => {
  const t = makeApp({ candidates: [MOTT_A, MOTT_B] });
  const parked = await park(t.app);
  expect(parked["action"]).toBe("confirm");
  expect(parked["awaitsWalkAway"]).toBe(true);
  expect(t.pushes).toEqual([]);

  const left = await walkAway(t);
  const prompt = left.json()["prompt"] as Record<string, unknown>;
  expect(prompt["kind"]).toBe("side");
  expect(prompt["title"]).toBe("Which side of the street?");
  expect(prompt["amountUsd"]).toBeUndefined();

  const blind = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(blind.statusCode).toBe(409);
  expect(blind.json()).toMatchObject({ error: "side_required" });
  const elsewhere = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {
    zoneId: "nyc-417371",
  });
  expect(elsewhere.statusCode).toBe(409);
  expect(elsewhere.json()).toMatchObject({ error: "zone_not_offered" });
  expect(t.calls.start).toBe(0);
});

test("what a tap can't pay is said at walk-away, not offered: no linked account", async () => {
  const t = makeApp({ seedLinkedProvider: false });
  const parked = await park(t.app);
  expect(t.pushes).toEqual([]);
  const left = await walkAway(t);
  const prompt = left.json()["prompt"] as Record<string, unknown>;
  expect(prompt).toMatchObject({ kind: "attention", reason: "provider_not_linked" });
  expect(String(prompt["body"])).toContain("Connect ParkNYC");

  // The tap is refused by the start path's own rule, and nothing ran.
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "provider_not_linked" });
  expect(t.calls.start).toBe(0);

  // Once linked, the same park is paid by the same tap.
  seedProviderAccount(t.state);
  const paid = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(paid.statusCode).toBe(200);
  expect(paid.json()).toMatchObject({ status: "started" });
  expect(t.calls.start).toBe(1);
});

test("over the caller's cap: the prompt says so and offers no Pay; the tap is refused", async () => {
  const t = makeApp({ policy: { session_cap_usd: 3 } });
  const parked = await park(t.app);
  const left = await walkAway(t);
  expect(left.json()["prompt"]).toMatchObject({
    kind: "attention",
    reason: "session_cap_exceeded",
  });
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "policy_violation", rule: "session_cap_exceeded" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
});

// ------------------------------------------------------------ the tap

test("Pay starts exactly one session, whatever is retried or raced", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  t.tick(10);

  const url = `/parked/${parked.parkedEventId}/confirm`;
  // Two taps at once (a double tap; a retry racing the first).
  const [a, b] = await Promise.all([post(t.app, url, {}), post(t.app, url, {})]);
  const statuses = [a.statusCode, b.statusCode].sort();
  expect(statuses[0]).toBe(200);
  expect([200, 409]).toContain(statuses[1]);
  const won = (a.statusCode === 200 ? a : b).json();
  expect(won).toMatchObject({ status: "started", amountUsd: 3.65 });

  // A retry after the fact answers with the same session.
  const retry = await post(t.app, url, {});
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toMatchObject({ status: "started", sessionId: won["sessionId"] });

  // …and the phone keeps posting fixes, some of them retried.
  for (let i = 0; i < 3; i += 1) {
    t.tick(15);
    const body = fix(t, 150 + i * 30);
    await post(t.app, "/location", body);
    await post(t.app, "/location", body);
  }

  expect(t.calls.start).toBe(1);
  expect(t.state.sessions).toHaveLength(1);
  expect(t.state.sessions[0]).toMatchObject({
    status: "active",
    dryRun: true,
    zoneId: "nyc-417371",
    parkedEventId: parked.parkedEventId,
    purchasedMinutes: 90,
  });
  expect(t.state.pendingParks[0]).toMatchObject({
    status: "started",
    sessionId: t.state.sessions[0]!.id,
  });

  // The ledger: one confirmation carrying the amount shown, one start.
  const confirmed = t.state.decisions.filter((d) => d.kind === "street_confirmed");
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]!.inputs).toMatchObject({ mode: "tap", dryRun: true });
  expect((confirmed[0]!.inputs["shown"] as { totalUsd: number }).totalUsd).toBe(3.65);
  expect(t.state.decisions.filter((d) => d.rule === "start_ok")).toHaveLength(1);
  const walkaway = t.state.decisions.filter((d) => d.kind === "session_start_walkaway");
  expect(walkaway).toHaveLength(1);
  expect(walkaway[0]!.sessionId).toBe(t.state.sessions[0]!.id);
  expect((walkaway[0]!.inputs["leftCar"] as { at: string }).at).toBeTruthy();

  // The provider was asked once, through the dry-run executor, for the
  // zone and the amount the driver was shown: $3.50 + $0.15 = $3.65.
  expect(t.executorCalls).toEqual([
    {
      op: "start",
      userId: "u1",
      city: "nyc",
      dryRun: true,
      zoneNumber: "417371",
      minutes: 90,
      amountUsd: 3.5,
      feeUsd: 0.15,
    },
  ]);
});

test("Not now pays nothing, and the phone is told to stop reporting", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);

  const declined = await post(t.app, `/parked/${parked.parkedEventId}/decline`, {});
  expect(declined.statusCode).toBe(200);
  expect(declined.json()).toMatchObject({ status: "declined" });
  expect(t.state.pendingParks[0]!.status).toBe("declined");
  expect(t.state.decisions.at(-1)).toMatchObject({ kind: "street_declined", rule: "not_now" });
  // Twice is once.
  await post(t.app, `/parked/${parked.parkedEventId}/decline`, {});
  expect(count(t.state, "street_declined")).toBe(1);

  t.tick(30);
  const after = await post(t.app, "/location", fix(t, 200));
  expect(after.statusCode).toBe(409);
  expect(after.json()).toEqual({ error: "no_active_session" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  expect(t.pushes).toEqual([]);
});

test("Pay tapped before walk-away confirms early; the session starts only once the phone leaves", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  const url = `/parked/${parked.parkedEventId}/confirm`;

  const early = await post(t.app, url, {});
  expect(early.statusCode).toBe(200);
  expect(early.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
  expect(t.state.pendingParks[0]!.status).toBe("confirmed");
  expect(t.calls.start).toBe(0);
  // A second tap is the same confirmation.
  await post(t.app, url, {});
  expect(count(t.state, "street_confirmed")).toBe(1);
  expect(t.state.decisions.find((d) => d.kind === "street_confirmed")!.inputs).toMatchObject({
    mode: "tap",
    early: true,
  });

  // Ten minutes in the driver's seat: still nothing.
  for (let i = 0; i < 10; i += 1) {
    t.tick(60);
    await post(t.app, "/location", fix(t, 5));
  }
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);

  const left = await walkOff(t);
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  expect(left.json()["started"]).toMatchObject({ amountUsd: 3.65 });
  // No tap is asked for: it was already given.
  expect(left.json()["prompt"]).toBeUndefined();
  expect(count(t.state, "street_prompt")).toBe(0);
  expect(t.calls.start).toBe(1);

  // Retried fixes after it don't start a second.
  t.tick(15);
  await post(t.app, "/location", fix(t, 140));
  await post(t.app, "/location", fix(t, 140));
  expect(t.calls.start).toBe(1);
  expect(t.state.sessions).toHaveLength(1);
  const walkaway = t.state.decisions.filter((d) => d.kind === "session_start_walkaway");
  expect(walkaway).toHaveLength(1);
});

test("Pay tapped back at the car pays nothing there: the start waits for the next walk-away", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // Back to the car to fetch something, and the prompt is tapped from the seat.
  t.tick(30);
  await post(t.app, "/location", fix(t, 6));
  t.tick(20);
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(200);
  expect(tap.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
  expect(t.calls.start).toBe(0);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "confirmed", leftCarAt: null });

  // Sitting there changes nothing, and is no "return" that cancels it.
  t.tick(90);
  const seat = await post(t.app, "/location", fix(t, 4));
  expect(seat.json()).toMatchObject({ park: { status: "confirmed" } });
  expect(t.calls.start).toBe(0);

  const left = await walkOff(t);
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
  expect(t.state.sessions).toHaveLength(1);
});

test("the tap pays what was shown or nothing: a start that would cost more asks again", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // The operator's fee went up between the prompt and the tap.
  t.deps.policy.update({
    ...t.deps.policy.get(),
    city_overrides: { nyc: { parking_fee_usd: 0.5, ticket_cost_usd: 65 } },
  });

  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "quote_changed" });
  expect((tap.json()["prompt"] as { amountUsd: number }).amountUsd).toBe(4);
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  expect(t.state.pendingParks[0]!.status).toBe("prompted");

  // The new amount, tapped, pays the new amount.
  const again = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({ status: "started", amountUsd: 4 });
  expect(t.calls.start).toBe(1);
});

test("the phone's own on-screen total binds too: less than the server would charge pays nothing", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // An older prompt was on screen: $3.40, where the stay now costs $3.65.
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, { shownTotalUsd: 3.4 });
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "quote_changed" });
  expect((tap.json()["prompt"] as { amountUsd: number }).amountUsd).toBe(3.65);
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  // More than the server quoted never raises what is paid.
  const over = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, { shownTotalUsd: 9 });
  expect(over.statusCode).toBe(200);
  expect(over.json()).toMatchObject({ status: "started", amountUsd: 3.65 });
});

test("a receipt above the amount the tap was shown is never recorded above it (the receipt bound)", async () => {
  const dry = new DryRunExecutor(
    () => {},
    () => PARKED_AT,
  );
  // The provider reads back $3.80, $0.15 over the $3.65 prompt: within the
  // $0.25 bound, trimmed to what the driver agreed to, flagged for review,
  // and the $0.15 counted by the caps.
  const receipt = { meterUsd: 3.65, feeUsd: 0.15, totalUsd: 3.8 };
  const t = makeApp({
    executor: {
      startSession: async (args) => ({ ...(await dry.startSession(args)), receipt }),
      extendSession: (args) => dry.extendSession(args),
      stopSession: (args) => dry.stopSession(args),
    },
  });
  const parked = await park(t.app);
  await walkAway(t);
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(200);
  expect(tap.json()).toMatchObject({ status: "started", amountUsd: 3.65, needsReview: true });
  const session = t.state.sessions.at(-1)!;
  expect(Number(session.amountUsd) + Number(session.feeUsd)).toBe(3.65);
  expect(Number(session.feeUsd)).toBe(0.15);
  expect(session.needsReview).toBe(true);
  expect(Number(session.receiptExcessUsd)).toBe(0.15);
  const start = t.state.decisions.find((d) => d.kind === "session_start")!;
  expect(start.rule).toBe("receipt_mismatch");
  expect(start.inputs).toMatchObject({
    providerReceipt: receipt,
    receiptBound: { shownTotalUsd: 3.65, boundUsd: 0.25 },
  });
  expect(start.outcome).toMatchObject({ recordedTotalUsd: 3.65, receiptExcessUsd: 0.15 });
  // A retried tap answers the same session, and says the same.
  const again = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(again.json()).toMatchObject({ status: "started", amountUsd: 3.65, needsReview: true });
  expect(t.executorCalls.filter((c) => c.op === "start")).toHaveLength(1);
});

test("a start that reached the provider and failed closes the park: no second attempt from it", async () => {
  const failing: Executor = {
    startSession: async (): Promise<ExecutorResult> => ({
      ok: false,
      code: "ui_changed",
      message: "pay button not found",
      afterPayClick: true,
    }),
    extendSession: async () => {
      throw new Error("not in this test");
    },
    stopSession: async () => {
      throw new Error("not in this test");
    },
  };
  const t = makeApp({ executor: failing });
  const parked = await park(t.app);
  await walkAway(t);

  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(502);
  expect(t.state.pendingParks[0]!.status).toBe("start_failed");
  expect(t.state.sessions).toHaveLength(1);
  expect(t.state.sessions[0]!.status).toBe("failed");

  // Whether that charged is unknown: this park is not paid from again.
  const again = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(again.statusCode).toBe(409);
  expect(again.json()).toMatchObject({ error: "park_closed", status: "start_failed" });
  expect(t.state.sessions).toHaveLength(1);
});

test("POST /session/start can't go around the lifecycle: a waiting park is paid only through its tap", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  const direct = await post(t.app, "/session/start", {
    parkedEventId: parked.parkedEventId,
    zoneId: "nyc-417371",
  });
  expect(direct.statusCode).toBe(409);
  expect(direct.json()).toMatchObject({ error: "park_awaits_walk_away" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  expect(t.state.decisions.at(-1)).toMatchObject({
    kind: "session_start",
    rule: "park_awaits_walk_away",
  });
});

test("…and a park that is over is never paid through it: declined, expired, superseded, cancelled", async () => {
  type T = ReturnType<typeof makeApp>;
  const closers: Record<string, (t: T, parkedEventId: string) => Promise<unknown>> = {
    declined: (t, id) => post(t.app, `/parked/${id}/decline`, {}),
    // Nobody walked away within the hour: closed by the start's own read.
    expired: async (t) => t.tick(61 * 60),
    superseded: async (t) => {
      t.tick(300);
      return park(t.app, { lat: CAR.lat + 0.01, ts: t.clock.now.toISOString() });
    },
    cancelled: async (t) => {
      t.tick(90);
      return post(t.app, "/location", fix(t, 6, { event: "returned_to_car" }));
    },
  };
  for (const [status, close] of Object.entries(closers)) {
    const t = makeApp();
    const parked = await park(t.app);
    await close(t, parked.parkedEventId);

    const direct = await post(t.app, "/session/start", {
      parkedEventId: parked.parkedEventId,
      zoneId: "nyc-417371",
    });
    expect(direct.statusCode, status).toBe(409);
    expect(direct.json(), status).toMatchObject({ error: "park_closed", parkStatus: status });
    expect(t.state.pendingParks[0]!.status, status).toBe(status);
    expect(t.calls.start, status).toBe(0);
    expect(t.state.sessions, status).toEqual([]);
    expect(t.state.decisions.at(-1), status).toMatchObject({
      kind: "session_start",
      rule: "park_closed",
    });
  }
});

test("a session for a park that is over doesn't reopen it: the closed park stays closed", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await post(t.app, `/parked/${parked.parkedEventId}/decline`, {});
  // A session for it all the same (made before /session/start refused
  // closed parks): its fixes are stored, and the declined park stays so.
  const session = seedSession(t.state, {
    status: "active",
    parkedEventId: parked.parkedEventId,
    carLat: CAR.lat,
    carLng: CAR.lng,
    startedAt: t.clock.now,
    expiresAt: new Date(t.clock.now.getTime() + 90 * 60_000),
  });
  t.tick(30);
  const res = await post(t.app, "/location", fix(t, 200));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ sessionId: session.id });
  expect(t.state.pendingParks).toHaveLength(1);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "declined", sessionId: null });
});

// ------------------------------------------------------------ whose car

test("someone else's park is not mine to confirm, decline, or walk away from", async () => {
  const t = makeApp();
  const mine = await park(t.app);

  const confirm = await post(t.app, `/parked/${mine.parkedEventId}/confirm`, {}, OTHER);
  expect(confirm.statusCode).toBe(404);
  const decline = await post(t.app, `/parked/${mine.parkedEventId}/decline`, {}, OTHER);
  expect(decline.statusCode).toBe(404);

  // The other user walks a long way from where my car is.
  t.tick(60);
  const theirs = await post(t.app, "/location", fix(t, 400), OTHER);
  expect(theirs.statusCode).toBe(409);
  t.tick(20);
  await post(t.app, "/location", fix(t, 500), OTHER);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "at_car", leftCarAt: null });
  expect(count(t.state, "street_prompt")).toBe(0);
});

test("a fix from before the car stopped, or a stale one, is no walk-away", async () => {
  const t = makeApp();
  await park(t.app);
  t.tick(120);
  const before = new Date(PARKED_AT.getTime() - 30_000).toISOString();
  await post(t.app, "/location", fix(t, 300, { ts: before }));
  await post(t.app, "/location", fix(t, 320, { ts: before }));
  expect(t.state.pendingParks[0]!.status).toBe("at_car");

  // Twenty minutes later the phone delivers two fixes it took long ago.
  const old = new Date(t.clock.now.getTime() + 10_000).toISOString();
  const older = new Date(t.clock.now.getTime() + 40_000).toISOString();
  t.tick(20 * 60);
  await post(t.app, "/location", fix(t, 300, { ts: old }));
  await post(t.app, "/location", fix(t, 320, { ts: older }));
  expect(t.state.pendingParks[0]!.status).toBe("at_car");
  expect(count(t.state, "street_prompt")).toBe(0);
});

test("the walk-away is measured from the newest park's car: an older park is superseded, never paid", async () => {
  const t = makeApp();
  const first = await park(t.app);
  // Confirmed early at the first spot, then the car moved on.
  await post(t.app, `/parked/${first.parkedEventId}/confirm`, {});
  t.tick(300);
  const second = await park(t.app, {
    lat: CAR.lat + 0.01,
    ts: t.clock.now.toISOString(),
  });

  expect(t.state.pendingParks.map((p) => p.status)).toEqual(["superseded", "at_car"]);
  expect(lifecycleRows(t.state)).toEqual([
    expect.objectContaining({
      rule: "newer_park",
      parkedEventId: first.parkedEventId,
      inputs: expect.objectContaining({
        previousStatus: "confirmed",
        newerParkedEventId: second.parkedEventId,
      }),
      outcome: { status: "superseded" },
    }),
  ]);
  // A kilometre from the first spot is the driver's seat at the second.
  t.tick(30);
  const atSecond = { ...fix(t, 0), lat: CAR.lat + 0.01 };
  await post(t.app, "/location", atSecond);
  t.tick(20);
  const still = await post(t.app, "/location", atSecond);
  expect(still.json()).toMatchObject({
    park: { parkedEventId: second.parkedEventId, status: "at_car" },
  });
  // The first park's confirmation died with it.
  expect(t.calls.start).toBe(0);
  const stale = await post(t.app, `/parked/${first.parkedEventId}/confirm`, {});
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: "park_closed", status: "superseded" });
  expect(t.calls.start).toBe(0);
});

test("a park nobody walked away from within the hour is not asked about", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  t.tick(61 * 60);
  // Said once, so the app can tell the driver; then there is nothing left
  // to report to.
  const late = await post(t.app, "/location", fix(t, 200));
  expect(late.statusCode).toBe(200);
  expect(late.json()).toMatchObject({ park: { status: "expired" } });
  expect(late.json()["prompt"]).toBeUndefined();
  expect((await post(t.app, "/location", fix(t, 220))).statusCode).toBe(409);
  expect(t.state.pendingParks[0]!.status).toBe("expired");
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "park_closed", status: "expired" });
  expect(t.calls.start).toBe(0);
  // Closed by the clock, once, and on the ledger.
  expect(lifecycleRows(t.state)).toHaveLength(1);
  expect(lifecycleRows(t.state)[0]).toMatchObject({
    rule: "ttl_expired",
    parkedEventId: parked.parkedEventId,
    inputs: { previousStatus: "at_car" },
    outcome: { status: "expired" },
  });
});

// ------------------------------------------------------------ before paying

test("back at the car before anything was paid: the pending park is cancelled", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  expect(t.state.pendingParks[0]!.status).toBe("prompted");

  // Back within 30 m, and still there a minute later.
  t.tick(30);
  const back = await post(t.app, "/location", fix(t, 12));
  expect(back.json()).toMatchObject({ park: { status: "prompted" } });
  t.tick(61);
  const stayed = await post(t.app, "/location", fix(t, 6));
  expect(stayed.statusCode).toBe(200);
  expect(stayed.json()).toMatchObject({ park: { status: "cancelled" } });

  const row = t.state.decisions.find((d) => d.kind === "park_cancelled_at_return")!;
  expect(row.rule).toBe("near_for_60s");
  expect(row.parkedEventId).toBe(parked.parkedEventId);
  expect((row.inputs["fix"] as { distanceM: number }).distanceM).toBeLessThan(30);

  // The old prompt's Pay button is dead.
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "park_closed", status: "cancelled" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
});

test("walking past the car is not a return: under a minute within 30 m changes nothing", async () => {
  const t = makeApp();
  await park(t.app);
  await walkAway(t);
  t.tick(30);
  await post(t.app, "/location", fix(t, 10));
  t.tick(40);
  const past = await post(t.app, "/location", fix(t, 80));
  expect(past.json()).toMatchObject({ park: { status: "prompted" } });
  t.tick(40);
  // Near again: the minute starts over.
  const near = await post(t.app, "/location", fix(t, 10));
  expect(near.json()).toMatchObject({ park: { status: "prompted" } });
  expect(count(t.state, "park_cancelled_at_return")).toBe(0);
});

/** Back at the car on fixes within 30 m but 40 m blurry, as urban returns are. */
async function blurryReturn(t: ReturnType<typeof makeApp>) {
  t.tick(120);
  await post(t.app, "/location", { ...fix(t, 10), accuracy: 40 });
  t.tick(30);
  await post(t.app, "/location", { ...fix(t, 8), accuracy: 40 });
}

test("a tap from the seat on blurry fixes waits for the walk-away, as one on sharp fixes does", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  await blurryReturn(t);
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(200);
  expect(tap.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
  expect(t.calls.start).toBe(0);
});

test("a tap from the seat waits even after a fix a little past 30 m: the phone was back at the car, and nothing since says it left", async () => {
  // 40 m with 30 m of error (usable, neither at the car nor clear of it),
  // and a sharp 35 m: the GPS wobble of a phone in the seat.
  for (const [metres, accuracy] of [
    [40, 30],
    [35, 8],
  ] as const) {
    const t = makeApp();
    const parked = await park(t.app);
    await walkAway(t);
    t.tick(120);
    await post(t.app, "/location", { ...fix(t, 10), accuracy: 40 });
    t.tick(20);
    await post(t.app, "/location", { ...fix(t, metres), accuracy });
    expect(t.state.pendingParks[0]!.nearSince).toBeNull();
    const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
    expect(tap.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
    expect(t.calls.start).toBe(0);
    // The walk starts over: a stale "back at the car" doesn't ride along.
    expect(t.state.pendingParks[0]).toMatchObject({
      status: "confirmed",
      leftCarAt: null,
      backAt: null,
      atCarSince: null,
    });
    expect(t.state.decisions.find((d) => d.kind === "street_confirmed")!.inputs["backAt"]).toEqual(
      expect.any(String),
    );
  }
});

test("a tap from the seat waits after a left_car that was never clear of the car", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  // On foot at 40 m with 25 m of error: left (its error stops 15 m short of
  // the car, past the door), with no fix clear of the car. (At 20 m with
  // 25 m of error, as this once read, the phone may be in the seat, and
  // that left_car is refused now: #264.)
  t.tick(30);
  await post(t.app, "/location", { ...fix(t, 40), accuracy: 25, event: "left_car" });
  expect(t.state.pendingParks[0]).toMatchObject({ status: "prompted", farAt: null });
  // Back to the car on sharp fixes, and Pay from the seat.
  t.tick(30);
  await post(t.app, "/location", fix(t, 5));
  t.tick(20);
  await post(t.app, "/location", fix(t, 4));
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });
  expect(t.calls.start).toBe(0);
});

test("back at the car on blurry fixes, then a drive-off by pace: the unpaid park closes, and the tap at the next light pays nothing", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  await blurryReturn(t);
  t.tick(15);
  await post(t.app, "/location", fix(t, 120));
  t.tick(12);
  const gone = await post(t.app, "/location", fix(t, 280));
  expect(gone.json()).toMatchObject({ park: { status: "cancelled", readBy: "pace" } });
  t.tick(20);
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "park_closed", status: "cancelled" });
  expect(t.calls.start).toBe(0);
});

test("a drive-off read from pace alone closes an unpaid park: the Pay tapped at the next light pays nothing", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // Never answered. Back in the seat, then pulling out: 160 m in 12 s,
  // with no speed to say it was a car.
  t.tick(30);
  await post(t.app, "/location", fix(t, 8));
  t.tick(15);
  await post(t.app, "/location", fix(t, 120));
  t.tick(12);
  const gone = await post(t.app, "/location", fix(t, 280));
  // A guess, and said to be one: the phone tells the driver nothing will
  // be paid here, rather than dropping the prompt in silence.
  expect(gone.json()).toMatchObject({ park: { status: "cancelled", readBy: "pace" } });
  expect(gone.json()["prompt"]).toBeUndefined();
  expect(t.state.decisions.filter((d) => d.kind === "park_cancelled_at_return")).toEqual([
    expect.objectContaining({
      rule: "drove_off",
      parkedEventId: parked.parkedEventId,
      outcome: { status: "cancelled", paid: false, readBy: "pace" },
    }),
  ]);

  // The prompt still on the lock screen is tapped at a light.
  t.tick(20);
  const tap = await post(t.app, `/parked/${parked.parkedEventId}/confirm`, {});
  expect(tap.statusCode).toBe(409);
  expect(tap.json()).toMatchObject({ error: "park_closed", status: "cancelled" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
});

test("driving off without ever leaving the car cancels the pending park", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  t.tick(90);
  const drove = await post(t.app, "/location", fix(t, 6, { event: "returned_to_car" }));
  expect(drove.json()).toMatchObject({ park: { status: "cancelled" } });
  expect(t.state.decisions.at(-1)).toMatchObject({
    kind: "park_cancelled_at_return",
    rule: "drove_off",
    parkedEventId: parked.parkedEventId,
  });
});

test("after a return, the next park is a fresh one: new quote, new tap, nothing carried over", async () => {
  const t = makeApp();
  const first = await park(t.app);
  await walkAway(t);
  t.tick(30);
  await post(t.app, "/location", fix(t, 8));
  t.tick(61);
  await post(t.app, "/location", fix(t, 8));
  expect(t.state.pendingParks[0]!.status).toBe("cancelled");

  t.tick(600);
  const second = await park(t.app, { ts: t.clock.now.toISOString() });
  expect(second.parkedEventId).not.toBe(first.parkedEventId);
  expect(second["awaitsWalkAway"]).toBe(true);
  expect(t.state.pendingParks.map((p) => p.status)).toEqual(["cancelled", "at_car"]);
  expect(t.state.pendingParks[1]!.leftCarAt).toBeNull();
  expect(count(t.state, "street_pending")).toBe(2);

  // The first park's walk-away doesn't count for the second: still at the car.
  t.tick(30);
  const seat = await post(t.app, "/location", fix(t, 4));
  expect(seat.json()).toMatchObject({
    park: { parkedEventId: second.parkedEventId, status: "at_car" },
  });
  expect(seat.json()["prompt"]).toBeUndefined();

  const left = await walkAway(t);
  const prompt = left.json()["prompt"] as { parkedEventId: string; kind: string };
  expect(prompt).toMatchObject({ kind: "confirm", parkedEventId: second.parkedEventId });
  expect(count(t.state, "street_prompt")).toBe(2);
  expect(t.calls.start).toBe(0);
});

// ------------------------------------------------------------ the car moved, or didn't walk

const tap = (t: ReturnType<typeof makeApp>, parkedEventId: string, body: object = {}) =>
  post(t.app, `/parked/${parkedEventId}/confirm`, body);

test("driving off after an early Pay is not a walk-away: the same ground, too fast for someone on foot", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);

  // 10 m/s down the block, a fix every 15 s, ahead of the app noticing.
  for (const metres of [60, 210, 360, 510]) {
    t.tick(15);
    const res = await post(t.app, "/location", fix(t, metres));
    expect(res.json()).toMatchObject({ park: { status: "confirmed" } });
  }
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);

  // Then the phone says so: the park is over, unpaid.
  t.tick(5);
  const driving = await post(t.app, "/location", fix(t, 560, { event: "returned_to_car" }));
  expect(driving.json()).toMatchObject({ park: { status: "cancelled" } });
  expect(t.calls.start).toBe(0);
});

test("an early Pay is never paid by distance alone: a red light a block away asks, and pays nothing", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);

  // Pulls away (60 m, then 210 m 15 s later), then sits at a light: two
  // fixes 20 s apart at nearly the same distance read like a walk.
  t.tick(15);
  await post(t.app, "/location", fix(t, 60));
  t.tick(15);
  await post(t.app, "/location", fix(t, 210));
  t.tick(20);
  const light = await post(t.app, "/location", fix(t, 214));
  // At most a prompt: a second tap is what would pay.
  expect(light.json()).toMatchObject({
    park: { parkedEventId: parked.parkedEventId, status: "prompted" },
    prompt: { kind: "confirm", amountUsd: 3.65 },
  });
  expect(light.json()["started"]).toBeUndefined();
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  expect(t.state.decisions.filter((d) => d.kind === "street_prompt")).toEqual([
    expect.objectContaining({
      rule: "walk_away",
      inputs: expect.objectContaining({ parkStatus: "confirmed" }),
    }),
  ]);

  // Green: driving on pays nothing either.
  for (const metres of [380, 560]) {
    t.tick(15);
    await post(t.app, "/location", fix(t, metres));
  }
  expect(t.calls.start).toBe(0);
  expect(count(t.state, "session_start_walkaway")).toBe(0);
});

test("an early Pay starts on the app's on-foot report, even on the fix that also finishes a pair", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);
  t.tick(40);
  await post(t.app, "/location", fix(t, 60));
  t.tick(20);
  // 30 m in 20 s is a walk-away by distance too; the app's word is what counts.
  const left = await post(t.app, "/location", fix(t, 90, { event: "left_car" }));
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
  expect(count(t.state, "street_prompt")).toBe(0);
  expect(t.state.decisions.find((d) => d.kind === "session_start_walkaway")).toMatchObject({
    rule: "started",
    inputs: expect.objectContaining({ fix: expect.objectContaining({ event: "left_car" }) }),
  });
});

test("a fix at driving speed never counts toward leaving, and starts the pair over", async () => {
  const t = makeApp();
  await park(t.app);
  t.tick(20);
  await post(t.app, "/location", fix(t, 60, { speedMps: 0.8 }));
  // Circling the block for a spot: about the same distance, at 12 m/s.
  t.tick(20);
  const circling = await post(t.app, "/location", fix(t, 70, { speedMps: 12 }));
  expect(circling.json()).toMatchObject({ park: { status: "at_car" } });
  expect(t.state.pendingParks[0]).toMatchObject({ farAt: null, leftCarAt: null });
  // …and neither does the app's on-foot report riding on one.
  t.tick(5);
  await post(t.app, "/location", fix(t, 75, { speedMps: 11, event: "left_car" }));
  expect(t.state.pendingParks[0]).toMatchObject({ status: "at_car", leftCarAt: null });

  // Out of the car: two fixes at a walk are a walk-away again.
  t.tick(20);
  await post(t.app, "/location", fix(t, 80, { speedMps: 1.2 }));
  t.tick(20);
  const walking = await post(t.app, "/location", fix(t, 105, { speedMps: 1.3 }));
  expect(walking.json()).toMatchObject({ park: { status: "prompted" } });
  // A phone that gives no speed (null, or iOS's -1) is read by pace, as before.
  expect((await post(t.app, "/location", fix(t, 110, { speedMps: null }))).statusCode).toBe(200);
  expect((await post(t.app, "/location", fix(t, 110, { speedMps: -1 }))).statusCode).toBe(200);
});

test("a measurement older than five minutes is not read, however freshly it is reported", async () => {
  const t = makeApp();
  await park(t.app);
  const measured = (secondsAfterPark: number) =>
    new Date(PARKED_AT.getTime() + secondsAfterPark * 1000).toISOString();
  // Six minutes on, the outbox delivers two measurements from the first minute.
  t.tick(6 * 60);
  await post(t.app, "/location", fix(t, 60, { measuredAt: measured(30) }));
  t.tick(1);
  const late = await post(t.app, "/location", fix(t, 90, { measuredAt: measured(50) }));
  expect(late.json()).toMatchObject({ park: { status: "at_car" } });
  expect(t.state.pendingParks[0]).toMatchObject({ farAt: null, leftCarAt: null });
  expect(count(t.state, "street_prompt")).toBe(0);
});

test("…and a driver who rode off and then walks is still seen leaving, at a walk", async () => {
  const t = makeApp();
  await park(t.app);
  t.tick(15);
  await post(t.app, "/location", fix(t, 60));
  t.tick(15);
  const riding = await post(t.app, "/location", fix(t, 260));
  expect(riding.json()).toMatchObject({ park: { status: "at_car" } });
  // Off the bus: 25 m in 18 s.
  t.tick(18);
  const walking = await post(t.app, "/location", fix(t, 285));
  expect(walking.json()).toMatchObject({ park: { status: "prompted" } });
});

test("one GPS jump sent twice is one fix: the heartbeat's re-send is not a walk-away", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);
  t.tick(30);
  const measuredAt = t.clock.now.toISOString();
  const jump = fix(t, 120, { measuredAt });
  await post(t.app, "/location", jump);
  // No new fix for a minute, so the app says "still there" with the old one.
  for (let i = 0; i < 3; i += 1) {
    t.tick(60);
    const again = await post(t.app, "/location", { ...jump, ts: t.clock.now.toISOString() });
    expect(again.json()).toMatchObject({ park: { status: "confirmed" } });
  }
  // The same from a client that doesn't say when it measured.
  t.tick(60);
  const bare = { ...fix(t, 120) };
  await post(t.app, "/location", bare);
  t.tick(60);
  await post(t.app, "/location", { ...bare, ts: t.clock.now.toISOString() });
  expect(t.state.pendingParks[0]).toMatchObject({ status: "confirmed", leftCarAt: null });
  expect(t.calls.start).toBe(0);
});

test("a later park of any kind ends an earlier park's confirmation: leaving the garage pays no meter", async () => {
  const t = makeApp();
  const first = await park(t.app);
  await tap(t, first.parkedEventId);
  expect(t.state.pendingParks[0]!.status).toBe("confirmed");

  // The car moved on to somewhere with nothing to hold (no meter here).
  t.tick(300);
  t.deps.findCandidates = async () => [];
  const second = await park(t.app, { lat: CAR.lat + 0.01, ts: t.clock.now.toISOString() });
  expect(second["action"]).toBe("unknown_zone");
  expect(second["awaitsWalkAway"]).toBeUndefined();
  expect(t.state.pendingParks.map((p) => p.status)).toEqual(["superseded"]);

  // Walking away from the new place is a kilometre from the old meter.
  for (const metres of [1170, 1195, 1220]) {
    t.tick(20);
    const res = await post(t.app, "/location", fix(t, metres));
    expect(res.statusCode).toBe(409);
  }
  expect(t.calls.start).toBe(0);
  expect((await tap(t, first.parkedEventId)).json()).toMatchObject({
    error: "park_closed",
    status: "superseded",
  });
});

test("a park delivered late, from before one the server already has, neither waits nor takes its place", async () => {
  const t = makeApp();
  const current = await park(t.app);
  await tap(t, current.parkedEventId);
  // The phone's outbox delivers a park from two hours ago, somewhere else.
  const old = await park(t.app, {
    lat: CAR.lat + 0.01,
    ts: new Date(PARKED_AT.getTime() - 2 * 60 * 60_000).toISOString(),
  });
  expect(old["awaitsWalkAway"]).toBeUndefined();
  expect(t.state.pendingParks).toHaveLength(1);
  expect(t.state.pendingParks[0]).toMatchObject({
    parkedEventId: current.parkedEventId,
    status: "confirmed",
  });
  // The current park still starts at its own walk-away.
  const left = await walkOff(t);
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
});

test("two parks never wait at once: the older of two open ones is closed by the next fix", async () => {
  const t = makeApp();
  const first = await park(t.app);
  // A second row slipped in beside it (two detections racing).
  const second = { ...t.state.pendingParks[0]!, id: "pp-race", parkedEventId: "pe-race" };
  t.state.pendingParks.push(second);
  t.tick(30);
  await post(t.app, "/location", fix(t, 4));
  expect(t.state.pendingParks.map((p) => p.status)).toEqual(["superseded", "at_car"]);
  expect((await tap(t, first.parkedEventId)).json()).toMatchObject({ error: "park_closed" });
  expect(lifecycleRows(t.state)).toEqual([
    expect.objectContaining({
      rule: "newer_park",
      parkedEventId: first.parkedEventId,
      inputs: expect.objectContaining({ previousStatus: "at_car", newerParkedEventId: "pe-race" }),
      outcome: { status: "superseded" },
    }),
  ]);
});

// ------------------------------------------------------------ what was agreed to

test("a prompt that said dry run is not charged for real: flipping dry run off asks again", async () => {
  const t = makeApp({ envDryRun: false });
  const parked = await park(t.app);
  const left = await walkAway(t);
  expect(left.json()["prompt"]).toMatchObject({ kind: "confirm", dryRun: true });

  t.deps.policy.update({ ...t.deps.policy.get(), dry_run: false });
  const first = await tap(t, parked.parkedEventId, { shownTotalUsd: 3.65 });
  expect(first.statusCode).toBe(409);
  expect(first.json()).toMatchObject({ error: "quote_changed" });
  const asked = first.json()["prompt"] as { dryRun: boolean; body: string };
  expect(asked.dryRun).toBe(false);
  expect(asked.body).not.toContain("Dry run");
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);

  // Asked again in real money, and tapped: now it is real.
  const second = await tap(t, parked.parkedEventId, { shownTotalUsd: 3.65 });
  expect(second.statusCode).toBe(200);
  expect(t.state.sessions).toHaveLength(1);
  expect(t.state.sessions[0]!.dryRun).toBe(false);
});

test("an early Pay made under dry run is not charged for real at walk-away either", async () => {
  const t = makeApp({ envDryRun: false });
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);
  t.deps.policy.update({ ...t.deps.policy.get(), dry_run: false });
  const left = await walkAway(t);
  expect(left.json()).toMatchObject({ park: { status: "prompted" } });
  expect(left.json()["prompt"]).toMatchObject({ kind: "confirm", dryRun: false });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
});

test("the tap pays the zone number it was shown, or nothing: a number changed meanwhile asks again", async () => {
  const t = makeApp({ zones: [{ ...STEINWAY_ZONE }] });
  const parked = await park(t.app);
  const left = await walkAway(t);
  expect((left.json()["prompt"] as { title: string }).title).toBe("Pay $3.65 for zone 417371?");
  // Another driver's report replaces the block's number.
  t.state.zones[0]!.providerZoneNumber = "999999";

  const first = await tap(t, parked.parkedEventId, { shownTotalUsd: 3.65 });
  expect(first.statusCode).toBe(409);
  expect(first.json()).toMatchObject({ error: "quote_changed" });
  expect((first.json()["prompt"] as { title: string }).title).toBe("Pay $3.65 for zone 999999?");
  expect(t.calls.start).toBe(0);

  const second = await tap(t, parked.parkedEventId, { shownTotalUsd: 3.65 });
  expect(second.statusCode).toBe(200);
  expect(t.state.sessions[0]!.providerZoneNumber).toBe("999999");
});

test("the prompt is priced from the terms the start will use: a rate that changed is asked about once, not forever", async () => {
  const t = makeApp({ zones: [{ ...STEINWAY_ZONE }] });
  const parked = await park(t.app);
  // The zones table is reloaded with a higher first hour before the walk-away.
  t.state.zones[0]!.rateFirstHour = 4;
  const left = await walkAway(t);
  const prompt = left.json()["prompt"] as { amountUsd: number };
  expect(prompt.amountUsd).toBe(5.65);
  const paid = await tap(t, parked.parkedEventId, { shownTotalUsd: prompt.amountUsd });
  expect(paid.statusCode).toBe(200);
  expect(paid.json()).toMatchObject({ status: "started", amountUsd: 5.65 });
});

test("Not now is final: that park is not paid from afterwards", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  await post(t.app, `/parked/${parked.parkedEventId}/decline`, {});
  const later = await tap(t, parked.parkedEventId);
  expect(later.statusCode).toBe(409);
  expect(later.json()).toMatchObject({ error: "park_closed", status: "declined" });
  expect(t.calls.start).toBe(0);
});

// ------------------------------------------------------------ when things break mid-start

test("a start that throws before the provider is asked leaves the park payable", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  const real = t.deps.db.vehicle.findFirst;
  let failed = false;
  t.deps.db.vehicle.findFirst = async (args) => {
    if (!failed) {
      failed = true;
      throw new Error("connection reset");
    }
    return real(args);
  };

  const first = await tap(t, parked.parkedEventId);
  expect(first.statusCode).toBe(500);
  expect(t.calls.start).toBe(0);
  expect(t.state.pendingParks[0]!.status).toBe("prompted");

  const second = await tap(t, parked.parkedEventId);
  expect(second.statusCode).toBe(200);
  expect(t.calls.start).toBe(1);
  expect(t.state.sessions.filter((s) => s.status === "active")).toHaveLength(1);
});

test("a start that throws after its session went active keeps it: the park has it, and no second one", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  const real = t.deps.db.sessionEvent.create;
  let failed = false;
  t.deps.db.sessionEvent.create = async (args) => {
    if (!failed) {
      failed = true;
      throw new Error("connection reset");
    }
    return real(args);
  };

  const first = await tap(t, parked.parkedEventId);
  expect(first.statusCode).toBe(500);
  expect(t.calls.start).toBe(1);
  // The provider charged and the session is running: the park is paid,
  // whatever the reply said.
  const session = t.state.sessions[0]!;
  expect(session.status).toBe("active");
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", sessionId: session.id });
  const second = await tap(t, parked.parkedEventId);
  expect(second.json()).toMatchObject({ status: "started", sessionId: session.id });
  expect(t.calls.start).toBe(1);
});

test("a start whose park never heard back is found by the sweep: started, not failed", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // The start goes through, and the process dies before the park hears.
  const real = t.deps.db.pendingPark.updateMany;
  t.deps.db.pendingPark.updateMany = async (args) => {
    if (args.data.status === "started") throw new Error("connection reset");
    return real(args);
  };
  expect((await tap(t, parked.parkedEventId)).statusCode).toBe(500);
  t.deps.db.pendingPark.updateMany = real;
  const session = t.state.sessions[0]!;
  expect(session.status).toBe("active");
  expect(t.state.pendingParks[0]!.status).toBe("starting");

  // Ten minutes on, a retried tap's read sweeps the start that never came
  // back: it finds the session, and answers with it.
  t.tick(11 * 60);
  const again = await tap(t, parked.parkedEventId);
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({ status: "started", sessionId: session.id });
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", sessionId: session.id });
  expect(t.calls.start).toBe(1);
  expect(lifecycleRows(t.state)).toEqual([
    expect.objectContaining({
      rule: "start_stale",
      sessionId: session.id,
      inputs: expect.objectContaining({ previousStatus: "starting" }),
      outcome: { status: "started", sessionId: session.id },
    }),
  ]);
});

test("a start whose session is still pending inside its deadline is left to finish: the sweep waits", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // Starting for eleven minutes, with a session made a minute ago (the
  // start reached its row late): still being paid for, not paid.
  const row = t.state.pendingParks[0]!;
  Object.assign(row, {
    status: "starting",
    startingAt: new Date(t.clock.now.getTime() - 11 * 60_000),
    zoneId: "nyc-417371",
  });
  const session = seedSession(t.state, {
    userId: "u1",
    status: "pending",
    zoneId: "nyc-417371",
    parkedEventId: parked.parkedEventId,
    createdAt: new Date(t.clock.now.getTime() - 60_000),
  });

  const again = await tap(t, parked.parkedEventId);
  expect(again.statusCode).toBe(409);
  expect(again.json()).toMatchObject({ error: "confirm_in_progress" });
  expect(row.status).toBe("starting");
  expect(session.status).toBe("pending");
  expect(lifecycleRows(t.state)).toEqual([]);
  expect(t.calls.start).toBe(0);
});

test("a start that throws after the provider was asked fails its park and its own pending session at once", async () => {
  const crashing: Executor = {
    startSession: async () => {
      throw new Error("browser crashed");
    },
    extendSession: async () => {
      throw new Error("not in this test");
    },
    stopSession: async () => {
      throw new Error("not in this test");
    },
  };
  const t = makeApp({ executor: crashing });
  const parked = await park(t.app);
  await walkAway(t);

  expect((await tap(t, parked.parkedEventId)).statusCode).toBe(500);
  const session = t.state.sessions[0]!;
  // The session it left pending is that very start's, and nothing is left
  // to answer for it: the park doesn't wait ten minutes on it. Whether it
  // charged is unknown, so the park is never tried again.
  expect(session.status).toBe("failed");
  expect(t.state.pendingParks[0]!.status).toBe("start_failed");
  const retried = await tap(t, parked.parkedEventId);
  expect(retried.statusCode).toBe(409);
  expect(retried.json()).toMatchObject({ error: "park_closed", status: "start_failed" });
  expect(t.state.sessions).toHaveLength(1);
  const error = t.state.decisions.find(
    (d) => d.kind === "session_start_walkaway" && d.rule === "error",
  )!;
  expect(error.outcome).toMatchObject({
    parkStatus: "start_failed",
    reachedProvider: true,
    reason: "start_threw",
    staleSessionId: session.id,
    sessionFailed: true,
  });

  // The sweep later finds nothing left to settle.
  t.tick(11 * 60);
  await tap(t, parked.parkedEventId);
  expect(lifecycleRows(t.state)).toEqual([]);
});

test("Postgres refusing a write after the provider was asked is a 500, never the request's 400 (#281)", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // The first session event written once the provider has been asked
  // fails as a NUL in JSON would (22P05): what the start charged is
  // unknown, so it's the server's failure, logged as one.
  const real = t.deps.db.sessionEvent.create;
  vi.spyOn(t.deps.db.sessionEvent, "create").mockImplementation((args) => {
    if (t.calls.start === 0) return real(args);
    return Promise.reject(
      Object.assign(new Error("Database error. Code: `22P05`. unsupported Unicode escape"), {
        code: "P2039",
        meta: { driverAdapterError: { cause: { kind: "postgres", originalCode: "22P05" } } },
      }),
    );
  });
  // A request's logger is a child of the app's: it logs through these.
  const errors = vi.spyOn(t.app.log, "error");
  const warnings = vi.spyOn(t.app.log, "warn");

  const res = await tap(t, parked.parkedEventId);
  expect(t.calls.start).toBe(1);
  expect(res.statusCode, res.body).toBe(500);
  expect(res.json()).toEqual({ error: "internal" });
  expect(errors).toHaveBeenCalledTimes(1);
  expect(warnings).not.toHaveBeenCalled();
  // The session the provider started is kept, and the park's own row
  // says the provider was asked.
  expect(t.state.sessions.at(-1)!.status).toBe("active");
  const row = t.state.decisions.find(
    (d) => d.kind === "session_start_walkaway" && d.rule === "error",
  )!;
  expect(row.outcome).toMatchObject({ reachedProvider: true, parkStatus: "started" });
});

test("a start that answers after the sweep closed its park: the park takes the session, on the ledger", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // The start stalls before it has made its session row.
  const real = t.deps.db.vehicle.findFirst;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.deps.db.vehicle.findFirst = async (args) => {
    await gate;
    return real(args);
  };
  const paying = tap(t, parked.parkedEventId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(t.state.pendingParks[0]!.status).toBe("starting");
  expect(t.state.sessions).toEqual([]);

  t.tick(11 * 60);
  await post(t.app, "/location", fix(t, 300));
  expect(t.state.pendingParks[0]!.status).toBe("start_failed");
  expect(lifecycleRows(t.state)).toEqual([
    expect.objectContaining({
      rule: "start_stale",
      inputs: expect.objectContaining({ previousStatus: "starting" }),
      outcome: { status: "start_failed" },
    }),
  ]);

  release();
  expect((await paying).statusCode).toBe(200);
  const session = t.state.sessions[0]!;
  expect(session.status).toBe("active");
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", sessionId: session.id });
  const late = t.state.decisions.find((d) => d.rule === "late_success")!;
  expect(late).toMatchObject({
    kind: "session_start_walkaway",
    sessionId: session.id,
    parkedEventId: parked.parkedEventId,
    outcome: { previousStatus: "start_failed", parkStatus: "started", sessionId: session.id },
  });
  expect(t.calls.start).toBe(1);
});

test("a newer park elsewhere while a stalled start's park is closed: the late success takes a session whose car moved, and buys nothing (#246)", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const parked = await park(t.app);
  await walkAway(t);
  // The start stalls before it has made its session row…
  const real = t.deps.db.vehicle.findFirst;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.deps.db.vehicle.findFirst = async (args) => {
    await gate;
    return real(args);
  };
  const paying = tap(t, parked.parkedEventId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // …the sweep closes its park, and then the car parks 1.1 km away.
  t.tick(11 * 60);
  await post(t.app, "/location", fix(t, 300));
  expect(t.state.pendingParks[0]!.status).toBe("start_failed");
  t.tick(30);
  const newer = await park(t.app, {
    lat: CAR.lat + 0.01,
    ts: t.clock.now.toISOString(),
  });
  expect(t.state.decisions.filter((d) => d.kind === "session_car_moved")).toEqual([]);

  // The start pays after all: the old park takes the session, moved.
  release();
  expect((await paying).statusCode).toBe(200);
  const session = t.state.sessions[0]!;
  const old = t.state.pendingParks.find((p) => p.parkedEventId === parked.parkedEventId)!;
  expect(old).toMatchObject({ status: "started", sessionId: session.id });
  expect(old.carMovedAt).not.toBeNull();
  const moved = t.state.decisions.filter((d) => d.kind === "session_car_moved");
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({
    rule: "newer_park_elsewhere",
    sessionId: session.id,
    parkedEventId: parked.parkedEventId,
    inputs: expect.objectContaining({
      newParkedEventId: newer.parkedEventId,
      seenAt: "late_success",
    }),
  });

  // Near expiry, nothing is bought for the spot the car left.
  t.clock.now = new Date(session.expiresAt!.getTime() - 8 * 60_000);
  await extender.tick();
  expect(t.state.decisions.filter((d) => d.kind === "extend_tick").at(-1)).toMatchObject({
    rule: "hold_car_moved",
  });
  expect(t.calls.extend).toBe(0);
});

test("a start with no answer by its deadline stops holding the park; a success after that is adopted", async () => {
  const t = makeApp();
  await park(t.app);
  await walkAway(t);
  // Where the tap leaves it: starting, for the side and amount shown.
  const row = t.state.pendingParks[0]!;
  Object.assign(row, { status: "starting", startingAt: t.clock.now, zoneId: "nyc-417371" });
  type StartReply = Awaited<ReturnType<ParkStarter>>;
  let answer: (reply: StartReply) => void = () => {};
  const stalled = new Promise<StartReply>((resolve) => (answer = resolve));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const outcome = startParkSession(
      t.deps,
      { start: () => stalled, stop: async () => ({ status: 200, body: {} }) },
      { ...row },
      { at: t.clock.now, mode: "tap", trigger: "confirm" },
    );
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS);
    expect(await outcome).toMatchObject({
      kind: "failed",
      status: 504,
      body: { error: "start_timeout" },
    });
    expect(START_DEADLINE_MS).toBeLessThan(STARTING_STALE_MS / 2);
  } finally {
    vi.useRealTimers();
  }
  expect(row.status).toBe("start_failed");
  expect(t.state.decisions.at(-1)).toMatchObject({
    kind: "session_start_walkaway",
    rule: "start_timeout",
  });

  answer({ status: 200, body: { sessionId: "s-late" }, reachedProvider: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(row).toMatchObject({ status: "started", sessionId: "s-late" });
  expect(t.state.decisions.at(-1)).toMatchObject({
    rule: "late_success",
    outcome: { previousStatus: "start_failed", sessionId: "s-late" },
  });
});

test("an early Pay whose start throws at walk-away is tried again by the app's next on-foot report", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);
  const real = t.deps.db.vehicle.findFirst;
  let failed = false;
  t.deps.db.vehicle.findFirst = async (args) => {
    if (!failed) {
      failed = true;
      throw new Error("connection reset");
    }
    return real(args);
  };
  const first = await walkOff(t);
  expect(first.statusCode).toBe(500);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "confirmed", leftCarAt: null });

  t.tick(20);
  await post(t.app, "/location", fix(t, 110));
  t.tick(20);
  const again = await post(t.app, "/location", fix(t, 135, { event: "left_car" }));
  expect(again.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
});

test("a fix in flight can't undo a tap: a Pay at the car still starts at the next walk-away", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  t.tick(30);
  await post(t.app, "/location", fix(t, 6));

  // A fix reads the park, then stalls while the driver taps Pay in the seat.
  const real = t.deps.db.pendingPark.findFirst;
  let release = () => {};
  let reading = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const read = new Promise<void>((resolve) => (reading = resolve));
  t.deps.db.pendingPark.findFirst = async (args) => {
    t.deps.db.pendingPark.findFirst = real;
    const row = await real(args);
    reading();
    await gate;
    return row;
  };
  t.tick(20);
  const slow = post(t.app, "/location", fix(t, 5));
  await read;
  const early = await tap(t, parked.parkedEventId);
  expect(early.json()).toMatchObject({ status: "confirmed" });
  release();
  await slow;
  expect(t.state.pendingParks[0]).toMatchObject({ status: "confirmed", leftCarAt: null });

  const left = await walkOff(t);
  expect(left.json()).toMatchObject({ park: { status: "started" } });
  expect(t.calls.start).toBe(1);
});

test("an early Pay that runs out of time is said, not dropped in silence", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);
  t.tick(61 * 60);
  const late = await post(t.app, "/location", fix(t, 3));
  expect(late.statusCode).toBe(200);
  expect(late.json()).toEqual({
    ok: true,
    park: { parkedEventId: parked.parkedEventId, status: "expired" },
  });
  expect(t.calls.start).toBe(0);
});

// ------------------------------------------------------------ before DRY_RUN=false (#226)

test("a crash in `starting` after the provider charged: the phone's next fix after the sweep finds the session, and nothing is charged again", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await tap(t, parked.parkedEventId);
  // The early Pay starts on the app's on-foot report. The provider charges
  // and the session goes active; the process dies before the park hears.
  const real = t.deps.db.pendingPark.updateMany;
  t.deps.db.pendingPark.updateMany = async (args) => {
    if (args.data.status === "started") throw new Error("process killed");
    return real(args);
  };
  expect((await walkOff(t)).statusCode).toBe(500);
  t.deps.db.pendingPark.updateMany = real;
  const session = t.state.sessions[0]!;
  expect(session.status).toBe("active");
  expect(t.state.pendingParks[0]!.status).toBe("starting");

  // The phone keeps reporting on foot, away from the car, minute by minute.
  // No fix, and no tap, is a second start.
  for (let i = 0; i < 12; i += 1) {
    t.tick(60);
    await post(t.app, "/location", fix(t, 150 + i * 20, { event: "left_car" }));
    await tap(t, parked.parkedEventId);
  }
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", sessionId: session.id });
  expect(t.calls.start).toBe(1);
  expect(t.state.sessions).toHaveLength(1);
  expect(lifecycleRows(t.state)).toEqual([
    expect.objectContaining({
      rule: "start_stale",
      sessionId: session.id,
      outcome: { status: "started", sessionId: session.id },
    }),
  ]);
  // …and the adopted session is the lifecycle's: a return now ends it.
  t.tick(60);
  await post(t.app, "/location", fix(t, 5));
  t.tick(61);
  await post(t.app, "/location", fix(t, 4));
  expect(session.status).toBe("stopped");
});

test("a crash in `starting` before the session was marked active: the sweep closes the park, and nothing pays it again", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  await walkAway(t);
  // The provider has been asked; the process dies while the session row
  // still says pending. Whether it charged is unknown.
  const real = t.deps.db.session.update;
  let die: (err: Error) => void = () => {};
  const dead = new Promise<never>((_, reject) => (die = reject));
  t.deps.db.session.update = async (args) => {
    if (args.data.status === "active") return dead;
    return real(args);
  };
  const paying = tap(t, parked.parkedEventId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(t.calls.start).toBe(1);
  expect(t.state.sessions[0]!.status).toBe("pending");
  t.deps.db.session.update = real;

  // Eleven minutes on, the next fix's sweep finds a start nothing will
  // answer for: the park is closed with its session, and is never paid
  // from again, by a fix, a left_car, or a tap.
  t.tick(11 * 60);
  await post(t.app, "/location", fix(t, 300, { event: "left_car" }));
  expect(t.state.pendingParks[0]!.status).toBe("start_failed");
  expect(t.state.sessions[0]!.status).toBe("failed");
  for (let i = 0; i < 3; i += 1) {
    t.tick(60);
    await post(t.app, "/location", fix(t, 320 + i * 20, { event: "left_car" }));
    expect((await tap(t, parked.parkedEventId)).statusCode).toBe(409);
  }
  expect(t.calls.start).toBe(1);
  expect(t.state.sessions).toHaveLength(1);
  die(new Error("process gone"));
  await paying;
});

test("a cap lowered between the prompt and the tap: the tap is refused, on the ledger, and nothing is paid", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  const left = await walkAway(t);
  expect(left.json()["prompt"]).toMatchObject({ amountUsd: 3.65 });
  const lowered = await t.app.inject({
    method: "PUT",
    url: "/me/limits",
    headers: HEADERS,
    payload: { sessionCapUsd: 3 },
  });
  expect(lowered.statusCode).toBe(200);

  const res = await tap(t, parked.parkedEventId);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "policy_violation", rule: "session_cap_exceeded" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions).toEqual([]);
  const refused = t.state.decisions.filter(
    (d) => d.parkedEventId === parked.parkedEventId && d.rule === "session_cap_exceeded",
  );
  expect(refused.length).toBeGreaterThanOrEqual(1);
  expect(refused[0]!.inputs).toMatchObject({ dryRun: true });
  // The park isn't paid by a second tap either, until the cap allows it.
  expect((await tap(t, parked.parkedEventId)).statusCode).toBe(409);
  expect(t.calls.start).toBe(0);
});

test("an old measurement at the car, replayed after the walk-away, doesn't end the session", async () => {
  const t = makeApp();
  const parked = await park(t.app);
  const measured = (secondsAfterPark: number) =>
    new Date(PARKED_AT.getTime() + secondsAfterPark * 1000).toISOString();
  // In the seat for over a minute, then a walk-away and the tap.
  t.tick(5);
  await post(t.app, "/location", fix(t, 4));
  t.tick(70);
  await post(t.app, "/location", fix(t, 4));
  t.tick(20);
  await post(t.app, "/location", fix(t, 60));
  t.tick(20);
  await post(t.app, "/location", fix(t, 90));
  expect((await tap(t, parked.parkedEventId)).json()).toMatchObject({ status: "started" });
  const session = t.state.sessions[0]!;
  t.tick(30);
  await post(t.app, "/location", fix(t, 200));

  // The outbox delivers the two seat measurements again, freshly stamped:
  // both from before the phone left, a minute apart.
  t.tick(10);
  const first = await post(t.app, "/location", fix(t, 4, { measuredAt: measured(5) }));
  t.tick(1);
  const second = await post(t.app, "/location", fix(t, 4, { measuredAt: measured(75) }));
  expect(first.json()["ended"]).toBeUndefined();
  expect(second.json()["ended"]).toBeUndefined();
  expect(session.status).toBe("active");
  expect(t.calls.stop).toBe(0);
  expect(t.state.pendingParks[0]).toMatchObject({ status: "started", backAt: null });
});

test("a park reported three hours late isn't held at the car: the walk-away it waits for is long past", async () => {
  const t = makeApp();
  t.tick(3 * 60 * 60);
  const parked = await park(t.app, { ts: PARKED_AT.toISOString() });
  // Answered as for a build that doesn't wait: priced for when it parked.
  expect(parked["action"]).toBe("pay");
  expect(parked["awaitsWalkAway"]).toBeUndefined();
  expect(t.state.pendingParks).toEqual([]);
  expect(count(t.state, "street_pending")).toBe(0);
});

test("clock skew: a park is held only when its phone's fixes will be read, with one tolerance for both", async () => {
  // Past the pricing clamp too (over 10 min ahead, over 24 h behind): the
  // park is priced at server time, and its phone's fixes are still off.
  for (const skewMs of [
    -25 * 60 * 60_000,
    -LIFECYCLE_FIX_MAX_AGE_MS - 60_000,
    -LIFECYCLE_FIX_MAX_AGE_MS + 60_000,
    LIFECYCLE_FIX_MAX_AGE_MS - 60_000,
    LIFECYCLE_FIX_MAX_AGE_MS + 60_000,
    11 * 60_000,
  ]) {
    const t = makeApp();
    // The phone's clock: every ts it sends is off by the skew.
    const phone = (distanceM: number) =>
      fix(t, distanceM, { ts: new Date(t.clock.now.getTime() + skewMs).toISOString() });
    const parked = await park(t.app, { ts: new Date(PARKED_AT.getTime() + skewMs).toISOString() });
    t.tick(40);
    await post(t.app, "/location", phone(60));
    t.tick(20);
    const left = await post(t.app, "/location", phone(90));
    const held = parked["awaitsWalkAway"] === true;
    const asked = left.json()["prompt"] !== undefined;
    expect({ skewMs, held, asked }).toEqual({
      skewMs,
      held: Math.abs(skewMs) < LIFECYCLE_FIX_MAX_AGE_MS,
      asked: Math.abs(skewMs) < LIFECYCLE_FIX_MAX_AGE_MS,
    });
  }
});

test("dry run enforces the daily cap on what dry runs recorded today: no Pay offered, and the tap is refused", async () => {
  const t = makeApp();
  // $60 a day; $58 of dry-run sessions already today.
  seedSession(t.state, {
    userId: "u1",
    status: "stopped",
    dryRun: true,
    amountUsd: 57.85,
    feeUsd: 0.15,
    createdAt: new Date(PARKED_AT.getTime() - 3 * 60 * 60_000),
  });
  const parked = await park(t.app);
  const left = await walkAway(t);
  expect(left.json()["prompt"]).toMatchObject({ kind: "attention", reason: "daily_cap_exceeded" });

  const res = await tap(t, parked.parkedEventId);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "policy_violation", rule: "daily_cap_exceeded" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions.filter((s) => s.parkedEventId === parked.parkedEventId)).toEqual([]);
});

test("…and so does a start outside the lifecycle", async () => {
  const t = makeApp();
  seedSession(t.state, {
    userId: "u1",
    status: "stopped",
    dryRun: true,
    amountUsd: 57.85,
    feeUsd: 0.15,
    createdAt: new Date(PARKED_AT.getTime() - 3 * 60 * 60_000),
  });
  const parked = await park(t.app, { outcomes: ["garage", "nopay"] });
  expect(parked).toMatchObject({ action: "confirm", rule: "daily_cap_exceeded" });
  const started = await post(t.app, "/session/start", {
    parkedEventId: parked.parkedEventId,
    zoneId: "nyc-417371",
  });
  expect(started.statusCode).toBe(409);
  expect(started.json()).toMatchObject({ rule: "daily_cap_exceeded" });
  expect(t.state.decisions.at(-1)).toMatchObject({ rule: "daily_cap_exceeded" });
  expect(t.calls.start).toBe(0);
});

test("a spend the gate can't sum (a garbled ledger row): no Pay offered, the tap and a start are refused", async () => {
  const t = makeApp();
  // Today's sum is NaN, and NaN passes every `>` cap: the gate refuses it.
  seedSession(t.state, {
    userId: "u1",
    status: "stopped",
    dryRun: true,
    amountUsd: Number.NaN,
    createdAt: new Date(PARKED_AT.getTime() - 3 * 60 * 60_000),
  });
  const parked = await park(t.app);
  const left = await walkAway(t);
  expect(left.json()["prompt"]).toMatchObject({
    kind: "attention",
    reason: "amount_invalid",
    body: expect.stringContaining("won't pay it"),
  });
  const res = await tap(t, parked.parkedEventId);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "policy_violation", rule: "amount_invalid" });

  const other = await park(t.app, { outcomes: ["garage", "nopay"] });
  expect(other).toMatchObject({ action: "confirm", rule: "amount_invalid" });
  const started = await post(t.app, "/session/start", {
    parkedEventId: other.parkedEventId,
    zoneId: "nyc-417371",
  });
  expect(started.statusCode).toBe(409);
  expect(started.json()).toMatchObject({ rule: "amount_invalid" });
  expect(t.state.decisions.at(-1)).toMatchObject({ rule: "amount_invalid" });
  expect(t.calls.start).toBe(0);
  expect(t.state.sessions.filter((s) => s.status !== "stopped")).toEqual([]);
});

test("a fix relinks a closed park to its late session before the adopt: the relink marks the car moved, once, and nothing is bought (#246)", async () => {
  const t = makeApp();
  const extender = makeExtender({ ...t.deps, log: { info() {}, warn() {} } });
  const parked = await park(t.app);
  await walkAway(t);
  const real = t.deps.db.vehicle.findFirst;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.deps.db.vehicle.findFirst = async (args) => {
    await gate;
    return real(args);
  };
  const paying = tap(t, parked.parkedEventId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.tick(11 * 60);
  await post(t.app, "/location", fix(t, 300));
  expect(t.state.pendingParks[0]!.status).toBe("start_failed");
  t.tick(30);
  await park(t.app, { lat: CAR.lat + 0.01, ts: t.clock.now.toISOString() });
  // The late start pays, then waits a moment before its reply.
  const realEvent = t.deps.db.sessionEvent.create;
  let reply = () => {};
  const replyGate = new Promise<void>((resolve) => (reply = resolve));
  t.deps.db.sessionEvent.create = async (args) => {
    if ((args.data as { kind: string }).kind === "started") await replyGate;
    return realEvent(args);
  };
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const session = t.state.sessions[0]!;
  expect(session.status).toBe("active");
  // A fix in that moment relinks the park to its session.
  t.tick(10);
  await post(t.app, "/location", fix(t, 400));
  reply();
  expect((await paying).statusCode).toBe(200);
  const old = t.state.pendingParks.find((p) => p.parkedEventId === parked.parkedEventId)!;
  expect(old).toMatchObject({ status: "started", sessionId: session.id });
  t.clock.now = new Date(session.expiresAt!.getTime() - 6 * 60_000);
  await post(t.app, "/location", fix(t, 1500));
  await extender.tick();
  expect({
    carMoved: old.carMovedAt !== null,
    rows: t.state.decisions
      .filter((d) => d.kind === "session_car_moved")
      .map((d) => (d.inputs as { seenAt?: string }).seenAt),
    extend: t.calls.extend,
  }).toEqual({ carMoved: true, rows: ["relinked"], extend: 0 });
});
