/**
 * "Does this user have a session awaiting payment right now?" — the
 * question the issuing webhook asks before approving an authorization.
 * True when the user has a pending or active session that started (or,
 * while still pending, was created) within the last 10 minutes — the
 * window in which the executor's ParkNYC charge should arrive.
 */

import type { AppDb, PendingParkRow, SessionRow } from "../db.js";
import { cityForZone, providerForCity, providerStatusUsable } from "../providers/registry.js";
import type { HoursInterval } from "./hours.js";
import { easternWallClock } from "./hours.js";
import { policyFor } from "./limits.js";
import type { Policy } from "./policy.js";
import type { Quote, ZoneTerms } from "./quote.js";
import { quoteZone } from "./quote.js";
import { spentToday, supportsEarlyStop } from "./sessions.js";
import { effectiveTerms, observedTermsFor } from "./zoneTermsObserved.js";

export type PendingSessionCheck = (userId: string, at: Date) => Promise<boolean>;

export const PENDING_SESSION_WINDOW_MINUTES = 10;

export function makePendingSessionCheck(db: AppDb): PendingSessionCheck {
  return async (userId, at) => {
    const cutoff = new Date(at.getTime() - PENDING_SESSION_WINDOW_MINUTES * 60_000);
    const rows = await db.session.findMany({
      where: { userId, status: { in: ["pending", "active"] } },
    });
    return rows.some((s) => (s.startedAt ?? s.createdAt) >= cutoff);
  };
}

/** Conservative fallback when no check is wired: nothing is ever pending. */
export const noPendingSessions: PendingSessionCheck = async () => false;

// ---------------------------------------------------------------------------
// The street session lifecycle (FR-55)
// ---------------------------------------------------------------------------
//
// A street session is active from the moment the phone leaves the car until
// it comes back. A detected park waits (`pending_parks`, status at_car):
// nothing is asked, paid, or extended while the phone is at the car. The
// phone's fixes (POST /location) show it leaving, and that is when the
// driver is asked — one tap on the amount the server quoted. Coming back
// ends it. Everything below is the rule set; routes/parked.ts and
// routes/location.ts apply it.

/** States in which a park is still waiting on the phone or the driver. */
export const PARK_OPEN = ["at_car", "confirmed", "prompted", "starting"];
/** …and those a newer park takes the place of. Never one mid-start: its
 * session may be seconds from existing. */
export const PARK_SUPERSEDABLE = ["at_car", "confirmed", "prompted"];
/** Every state, for "this user's newest park, whatever became of it". */
export const PARK_STATUSES = [
  ...PARK_OPEN,
  "started",
  "declined",
  "cancelled",
  "superseded",
  "covered",
  "expired",
  "free",
  "start_failed",
  "ended",
];

/** Within this of the car's fix the phone is at the car. */
export const AT_CAR_RADIUS_M = 30;
/** Back at the car for this long is a return. */
export const RETURN_DWELL_MS = 60_000;
/** The app's own "back at the car" counts within this of the car. */
export const RETURN_EVENT_RADIUS_M = 75;
/** A fix blurrier than this says nothing about where the phone is. */
export const FIX_USABLE_ACCURACY_M = 65;
/** Leaving takes two measurements clear of the car at least this far
 * apart: one fix a hundred metres off is what GPS does between tall
 * buildings. */
export const LEAVE_CONFIRM_MS = 10_000;
/** …and no faster than this between them. A car pulling away covers the
 * same ground as a driver on foot, only quicker, and it is not a
 * walk-away. */
export const MAX_WALK_MPS = 3;
/** The app's "left the car" is refused only by a sharp fix this close. */
export const DOOR_RADIUS_M = 10;
export const DOOR_ACCURACY_M = 20;
/** A report older than this describes where the phone was. */
export const LIFECYCLE_FIX_MAX_AGE_MS = 5 * 60_000;
/** A park nobody walked away from in this long is not asked about. */
export const PARK_TTL_MS = 60 * 60_000;
/** A start that never came back (a crash mid-start) stops blocking. */
export const STARTING_STALE_MS = 10 * 60_000;
/** Two car fixes this close are the same spot; farther, the car moved. */
export const SAME_SPOT_M = 100;

