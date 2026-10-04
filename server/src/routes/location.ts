/**
 * Phone fixes: where the driver is relative to the car. They are reported
 * while a park waits for its walk-away and while a session is active (the
 * iOS LocationReporter), and they are what moves the street session
 * lifecycle (FR-55, services/pendingSession.ts):
 *
 *  - the phone leaving the car is when the driver is asked to pay (or,
 *    for a Pay tapped early, when the session starts);
 *  - the phone coming back ends the session, or cancels a park nobody
 *    paid for.
 *
 * Nothing here asks, pays, or ends anything on a fix that shows the phone
 * at the car, is older than the park, or belongs to someone else: every
 * read is of the caller's own park and session. Fixes of an active session
 * are also stored for the extension worker. Each transition writes a
 * decisions row carrying the fix that caused it.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { PendingParkRow, SessionRow } from "../db.js";
import { haversineM } from "../jobs/extendTick.js";
import type { FixRecord, ParkPrompt, WalkStep } from "../services/pendingSession.js";
import {
  PARK_OPEN,
  advanceWalk,
  buildParkPrompt,
  fixCountsFor,
  settlePark,
  startParkSession,
  walkStateOf,
} from "../services/pendingSession.js";
import { supportsEarlyStop } from "../services/sessions.js";
import type { SessionOps } from "./session.js";

const bodySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().nonnegative().lte(10_000),
  ts: z.iso.datetime({ offset: true }),
  // What the app itself saw: on foot after the park, or back at the car
  // (its audio reconnecting, driving again).
  event: z.enum(["left_car", "returned_to_car"]).optional(),
});

type Body = z.infer<typeof bodySchema>;

export function registerLocation(app: FastifyInstance, deps: AppDeps, sessions: SessionOps): void {
  const now = () => deps.now?.() ?? new Date();
  const ledger = () => ({
    dryRun: deps.policy.effectiveDryRun(),
    policyHash: deps.policy.hash(),
  });

  /** The lifecycle row of a session: its park's, or one made for a
   * session that started outside the lifecycle (an older build). */
  async function parkOf(session: SessionRow): Promise<PendingParkRow | null> {
    const own = await deps.db.pendingPark.findUnique({ where: { sessionId: session.id } });
    if (own) return own;
    if (session.carLat === null || session.carLng === null) return null;
    const earlier = session.parkedEventId
      ? await deps.db.pendingPark.findUnique({ where: { parkedEventId: session.parkedEventId } })
      : null;
    try {
      if (earlier) {
        // Declined, then paid by hand: the same park, now with a session.
        return await deps.db.pendingPark.update({
          where: { id: earlier.id },
          data: { status: "started", sessionId: session.id, closedAt: null },
        });
      }
      return await deps.db.pendingPark.create({
        data: {
          userId: session.userId,
          ...(session.parkedEventId ? { parkedEventId: session.parkedEventId } : {}),
          status: "started",
          sessionId: session.id,
          carLat: session.carLat,
          carLng: session.carLng,
          parkedAt: session.startedAt ?? session.createdAt,
        },
      });
    } catch (err) {
      // Two fixes at once: the other one made the row.
      if ((err as { code?: string }).code !== "P2002") throw err;
      return deps.db.pendingPark.findUnique({ where: { sessionId: session.id } });
    }
  }

  function measure(park: PendingParkRow, body: Body): FixRecord {
    return {
      lat: body.lat,
      lng: body.lng,
      accuracyM: body.accuracy,
      ts: body.ts,
      distanceM: Math.round(haversineM(body.lat, body.lng, park.carLat, park.carLng) * 10) / 10,
      ...(body.event ? { event: body.event } : {}),
    };
  }

  /** The phone came back to a session's car: end it. Called by the one
   * request that moved the park to `ended`. */
  async function endAtReturn(
    session: SessionRow,
    park: PendingParkRow,
    step: WalkStep,
    fix: FixRecord,
    at: Date,
  ): Promise<Record<string, unknown>> {
    const inputs = {
      why: step.why,
      fix,
      leftCarAt: park.leftCarAt?.toISOString() ?? null,
      expiresAt: session.expiresAt?.toISOString() ?? null,
      ...ledger(),
    };
    const row = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: {
          kind: "session_end_return",
          inputs,
          rule,
          outcome,
          userId: session.userId,
          sessionId: session.id,
          ...(park.parkedEventId ? { parkedEventId: park.parkedEventId } : {}),
        },
      });

    if (!supportsEarlyStop(session.zoneId)) {
      // The time already bought can't be handed back, and nothing more is
      // bought: the session is over for us, and the provider isn't asked.
      await deps.db.session.update({
        where: { id: session.id },
        data: { status: "stopped", stoppedAt: at },
      });
      await deps.db.sessionEvent.create({
        data: {
          sessionId: session.id,
          kind: "ended_at_return",
          at,
          dryRun: session.dryRun,
          details: { why: step.why, paidUntil: inputs.expiresAt },
        },
      });
      await row("ended_at_return", { stopped: false, paidUntil: inputs.expiresAt });
      return { reason: "returned", stopped: false };
    }

    const stopped = await sessions.stop(session.userId, session);
    if (stopped.status === 200) {
      await row("stopped_at_return", { stopped: true, stoppedAt: at.toISOString() });
      return { reason: "returned", stopped: true };
    }
    // The provider didn't stop it. The park is over all the same (nothing
    // more is bought); the session runs out on its own, and Stop in the
    // app still works.
    await row("stop_failed", {
      stopped: false,
      error: stopped.body["error"],
      code: stopped.body["code"],
    });
    return { reason: "returned", stopped: false, error: stopped.body["error"] };
  }

  app.post("/location", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const at = now();
    const fixAt = new Date(body.ts);

    const session = await deps.db.session.findFirst({
      where: { userId: user.id, status: "active" },
    });

    if (session) {
      await deps.db.locationFix.create({
        data: {
          sessionId: session.id,
          userId: user.id,
          lat: body.lat,
          lng: body.lng,
          accuracyM: body.accuracy,
          ts: fixAt,
        },
      });
      const answer = { ok: true, sessionId: session.id };
      const park = await parkOf(session);
      // No car fix to measure from, or a park that already ended (a stop
      // the provider refused): the fix is stored and decides nothing.
      if (!park || park.status !== "started" || !fixCountsFor(park.parkedAt, fixAt, at)) {
        return answer;
      }
      const fix = measure(park, body);
      const step = advanceWalk(walkStateOf(park), {
        distanceM: fix.distanceM,
        accuracyM: fix.accuracyM,
        at: fixAt,
        event: body.event,
      });
      if (!step.returned) {
        await deps.db.pendingPark.update({ where: { id: park.id }, data: step.state });
        return answer;
      }
      const ended = await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: "started" },
        data: { ...step.state, status: "ended", closedAt: at },
      });
      // Another report of the same return got there first.
      if (ended.count === 0) return answer;
      return { ...answer, ended: await endAtReturn(session, park, step, fix, at) };
    }

    // No session: a park waiting on its walk-away, or on the tap.
    const newest = await deps.db.pendingPark.findFirst({
      where: { userId: user.id, status: { in: PARK_OPEN } },
      orderBy: { createdAt: "desc" },
    });
    const park = newest ? await settlePark(deps, newest, at) : null;
    if (!park || !PARK_OPEN.includes(park.status) || park.parkedEventId === null) {
      return reply.code(409).send({ error: "no_active_session" });
    }
    const parkedEventId = park.parkedEventId;
    const answer = (status: string, extra: Record<string, unknown> = {}) => ({
      ok: true,
      park: { parkedEventId, status },
      ...extra,
    });
    /** The prompt already given, again: a lost reply is asked for by the
     * next fix, and the phone shows a park's prompt once. */
    const asked = (row: PendingParkRow) =>
      row.status === "prompted" && row.prompt ? { prompt: row.prompt as ParkPrompt } : {};

    if (park.status === "starting" || !fixCountsFor(park.parkedAt, fixAt, at)) {
      return answer(park.status, asked(park));
    }
    const fix = measure(park, body);
    const step = advanceWalk(walkStateOf(park), {
      distanceM: fix.distanceM,
      accuracyM: fix.accuracyM,
      at: fixAt,
      event: body.event,
    });
    const cancelled = async (rule: string) => {
      const moved = await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: park.status },
        data: { ...step.state, status: "cancelled", closedAt: at },
      });
      if (moved.count === 0) return answer(park.status);
      await deps.db.decision.create({
        data: {
          kind: "park_cancelled_at_return",
          inputs: {
            parkedEventId,
            parkStatus: park.status,
            fix,
            leftCarAt: park.leftCarAt?.toISOString() ?? null,
            ...ledger(),
          },
          rule,
          outcome: { status: "cancelled", paid: false },
          userId: user.id,
          parkedEventId,
        },
      });
      return answer("cancelled");
    };

    // Driving again without ever having left, or back at the car before
    // anything was paid: the park is over, and so is anything it was asked.
    if (step.droveOff) return cancelled("drove_off");
    if (step.returned) return cancelled(step.why ?? "returned");
    if (!step.left) {
      await deps.db.pendingPark.update({ where: { id: park.id }, data: step.state });
      return answer(park.status, asked(park));
    }

    // The phone has left the car.
    const rule = step.why === "left_car_event" ? "left_car_event" : "walk_away";
    if (park.status === "confirmed") {
      // Pay was tapped at the car: this is the moment it waited for.
      const won = await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: "confirmed" },
        data: { ...step.state, status: "starting", startingAt: at },
      });
      if (won.count === 0) return answer(park.status);
      const starting = (await deps.db.pendingPark.findUnique({ where: { id: park.id } }))!;
      const outcome = await startParkSession(deps, sessions.start, starting, {
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
        case "failed":
          return answer("start_failed", { startFailed: outcome.body });
        case "quote_changed":
        case "refused":
          // Not paid, and nothing reached the provider: asked now, with
          // the phone away from the car, at what it costs now.
          return answer("prompted", outcome.prompt ? { prompt: outcome.prompt } : {});
      }
    }

    const built = await buildParkPrompt(deps, park, at);
    if (built.kind !== "prompt") {
      // The meters stopped charging while the car sat: nothing to ask.
      await deps.db.pendingPark.updateMany({
        where: { id: park.id, status: "at_car" },
        data: { ...step.state, status: "free", closedAt: at },
      });
      return answer("free");
    }
    const moved = await deps.db.pendingPark.updateMany({
      where: { id: park.id, status: "at_car" },
      data: {
        ...step.state,
        status: "prompted",
        promptedAt: at,
        prompt: built.prompt,
        ...(built.quote ? { quote: built.quote } : {}),
      },
    });
    if (moved.count === 0) {
      // Another fix asked first: answer with what it asked.
      const current = await deps.db.pendingPark.findUnique({ where: { id: park.id } });
      return answer(current?.status ?? park.status, current ? asked(current) : {});
    }
    const asking = await deps.db.decision.create({
      data: {
        kind: "street_prompt",
        inputs: {
          parkedEventId,
          fix,
          parkedAt: park.parkedAt.toISOString(),
          quotedAtPark: park.quote,
          ...ledger(),
        },
        rule,
        outcome: { prompt: built.prompt, quote: built.quote },
        userId: user.id,
        parkedEventId,
      },
    });
    return answer("prompted", { prompt: built.prompt, decisionId: asking.id });
  });
}
