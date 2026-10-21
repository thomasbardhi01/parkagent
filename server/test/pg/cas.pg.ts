/**
 * The lifecycle's races, decided by Postgres (#226 item 8). The fake DB
 * (test/helpers.ts) runs one call at a time, so its compare-and-set writes
 * and unique indexes can't lose a race the way Postgres's can. Here each
 * race is forced: both requests are held at the write they race for
 * (`hold`), having read the same row, and then let go together.
 *
 * Every race has one invariant: nothing is paid twice, and what the rows
 * say afterwards is what happened.
 */

import { randomBytes } from "node:crypto";

import { afterAll, expect, test } from "vitest";

import { MOTT_A, MOTT_B, parkedBody } from "../helpers.js";
import type { PgApp } from "./pgApp.js";
import { ALWAYS, CAR, hold, makePgApp, pause, prisma, until } from "./pgApp.js";

afterAll(() => prisma.$disconnect());

const OUTCOMES = ["garage", "nopay", "walk_away"];

async function park(t: PgApp, extra: Record<string, unknown> = {}) {
  const res = await t.post(
    "/parked",
    parkedBody({ ts: t.now().toISOString(), outcomes: OUTCOMES, ...extra }),
  );
  expect(res.statusCode).toBe(200);
  return res.json() as { parkedEventId: string; awaitsWalkAway?: boolean };
}

/** Two fixes clear of the car, 20 s apart: prompted. */
async function walkAway(t: PgApp) {
  t.tick(40);
  await t.post("/location", t.fix(60));
  t.tick(20);
  const left = await t.post("/location", t.fix(90));
  expect(left.json()).toMatchObject({ park: { status: "prompted" } });
}

const tap = (t: PgApp, parkedEventId: string, body: object = {}) =>
  t.post(`/parked/${parkedEventId}/confirm`, body);

const parksOf = (t: PgApp) =>
  prisma.pendingPark.findMany({ where: { userId: t.user.id }, orderBy: { createdAt: "asc" } });
const sessionsOf = (t: PgApp) => prisma.session.findMany({ where: { userId: t.user.id } });
const decisionsOf = (t: PgApp, kind: string) =>
  prisma.decision.findMany({ where: { userId: t.user.id, kind } });

const where = (args: Record<string, unknown>) =>
  (args["where"] ?? {}) as { id?: string; status?: unknown };
const data = (args: Record<string, unknown>) => (args["data"] ?? {}) as { status?: string };

test("two taps at once from `prompted`: one start, one session, one confirmation", async () => {
  const t = await makePgApp();
  const { parkedEventId } = await park(t);
  await walkAway(t);

  const race = hold("pendingPark.updateMany", 2, (a) => data(a).status === "starting");
  const [a, b] = await Promise.all([tap(t, parkedEventId), tap(t, parkedEventId)]);
  await race.done;

  expect(race.arrived()).toBe(2);
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  expect((a.statusCode === 409 ? a : b).json()).toMatchObject({ error: "confirm_in_progress" });
  expect(t.calls.start).toBe(1);
  const sessions = await sessionsOf(t);
  expect(sessions).toHaveLength(1);
  expect(await parksOf(t)).toEqual([
    expect.objectContaining({ status: "started", sessionId: sessions[0]!.id }),
  ]);
  expect(await decisionsOf(t, "street_confirmed")).toHaveLength(1);
});

test("a tap changing the side against the app's left_car, both from `confirmed`: one wins, and a start pays the side its park held", async () => {
  const t = await makePgApp({ candidates: [MOTT_A, MOTT_B] });
  const { parkedEventId } = await park(t);
  // Pay tapped at the car for one side: confirmed, waiting on the walk-away.
  const early = await tap(t, parkedEventId, { zoneId: MOTT_A.zoneId });
  expect(early.json()).toMatchObject({ status: "confirmed", startsAt: "walk_away" });

  // The driver switches sides just as the app reports them on foot.
  const race = hold("pendingPark.updateMany", 2, (a) => where(a).status === "confirmed");
  t.tick(30);
  const [side, left] = await Promise.all([
    tap(t, parkedEventId, { zoneId: MOTT_B.zoneId }),
    t.post("/location", t.fix(60, { event: "left_car" })),
  ]);
  await race.done;
  expect(race.arrived()).toBe(2);
  expect(side.statusCode).not.toBe(500);
  expect(left.statusCode).toBe(200);

  // The side change keeps the park `confirmed`, so both writes can land:
  // the side change first, then the start, which pays the side the driver
  // just chose. What must never happen is a start paying the side the
  // driver was told it no longer pays.
  const [row] = await parksOf(t);
  const sessions = await sessionsOf(t);
  expect(t.calls.start).toBeLessThanOrEqual(1);
  const toldB = side.statusCode === 200;
  if (toldB) {
    expect(side.json()).toMatchObject({ status: "confirmed", zoneId: MOTT_B.zoneId });
  } else {
    expect(side.json()).toMatchObject({ error: "confirm_in_progress" });
  }
  if (row!.status === "started") {
    expect(t.calls.start).toBe(1);
    expect(sessions).toEqual([
      expect.objectContaining({ zoneId: toldB ? MOTT_B.zoneId : MOTT_A.zoneId }),
    ]);
  } else {
    // Nothing started: the park waits on the side it was last told.
    expect(row).toMatchObject({ status: "confirmed", zoneId: MOTT_B.zoneId });
    expect(t.calls.start).toBe(0);
    expect(sessions).toEqual([]);
  }
});

