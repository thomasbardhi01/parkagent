/**
 * Phone fixes: where the driver is relative to the car. They are reported
 * while a park waits for its walk-away and while a session is active (the
 * iOS LocationReporter), and they are what moves the street session
 * lifecycle (FR-55, services/pendingSession.ts):
 *
 *  - the phone leaving the car is when the driver is asked to pay (or,
 *    for a Pay tapped early, when the session starts, on the app's own
 *    on-foot report only);
 *  - the phone coming back ends the session, or cancels a park nobody
 *    paid for, and so does coming back and driving off.
 *
 * Nothing here asks, pays, or ends anything on a fix that shows the phone
 * at the car, is older than the park, or belongs to someone else: every
 * read is of the caller's own park and session. Fixes of an active session
 * are also stored for the extension worker. Each transition writes a
 * decisions row carrying the fix that caused it.
 *
 * A session and a waiting park can both be the caller's at once (the car
 * moved and parked again before the old session's return was seen): the
 * fix is read against each, from that one's own car.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { PendingParkRow, SessionRow } from "../db.js";
import type { FixRecord, ParkPrompt } from "../services/pendingSession.js";
import {
  PARK_OPEN,
  SAME_SPOT_M,
  advanceWalk,
  buildParkPrompt,
  endSession,
  fixRejection,
  lifecycleOf,
  metersBetween,
  settlePark,
  startParkSession,
  supersedeParks,
  walkStateOf,
} from "../services/pendingSession.js";
import type { SessionOps } from "./session.js";

const bodySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().nonnegative().lte(10_000),
  ts: z.iso.datetime({ offset: true }),
  // When the fix was measured, when that isn't now: the app re-sends its
  // last fix on a heartbeat, and a re-sent fix is not a second one.
  measuredAt: z.iso.datetime({ offset: true }).optional(),
  // The phone's own speed at the fix (CLLocation.speed), null when it had
  // none. A fix at driving speed is never someone walking away.
  speedMps: z.number().lte(1_000).nullable().optional(),
  // What the app itself saw: on foot after the park, or back at the car
  // (its audio reconnecting, driving again).
  event: z.enum(["left_car", "returned_to_car"]).optional(),
  // What the phone's own sensing said at the fix, for the park's trace
  // only (nothing here decides on them yet): CoreMotion's activity and
  // its confidence, and a car-audio (Bluetooth / CarPlay) hint.
  motionActivity: z
    .enum(["stationary", "walking", "running", "automotive", "cycling", "unknown"])
    .optional(),
  motionConfidence: z.enum(["low", "medium", "high"]).optional(),
  btHint: z
    .string()
    .regex(/^[a-z_]{1,32}$/)
    .optional(),
});

type Body = z.infer<typeof bodySchema>;
type Answer = Record<string, unknown>;

export function registerLocation(app: FastifyInstance, deps: AppDeps, sessions: SessionOps): void {
  const now = () => deps.now?.() ?? new Date();
  const ledger = () => ({
    dryRun: deps.policy.effectiveDryRun(),
    policyHash: deps.policy.hash(),
  });

  /** The phone's speed, when it gave a real one (iOS reports -1 for
   * none; the app sends null, and a negative means the same). */
  const speedOf = (body: Body) =>
    typeof body.speedMps === "number" && body.speedMps >= 0 ? body.speedMps : null;

  function measure(park: PendingParkRow, body: Body): FixRecord {
    const speedMps = speedOf(body);
    return {
      lat: body.lat,
      lng: body.lng,
      accuracyM: body.accuracy,
      ts: body.ts,
      ...(body.measuredAt ? { measuredAt: body.measuredAt } : {}),
      ...(speedMps !== null ? { speedMps } : {}),
      distanceM: Math.round(metersBetween(body.lat, body.lng, park.carLat, park.carLng) * 10) / 10,
      ...(body.event ? { event: body.event } : {}),
    };
  }

  /** The fix on the park's trace (park_fixes), read or refused and why.
   * Evidence only: a failed write is logged and never stops the fix from
   * being read. */
  async function keep(park: PendingParkRow, body: Body, at: Date, rejected: string | null) {
    const reportedAt = new Date(body.ts);
    try {
      await deps.db.parkFix.create({
        data: {
          pendingParkId: park.id,
          measuredAt: body.measuredAt ? new Date(body.measuredAt) : reportedAt,
          reportedAt,
          receivedAt: at,
          lat: body.lat,
          lng: body.lng,
          accuracyM: body.accuracy,
          speedMps: typeof body.speedMps === "number" ? body.speedMps : null,
          event: body.event ?? null,
          motionActivity: body.motionActivity ?? null,
          motionConfidence: body.motionConfidence ?? null,
          btHint: body.btHint ?? null,
          rejected,
        },
      });
    } catch (err) {
      app.log.warn(`park trace: fix not kept for ${park.id}: ${String(err).split("\n")[0]}`);
    }
  }

  /** The fix against a park's own car, or null when it says nothing about
   * this park (stale, or measured before the car stopped). */
  async function read(park: PendingParkRow, body: Body, at: Date) {
    const reportedAt = new Date(body.ts);
    const measuredAt = body.measuredAt ? new Date(body.measuredAt) : reportedAt;
    const rejected = fixRejection(park.parkedAt, measuredAt, reportedAt, at);
    await keep(park, body, at, rejected);
    if (rejected !== null) return null;
    const fix = measure(park, body);
    const step = advanceWalk(walkStateOf(park), {
      distanceM: fix.distanceM,
      accuracyM: fix.accuracyM,
      at: reportedAt,
      measuredAt,
      speedMps: speedOf(body),
      event: body.event,
    });
    return { fix, step };
  }

  /** The first fix of a drive-off's pair, as the park held it before the
   * second: with the fix that finished it, the row says both. */
  const driveFrom = (park: PendingParkRow) => ({
    measuredAt: park.driveAt?.toISOString() ?? null,
    distanceM: park.driveDistanceM,
    speedMps: park.driveSpeedMps,
  });

  /** Where the phone stands, written only while the park is still in the
   * state it was read in: a tap that moved it on meanwhile wins. */
  const remember = (park: PendingParkRow, state: ReturnType<typeof walkStateOf>) =>
    deps.db.pendingPark.updateMany({
      where: { id: park.id, status: park.status },
      data: state,
    });

  /** A running session: store the fix, and end the session if this fix
   * shows the phone back at its car. */
  async function forSession(session: SessionRow, body: Body, at: Date): Promise<Answer> {
    await deps.db.locationFix.create({
      data: {
        sessionId: session.id,
        userId: session.userId,
        lat: body.lat,
        lng: body.lng,
        accuracyM: body.accuracy,
        ts: new Date(body.ts),
      },
    });
    const answer = { sessionId: session.id };
    const park = await lifecycleOf(deps, session, at);
    // No car fix to measure from, or a park that already ended (a stop
    // the provider refused): the fix is stored and decides nothing.
    if (!park || park.status !== "started") return answer;
    const seen = await read(park, body, at);
    if (!seen) return answer;
    if (!seen.step.returned) {
      await remember(park, seen.step.state);
      return answer;
    }
    const ended = await deps.db.pendingPark.updateMany({
      where: { id: park.id, status: "started" },
      data: { ...seen.step.state, status: "ended", closedAt: at },
    });
    // Another report of the same return got there first.
    if (ended.count === 0) return answer;
    return {
      ...answer,
      ended: await endSession(deps, sessions.stop, session, park, {
        reason: "returned",
        why: seen.step.why ?? "returned",
        fix: seen.fix,
        at,
        // A drive-off read from pace alone can be one GPS jump: it ends
        // the session as an unstoppable provider's return does (nothing
        // more bought, the paid time runs out), and never asks to stop.
        ...(seen.step.droveOffBy
          ? { readBy: seen.step.droveOffBy, askProvider: seen.step.droveOffBy === "speed" }
          : {}),
      }),
    };
  }

  /** A park waiting on its walk-away, or on the tap. */
  async function forPark(
    park: PendingParkRow,
    session: SessionRow | null,
    body: Body,
    at: Date,
  ): Promise<Answer> {
    const parkedEventId = park.parkedEventId as string;
    const answer = (status: string, extra: Answer = {}): Answer => ({
      park: { parkedEventId, status },
      ...extra,
    });
    /** The prompt already given, again: a lost reply is asked for by the
     * next fix, and the phone shows a park's prompt once. */
    const asked = (row: PendingParkRow) =>
      row.status === "prompted" && row.prompt ? { prompt: row.prompt as ParkPrompt } : {};
    const current = async () => {
      const row = await deps.db.pendingPark.findUnique({ where: { id: park.id } });
      return answer(row?.status ?? park.status, row ? asked(row) : {});
    };

    if (park.status === "starting") {
      // Mid-start: the fix isn't read for this park until its start settles.
      await keep(park, body, at, "park_starting");
      return answer(park.status);
    }
    const seen = await read(park, body, at);
    if (!seen) return answer(park.status, asked(park));
    const { fix, step } = seen;

    /** `said` goes on the answer's `park` too, for the phone to word it. */
    const close = async (
      status: string,
      kind: string,
      rule: string,
      outcome: Answer,
      said: Answer = {},
    ) => {
      const moved = await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: park.status },
        data: { ...step.state, status, closedAt: at },
      });
      if (moved.count === 0) return current();
      await deps.db.decision.create({
        data: {
          kind,
          inputs: {
            parkedEventId,
            parkStatus: park.status,
            fix,
            ...(step.droveOffBy ? { driveFrom: driveFrom(park) } : {}),
            leftCarAt: park.leftCarAt?.toISOString() ?? null,
            ...ledger(),
          },
          rule,
          outcome: { status, paid: false, ...outcome },
          userId: park.userId,
          parkedEventId,
        },
      });
      return { park: { parkedEventId, status, ...said } };
    };

    // Driving again without ever having left, or back at the car before
    // anything was paid: the park is over, and so is anything it was asked.
    if (step.droveOff) return close("cancelled", "park_cancelled_at_return", "drove_off", {});
    if (step.returned) {
      // A drive-off read from pace closes it too: a tap after it would pay
      // now for a spot the car may have left, and nothing at the confirm
      // route could tell. It is a guess, so the answer says what it was
      // read from: the phone tells the driver, in words, that nothing will
      // be paid here (the prompt is withdrawn, and the park stays closed).
      const readBy = step.droveOffBy ? { readBy: step.droveOffBy } : {};
      return close("cancelled", "park_cancelled_at_return", step.why ?? "returned", readBy, readBy);
    }
    if (!step.left) {
      await remember(park, step.state);
      return answer(park.status, asked(park));
    }

    // The phone has left the car.
    const rule = step.why === "left_car_event" ? "left_car_event" : "walk_away";
    // A session already running at this very spot pays for it: nothing to
    // ask, and nothing to start a second time.
    if (
      session !== null &&
      (session.carLat === null ||
        session.carLng === null ||
        metersBetween(park.carLat, park.carLng, session.carLat, session.carLng) <= SAME_SPOT_M)
    ) {
      return close("covered", "street_prompt", "already_paid", { coveredBy: session.id });
    }

    if (park.status === "confirmed" && step.why === "left_car_event") {
      // Pay was tapped at the car, and the app has the driver on foot:
      // this is the moment it waited for. Distance alone never pays it: a
      // car stopped at a light a block away reads like a walk-away, so
      // that only asks again (below), and a second tap pays.
      const won = await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: "confirmed" },
        data: { ...step.state, status: "starting", startingAt: at },
      });
      if (won.count === 0) return current();
      const starting = (await deps.db.pendingPark.findUnique({ where: { id: park.id } }))!;
      const outcome = await startParkSession(deps, sessions, starting, {
        at,
        mode: "tap",
        trigger: "walk_away",
        fix,
      });
      switch (outcome.kind) {
        case "started":
          return answer("started", { started: outcome.body });
        case "free":
          return answer("free");
        case "covered":
          return answer("covered");
        case "failed":
          return answer("start_failed", { startFailed: outcome.body });
        case "quote_changed":
        case "refused":
          // Not paid, and nothing reached the provider: asked now, with
          // the phone away from the car, as things stand now.
          return answer("prompted", outcome.prompt ? { prompt: outcome.prompt } : {});
      }
    }

    const built = await buildParkPrompt(deps, park, at);
    if (built.kind !== "prompt") {
      // The meters stopped charging while the car sat: nothing to ask.
      return close("free", "street_prompt", "free_now", {});
    }
    // From at_car, or from an early Pay that distance alone can't start.
    const moved = await deps.db.pendingPark.updateMany({
      where: { id: park.id, status: park.status },
      data: {
        ...step.state,
        status: "prompted",
        promptedAt: at,
        prompt: built.prompt,
        shownDryRun: built.prompt.dryRun,
        ...(built.quote ? { quote: built.quote } : {}),
      },
    });
    // Another fix asked first: answer with what it asked.
    if (moved.count === 0) return current();
    const asking = await deps.db.decision.create({
      data: {
        kind: "street_prompt",
        inputs: {
          parkedEventId,
          parkStatus: park.status,
          fix,
          parkedAt: park.parkedAt.toISOString(),
          quotedAtPark: park.quote,
          ...ledger(),
        },
        rule,
        outcome: { prompt: built.prompt, quote: built.quote },
        userId: park.userId,
        parkedEventId,
      },
    });
    return answer("prompted", { prompt: built.prompt, decisionId: asking.id });
  }

  app.post("/location", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const at = now();

    const session = await deps.db.session.findFirst({
      where: { userId: user.id, status: "active" },
    });
    const newest = await deps.db.pendingPark.findFirst({
      where: { userId: user.id, status: { in: PARK_OPEN } },
      orderBy: { createdAt: "desc" },
    });
    if (newest?.parkedEventId) {
      // One park waits at a time: an older one still open is over, unless
      // it is mid-start (its session may be seconds from existing).
      await supersedeParks(
        deps,
        user.id,
        { id: newest.id, parkedEventId: newest.parkedEventId },
        at,
      );
    }
    const park = newest ? await settlePark(deps, newest, at) : null;
    const waiting = park !== null && PARK_OPEN.includes(park.status) && park.parkedEventId !== null;

    if (!session && !waiting) {
      if (park && newest && park.status !== newest.status && park.parkedEventId !== null) {
        // It ran out of time on this very request (nobody walked away
        // from it, or answered, within the hour): said once, so the app
        // can tell the driver, and then there is nothing to report to.
        return { ok: true, park: { parkedEventId: park.parkedEventId, status: park.status } };
      }
      return reply.code(409).send({ error: "no_active_session" });
    }

    const forTheSession = session ? await forSession(session, body, at) : {};
    // The session may have just ended on this fix; a waiting park then
    // has no running session to be weighed against.
    const stillRunning = session && !("ended" in forTheSession) ? session : null;
    const forThePark = waiting ? await forPark(park, stillRunning, body, at) : {};
    return { ok: true, ...forTheSession, ...forThePark };
  });
}
