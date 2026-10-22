/**
 * "Does this user have a session awaiting payment right now?" — the
 * question the issuing webhook asks before approving an authorization.
 * True when the user has a pending or active session that started (or,
 * while still pending, was created) within the last 10 minutes — the
 * window in which the executor's ParkNYC charge should arrive.
 */

import { acceptedSignStay } from "./signs/acceptedStay.js";
import { tightenedMaxStay } from "./signs/signRules.js";
import type { AppDb, PendingParkRow, PendingParkWrite, SessionRow } from "../db.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import type { HoursInterval } from "./hours.js";
import { easternWallClock } from "./hours.js";
import { policyFor } from "./limits.js";
import { MANDATE_TTL_MS } from "./mandates.js";
import type { Policy } from "./policy.js";
import { moneyGate } from "./moneyGate.js";
import { principalFor } from "./principal.js";
import type { Quote, ZoneTerms } from "./quote.js";
import { quoteZone } from "./quote.js";
import { supportsEarlyStop } from "./sessions.js";
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
/** …and those a session for the park may still be linked to: one already
 * started (a later start for the same park), or one closed before its
 * start's reply was in (swept as failed, or superseded). Any other park
 * that is over stays over. */
export const PARK_RELINKABLE = ["started", "start_failed", "superseded"];
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
/** A drive-off read from pace alone takes its two fixes within this (two
 * of the app's 60 s heartbeats): farther apart, the gap between them may
 * be a subway ride, not a car. */
export const DRIVE_PACE_MAX_MS = 120_000;
/** …and no faster than this between them. A car pulling away covers the
 * same ground as a driver on foot, only quicker, and it is not a
 * walk-away. A fix whose own speed (the phone's `speedMps`) is over it is
 * a moving car: it never counts toward leaving. */
export const MAX_WALK_MPS = 3;
/** The phone's own speed says "on foot" only from this up: CLLocation
 * reads 0 for a phone standing still (a car at a light included), and a
 * few tenths for one sitting in GPS noise. */
export const MIN_WALK_MPS = 0.5;
/** The app's "left the car" is refused on a fix whose error reaches this
 * close to the car (mayBeAtTheDoor). */
export const DOOR_RADIUS_M = 10;

/**
 * Whether a fix may have the phone at the car's door, so the app's
 * `left_car` on it can't be the walk-away: nothing pays on a fix that has
 * the phone at the car. The phone may be anywhere in the fix's error, and
 * the whole of that must be clear of the door (`distance − accuracy >
 * DOOR_RADIUS_M`), sharp or blurry alike: in an urban canyon a seat fix
 * reads 30–50 m off, 30–50 m blurry (#264). Too blurry to read at all, it
 * can't show the phone has left. A refused `left_car` is kept
 * (`walkSaidAt`): the app says it again with its next fix while the driver
 * is on foot (LocationReporter.taken), and a later fix off the car takes
 * the walk-away even once the app has stopped saying it.
 */
export function mayBeAtTheDoor(fix: { distanceM: number; accuracyM: number }): boolean {
  if (fix.accuracyM > FIX_USABLE_ACCURACY_M) return true;
  return fix.distanceM - fix.accuracyM <= DOOR_RADIUS_M;
}
/** A report, or a measurement, older than this describes where the phone
 * was. */
export const LIFECYCLE_FIX_MAX_AGE_MS = 5 * 60_000;
/** A park nobody walked away from in this long is not asked about. */
export const PARK_TTL_MS = 60 * 60_000;
/** A start that never came back (a crash mid-start) stops blocking. */
export const STARTING_STALE_MS = 10 * 60_000;
/** A start not answered in this long stops holding its park: well inside
 * STARTING_STALE_MS, so the sweep never closes a start still running
 * here. An answer that comes later is adopted then. */
export const START_DEADLINE_MS = 3 * 60_000;
/** Two car fixes this close are the same spot; farther, the car moved. */
export const SAME_SPOT_M = 100;

/** An agent's confirmed street plan the park the phone just reported may
 * be held for (WS-4 E3): its consent, its stay, and the cap. The zone is
 * the one the caller resolved and asked about. */
export interface AgentBinding {
  planId: string;
  /** The mandate's id (its token's hash). */
  mandateId: string;
  agentKeyId: string;
  /** The stay the agent confirmed: the bound park is quoted for it. */
  durationMinutes: number;
  /** What the plan said this spot costs: the shown cap is the lower of
   * this and the bound park's quote. */
  planPriceUsd: number;
}

/**
 * Whether the park the phone just reported is at a spot an agent of this
 * person confirmed (`POST /agent/plans/:id/confirm` answered
 * `pending_arrival`), inside that mandate's window. The phone is the only
 * source of arrival, and `/parked` the only judge of which zone the car is
 * in: `zoneId` is the zone `/parked` would itself pay without asking (its
 * candidates agree, the pay-by-app number known), or null — a car across
 * the street or in the next zone never binds to the plan's. The plan's
 * zone must be that zone; the plan not yet bound and confirmed within the
 * mandate's window; its mandate an agent's, consumed, unexpired, and
 * minted under the dry run in force now (what the agent was shown is what
 * runs). And the plan must be one for parking now (its request's intent
 * `park_now`): a plan for later was priced, and consented to, for a window
 * that hasn't begun, and its mandate (10 minutes) expires before a
 * `park_later` window (more than 15 minutes out) opens, so a park now never
 * binds to it. A plan that says no intent binds nothing. The newest such
 * plan wins. Pure read: the caller binds (once, by CAS).
 */
