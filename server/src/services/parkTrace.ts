/**
 * A park's trace: everything that says what happened to one park, as one
 * document. Its parked event, every /location fix it read or refused
 * (park_fixes), the park's own timeline, every decisions row for the park
 * or its session, and the session with its events (what the executor was
 * asked and answered). GET /admin/parks/:id/trace serves it;
 * `pnpm -C server trace:export` turns it into an anonymized fixture that
 * `trace:replay` and the golden tests (server/test/traces) run through the
 * lifecycle. docs/park-traces.md says how a field-test park becomes a
 * regression test.
 */

import type { AppDb, ParkFixRow, PendingParkRow, SessionRow } from "../db.js";
import { metersBetween, parkCandidates } from "./pendingSession.js";
import type { ParkCandidate } from "./pendingSession.js";

/** park_fixes older than this are deleted (the retention job). */
export const PARK_FIX_RETENTION_DAYS = 30;

export interface ParkTrace {
  park: PendingParkRow;
  parkedEvent: { id: string; userId: string; lat: number; lng: number; ts: Date } | null;
  fixes: ParkFixRow[];
  /** When the park reached each state it has a timestamp for. pending_parks
   * keeps the latest of each, not every move; the decisions say the rest. */
  timeline: { at: Date; status: string }[];
  decisions: {
    id: string;
    kind: string;
    rule: string;
    inputs: unknown;
    outcome: unknown;
    sessionId: string | null;
    createdAt: Date;
  }[];
  session: SessionRow | null;
  sessionEvents: { kind: string; at: Date; details?: unknown }[];
}