/** What the app itself saw: on foot after the park, or the car's audio
 * reconnecting / driving again. */
export type PhoneEvent = "left_car" | "returned_to_car";

export interface WalkState {
  /** When the phone was first known to have left the car. */
  leftCarAt: Date | null;
  /** Before leaving: when the first of the two measurements that show it
   * was taken. After: when a fix first put the phone clear of the car (a
   * return by distance needs one). */
  farAt: Date | null;
  /** How far from the car that first measurement was. */
  farDistanceM: number | null;
  /** Since when every usable fix has been at the car. */
  nearSince: Date | null;
}

export interface WalkFix {
  distanceM: number;
  accuracyM: number;
  /** When the phone reported it. */
  at: Date;
  /** When it was measured. The app re-sends its last fix on a heartbeat
   * with a fresh report time: the same measurement, not a second one. */
  measuredAt: Date;
  event?: PhoneEvent | undefined;
}

export type WalkReason =
  "fix_away" | "left_car_event" | "near_for_60s" | "returned_event" | "drove_off";

export interface WalkStep {
  state: WalkState;
  /** This fix is the one that showed the phone leaving the car. */
  left: boolean;
  /** …or back at it, after having left. */
  returned: boolean;
  /** Driving again without the phone ever having left. */
  droveOff: boolean;
  why: WalkReason | null;
}

/**
 * One fix against where the phone stood. Pure.
 *
 * Leaving: two separate measurements clear of the car even allowing for
 * their own error, at walking pace between them, or the app's own report
 * (on foot) unless a sharp fix has it at the door.
 * Returning: the app's report beside the car, or a minute within reach of
 * it — and that only after a fix put the phone clear of the car, so a
 * driver whose errand is right beside the car isn't "back" the whole time.
 */
export function advanceWalk(before: WalkState, fix: WalkFix): WalkStep {
  const state = { ...before };
  const usable = fix.accuracyM <= FIX_USABLE_ACCURACY_M;
  const near = usable && fix.distanceM <= AT_CAR_RADIUS_M;
  const clear = usable && fix.distanceM - fix.accuracyM > AT_CAR_RADIUS_M;
  const step = (extra: Partial<WalkStep>): WalkStep => ({
    state,
    left: false,
    returned: false,
    droveOff: false,
    why: null,
    ...extra,
  });

  if (state.leftCarAt === null) {
    if (fix.event === "returned_to_car") return step({ droveOff: true, why: "drove_off" });
    if (clear) {
      const first = state.farAt;
      const sinceMs = first === null ? 0 : fix.measuredAt.getTime() - first.getTime();
      if (first === null) {
        state.farAt = fix.measuredAt;
        state.farDistanceM = fix.distanceM;
      } else if (fix.distanceM === state.farDistanceM) {
        // The very same spot to the decimetre: the first measurement sent
        // again (by a client that doesn't say when it measured), not a
        // second one.
      } else if (sinceMs >= LEAVE_CONFIRM_MS) {
        const paceMps =
          Math.abs(fix.distanceM - (state.farDistanceM ?? fix.distanceM)) / (sinceMs / 1000);
        if (paceMps <= MAX_WALK_MPS) {
          state.leftCarAt = fix.at;
          state.nearSince = null;
          return step({ left: true, why: "fix_away" });
        }
        // Too fast for someone on foot. This measurement is the first of
        // the next pair; a car that keeps driving never makes one.
        state.farAt = fix.measuredAt;
        state.farDistanceM = fix.distanceM;
      }
      // Otherwise the same measurement again, or one too soon after it.
    } else if (usable) {
      state.farAt = null;
      state.farDistanceM = null;
    }
    const atTheDoor = usable && fix.accuracyM <= DOOR_ACCURACY_M && fix.distanceM <= DOOR_RADIUS_M;
    if (fix.event === "left_car" && !atTheDoor) {
      state.leftCarAt = fix.at;
      // On foot, not necessarily far: a return by distance waits for a fix
      // that is clear of the car.
      state.farAt = clear ? fix.measuredAt : null;
      state.farDistanceM = clear ? fix.distanceM : null;
      state.nearSince = null;
      return step({ left: true, why: "left_car_event" });
    }
    return step({});
  }

  if (clear && state.farAt === null) {
    state.farAt = fix.measuredAt;
    state.farDistanceM = fix.distanceM;
  }
  if (fix.event === "returned_to_car" && usable && fix.distanceM <= RETURN_EVENT_RADIUS_M) {
    return step({ returned: true, why: "returned_event" });
  }
  if (near) {
    state.nearSince ??= fix.at;
    if (state.farAt !== null && fix.at.getTime() - state.nearSince.getTime() >= RETURN_DWELL_MS) {
      return step({ returned: true, why: "near_for_60s" });
    }
  } else if (usable) {
    state.nearSince = null;
  }
  return step({});
}