export async function agentBindingFor(
  db: Pick<AppDb, "assistantPlan" | "mandate">,
  userId: string,
  here: { zoneId: string | null; dryRun: boolean },
  at: Date,
): Promise<AgentBinding | null> {
  if (here.zoneId === null) return null;
  const since = new Date(at.getTime() - MANDATE_TTL_MS);
  const plans = (
    await db.assistantPlan.findMany({
      where: { userId, confirmedAt: { not: null, gte: since }, boundParkedEventId: null },
    })
  )
    .filter((p) => p.kind === "single_spot" && p.conversationId.startsWith("agent:"))
    .sort((a, b) => (b.confirmedAt?.getTime() ?? 0) - (a.confirmedAt?.getTime() ?? 0));
  for (const plan of plans) {
    const intent = (plan.plan as { requestSummary?: { intent?: unknown } }).requestSummary?.intent;
    if (intent !== "park_now") continue;
    const options = (plan.plan as { options?: unknown }).options;
    const option = Array.isArray(options)
      ? (
          options as {
            id: string;
            type: string;
            zoneId?: string;
            priceUsd: number;
            durationMinutes: number;
          }[]
        ).find((o) => o.id === plan.confirmedOptionId)
      : undefined;
    if (!option || option.type !== "street" || option.zoneId !== here.zoneId) continue;
    const mandate = await db.mandate.findFirst({
      where: { planId: plan.id },
      orderBy: { createdAt: "desc" },
    });
    const shownDryRun = (mandate?.capsSnapshot as { dryRun?: unknown } | null)?.dryRun;
    if (
      !mandate ||
      mandate.userId !== userId ||
      mandate.agentKeyId === null ||
      mandate.consumedAt === null ||
      mandate.expiresAt.getTime() <= at.getTime() ||
      // A mandate that recorded no dry run binds nothing.
      shownDryRun !== here.dryRun
    ) {
      continue;
    }
    return {
      planId: plan.id,
      mandateId: mandate.token,
      agentKeyId: mandate.agentKeyId,
      durationMinutes: option.durationMinutes,
      planPriceUsd: option.priceUsd,
    };
  }
  return null;
}

/**
 * The agent key whose confirmed plan this park is bound to (E3), or null.
 * The bound park's start is the phone's act, so the principal is the
 * person's; the consent was the key's, and every start decision for the
 * park names it, so a per-key ledger query finds the money it moved.
 */
export async function boundAgentKeyId(
  db: Pick<AppDb, "assistantPlan" | "mandate">,
  userId: string,
  parkedEventId: string,
): Promise<string | null> {
  const plan = await db.assistantPlan.findFirst({ where: { boundParkedEventId: parkedEventId } });
  if (!plan || plan.userId !== userId) return null;
  const mandate = await db.mandate.findFirst({
    where: { planId: plan.id },
    orderBy: { createdAt: "desc" },
  });
  return mandate && mandate.userId === userId ? mandate.agentKeyId : null;
}

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
  /** Since when every usable fix has been within reach of the car
   * (measured): what keeps a tap at the car waiting. */
  nearSince: Date | null;
  /** …and at it even allowing for each fix's error: what a return, which
   * stops the session, is timed from. */
  atCarSince: Date | null;
  /** After leaving: the last measurement that had the phone at the car,
   * kept until the phone is seen walking away from it again. Driving off
   * is told from it. */
  backAt: Date | null;
  /** After `backAt`: the first fix clear of the car not at a walk, its
   * distance, and its speed when the phone gave one. A second one makes a
   * drive-off. */
  driveAt: Date | null;
  driveDistanceM: number | null;
  driveSpeedMps: number | null;
  /** Before leaving: the app's `left_car`, refused because its fix may
   * have had the phone at the car's door (mayBeAtTheDoor), and not yet
   * taken back. A later fix off the car takes the walk-away it said. */
  walkSaidAt: Date | null;
}

export interface WalkFix {
  distanceM: number;
  accuracyM: number;
  /** When the phone reported it. */
  at: Date;
  /** When it was measured. The app re-sends its last fix on a heartbeat
   * with a fresh report time: the same measurement, not a second one. */
  measuredAt: Date;
  /** The phone's own speed at the fix (CLLocation.speed); null or absent
   * when it gave none. */
  speedMps?: number | null | undefined;
  event?: PhoneEvent | undefined;
}

export type WalkReason =
  "fix_away" | "left_car_event" | "near_for_60s" | "returned_event" | "drove_off";

export interface WalkStep {
  state: WalkState;
  /** This fix is the one that showed the phone leaving the car. */
  left: boolean;
  /** …or back at it, after having left (`drove_off`: back, and gone again
   * in the car). */
  returned: boolean;
  /** Driving again without the phone ever having left. */
  droveOff: boolean;
  /** For a `drove_off` return: read from the phone's own speed on both
   * fixes, or from the pace between them (which a GPS jump can fake). */
  droveOffBy?: "speed" | "pace";
  why: WalkReason | null;
}

/**
 * One fix against where the phone stood. Pure.
 *
 * Leaving: two separate measurements clear of the car even allowing for
 * their own error, at walking pace between them, or the app's own report
 * (on foot) on a fix whose error doesn't reach the car's door — or, said on
 * one that does, the next fix that doesn't (mayBeAtTheDoor, `walkSaidAt`).
 * A fix at driving speed is never part of leaving.
 * Returning: the app's report beside the car, or a minute of measurements
 * within reach of it — and that only after a fix put the phone clear of
 * the car, so a driver whose errand is right beside the car isn't "back"
 * the whole time. Or driving off: a measurement at the car, then two clear
 * of it faster than anyone walks.
 */