/** The trace of a park, by its pending_parks id or its parkedEventId. */
export async function buildParkTrace(db: AppDb, id: string): Promise<ParkTrace | null> {
  const park =
    (await db.pendingPark.findUnique({ where: { id } })) ??
    (await db.pendingPark.findUnique({ where: { parkedEventId: id } }));
  if (!park) return null;
  const parkedEvent = park.parkedEventId
    ? await db.parkedEvent.findUnique({ where: { id: park.parkedEventId } })
    : null;
  const fixes = await db.parkFix.findMany({
    where: { pendingParkId: park.id },
    orderBy: { receivedAt: "asc" },
  });
  const session = park.sessionId
    ? await db.session.findUnique({ where: { id: park.sessionId } })
    : null;
  const byPark = park.parkedEventId
    ? await db.decision.findMany({ where: { parkedEventId: park.parkedEventId } })
    : [];
  const bySession = park.sessionId
    ? await db.decision.findMany({ where: { sessionId: { in: [park.sessionId] } } })
    : [];
  const seen = new Set<string>();
  const decisions = [...byPark, ...bySession]
    .filter((d) => !seen.has(d.id) && seen.add(d.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      rule: d.rule,
      inputs: d.inputs,
      outcome: d.outcome,
      sessionId: d.sessionId,
      createdAt: d.createdAt,
    }));
  const sessionEvents = park.sessionId
    ? (
        await db.sessionEvent.findMany({
          where: { sessionId: { in: [park.sessionId] } },
          orderBy: { at: "asc" },
        })
      ).map((e) => ({ kind: e.kind, at: e.at, details: e.details }))
    : [];
  const stamped: [Date | null, string][] = [
    [park.createdAt, "at_car"],
    [park.promptedAt, "prompted"],
    [park.confirmedAt, "confirmed"],
    [park.startingAt, "starting"],
    [session?.startedAt ?? null, "started"],
    [park.closedAt, park.status],
  ];
  const timeline = stamped
    .filter((s): s is [Date, string] => s[0] !== null)
    .map(([at, status]) => ({ at, status }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return { park, parkedEvent, fixes, timeline, decisions, session, sessionEvents };
}

/** A park's tap, as a fixture replays it. */
export interface FixtureTap {
  /** Seconds after the park. */
  atS: number;
  kind: "confirm" | "decline";
  zoneId?: string;
  shownTotalUsd?: number;
}

/** One fix of a fixture: where the phone was relative to the car, when. */
export interface FixtureFix {
  /** Seconds after the park the server received it, the phone measured
   * it, and the phone stamped it (its `ts`). */
  receivedS: number;
  measuredS: number;
  reportedS: number;
  /** Metres north and east of the car. */
  northM: number;
  eastM: number;
  accuracyM: number;
  speedMps?: number;
  event?: string;
  motionActivity?: string;
  motionConfidence?: string;
  btHint?: string;
  /** Why the park refused it when it was recorded (null: read). */
  rejected?: string | null;
}

/**
 * A park as a regression test: no user id, no coordinates, no dates. The
 * car is the origin, times count from the park, and the park's wall-clock
 * start is a weekday and a New York time of day (so a replay prices the
 * same meter hours). `expected` is what the replay must end with.
 */
export interface TraceFixture {
  version: 1;
  name: string;
  note?: string;
  parkedAt: { weekday: string; time: string };
  /** What the phone sent at /parked beyond the fix itself. */
  outcomes: string[];
  candidates: ParkCandidate[];
  fixes: FixtureFix[];
  taps: FixtureTap[];
  expected?: FixtureOutcome;
}

/** What a replay ends with, and the park states it passed through. */
export interface FixtureOutcome {
  statuses: string[];
  park: string;
  session: string | null;
  starts: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Metres north and east of `origin`. */
function offsetM(origin: { lat: number; lng: number }, at: { lat: number; lng: number }) {
  const north = metersBetween(origin.lat, origin.lng, at.lat, origin.lng);
  const east = metersBetween(origin.lat, origin.lng, origin.lat, at.lng);
  return {
    northM: round1(at.lat >= origin.lat ? north : -north),
    eastM: round1(at.lng >= origin.lng ? east : -east),
  };
}

/** A weekday and an "HH:MM" in New York, for a park's wall-clock start. */
function nyWallClock(at: Date): { weekday: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: part("weekday"), time: `${part("hour")}:${part("minute")}` };
}

/** The trace as a fixture: relative, and with nothing that names the driver. */
export function traceToFixture(trace: ParkTrace, name: string): TraceFixture {
  const car = { lat: trace.park.carLat, lng: trace.park.carLng };
  const t0 = trace.park.parkedAt.getTime();
  const secondsAfter = (at: Date) => Math.round((at.getTime() - t0) / 100) / 10;
  const fixes: FixtureFix[] = trace.fixes.map((f) => ({
    receivedS: secondsAfter(f.receivedAt),
    measuredS: secondsAfter(f.measuredAt),
    reportedS: secondsAfter(f.reportedAt),
    ...offsetM(car, f),
    accuracyM: f.accuracyM,
    ...(f.speedMps !== null ? { speedMps: f.speedMps } : {}),
    ...(f.event !== null ? { event: f.event } : {}),
    ...(f.motionActivity !== null ? { motionActivity: f.motionActivity } : {}),
    ...(f.motionConfidence !== null ? { motionConfidence: f.motionConfidence } : {}),
    ...(f.btHint !== null ? { btHint: f.btHint } : {}),
    rejected: f.rejected,
  }));
  const taps: FixtureTap[] = trace.decisions
    .filter((d) => d.kind === "street_confirmed" || d.kind === "street_declined")
    .map((d) => {
      const inputs = (d.inputs ?? {}) as { zoneId?: string; shown?: { totalUsd?: number } };
      return {
        atS: secondsAfter(d.createdAt),
        kind: d.kind === "street_confirmed" ? ("confirm" as const) : ("decline" as const),
        ...(inputs.zoneId ? { zoneId: inputs.zoneId } : {}),
        ...(typeof inputs.shown?.totalUsd === "number"
          ? { shownTotalUsd: inputs.shown.totalUsd }
          : {}),
      };
    });
  return {
    version: 1,
    name,
    parkedAt: nyWallClock(trace.park.parkedAt),
    outcomes: ["garage", "nopay", "walk_away"],
    candidates: parkCandidates(trace.park),
    fixes,
    taps,
  };
}