test("the stale sweep against a start's late success: the park ends with its one session", async () => {
  const t = await makePgApp();
  const { parkedEventId } = await park(t);
  await walkAway(t);

  // The start stalls before its session row exists (the process is slow,
  // not dead), past STARTING_STALE_MS.
  const stall = pause("vehicle.findFirst");
  const paying = tap(t, parkedEventId);
  await stall.reached;
  t.tick(11 * 60);

  // The sweep (the phone's next fix) and the start's own settle race for
  // the `starting` row.
  const race = hold("pendingPark.updateMany", 2, (a) => where(a).status === "starting");
  stall.release();
  const [paid, swept] = await Promise.all([paying, t.post("/location", t.fix(300))]);
  await race.done;
  expect(race.arrived()).toBe(2);
  expect(paid.statusCode).toBe(200);
  expect(swept.statusCode).toBe(200);

  const sessions = await sessionsOf(t);
  expect(sessions).toEqual([expect.objectContaining({ status: "active" })]);
  expect(await parksOf(t)).toEqual([
    expect.objectContaining({ status: "started", sessionId: sessions[0]!.id }),
  ]);
  expect(t.calls.start).toBe(1);
});

test("a newer park against a tap on the old one: the old park is superseded or started, never both, and pays at most once", async () => {
  const t = await makePgApp();
  const { parkedEventId } = await park(t);
  await walkAway(t);

  const race = hold("pendingPark.updateMany", 2, (a) => where(a).status === "prompted");
  t.tick(5);
  const [paid, newer] = await Promise.all([
    tap(t, parkedEventId),
    t.post(
      "/parked",
      parkedBody({
        ts: t.now().toISOString(),
        outcomes: OUTCOMES,
        lat: CAR.lat + 0.005,
        lng: CAR.lng,
      }),
    ),
  ]);
  await race.done;
  expect(race.arrived()).toBe(2);
  expect(newer.statusCode).toBe(200);

  const old = (await parksOf(t)).find((p) => p.parkedEventId === parkedEventId)!;
  const sessions = await sessionsOf(t);
  expect(["started", "superseded"]).toContain(old.status);
  if (old.status === "started") {
    expect(paid.statusCode).toBe(200);
    expect(t.calls.start).toBe(1);
    expect(sessions).toEqual([expect.objectContaining({ id: old.sessionId })]);
  } else {
    expect(paid.statusCode).toBe(409);
    expect(t.calls.start).toBe(0);
    expect(sessions).toEqual([]);
  }
});

test("a relink against a late success, both from `start_failed`: one moves the park, once, onto its one session", async () => {
  const t = await makePgApp();
  const { parkedEventId } = await park(t);
  await walkAway(t);

  // Swept as failed before its session existed…
  const stall = pause("vehicle.findFirst");
  const paying = tap(t, parkedEventId);
  await stall.reached;
  t.tick(11 * 60);
  await t.post("/location", t.fix(300));
  expect((await parksOf(t))[0]!.status).toBe("start_failed");

  // …then the start pays after all. Its adoption of the session and the
  // phone's next fix (lifecycleOf relinking the park to the running
  // session) race for the `start_failed` row.
  const race = hold("pendingPark.updateMany", 2, (a) => where(a).status === "start_failed");
  stall.release();
  await until(() => race.arrived() === 1);
  const [paid, fixed] = await Promise.all([paying, t.post("/location", t.fix(320))]);
  await race.done;
  expect(race.arrived()).toBe(2);
  expect(paid.statusCode).toBe(200);
  expect(fixed.statusCode).toBe(200);

  const sessions = await sessionsOf(t);
  expect(sessions).toEqual([expect.objectContaining({ status: "active" })]);
  expect(await parksOf(t)).toEqual([
    expect.objectContaining({ status: "started", sessionId: sessions[0]!.id }),
  ]);
  // One of the two moved it, and only that one is on the ledger.
  const moved = [
    ...(await decisionsOf(t, "session_start_walkaway")).filter((d) => d.rule === "late_success"),
    ...(await decisionsOf(t, "park_lifecycle")).filter((d) => d.rule === "linked_to_session"),
  ];
  expect(moved).toHaveLength(1);
  expect(t.calls.start).toBe(1);
});