export function advanceWalk(before: WalkState, fix: WalkFix): WalkStep {
  const state = { ...before };
  const usable = fix.accuracyM <= FIX_USABLE_ACCURACY_M;
  const speed = typeof fix.speedMps === "number" && fix.speedMps >= 0 ? fix.speedMps : null;
  const fast = speed !== null && speed > MAX_WALK_MPS;
  const near = usable && fix.distanceM <= AT_CAR_RADIUS_M;
  // At the car even allowing for the fix's own error: what a return (which
  // stops the session) is timed from. `near` alone only holds.
  const atCar = near && fix.distanceM + fix.accuracyM <= AT_CAR_RADIUS_M;
  const clear = usable && fix.distanceM - fix.accuracyM > AT_CAR_RADIUS_M;
  const step = (extra: Partial<WalkStep>): WalkStep => ({
    state,
    left: false,
    returned: false,
    droveOff: false,
    why: null,
    ...extra,
  });
  const forgetDrive = () => {
    state.driveAt = null;
    state.driveDistanceM = null;
    state.driveSpeedMps = null;
  };
  const leave = (why: WalkReason) => {
    state.leftCarAt = fix.at;
    state.walkSaidAt = null;
    state.nearSince = null;
    state.atCarSince = null;
    state.backAt = null;
    forgetDrive();
    return step({ left: true, why });
  };

  if (state.leftCarAt === null) {
    if (fix.event === "returned_to_car") {
      state.walkSaidAt = null;
      return step({ droveOff: true, why: "drove_off" });
    }
    if (fast) {
      // In a moving car: nothing about it is a driver on foot, and the
      // pair it would have finished starts over, and a walk the app said
      // at the door is over.
      state.farAt = null;
      state.farDistanceM = null;
      state.walkSaidAt = null;
      return step({});
    }
    const offTheCar = !mayBeAtTheDoor(fix);
    if (fix.event === "left_car" && !offTheCar) {
      // On foot, by the app's word, on a fix that may have the phone at
      // the door: not the walk-away, but kept (the first such).
      state.walkSaidAt ??= fix.measuredAt;
    } else if (fix.event !== "left_car" && state.walkSaidAt !== null) {
      if (near) {
        // Back within reach of the car: that walk ended at it.
        state.walkSaidAt = null;
      } else if (offTheCar && fix.measuredAt.getTime() > state.walkSaidAt.getTime()) {
        // Off the car since the app said the driver was on foot: the
        // walk-away it said, on a fix that can show it (#264 review). An
        // early Pay starts on it, as on the app's own word.
        state.farAt = clear ? fix.measuredAt : null;
        state.farDistanceM = clear ? fix.distanceM : null;
        return leave("left_car_event");
      }
    }
    if (fix.event === "left_car" && offTheCar) {
      // The app's own word first, even on a fix that also finishes a pair:
      // only it starts an early Pay. On foot, not necessarily far: a
      // return by distance waits for a fix that is clear of the car.
      state.farAt = clear ? fix.measuredAt : null;
      state.farDistanceM = clear ? fix.distanceM : null;
      return leave("left_car_event");
    }
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
        if (paceMps <= MAX_WALK_MPS) return leave("fix_away");
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
    return step({});
  }

  // Measured before the phone left (the outbox or a re-send delivering it
  // late): where it was then, which says nothing about coming back.
  if (fix.measuredAt.getTime() < state.leftCarAt.getTime()) return step({});
  if (clear && state.farAt === null) {
    state.farAt = fix.measuredAt;
    state.farDistanceM = fix.distanceM;
  }
  if (fix.event === "returned_to_car" && usable && fix.distanceM <= RETURN_EVENT_RADIUS_M) {
    return step({ returned: true, why: "returned_event" });
  }
  if (fix.event === "left_car" && !fast && !mayBeAtTheDoor(fix)) {
    // The app has the driver on foot again: whatever brought the phone
    // back to the car, it isn't driving off. (Not on a fix at driving
    // speed, which no rule reads as on foot, nor on one that may have the
    // phone at the door: a seat fix would release a tap's hold, #264.)
    state.backAt = null;
    forgetDrive();
  }
  if (near && !fast) {
    // Holding takes any usable fix within reach of the car: urban returns
    // are often 20–50 m blurry, and a return nobody saw would leave a tap
    // paying from the seat, a drive-off unseen, and extensions bought for
    // an empty spot. So the phone may be back: a tap waits (nearSince),
    // and the drive-off pair and the extension hold are armed (backAt).
    state.nearSince ??= fix.measuredAt;
    state.backAt = fix.measuredAt;
    forgetDrive();
    // Stopping takes more. A return stops the session, and two blurry
    // fixes are a driver in a café down the block as much as one at the
    // car: only fixes at the car even allowing for their error count
    // toward the minute, and a blurry one neither counts nor restarts it.
    // Measured, not reported: the heartbeat's re-send of one measurement
    // beside the car is not a minute there.
    if (!atCar) return step({});
    state.atCarSince ??= fix.measuredAt;
    if (
      state.farAt !== null &&
      fix.measuredAt.getTime() - state.atCarSince.getTime() >= RETURN_DWELL_MS
    ) {
      return step({ returned: true, why: "near_for_60s" });
    }
    return step({});
  }
  if (!usable) return step({});
  state.nearSince = null;
  state.atCarSince = null;
  if (!clear || state.backAt === null) {
    forgetDrive();
    return step({});
  }
  // Clear of the car after a measurement at it: back in the car and
  // driving off, or on foot again. Only the phone's own walking speed
  // says on foot: a walking pace between two fixes is also what
  // stop-and-go traffic looks like, and a speed of (nearly) nothing is a
  // phone standing still, in a car at a light as much as anywhere.
  if (speed !== null && speed >= MIN_WALK_MPS && !fast) {
    state.backAt = null;
    forgetDrive();
    return step({});
  }
  const firstOfPair = () => {
    state.driveAt = fix.measuredAt;
    state.driveDistanceM = fix.distanceM;
    state.driveSpeedMps = speed;
    return step({});
  };
  if (state.driveAt === null) return firstOfPair();
  const sinceMs = fix.measuredAt.getTime() - state.driveAt.getTime();
  // The first measurement sent again, or one from before it.
  if (sinceMs <= 0 || fix.distanceM === state.driveDistanceM) return step({});
  const firstFast = state.driveSpeedMps !== null && state.driveSpeedMps > MAX_WALK_MPS;
  if (fast && firstFast) return step({ returned: true, why: "drove_off", droveOffBy: "speed" });
  // Without the phone's speed for both, the pace between them decides:
  // over long enough that one GPS jump doesn't, and short enough that a
  // gap (a subway ride, a phone gone quiet) isn't read as one leg.
  if (sinceMs < LEAVE_CONFIRM_MS) return step({});
  if (sinceMs > DRIVE_PACE_MAX_MS) return firstOfPair();
  const paceMps = Math.abs(fix.distanceM - (state.driveDistanceM ?? 0)) / (sinceMs / 1000);
  if (paceMps > MAX_WALK_MPS) return step({ returned: true, why: "drove_off", droveOffBy: "pace" });
  // At a walking pace: on foot, or a car in traffic. This fix starts the
  // next pair, and the phone stays "back at the car".
  return firstOfPair();
}