/** Whether a fix may be read at all for this park: measured after the car
 * stopped, and reported now. Anything else describes another moment. */
export function fixCountsFor(
  parkedAt: Date,
  measuredAt: Date,
  reportedAt: Date,
  now: Date,
): boolean {
  return (
    measuredAt.getTime() >= parkedAt.getTime() &&
    Math.abs(now.getTime() - reportedAt.getTime()) <= LIFECYCLE_FIX_MAX_AGE_MS
  );
}

/** Metres between two points (haversine). */
export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const s =
    Math.sin(rad(bLat - aLat) / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ------------------------------------------------------------ the prompt

/** A street candidate as /parked answered it, kept on the park. */
export interface ParkCandidate extends ZoneTerms {
  quote: Quote;
}

export function parkCandidates(park: Pick<PendingParkRow, "candidates">): ParkCandidate[] {
  return Array.isArray(park.candidates) ? (park.candidates as ParkCandidate[]) : [];
}

export type ParkPromptReason =
  "needs_zone_number" | "provider_not_linked" | "session_cap_exceeded" | "daily_cap_exceeded";

/**
 * What the phone shows at walk-away, word for word. `confirm` carries the
 * amount a tap pays; `side` asks which candidate; `attention` says what is
 * in the way of paying here (its amount is what it would cost; nothing
 * pays it by a tap). The phone never composes a number of its own.
 */
export interface ParkPrompt {
  kind: "confirm" | "side" | "attention";
  parkedEventId: string;
  title: string;
  body: string;
  zoneId?: string;
  zoneNumber?: string;
  amountUsd?: number;
  minutes?: number;
  endsAt?: string;
  /** The quote behind the amount, for the app's own sheet to show. */
  quote?: Quote;
  reason?: ParkPromptReason;
  dryRun: boolean;
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/** "1 h 05 m", "45 m", "2 h". */
export function stayLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")} m`;
}

/** "3:05 PM", on the meters' own clock. */
export function clockLabel(at: Date): string {
  const [hour = 0, minute = 0] = easternWallClock(at).slice(11, 16).split(":").map(Number);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

interface PromptDeps {
  db: AppDb;
  policy: { get(): Policy; effectiveDryRun(): boolean };
}

export type BuiltPrompt =
  | { kind: "prompt"; prompt: ParkPrompt; quote: Quote | null }
  /** Nothing to pay any more (the meters stopped charging meanwhile). */
  | { kind: "free" }
  | { kind: "none" };

/**
 * A candidate's terms as the start path would read them right now: the
 * zone's row and anything the provider itself displayed for its number
 * (the same two reads POST /session/start prices from). A prompt quoted
 * from the terms /parked saw could name an amount the start then refuses,
 * every time. The candidate stands in only when the zone's row is gone.
 */
async function termsNow(
  db: AppDb,
  candidate: ParkCandidate,
): Promise<{ terms: ZoneTerms; street: string | null }> {
  const zone = await db.zone.findUnique({ where: { zoneId: candidate.zoneId } });
  if (!zone) return { terms: candidate, street: null };
  const city = zone.city ?? "nyc";
  const live = effectiveTerms(zone, await observedTermsFor(db, city, zone.providerZoneNumber));
  return {
    terms: {
      zoneId: candidate.zoneId,
      city,
      providerZoneNumber: zone.providerZoneNumber,
      rateFirstHourUsd: live.rateFirstHourUsd,
      rateAdditionalHourUsd: live.rateAdditionalHourUsd,
      maxStayMinutes: live.maxStayMinutes,
      hours: zone.hoursJson as HoursInterval[],
    },
    street: zone.street ?? null,
  };
}

/**
 * The prompt for a park as things stand at `at`: quoted now, for the stay
 * the session would buy now, and refused in words when the start path
 * would refuse it. `zoneId` is the driver's choice of side, when made.
 */
export async function buildParkPrompt(
  deps: PromptDeps,
  park: PendingParkRow,
  at: Date,
): Promise<BuiltPrompt> {
  const candidates = parkCandidates(park);
  if (candidates.length === 0 || park.parkedEventId === null) return { kind: "none" };
  const policy = await policyFor(deps, park.userId);
  const dryRun = deps.policy.effectiveDryRun();
  const base = { parkedEventId: park.parkedEventId, dryRun };
  const note = dryRun ? " Dry run — nothing will be charged." : "";

  const chosen =
    park.zoneId !== null
      ? candidates.find((c) => c.zoneId === park.zoneId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  if (!chosen) {
    const totals: string[] = [];
    for (const candidate of candidates) {
      totals.push(usd(quoteZone((await termsNow(deps.db, candidate)).terms, policy, at).totalUsd));
    }
    return {
      kind: "prompt",
      quote: null,
      prompt: {
        ...base,
        kind: "side",
        title: "Which side of the street?",
        body: `The two sides here have different rules (${totals.join(" or ")}). Open ParkAgent and pick yours to pay.${note}`,
      },
    };
  }

  // The number may have been reported since the car stopped.
  const { terms, street } = await termsNow(deps.db, chosen);
  const zoneNumber = terms.providerZoneNumber;
  const quote = quoteZone(terms, policy, at);
  if (quote.totalUsd === 0) return { kind: "free" };

  const provider = providerForCity(cityForZone(chosen.zoneId));
  const account = provider
    ? await deps.db.providerAccount.findUnique({
        where: { userId_provider: { userId: park.userId, provider: provider.id } },
      })
    : null;
  // The start path's own refusals, in its order: said now, in words,
  // rather than offered as a Pay button that would be refused.
  let reason: ParkPromptReason | null = null;
  if (provider && !providerStatusUsable(account?.status)) reason = "provider_not_linked";
  else if (provider && zoneNumber === "") reason = "needs_zone_number";
  else if (quote.totalUsd > policy.session_cap_usd) reason = "session_cap_exceeded";
  else if (
    !dryRun &&
    (await spentToday(deps.db, park.userId, at)) + quote.totalUsd > policy.daily_cap_usd
  ) {
    reason = "daily_cap_exceeded";
  }

  const parkedIn = zoneNumber === "" ? "Parked at a meter" : `Parked in zone ${zoneNumber}`;
  if (reason !== null) {
    const attention = {
      provider_not_linked: {
        title: parkedIn,
        body: `Connect ${provider?.displayName ?? "your parking account"} in ParkAgent to pay here, or pay at the meter.`,
      },
      needs_zone_number: {
        title: "Parked — zone number needed",
        body: "Open ParkAgent and type the zone number from the meter to pay.",
      },
      session_cap_exceeded: {
        title: parkedIn,
        body: `${usd(quote.totalUsd)} is more than ParkAgent pays for one stop, so it won't pay this one. Pay at the meter or in your parking app.`,
      },
      daily_cap_exceeded: {
        title: parkedIn,
        body: `${usd(quote.totalUsd)} is over today's limit, so ParkAgent won't pay it. Pay at the meter or in your parking app.`,
      },
    }[reason];
    return {
      kind: "prompt",
      quote,
      prompt: {
        ...base,
        kind: "attention",
        reason,
        title: attention.title,
        body: attention.body + note,
        zoneId: chosen.zoneId,
        ...(zoneNumber === "" ? {} : { zoneNumber }),
        // What it would cost, for the app to show. No tap pays it.
        amountUsd: quote.totalUsd,
        minutes: quote.stayMinutes,
        quote,
      },
    };
  }

  const endsAt = new Date(at.getTime() + quote.stayMinutes * 60_000);
  const where = street ? ` on ${street}` : "";
  return {
    kind: "prompt",
    quote,
    prompt: {
      ...base,
      kind: "confirm",
      title: `Pay ${usd(quote.totalUsd)} for zone ${zoneNumber}?`,
      body: `${stayLabel(quote.stayMinutes)}${where} · ends ${clockLabel(endsAt)}${dryRun ? " · Dry run, nothing is charged" : ""}`,
      zoneId: chosen.zoneId,
      zoneNumber,
      amountUsd: quote.totalUsd,
      minutes: quote.stayMinutes,
      endsAt: endsAt.toISOString(),
      quote,
    },
  };
}

// ------------------------------------------------------------ transitions

interface LifecycleDeps extends PromptDeps {
  policy: { get(): Policy; hash(): string; effectiveDryRun(): boolean };
}

export const walkStateOf = (park: PendingParkRow): WalkState => ({
  leftCarAt: park.leftCarAt,
  farAt: park.farAt,
  farDistanceM: park.farDistanceM,
  nearSince: park.nearSince,
});

/** A fix as a decisions row records it. */
export interface FixRecord {
  lat: number;
  lng: number;
  accuracyM: number;
  ts: string;
  measuredAt?: string;
  distanceM: number;
  event?: PhoneEvent;
}

/**
 * Close what time has closed, and answer with the row as it now stands: a
 * park nobody walked away from (or answered) within the hour is not asked
 * about, and a start that never came back stops blocking the park — as a
 * failed one, since whether it charged is unknown.
 */
export async function settlePark(
  deps: Pick<LifecycleDeps, "db">,
  park: PendingParkRow,
  at: Date,
): Promise<PendingParkRow> {
  const since = (from: Date | null) => at.getTime() - (from ?? park.createdAt).getTime();
  let closed: string | null = null;
  if (park.status === "at_car" || park.status === "confirmed") {
    // From when the server heard of it, not from the phone's own clock.
    if (since(park.createdAt) > PARK_TTL_MS) closed = "expired";
  } else if (park.status === "prompted") {
    if (since(park.promptedAt ?? park.createdAt) > PARK_TTL_MS) closed = "expired";
  } else if (park.status === "starting") {
    if (since(park.startingAt) > STARTING_STALE_MS) closed = "start_failed";
  }
  if (closed === null) return park;
  await deps.db.pendingPark.updateMany({
    where: { id: park.id, status: park.status },
    data: { status: closed, closedAt: at },
  });
  return (await deps.db.pendingPark.findUnique({ where: { id: park.id } })) ?? park;
}

/**
 * The lifecycle row of a session: its park's, or one made for a session
 * that started outside the lifecycle (an older build). Null when the
 * session has no car fix to measure from.
 */
export async function lifecycleOf(db: AppDb, session: SessionRow): Promise<PendingParkRow | null> {
  const own = await db.pendingPark.findUnique({ where: { sessionId: session.id } });
  if (own) return own;
  if (session.carLat === null || session.carLng === null) return null;
  const earlier = session.parkedEventId
    ? await db.pendingPark.findUnique({ where: { parkedEventId: session.parkedEventId } })
    : null;
  try {
    if (earlier) {
      // Its own park's row, never linked (a start that ran outside the
      // tap): the same park, now with its session.
      return await db.pendingPark.update({
        where: { id: earlier.id },
        data: { status: "started", sessionId: session.id, closedAt: null },
      });
    }
    return await db.pendingPark.create({
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
    // Two requests at once: the other one made the row.
    if ((err as { code?: string }).code !== "P2002") throw err;
    return db.pendingPark.findUnique({ where: { sessionId: session.id } });
  }
}

/** The stop path, as the lifecycle calls it (routes/session.ts SessionOps). */
export type SessionStopper = (
  userId: string,
  session: SessionRow,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface SessionEnd {
  reason: "returned" | "new_park";
  /** False where the provider can't stop early, or refused to. */
  stopped: boolean;
  error?: unknown;
}

/**
 * End a session whose car the driver is done with: the phone came back to
 * it, or the driver paid for a newer park somewhere else. Stopped through
 * the stop path where the provider can stop early; where it can't, the
 * time already bought stays, nothing more is bought, and the provider is
 * never asked. The caller has already closed the lifecycle row, which is
 * what makes this run once.
 */
export async function endSession(
  deps: LifecycleDeps,
  stop: SessionStopper,
  session: SessionRow,
  park: PendingParkRow | null,
  args: { reason: SessionEnd["reason"]; why: string; fix?: FixRecord; at: Date },
): Promise<SessionEnd> {
  const paidUntil = session.expiresAt?.toISOString() ?? null;
  const row = (rule: string, outcome: Record<string, unknown>) =>
    deps.db.decision.create({
      data: {
        kind: "session_end_return",
        inputs: {
          reason: args.reason,
          why: args.why,
          ...(args.fix ? { fix: args.fix } : {}),
          leftCarAt: park?.leftCarAt?.toISOString() ?? null,
          expiresAt: paidUntil,
          dryRun: deps.policy.effectiveDryRun(),
          policyHash: deps.policy.hash(),
        },
        rule,
        outcome,
        userId: session.userId,
        sessionId: session.id,
        ...(park?.parkedEventId ? { parkedEventId: park.parkedEventId } : {}),
      },
    });

  if (!supportsEarlyStop(session.zoneId)) {
    await deps.db.session.update({
      where: { id: session.id },
      data: { status: "stopped", stoppedAt: args.at },
    });
    await deps.db.sessionEvent.create({
      data: {
        sessionId: session.id,
        kind: "ended_at_return",
        at: args.at,
        dryRun: session.dryRun,
        details: { reason: args.reason, why: args.why, paidUntil },
      },
    });
    await row("ended_at_return", { stopped: false, paidUntil });
    return { reason: args.reason, stopped: false };
  }

  const stopped = await stop(session.userId, session);
  if (stopped.status === 200) {
    await row("stopped_at_return", { stopped: true, stoppedAt: args.at.toISOString() });
    return { reason: args.reason, stopped: true };
  }
  // The provider didn't stop it. The park is over all the same (nothing
  // more is bought); the session runs out on its own, and Stop in the app
  // still works.
  await row("stop_failed", {
    stopped: false,
    error: stopped.body["error"],
    code: stopped.body["code"],
  });
  return { reason: args.reason, stopped: false, error: stopped.body["error"] };
}

/**
 * A park was just detected at `point`. If the user has a session running
 * for a car that was somewhere else, the car has moved as far as anyone
 * can tell: nothing more is bought for that session without the driver.
 * It is not stopped here — the new park may be someone else's car the
 * phone rode in — only at the tap that pays for the new one.
 */
export async function noteCarMoved(
  deps: LifecycleDeps,
  userId: string,
  point: { lat: number; lng: number },
  at: Date,
  parkedEventId: string,
): Promise<void> {
  const session = await deps.db.session.findFirst({ where: { userId, status: "active" } });
  if (!session || session.carLat === null || session.carLng === null) return;
  const distanceM = metersBetween(point.lat, point.lng, session.carLat, session.carLng);
  if (distanceM <= SAME_SPOT_M) return;
  const row = await lifecycleOf(deps.db, session);
  if (!row || row.carMovedAt !== null) return;
  await deps.db.pendingPark.update({ where: { id: row.id }, data: { carMovedAt: at } });
  await deps.db.decision.create({
    data: {
      kind: "session_car_moved",
      inputs: {
        car: { lat: session.carLat, lng: session.carLng },
        newPark: point,
        distanceM: Math.round(distanceM),
        newParkedEventId: parkedEventId,
        dryRun: deps.policy.effectiveDryRun(),
        policyHash: deps.policy.hash(),
      },
      rule: "newer_park_elsewhere",
      outcome: { autoExtend: false, stopped: false },
      userId,
      sessionId: session.id,
      parkedEventId,
    },
  });
}

/** The start path, as the lifecycle calls it (routes/session.ts SessionOps). */
export type ParkStarter = (
  user: { id: string },
  body: { parkedEventId: string; zoneId: string; minutes?: number },
  opts?: { maxTotalUsd?: number; shownZoneNumber?: string; shownDryRun?: boolean },
) => Promise<{ status: number; body: Record<string, unknown>; reachedProvider: boolean }>;

/** The start path's refusals that mean "not what the driver agreed to". */
const CHANGED_RULES = ["quote_changed", "zone_number_changed", "dry_run_changed"];

export type ParkStartOutcome =
  | { kind: "started"; body: Record<string, unknown> }
  | { kind: "free"; body: Record<string, unknown> }
  /** What was agreed to no longer holds (the amount, the zone number, or
   * a dry run that is now real): asked again, as it stands now. */
  | { kind: "quote_changed"; prompt: ParkPrompt | null }
  /** A running session already pays this spot: nothing to start. */
  | { kind: "covered"; sessionId: string }
  /** Refused before the provider was asked: the park can still be paid. */
  | { kind: "refused"; status: number; body: Record<string, unknown>; prompt: ParkPrompt | null }
  /** The provider was asked and it failed: this park is not paid from again. */
  | { kind: "failed"; status: number; body: Record<string, unknown> };

/**
 * Run the one start a park gets. The caller has already moved the park to
 * `starting` with a compare-and-set, which is what makes this run once
 * however many taps and fixes race for it; `park` is that row, with the
 * confirmed zone and the quote the driver was shown.
 */
export async function startParkSession(
  deps: LifecycleDeps,
  ops: { start: ParkStarter; stop: SessionStopper },
  park: PendingParkRow,
  args: { at: Date; mode: "tap"; trigger: "confirm" | "walk_away"; fix?: FixRecord },
): Promise<ParkStartOutcome> {
  const shown = park.quote as Quote;
  const parkedEventId = park.parkedEventId as string;
  const settle = (data: Parameters<AppDb["pendingPark"]["updateMany"]>[0]["data"]) =>
    deps.db.pendingPark.updateMany({ where: { id: park.id, status: "starting" }, data });
  const record = (rule: string, outcome: Record<string, unknown>, sessionId?: string) =>
    deps.db.decision.create({
      data: {
        kind: "session_start_walkaway",
        inputs: {
          parkedEventId,
          zoneId: park.zoneId,
          mode: args.mode,
          trigger: args.trigger,
          // The walk-away this start waited for, and the fix that showed
          // it when the start ran on that very fix.
          leftCar: { at: park.leftCarAt?.toISOString() ?? null },
          ...(args.fix ? { fix: args.fix } : {}),
          shown,
          shownDryRun: park.shownDryRun,
          dryRun: deps.policy.effectiveDryRun(),
          policyHash: deps.policy.hash(),
        },
        rule,
        outcome,
        userId: park.userId,
        parkedEventId,
        ...(sessionId ? { sessionId } : {}),
      },
    });

  // A session still running for this driver. At the same spot it already
  // pays this park: a second one would pay twice. Somewhere else, the car
  // has moved, and this tap is the driver saying so: that session ends.
  const running = await deps.db.session.findFirst({
    where: { userId: park.userId, status: "active" },
  });
  if (running) {
    const sameSpot =
      running.carLat === null ||
      running.carLng === null ||
      metersBetween(park.carLat, park.carLng, running.carLat, running.carLng) <= SAME_SPOT_M;
    if (sameSpot) {
      await settle({ status: "covered", closedAt: args.at });
      await record("covered", { parkStatus: "covered", coveredBy: running.id }, running.id);
      return { kind: "covered", sessionId: running.id };
    }
    const lifecycle = await lifecycleOf(deps.db, running);
    const ended = lifecycle
      ? await deps.db.pendingPark.updateMany({
          where: { id: lifecycle.id, status: "started" },
          data: { status: "ended", closedAt: args.at },
        })
      : { count: 1 };
    if (ended.count === 1) {
      await endSession(deps, ops.stop, running, lifecycle, {
        reason: "new_park",
        why: "new_park_paid",
        ...(args.fix ? { fix: args.fix } : {}),
        at: args.at,
      });
    }
  }

  let reply: Awaited<ReturnType<ParkStarter>>;
  try {
    reply = await ops.start(
      { id: park.userId },
      { parkedEventId, zoneId: park.zoneId as string, minutes: shown.stayMinutes },
      {
        maxTotalUsd: shown.totalUsd,
        shownZoneNumber: shown.providerZoneNumber,
        ...(park.shownDryRun === true ? { shownDryRun: true } : {}),
      },
    );
  } catch (err) {
    // The start itself blew up. If the provider was never asked, nothing
    // was charged and the park goes back to waiting: for its tap, or (an
    // early tap) for the next two fixes that show the phone away. If it
    // was asked, whether it charged is unknown.
    const reached = (err as { reachedProvider?: boolean }).reachedProvider === true;
    const next = reached
      ? { status: "start_failed", closedAt: args.at }
      : args.trigger === "confirm"
        ? { status: "prompted" }
        : {
            status: "confirmed",
            leftCarAt: null,
            farAt: null,
            farDistanceM: null,
            nearSince: null,
          };
    await settle(next).catch(() => undefined);
    await record("error", {
      parkStatus: next.status,
      reachedProvider: reached,
      error: String(err).split("\n")[0],
    }).catch(() => undefined);
    throw err;
  }

  let outcome: ParkStartOutcome;
  let next: Parameters<typeof settle>[0];
  const sessionId = typeof reply.body["sessionId"] === "string" ? reply.body["sessionId"] : null;
  if (reply.status === 200 && sessionId !== null) {
    outcome = { kind: "started", body: reply.body };
    next = { status: "started", sessionId };
  } else if (reply.status === 200) {
    // The provider says the zone isn't charging: nothing to pay here.
    outcome = { kind: "free", body: reply.body };
    next = { status: "free", closedAt: args.at };
  } else if (reply.reachedProvider) {
    outcome = { kind: "failed", status: reply.status, body: reply.body };
    next = { status: "start_failed", closedAt: args.at };
  } else {
    // Nothing reached the provider: the park goes back to waiting for a
    // tap, with a prompt that says where it stands now.
    const built = await buildParkPrompt(deps, park, args.at);
    const prompt = built.kind === "prompt" ? built.prompt : null;
    outcome = CHANGED_RULES.includes(String(reply.body["rule"]))
      ? { kind: "quote_changed", prompt }
      : { kind: "refused", status: reply.status, body: reply.body, prompt };
    next =
      built.kind === "free"
        ? { status: "free", closedAt: args.at }
        : {
            status: "prompted",
            promptedAt: park.promptedAt ?? args.at,
            ...(built.kind === "prompt"
              ? {
                  prompt: built.prompt,
                  quote: built.quote ?? shown,
                  shownDryRun: built.prompt.dryRun,
                }
              : {}),
          };
  }
  await settle(next);
  await record(
    outcome.kind,
    {
      status: reply.status,
      reachedProvider: reply.reachedProvider,
      parkStatus: next.status,
      ...(sessionId !== null ? { sessionId } : {}),
      ...(reply.status === 200 ? {} : { error: reply.body["error"], rule: reply.body["rule"] }),
    },
    sessionId ?? undefined,
  );
  return outcome;
}