test("two fixes at once for a session started outside the lifecycle: one lifecycle row, by the unique indexes, and no error", async () => {
  const t = await makePgApp();
  const parked = await park(t, { outcomes: ["garage", "nopay"] });
  const started = await t.post("/session/start", {
    parkedEventId: parked.parkedEventId,
    zoneId: "nyc-417371",
  });
  expect(started.statusCode).toBe(200);
  expect(await parksOf(t)).toEqual([]);

  // Both reads find no row, and both create one for the same park and
  // session: parked_event_id and session_id are unique, and the loser
  // reads the winner's row.
  const race = hold("pendingPark.create", 2);
  t.tick(30);
  const [a, b] = await Promise.all([
    t.post("/location", t.fix(120)),
    t.post("/location", t.fix(125)),
  ]);
  await race.done;
  expect(race.arrived()).toBe(2);
  expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  const sessionId = (started.json() as { sessionId: string }).sessionId;
  expect(await parksOf(t)).toEqual([
    expect.objectContaining({ status: "started", sessionId, parkedEventId: parked.parkedEventId }),
  ]);
});

test("two starts at once for one driver: one_open_session_per_user lets one reach the provider", async () => {
  const t = await makePgApp();
  const first = await park(t, { outcomes: ["garage", "nopay"] });
  t.tick(5);
  const second = await park(t, { outcomes: ["garage", "nopay"] });

  const race = hold("session.create", 2);
  const [a, b] = await Promise.all([
    t.post("/session/start", { parkedEventId: first.parkedEventId, zoneId: "nyc-417371" }),
    t.post("/session/start", { parkedEventId: second.parkedEventId, zoneId: "nyc-417371" }),
  ]);
  await race.done;
  expect(race.arrived()).toBe(2);
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  expect((a.statusCode === 409 ? a : b).json()).toMatchObject({ error: "session_already_active" });
  expect(t.calls.start).toBe(1);
  expect(await sessionsOf(t)).toEqual([expect.objectContaining({ status: "active" })]);
});

test("one assistant confirmation token used twice at once: one use is honored", async () => {
  const t = await makePgApp();
  const planId = `plan-${randomBytes(6).toString("hex")}`;
  const option = {
    id: "o1",
    type: "street",
    zoneId: "nyc-417371",
    durationMinutes: 60,
    hours: ALWAYS,
  };
  await prisma.assistantPlan.create({
    data: {
      id: planId,
      userId: t.user.id,
      conversationId: `conv-${planId}`,
      kind: "single_spot",
      plan: { options: [option] },
    },
  });
  const token = randomBytes(24).toString("base64url");
  await prisma.assistantConfirmation.create({
    data: {
      token,
      userId: t.user.id,
      planId,
      optionId: option.id,
      expiresAt: new Date(t.now().getTime() + 5 * 60_000),
    },
  });
  const ctx = { userId: t.user.id, conversationId: `conv-${planId}` };
  const input = { zone: option.zoneId, duration_minutes: 60, confirmation_token: token };

  const race = hold("assistantConfirmation.updateMany", 2);
  const results = await Promise.all([
    t.assistantTools.execute(ctx, "start_session", input),
    t.assistantTools.execute(ctx, "start_session", input),
  ]);
  await race.done;
  expect(race.arrived()).toBe(2);
  const outcomes = results.map((r) => r.result as { confirmed?: boolean; error?: string });
  expect(outcomes.filter((o) => o.confirmed === true)).toHaveLength(1);
  expect(outcomes.filter((o) => o.error === "needs_confirmation")).toHaveLength(1);
  const row = await prisma.assistantConfirmation.findUnique({ where: { token } });
  expect(row!.usedAt).not.toBeNull();
});