/** Whether a fix may be read at all for this park: measured after the car
 * stopped, measured lately, and reported now. Anything else describes
 * another moment. */
export function fixCountsFor(
  parkedAt: Date,
  measuredAt: Date,
  reportedAt: Date,
  now: Date,
): boolean {
  return fixRejection(parkedAt, measuredAt, reportedAt, now) === null;
}

/** Why a fix isn't read for a park (fixCountsFor), or null when it is:
 * what the park's trace records beside the fix. */
export type FixRejection = "before_park" | "stale_measurement" | "clock_skew";

export function fixRejection(
  parkedAt: Date,
  measuredAt: Date,
  reportedAt: Date,
  now: Date,
): FixRejection | null {
  if (measuredAt.getTime() < parkedAt.getTime()) return "before_park";
  if (now.getTime() - measuredAt.getTime() > LIFECYCLE_FIX_MAX_AGE_MS) return "stale_measurement";
  if (Math.abs(now.getTime() - reportedAt.getTime()) > LIFECYCLE_FIX_MAX_AGE_MS) {
    return "clock_skew";
  }
  return null;
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
  | "needs_zone_number"
  | "provider_not_linked"
  | "session_cap_exceeded"
  | "daily_cap_exceeded"
  | "amount_invalid";

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
  parkedEventId: string,
): Promise<{ terms: ZoneTerms; street: string | null }> {
  // A shorter stay the driver accepted from the signs here (Issue N)
  // tightens the max stay, as the start path does; nothing lengthens it.
  const signStay = await acceptedSignStay(db, parkedEventId);
  const zone = await db.zone.findUnique({ where: { zoneId: candidate.zoneId } });
  if (!zone) {
    return {
      terms: { ...candidate, maxStayMinutes: tightenedMaxStay(candidate.maxStayMinutes, signStay) },
      street: null,
    };
  }
  const city = zone.city ?? "nyc";
  const live = effectiveTerms(zone, await observedTermsFor(db, city, zone.providerZoneNumber));
  return {
    terms: {
      zoneId: candidate.zoneId,
      city,
      providerZoneNumber: zone.providerZoneNumber,
      rateFirstHourUsd: live.rateFirstHourUsd,
      rateAdditionalHourUsd: live.rateAdditionalHourUsd,
      maxStayMinutes: tightenedMaxStay(live.maxStayMinutes, signStay),
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
      totals.push(
        usd(
          quoteZone((await termsNow(deps.db, candidate, park.parkedEventId)).terms, policy, at)
            .totalUsd,
        ),
      );
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
  const { terms, street } = await termsNow(deps.db, chosen, park.parkedEventId);
  const zoneNumber = terms.providerZoneNumber;
  const quote = quoteZone(terms, policy, at);
  if (quote.totalUsd === 0) return { kind: "free" };

  const provider = providerForCity(cityForZone(chosen.zoneId));
  // The start path's own refusals, in its order (the money gate's): said
  // now, in words, rather than offered as a Pay button that would be
  // refused.
  const gate = await moneyGate(
    deps,
    principalFor(park.userId),
    { kind: "prompt", provider, zoneNumber, totalUsd: quote.totalUsd },
    at,
  );
  const reason: ParkPromptReason | null = gate.ok ? null : (gate.rule as ParkPromptReason);

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
      amount_invalid: {
        title: parkedIn,
        body: "ParkAgent couldn't work out what this stop costs, so it won't pay it. Pay at the meter or in your parking app.",
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
  atCarSince: park.atCarSince,
  backAt: park.backAt,
  driveAt: park.driveAt,
  driveDistanceM: park.driveDistanceM,
  driveSpeedMps: park.driveSpeedMps,
  walkSaidAt: park.walkSaidAt,
});

/** Written with every move to `started`. A session starts with the phone
 * away from the car (a tap away from it, or the app's on-foot report), so
 * a walk past the car before the tap is about the walk-away, not the
 * session: left in place it would hold the session's extensions, or (a
 * minute at the car begun before) stop the new session at once. */
const NOT_BACK = {
  nearSince: null,
  atCarSince: null,
  backAt: null,
  driveAt: null,
  driveDistanceM: null,
  driveSpeedMps: null,
};

/** A fix as a decisions row records it. */
export interface FixRecord {
  lat: number;
  lng: number;
  accuracyM: number;
  ts: string;
  measuredAt?: string;
  speedMps?: number;
  distanceM: number;
  event?: PhoneEvent;
}

/**
 * A park moved on by the clock, by a newer park, or by its session turning
 * up, rather than by the phone or a tap: the ledger still says from what,
 * to what, and by which rule.
 */
async function recordParkChange(
  deps: Pick<LifecycleDeps, "db" | "policy">,
  park: PendingParkRow,
  next: PendingParkWrite & { status: string },
  rule: string,
  at: Date,
  inputs: Record<string, unknown> = {},
  extra: { sessionId?: string; outcome?: Record<string, unknown> } = {},
): Promise<void> {
  const sessionId = next.sessionId ?? extra.sessionId ?? null;
  await deps.db.decision.create({
    data: {
      kind: "park_lifecycle",
      inputs: {
        parkedEventId: park.parkedEventId,
        previousStatus: park.status,
        at: at.toISOString(),
        ...inputs,
        dryRun: deps.policy.effectiveDryRun(),
        policyHash: deps.policy.hash(),
      },
      rule,
      outcome: {
        status: next.status,
        ...extra.outcome,
        ...(sessionId !== null ? { sessionId } : {}),
      },
      userId: park.userId,
      ...(park.parkedEventId ? { parkedEventId: park.parkedEventId } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
    },
  });
}

/**
 * A newer park says where the car is: every other park of the user's
 * still waiting is over. Never one mid-start (PARK_SUPERSEDABLE). Each is
 * closed from the state it was read in, with its own decisions row.
 */
export async function supersedeParks(
  deps: Pick<LifecycleDeps, "db" | "policy">,
  userId: string,
  newer: { id?: string; parkedEventId: string },
  at: Date,
): Promise<void> {
  const open = await deps.db.pendingPark.findMany({
    where: { userId, status: { in: PARK_SUPERSEDABLE } },
  });
  for (const park of open) {
    if (park.id === newer.id) continue;
    const next = { status: "superseded", closedAt: at };
    const moved = await deps.db.pendingPark.updateMany({
      where: { id: park.id, status: park.status },
      data: next,
    });
    if (moved.count === 1) {
      await recordParkChange(deps, park, next, "newer_park", at, {
        newerParkedEventId: newer.parkedEventId,
      });
    }
  }
}

/** Where a park goes after its start failed or never answered. */
interface StartLeft {
  /** Null: the park keeps waiting on a start still being paid for. */
  next: (PendingParkWrite & { status: string }) | null;
  /** A session pending past the start's deadline, for the caller to fail
   * once the park is closed. */
  stalePending: SessionRow | null;
}

/**
 * Where a park goes when its start failed or never answered, by the
 * session that start left for it. Active: it paid, and the park is
 * `started` with it. Pending, younger than START_DEADLINE_MS: it may
 * still be paid for, and the park keeps waiting. Pending past the
 * deadline, or none: nothing will pay it, and the park is `start_failed`;
 * a pending session that old is one whose start died with the process
 * that ran it. So is one whose start `threw` here: it is that start's own
 * (one start runs per park, under the `starting` compare-and-set, and a
 * user has one open session at most), and nothing is left to answer for
 * it.
 */
async function afterStart(
  db: AppDb,
  park: PendingParkRow,
  at: Date,
  opts: { threw?: boolean } = {},
): Promise<StartLeft> {
  const made =
    park.parkedEventId === null
      ? null
      : await db.session.findFirst({
          where: {
            userId: park.userId,
            parkedEventId: park.parkedEventId,
            status: { in: ["pending", "active"] },
          },
        });
  if (made?.status === "active") {
    return { next: { status: "started", sessionId: made.id, ...NOT_BACK }, stalePending: null };
  }
  if (made && !opts.threw && at.getTime() - made.createdAt.getTime() < START_DEADLINE_MS) {
    return { next: null, stalePending: null };
  }
  return { next: { status: "start_failed", closedAt: at }, stalePending: made };
}

/** Fail a pending session nothing will ever answer for, from pending only:
 * one that went active meanwhile stays active. */
async function failStalePending(db: AppDb, session: SessionRow): Promise<boolean> {
  const failed = await db.session.updateMany({
    where: { id: session.id, status: "pending" },
    data: { status: "failed" },
  });
  return failed.count === 1;
}

/**
 * Close what time has closed, and answer with the row as it now stands: a
 * park nobody walked away from (or answered) within the hour is not asked
 * about, and a start that never came back stops blocking the park — as a
 * failed one, since whether it charged is unknown, unless its active
 * session says it did, or a session still within the start's deadline
 * says it may yet (see afterStart).
 */
export async function settlePark(
  deps: Pick<LifecycleDeps, "db" | "policy">,
  park: PendingParkRow,
  at: Date,
): Promise<PendingParkRow> {
  const since = (from: Date | null) => at.getTime() - (from ?? park.createdAt).getTime();
  let next: (PendingParkWrite & { status: string }) | null = null;
  let rule = "ttl_expired";
  let inputs: Record<string, unknown> = {};
  let stalePending: SessionRow | null = null;
  if (park.status === "at_car" || park.status === "confirmed") {
    // From when the server heard of it, not from the phone's own clock.
    if (since(park.createdAt) > PARK_TTL_MS) {
      next = { status: "expired", closedAt: at };
      inputs = { createdAt: park.createdAt.toISOString(), ttlMs: PARK_TTL_MS };
    }
  } else if (park.status === "prompted") {
    if (since(park.promptedAt ?? park.createdAt) > PARK_TTL_MS) {
      next = { status: "expired", closedAt: at };
      inputs = { promptedAt: park.promptedAt?.toISOString() ?? null, ttlMs: PARK_TTL_MS };
    }
  } else if (park.status === "starting") {
    if (since(park.startingAt) > STARTING_STALE_MS) {
      ({ next, stalePending } = await afterStart(deps.db, park, at));
      rule = "start_stale";
      inputs = { startingAt: park.startingAt?.toISOString() ?? null, staleMs: STARTING_STALE_MS };
    }
  }
  if (next === null) return park;
  const closing = next;
  await movePark(deps, park, park.status, closing, at, "swept", async (count) => {
    if (count !== 1) return;
    const stale = stalePending
      ? {
          sessionId: stalePending.id,
          outcome: {
            reason: "stale_pending",
            sessionFailed: await failStalePending(deps.db, stalePending),
          },
        }
      : {};
    await recordParkChange(deps, park, closing, rule, at, inputs, stale);
  });
  return (await deps.db.pendingPark.findUnique({ where: { id: park.id } })) ?? park;
}

/**
 * The lifecycle row of a session: its park's, or one made for a session
 * that started outside the lifecycle (an older build). Null when the
 * session has no car fix to measure from, or when its park is over and
 * can't take a session (declined, cancelled, expired, …).
 */
export async function lifecycleOf(
  deps: Pick<LifecycleDeps, "db" | "policy">,
  session: SessionRow,
  at: Date,
): Promise<PendingParkRow | null> {
  const db = deps.db;
  const own = await db.pendingPark.findUnique({ where: { sessionId: session.id } });
  if (own) return own;
  if (session.carLat === null || session.carLng === null) return null;
  const earlier = session.parkedEventId
    ? await db.pendingPark.findUnique({ where: { parkedEventId: session.parkedEventId } })
    : null;
  try {
    if (earlier) {
      // Its own park's row, never linked (a start that ran outside the
      // tap, or whose reply was lost): the same park, now with its
      // session, moved only from the state it was read in.
      if (!PARK_RELINKABLE.includes(earlier.status)) return null;
      const next = { status: "started", sessionId: session.id, closedAt: null, ...NOT_BACK };
      const linked = await movePark(
        deps,
        earlier,
        earlier.status,
        next,
        at,
        "relinked",
        async (count) => {
          if (count === 1) {
            await recordParkChange(deps, earlier, next, "linked_to_session", at, {
              previousSessionId: earlier.sessionId,
            });
          }
        },
      );
      // Moved meanwhile: linked by another request, or closed.
      if (linked === 0) return db.pendingPark.findUnique({ where: { sessionId: session.id } });
      return db.pendingPark.findUnique({ where: { id: earlier.id } });
    }
    const made = await db.pendingPark.create({
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
    // Made already holding its session: the same check a move to
    // `started` gets (movePark).
    await noteNewerParkSafely(deps, made, session.id, at, "created");
    return (await db.pendingPark.findUnique({ where: { id: made.id } })) ?? made;
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
  /** The rule that saw it: `near_for_60s`, `returned_event`, `drove_off`
   * (a return), or `new_park_paid`. */
  why: string;
  /** For `drove_off`: read from the phone's own speed, or from pace. */
  readBy?: "speed" | "pace";
  /** False where the provider can't stop early, or refused to, or (a
   * drive-off read from pace) was never asked. */
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
  args: {
    reason: SessionEnd["reason"];
    why: string;
    fix?: FixRecord;
    at: Date;
    /** False: never ask the provider to stop, even where it can: what
     * showed the return could be wrong (a drive-off read from pace). The
     * time already bought runs out; nothing more is bought. */
    askProvider?: boolean;
    /** What a drive-off was read from, for the ledger. */
    readBy?: "speed" | "pace";
  },
): Promise<SessionEnd> {
  const paidUntil = session.expiresAt?.toISOString() ?? null;
  // Back at the car and gone again before a return was seen: one rule
  // for it, whichever way the session ended (`outcome.stopped` says).
  const droveOff = args.why === "drove_off";
  // What the phone is told, beside `stopped`: which rule saw the end, and
  // for a drive-off what it was read from (the app words a pace-read end
  // as a guess, not "you're back at your car").
  const said = {
    reason: args.reason,
    why: args.why,
    ...(args.readBy ? { readBy: args.readBy } : {}),
  };
  const row = (rule: string, outcome: Record<string, unknown>) =>
    deps.db.decision.create({
      data: {
        kind: "session_end_return",
        inputs: {
          reason: args.reason,
          why: args.why,
          ...(args.fix ? { fix: args.fix } : {}),
          ...(args.readBy ? { readBy: args.readBy } : {}),
          // A drive-off's first fix, as the park held it before the one
          // that finished the pair (`fix`).
          ...(droveOff && park
            ? {
                driveFrom: {
                  measuredAt: park.driveAt?.toISOString() ?? null,
                  distanceM: park.driveDistanceM,
                  speedMps: park.driveSpeedMps,
                },
              }
            : {}),
          leftCarAt: park?.leftCarAt?.toISOString() ?? null,
          expiresAt: paidUntil,
          dryRun: deps.policy.effectiveDryRun(),
          policyHash: deps.policy.hash(),
        },
        rule: droveOff ? "ended_drove_off" : rule,
        outcome,
        userId: session.userId,
        sessionId: session.id,
        ...(park?.parkedEventId ? { parkedEventId: park.parkedEventId } : {}),
      },
    });

  if (!supportsEarlyStop(session.zoneId) || args.askProvider === false) {
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
        details: {
          ...said,
          paidUntil,
          ...(args.askProvider === false ? { providerAsked: false } : {}),
        },
      },
    });
    await row("ended_at_return", {
      stopped: false,
      paidUntil,
      ...(args.askProvider === false ? { providerAsked: false } : {}),
    });
    return { ...said, stopped: false };
  }

  const stopped = await stop(session.userId, session);
  if (stopped.status === 200) {
    await row("stopped_at_return", { stopped: true, stoppedAt: args.at.toISOString() });
    return { ...said, stopped: true };
  }
  // The provider didn't stop it. The park is over all the same (nothing
  // more is bought); the session runs out on its own, and Stop in the app
  // still works.
  await row("stop_failed", {
    stopped: false,
    error: stopped.body["error"],
    code: stopped.body["code"],
  });
  return { ...said, stopped: false, error: stopped.body["error"] };
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
  const row = await lifecycleOf(deps, session, at);
  if (!row || row.carMovedAt !== null) return;
  // Once, however many newer parks race for it.
  const marked = await deps.db.pendingPark.updateMany({
    where: { id: row.id, status: row.status, carMovedAt: null },
    data: { carMovedAt: at },
  });
  if (marked.count !== 1) return;
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

/** What the newer-park check needs. The hash is optional only in type:
 * the gate's deps type names no hash, but its callers (applyExtension's
 * SessionDeps) pass the policy service, so its rows carry one too; a
 * caller with none writes null. */
interface NewerParkDeps {
  db: AppDb;
  policy: { effectiveDryRun(): boolean; hash?: () => string };
}

/** Where a park took its session, as its `session_car_moved` row says. */
type TookSessionAt =
  | "start_settled"
  | "late_success"
  | "relinked"
  | "swept"
  | "start_threw"
  | "created"
  // The belt: read again before time is bought (checkNewerPark).
  | "extension_worker"
  | "extension_gate";

/**
 * The one way a park moves on (#246): a compare-and-set from the state it
 * was read in, then the caller's own ledger row (`recorded`, with how many
 * moved), then, when the move gave the park its session (`started`), the
 * newer-park check. That check runs after the row and never fails the
 * move: a paid start is never undone by a ledger read.
 */
async function movePark(
  deps: Pick<LifecycleDeps, "db" | "policy">,
  park: PendingParkRow,
  from: string,
  data: PendingParkWrite & { status: string },
  at: Date,
  seenAt: TookSessionAt,
  recorded: (count: number) => Promise<unknown>,
): Promise<number> {
  const moved = await deps.db.pendingPark.updateMany({
    where: { id: park.id, status: from },
    data,
  });
  await recorded(moved.count);
  if (moved.count === 1 && data.status === "started" && typeof data.sessionId === "string") {
    await noteNewerParkSafely(deps, park, data.sessionId, at, seenAt);
  }
  return moved.count;
}

/** noteNewerParkSince, whose failure is logged and goes no further: the
 * extension worker checks again before buying anything (extendTick). */
async function noteNewerParkSafely(
  deps: Pick<LifecycleDeps, "db" | "policy">,
  park: PendingParkRow,
  sessionId: string,
  at: Date,
  seenAt: TookSessionAt,
): Promise<void> {
  try {
    await noteNewerParkSince(deps, park, sessionId, at, seenAt);
  } catch (err) {
    console.warn(`car-moved check failed for park ${park.id}: ${String(err).split("\n")[0]}`);
  }
}

/**
 * A park that just took its session (its start settled, a late success
 * adopted it, or a relink): a newer /parked may have landed while it was
 * mid-start or closed (#246). A `starting` park is never superseded, a
 * `start_failed` or `superseded` one has no session, and noteCarMoved
 * finds neither. So, the moment it holds a session, the user's newest
 * park since this one says where the car is: more than SAME_SPOT_M from
 * this park's car, the car has moved, once (compare-and-set on
 * `car_moved_at` null), on the ledger against this park and its session.
 * A newer /parked that lands after this read finds the session running
 * and marks it itself (noteCarMoved).
 */
async function noteNewerParkSince(
  deps: NewerParkDeps,
  park: PendingParkRow,
  sessionId: string,
  at: Date,
  seenAt: TookSessionAt,
): Promise<boolean> {
  const newer = await deps.db.parkedEvent.findFirst({
    where: { userId: park.userId, ts: { gt: park.parkedAt } },
    orderBy: { ts: "desc" },
  });
  if (!newer || newer.id === park.parkedEventId) return false;
  const distanceM = metersBetween(newer.lat, newer.lng, park.carLat, park.carLng);
  if (distanceM <= SAME_SPOT_M) return false;
  const marked = await deps.db.pendingPark.updateMany({
    where: { id: park.id, status: "started", carMovedAt: null },
    data: { carMovedAt: at },
  });
  // Lost to another marker: the car has moved all the same.
  if (marked.count !== 1) return true;
  await deps.db.decision.create({
    data: {
      kind: "session_car_moved",
      inputs: {
        car: { lat: park.carLat, lng: park.carLng },
        newPark: { lat: newer.lat, lng: newer.lng },
        distanceM: Math.round(distanceM),
        newParkedEventId: newer.id,
        seenAt,
        dryRun: deps.policy.effectiveDryRun(),
        policyHash: deps.policy.hash?.() ?? null,
      },
      rule: "newer_park_elsewhere",
      outcome: { autoExtend: false, stopped: false },
      userId: park.userId,
      sessionId,
      ...(park.parkedEventId ? { parkedEventId: park.parkedEventId } : {}),
    },
  });
  return true;
}

/**
 * The belt (#246): before time is bought for a street session (the
 * extension worker, and the gate under the extension lock), the newest park
 * since its park is read again, so a move to `started` that skipped
 * movePark can't buy an extension for a car that moved. True when the car
 * has moved (marked before, or now). A read that fails throws: nothing is
 * bought on it.
 */
export async function checkNewerPark(
  deps: NewerParkDeps,
  park: PendingParkRow,
  at: Date,
  seenAt: "extension_worker" | "extension_gate",
): Promise<boolean> {
  if (park.carMovedAt !== null) return true;
  if (park.status !== "started" || park.sessionId === null) return false;
  return noteNewerParkSince(deps, park, park.sessionId, at, seenAt);
}

/** The start path, as the lifecycle calls it (routes/session.ts SessionOps). */
export type ParkStarter = (
  user: { id: string },
  body: { parkedEventId: string; zoneId: string; minutes?: number },
  opts?: {
    maxTotalUsd?: number;
    shownZoneNumber?: string;
    shownDryRun?: boolean;
    checkOnly?: boolean;
    replacing?: string;
  },
) => Promise<{ status: number; body: Record<string, unknown>; reachedProvider: boolean }>;

/** The start path's refusals that mean "not what the driver agreed to". */
const CHANGED_RULES = ["quote_changed", "zone_number_changed", "dry_run_changed"];
/** Where a park can be when its start's success arrives late: swept as a
 * failed start, timed out, or superseded. */
const LATE_SUCCESS_FROM = ["start_failed", "superseded"];

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
  /** Every move this start makes, from `starting` (movePark): `recorded`
   * writes its ledger row first, then a move that gave the park its
   * session gets the newer-park check. */
  const settle = (
    data: PendingParkWrite & { status: string },
    seenAt: TookSessionAt,
    recorded: (count: number) => Promise<unknown> = async () => undefined,
  ) => movePark(deps, park, "starting", data, args.at, seenAt, recorded);
  // An agent-bound park's start rows name the key that consented (E3).
  const agentKeyId = await boundAgentKeyId(deps.db, park.userId, parkedEventId);
  const record = (rule: string, outcome: Record<string, unknown>, sessionId?: string) =>
    deps.db.decision.create({
      data: {
        kind: "session_start_walkaway",
        ...(agentKeyId ? { agentKeyId } : {}),
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
  /** A start that paid after its park stopped waiting on it (a sweep, its
   * own deadline, a newer park): the session is real, so the park takes
   * it, from the state it was read in. */
  const adopt = async (sessionId: string) => {
    const current = await deps.db.pendingPark.findUnique({ where: { id: park.id } });
    if (!current || !LATE_SUCCESS_FROM.includes(current.status)) return;
    await movePark(
      deps,
      park,
      current.status,
      { status: "started", sessionId, closedAt: null, ...NOT_BACK },
      args.at,
      "late_success",
      async (count) => {
        if (count !== 1) return;
        await record(
          "late_success",
          { previousStatus: current.status, parkStatus: "started", sessionId },
          sessionId,
        );
      },
    );
  };
  const sessionIdOf = (body: Record<string, unknown>) =>
    typeof body["sessionId"] === "string" ? body["sessionId"] : null;
  /** A session pending past the deadline, or left by a start that threw,
   * goes with its closed park. */
  const failStale = async (session: SessionRow, reason = "stale_pending") => ({
    reason,
    staleSessionId: session.id,
    sessionFailed: await failStalePending(deps.db, session),
  });
  /** Settle as `afterStart` said (left `starting` when its next is null),
   * then `recorded` with what the stale session became. */
  const settleAfterStart = async (
    left: StartLeft,
    reason: string,
    recorded: (stale: Awaited<ReturnType<typeof failStale>> | null) => Promise<unknown>,
  ) => {
    if (left.next === null) return recorded(null);
    return settle(left.next, "start_threw", async (count) =>
      recorded(
        count === 1 && left.stalePending ? await failStale(left.stalePending, reason) : null,
      ),
    );
  };

  const user = { id: park.userId };
  const body = { parkedEventId, zoneId: park.zoneId as string, minutes: shown.stayMinutes };
  const agreed = {
    maxTotalUsd: shown.totalUsd,
    shownZoneNumber: shown.providerZoneNumber,
    ...(park.shownDryRun === true ? { shownDryRun: true } : {}),
  };

  // A session still running for this driver. At the same spot it already
  // pays this park: a second one would pay twice. Somewhere else, the car
  // has moved, and this tap is the driver saying so: that session ends —
  // but only for a start that will run. This start's own refusals (the
  // caps, a changed amount or zone number, an unlinked account) are asked
  // first, and a refused start leaves the running session alone.
  const running = await deps.db.session.findFirst({
    where: { userId: park.userId, status: "active" },
  });
  let refused: Awaited<ReturnType<ParkStarter>> | null = null;
  if (running) {
    const sameSpot =
      running.carLat === null ||
      running.carLng === null ||
      metersBetween(park.carLat, park.carLng, running.carLat, running.carLng) <= SAME_SPOT_M;
    if (sameSpot) {
      await settle({ status: "covered", closedAt: args.at }, "start_settled");
      await record("covered", { parkStatus: "covered", coveredBy: running.id }, running.id);
      return { kind: "covered", sessionId: running.id };
    }
    const check = await ops.start(user, body, {
      ...agreed,
      checkOnly: true,
      replacing: running.id,
    });
    if (check.status !== 200) {
      refused = check;
    } else {
      const lifecycle = await lifecycleOf(deps, running, args.at);
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
  }

  let reply: Awaited<ReturnType<ParkStarter>> | null;
  // A refused check is this start's answer: nothing reached the provider.
  const starting = refused ? Promise.resolve(refused) : ops.start(user, body, agreed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reply = await Promise.race([
      starting,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), START_DEADLINE_MS);
      }),
    ]);
  } catch (err) {
    // The start itself blew up. If the provider was never asked, nothing
    // was charged and the park goes back to waiting: for its tap, or (an
    // early tap) for the app's next on-foot report, or a prompt from the
    // next fixes that show the phone away. If it was asked, whether it
    // charged is unknown, unless its session says; nothing else will
    // answer for a session it left pending, so the park doesn't wait on it.
    const reached = (err as { reachedProvider?: boolean }).reachedProvider === true;
    const left: StartLeft = reached
      ? await afterStart(deps.db, park, args.at, { threw: true }).catch(() => ({
          next: { status: "start_failed", closedAt: args.at },
          stalePending: null,
        }))
      : {
          next:
            args.trigger === "confirm"
              ? { status: "prompted" }
              : {
                  status: "confirmed",
                  leftCarAt: null,
                  farAt: null,
                  farDistanceM: null,
                  ...NOT_BACK,
                },
          stalePending: null,
        };
    let recorded = false;
    const recordError = async (stale: Awaited<ReturnType<typeof failStale>> | null) => {
      recorded = true;
      await record(
        "error",
        {
          parkStatus: left.next?.status ?? "starting",
          reachedProvider: reached,
          error: String(err).split("\n")[0],
          ...stale,
        },
        left.next?.sessionId ?? undefined,
      ).catch(() => undefined);
    };
    await settleAfterStart(left, "start_threw", recordError).catch(() => undefined);
    if (!recorded) await recordError(null);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (reply === null) {
    // No answer in time. Whether it charges is unknown until it answers:
    // the park stops waiting on it as a failed start (its session, still
    // pending, is this very start), and an answer that comes later and
    // paid is adopted.
    await settle({ status: "start_failed", closedAt: args.at }, "start_settled");
    await record("start_timeout", {
      parkStatus: "start_failed",
      reachedProvider: "unknown",
      deadlineMs: START_DEADLINE_MS,
    });
    void starting
      .then(async (late) => {
        const sessionId = sessionIdOf(late.body);
        if (late.status === 200 && sessionId !== null) await adopt(sessionId);
      })
      .catch(() => undefined);
    return { kind: "failed", status: 504, body: { error: "start_timeout" } };
  }

  let outcome: ParkStartOutcome;
  let next: (PendingParkWrite & { status: string }) | null;
  let stalePending: SessionRow | null = null;
  const sessionId = sessionIdOf(reply.body);
  if (reply.status === 200 && sessionId !== null) {
    outcome = { kind: "started", body: reply.body };
    next = { status: "started", sessionId, ...NOT_BACK };
  } else if (reply.status === 200) {
    // The provider says the zone isn't charging: nothing to pay here.
    outcome = { kind: "free", body: reply.body };
    next = { status: "free", closedAt: args.at };
  } else if (reply.reachedProvider) {
    outcome = { kind: "failed", status: reply.status, body: reply.body };
    ({ next, stalePending } = await afterStart(deps.db, park, args.at));
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
  const answered = reply;
  const finish = async (count: number | null) => {
    const stale = count === 1 && stalePending ? await failStale(stalePending) : null;
    await record(
      outcome.kind,
      {
        status: answered.status,
        reachedProvider: answered.reachedProvider,
        parkStatus: next?.status ?? "starting",
        ...(count === 0 ? { parkMovedOn: true } : {}),
        ...stale,
        ...(sessionId !== null ? { sessionId } : {}),
        ...(answered.status === 200
          ? {}
          : { error: answered.body["error"], rule: answered.body["rule"] }),
      },
      sessionId ?? undefined,
    );
  };
  let count: number | null = null;
  if (next === null) await finish(null);
  else count = await settle(next, "start_settled", finish);
  // The park stopped waiting on this start before it answered.
  if (count === 0 && outcome.kind === "started" && sessionId !== null) {
    await adopt(sessionId);
  }
  return outcome;
}
