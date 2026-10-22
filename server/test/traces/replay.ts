/**
 * Replay a park fixture (services/parkTrace.ts TraceFixture) through the
 * lifecycle: the real /parked, /location and tap routes over the fake DB,
 * on a clock the replay moves. The car stands at one reference point, the
 * park starts on the fixture's weekday and New York time in the week of
 * 2026-01-05, and every fix and tap lands at its own second. What comes
 * back is the park's status after each step and how it ended.
 *
 * Used by golden.test.ts (every server/test/traces/*.json) and by
 * `pnpm -C server trace:replay <fixture>` (replay-cli.ts).
 */

import type { ZoneTermsRow } from "../../src/db.js";
import type { Executor } from "../../src/services/executor.js";
import { DryRunExecutor } from "../../src/services/executor.js";
import type {
  FixtureOutcome,
  FixtureFix,
  FixtureTap,
  TraceFixture,
} from "../../src/services/parkTrace.js";
import type { Candidate } from "../../src/services/zoneLookup.js";
import { API_KEY, makeTestApp } from "../helpers.js";

/** Where every replayed car stands (30th Ave & Steinway). */
const CAR = { lat: 40.7784, lng: -73.9819 };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HEADERS = { "x-api-key": API_KEY };

export interface ReplayStep {
  atS: number;
  what: string;
  status: number;
  park: string;
}

export interface Replay {
  steps: ReplayStep[];
  outcome: FixtureOutcome;
}

/** The park's start: its weekday and New York time in the week of
 * Monday 2026-01-05 (EST, no DST change that week). */
function parkedAtOf(fixture: TraceFixture): Date {
  const day = WEEKDAYS.indexOf(fixture.parkedAt.weekday);
  if (day < 0) throw new Error(`fixture ${fixture.name}: weekday ${fixture.parkedAt.weekday}`);
  const date = String(5 + day).padStart(2, "0");
  return new Date(`2026-01-${date}T${fixture.parkedAt.time}:00-05:00`);
}

function fixBody(fix: FixtureFix, t0: number) {
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const metresPerDegLng = 111_320 * Math.cos((CAR.lat * Math.PI) / 180);
  return {
    lat: CAR.lat + fix.northM / 111_320,
    lng: CAR.lng + fix.eastM / metresPerDegLng,
    accuracy: fix.accuracyM,
    ts: at(fix.reportedS),
    // A phone that didn't say when it measured sent no measuredAt.
    ...(fix.measuredS !== fix.reportedS ? { measuredAt: at(fix.measuredS) } : {}),
    ...(fix.speedMps !== undefined ? { speedMps: fix.speedMps } : {}),
    ...(fix.event !== undefined ? { event: fix.event } : {}),
    ...(fix.motionActivity !== undefined ? { motionActivity: fix.motionActivity } : {}),
    ...(fix.motionConfidence !== undefined ? { motionConfidence: fix.motionConfidence } : {}),
    ...(fix.btHint !== undefined ? { btHint: fix.btHint } : {}),
  };
}

export async function replayFixture(fixture: TraceFixture): Promise<Replay> {
  const t0 = parkedAtOf(fixture).getTime();
  const clock = { now: new Date(t0) };
  let starts = 0;
  const dry = new DryRunExecutor(
    () => {},
    () => clock.now,
  );
  const executor: Executor = {
    startSession: (args) => {
      starts += 1;
      return dry.startSession(args);
    },
    extendSession: (args) => dry.extendSession(args),
    stopSession: (args) => dry.stopSession(args),
  };
  const candidates: Candidate[] = fixture.candidates.map((c) => ({
    zoneId: c.zoneId,
    ...(c.city ? { city: c.city } : {}),
    providerZoneNumber: c.providerZoneNumber,
    rateFirstHourUsd: c.rateFirstHourUsd,
    rateAdditionalHourUsd: c.rateAdditionalHourUsd,
    maxStayMinutes: c.maxStayMinutes,
    hours: c.hours,
    distanceM: 5,
    containsPoint: true,
  }));
  const zones: ZoneTermsRow[] = fixture.candidates.map((c) => ({
    zoneId: c.zoneId,
    ...(c.city ? { city: c.city } : {}),
    providerZoneNumber: c.providerZoneNumber,
    rateFirstHour: c.rateFirstHourUsd,
    rateAdditionalHour: c.rateAdditionalHourUsd,
    maxStayMinutes: c.maxStayMinutes,
    hoursJson: c.hours,
  }));
  const t = makeTestApp({ candidates, zones, now: () => clock.now, executor });
  const post = (url: string, payload: object) =>
    t.app.inject({ method: "POST", url, headers: HEADERS, payload });

  const parked = await post("/parked", {
    lat: CAR.lat,
    lng: CAR.lng,
    accuracy: 10,
    ts: clock.now.toISOString(),
    signals: ["motion_stop"],
    outcomes: fixture.outcomes,
  });
  const parkedEventId = (parked.json() as { parkedEventId: string }).parkedEventId;
  const parkStatus = () =>
    t.state.pendingParks.find((p) => p.parkedEventId === parkedEventId)?.status ?? "not_held";
  const steps: ReplayStep[] = [
    { atS: 0, what: "parked", status: parked.statusCode, park: parkStatus() },
  ];

  type Event = { atS: number; order: number } & (
    { kind: "fix"; fix: FixtureFix } | { kind: "tap"; tap: FixtureTap }
  );
  const events: Event[] = [
    ...fixture.fixes.map((fix, i) => ({ atS: fix.receivedS, order: i, kind: "fix" as const, fix })),
    ...fixture.taps.map((tap, i) => ({ atS: tap.atS, order: i, kind: "tap" as const, tap })),
  ].sort(
    (a, b) => a.atS - b.atS || (a.kind === b.kind ? a.order - b.order : a.kind === "tap" ? -1 : 1),
  );

  for (const event of events) {
    clock.now = new Date(t0 + event.atS * 1000);
    if (event.kind === "fix") {
      const f = event.fix;
      const res = await post("/location", fixBody(f, t0));
      const where = `${f.northM} m N ${f.eastM} m E ±${f.accuracyM}`;
      const extra = [f.event, f.speedMps !== undefined ? `${f.speedMps} m/s` : null]
        .filter(Boolean)
        .join(" ");
      steps.push({
        atS: event.atS,
        what: `fix ${where}${extra ? ` ${extra}` : ""}`,
        status: res.statusCode,
        park: parkStatus(),
      });
    } else {
      const tap = event.tap;
      const url = `/parked/${parkedEventId}/${tap.kind === "confirm" ? "confirm" : "decline"}`;
      const res = await post(url, {
        ...(tap.zoneId ? { zoneId: tap.zoneId } : {}),
        ...(tap.kind === "confirm" && tap.shownTotalUsd !== undefined
          ? { shownTotalUsd: tap.shownTotalUsd }
          : {}),
      });
      steps.push({
        atS: event.atS,
        what: `tap ${tap.kind}`,
        status: res.statusCode,
        park: parkStatus(),
      });
    }
  }

  const statuses = steps
    .map((s) => s.park)
    .filter((status, i, all) => i === 0 || status !== all[i - 1]);
  const session = t.state.sessions.find((s) => s.parkedEventId === parkedEventId) ?? null;
  return {
    steps,
    outcome: { statuses, park: parkStatus(), session: session?.status ?? null, starts },
  };
}
