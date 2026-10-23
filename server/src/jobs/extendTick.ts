/**
 * The extension worker: every 60 s, look at each active session and decide
 * — extend, hold, or warn — from where the driver is relative to the car,
 * how they're moving, what they historically do at this zone, and what a
 * ticket would cost versus more meter time. Every tick writes a decisions
 * row (kind "extend_tick") with all of its inputs; that table is the whole
 * debugging story for the dry-run week.
 *
 * It buys time only while the phone is known to be away from the car
 * (FR-55): never with the phone at the car, never after it came back, and
 * never when there is no sign of where it is.
 *
 * Money only moves through applyExtension → executor, which is picked per
 * call by effectiveDryRun(). Pushes fire on rule *transitions* (a session
 * that stays in "warn_max_stay" for ten ticks warns once), except the
 * extended/failed pushes, which accompany the actual event.
 */

import type { SessionRow } from "../db.js";
import type { ExpiringReason, Push } from "../services/apns.js";
import { reconnectToExtendPush, sessionExpiringPush } from "../services/apns.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import type { Heading, PhonePosition } from "../services/pendingSession.js";
import {
  checkNewerPark,
  clockLabel,
  phonePosition,
  walkTrend,
} from "../services/pendingSession.js";
import { cityPolicy } from "../services/policy.js";
import type { SessionDeps } from "../services/sessions.js";
import { applyExtension, priceExtension } from "../services/sessions.js";
import { withAcceptedStay } from "../services/signs/acceptedStay.js";
import { moneyGate, refusedConsent, sessionSpentUsd } from "../services/moneyGate.js";
import { jobPrincipal, runAs } from "../services/principal.js";
import { policyFor } from "../services/limits.js";

const DECISION_WINDOW_MIN = 12; // only act when expiry is this close
const MAX_STAY_WARN_MIN = 15; // "move your car" comes this long before the stay runs out
const HYSTERESIS_MS = 5 * 60_000; // don't flip a fresh decision
const MIN_EXTEND_MINUTES = 15;
const TICKET_COST_MARGIN = 1.2; // extend only when ticket risk clearly wins
const AT_CAR_ETA_MIN = 2; // within ~2 walking minutes = standing at the car

// Where the phone is, and the trend the cost model reads, are the
// lifecycle's (services/pendingSession.ts: phonePosition, walkTrend).
export type { Heading, PhonePosition };

/** The max stay can't be bought past: say when the car has to move. */
function moveYourCarPush(zoneNumber: string, paidUntil: Date): Push {
  const at = clockLabel(paidUntil);
  return {
    type: "session_expiring",
    title: `Move your car — max stay at ${at}`,
    body: `Zone ${zoneNumber} can't be extended past its max stay. Paid time ends at ${at}.`,
    extra: { reason: "max_stay" },
  };
}

/** A later park put the car somewhere else. Nothing more is bought for a
 * spot the car may have left; the driver can still extend by hand. */
function carMovedPush(zoneNumber: string, minutesLeft: number): Push {
  return {
    type: "session_expiring",
    title: "Meter expiring",
    body: `Zone ${zoneNumber} expires in ${minutesLeft} min. ParkAgent saw your car park somewhere else since, so it won't add time here. Extend in the app if it's still there.`,
    extra: { reason: "car_moved" },
  };
}

/** No extension without knowing the phone has left the car: say so, so
 * the driver can extend by hand. */
function positionUnknownPush(zoneNumber: string, minutesLeft: number): Push {
  return {
    type: "session_expiring",
    title: "Meter expiring",
    body: `Zone ${zoneNumber} expires in ${minutesLeft} min. ParkAgent can't tell that you've left the car, so it won't add time. Extend in the app if you need to.`,
    extra: { reason: "position_unknown" },
  };
}

/** The phone was back at the car since it left, and may have driven off
 * with it: nothing more is bought on a guess, and the driver is told why. */
function backAtCarPush(zoneNumber: string, minutesLeft: number): Push {
  return {
    type: "session_expiring",
    title: "Meter expiring",
    body: `Zone ${zoneNumber} expires in ${minutesLeft} min. Your phone was back at the car since you paid, so ParkAgent won't add time on its own. Extend in the app if the car is still there.`,
    extra: { reason: "back_at_car" },
  };
}

function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface DwellStats {
  p50Minutes: number;
  p80Minutes: number;
  sampleCount: number;
}

/**
 * Dwell model v1: how long this user's past sessions at this zone lasted
 * (stop time, or expiry for sessions that ran out). No history → the
 * policy's default stay. P80 needs a few samples to mean anything; below
 * three it's a flat 1.25 × P50.
 */
export function dwellStatsFrom(dwellsMinutes: number[], defaultStayMinutes: number): DwellStats {
  const samples = dwellsMinutes.filter((d) => d > 0).sort((a, b) => a - b);
  if (samples.length === 0) {
    return {
      p50Minutes: defaultStayMinutes,
      p80Minutes: Math.round(defaultStayMinutes * 1.25),
      sampleCount: 0,
    };
  }
  const p50 = quantile(samples, 0.5);
  const p80 = samples.length >= 3 ? quantile(samples, 0.8) : p50 * 1.25;
  return {
    p50Minutes: Math.round(p50),
    p80Minutes: Math.round(p80),
    sampleCount: samples.length,
  };
}

/**
 * P(driver is back at the car before the meter runs out). v1 heuristic —
 * coarse buckets, every input logged so the buckets can be tuned against
 * the decisions table.
 */
export function pReturnInTime(args: {
  heading: Heading;
  walkEtaMin: number | null;
  remainingMin: number;
  elapsedMin: number;
  dwellP50Min: number;
}): number {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  // Standing at (or next to) the car: they can drive off or feed the meter
  // themselves — extending against a ticket is money down the drain. Same
  // 0.98 as walking-back-with-time-to-spare, and for the same reason: it
  // must sit high enough that ticket_cost × (1 − p) undercuts even a
  // cheap extension.
  if (args.walkEtaMin !== null && args.walkEtaMin <= AT_CAR_ETA_MIN) return 0.98;
  if (args.heading === "toward" && args.walkEtaMin !== null) {
    // Walking back with time to spare: near-certain. Must sit high enough
    // that ticket_cost × (1 - p) drops below a cheap extension's cost, or
    // the $65-vs-$2 asymmetry would extend on every walk back.
    if (args.walkEtaMin <= args.remainingMin) return 0.98;
    return clamp(0.9 - 0.05 * (args.walkEtaMin - args.remainingMin), 0.1, 0.9);
  }
  if (args.heading === "away") return 0.15;
  // Still, or no usable fixes: fall back to how long they usually stay.
  const remainingDwellP50 = Math.max(0, args.dwellP50Min - args.elapsedMin);
  return remainingDwellP50 <= args.remainingMin ? 0.6 : 0.25;
}

export interface ExtenderDeps extends SessionDeps {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface Extender {
  /** One pass over the active sessions; exposed for tests. */
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
  /** Resolves when the pass in progress (if any) is done — shutdown waits
   * for it rather than cutting an extension off mid-payment. */
  drain(): Promise<void>;
}

export function makeExtender(deps: ExtenderDeps): Extender {
  const now = () => deps.now?.() ?? new Date();

  async function evaluateSession(session: SessionRow, at: Date): Promise<void> {
    // The session owner's caps and default stay, not the operator's.
    const policy = await policyFor(deps, session.userId);
    const dryRun = deps.policy.effectiveDryRun();
    const expiresAt = session.expiresAt ?? at;
    const startedAt = session.startedAt ?? session.createdAt;
    const remainingMin = (expiresAt.getTime() - at.getTime()) / 60_000;
    const elapsedMin = (at.getTime() - startedAt.getTime()) / 60_000;

    // Meter already ran out: bookkeeping, not a decision to extend.
    if (remainingMin <= 0) {
      await deps.db.session.update({ where: { id: session.id }, data: { status: "expired" } });
      await deps.db.sessionEvent.create({
        data: { sessionId: session.id, kind: "expired", at, dryRun },
      });
      await deps.db.decision.create({
        data: {
          kind: "extend_tick",
          inputs: { remainingMin, elapsedMin, dryRun, policyHash: deps.policy.hash() },
          rule: "expired",
          outcome: { action: "none" },
          userId: session.userId,
          sessionId: session.id,
        },
      });
      return;
    }

    // Where the driver is (FR-55), and the trend the cost model reads: both
    // the lifecycle's, from its park row and the session's newest fixes on
    // their report clock (phonePosition, walkTrend). No park row is
    // `unknown`: nothing is bought for a session the walk rules never saw.
    let park = await deps.db.pendingPark.findUnique({ where: { sessionId: session.id } });
    // The belt (#246): however this park came to hold its session, the
    // newest park since it says where the car is before anything is bought.
    if (park && park.carMovedAt === null) {
      if (await checkNewerPark(deps, park, at, "extension_worker")) {
        park = await deps.db.pendingPark.findUnique({ where: { sessionId: session.id } });
      }
    }
    const fixes = await deps.db.locationFix.findMany({
      where: { sessionId: session.id },
      orderBy: { ts: "desc" },
      take: 3,
    });
    const position: PhonePosition = phonePosition(park, fixes[0] ?? null, at);
    const trend = walkTrend(
      session.carLat !== null && session.carLng !== null
        ? { lat: session.carLat, lng: session.carLng }
        : null,
      fixes,
      park?.parkedAt ?? startedAt,
      at,
    );
    const { distanceM, heading, walkEtaMin } = trend;

    // How long they usually stay here.
    const past = await deps.db.session.findMany({
      where: {
        userId: session.userId,
        zoneId: session.zoneId,
        status: { in: ["stopped", "expired"] },
        id: { not: session.id },
      },
    });
    const dwells = past
      .filter((s) => s.startedAt !== null)
      .map((s) => {
        const end = s.stoppedAt ?? s.expiresAt;
        return end ? (end.getTime() - s.startedAt!.getTime()) / 60_000 : 0;
      });
    const dwell = dwellStatsFrom(dwells, policy.default_stay_minutes);

    const pReturn = pReturnInTime({
      heading,
      walkEtaMin,
      remainingMin,
      elapsedMin,
      dwellP50Min: dwell.p50Minutes,
    });

    // What to buy if we extend: to the P80 of predicted remaining dwell,
    // clamped by policy.
    const remainingDwellP80 = Math.max(0, dwell.p80Minutes - elapsedMin);
    // The stay as the gate judges it: held to a stay accepted from the
    // signs, whatever the row's stored max stay says (signs/acceptedStay.ts).
    const judged = await withAcceptedStay(deps.db, session);
    const stayLeftMin =
      judged.maxStayMinutes !== null
        ? judged.maxStayMinutes - judged.purchasedMinutes
        : Number.POSITIVE_INFINITY;
    const desiredMinutes = Math.min(
      Math.max(MIN_EXTEND_MINUTES, Math.ceil(remainingDwellP80)),
      policy.auto_extend.max_minutes_each,
      stayLeftMin,
    );
    const price = priceExtension(session, policy, Math.max(1, Math.floor(desiredMinutes)));
    const costExtendUsd = price.totalUsd;
    // Ticket risk is priced with the session's city's ticket (a Boston
    // "Meter Fee Unpaid" is $40 where NYC's is $65 — policy city_overrides).
    const costTicketUsd = cityPolicy(policy, session.city).ticketCostUsd * (1 - pReturn);
    // The session's provider, from its zone as the gate reads it: named on
    // a hold for an account that can't pay, and in its reconnect push.
    const provider = providerForCity(cityForZone(session.zoneId));
    // The money gate's answer for this extension (caps, max stay); the
    // ladder below asks it only once the cheaper holds are ruled out.
    const gate = await moneyGate(
      deps,
      jobPrincipal(session.userId),
      {
        kind: "extend",
        session: judged,
        minutes: Math.floor(desiredMinutes),
        price,
        source: "auto",
      },
      at,
    );
    // A job pass acts for the session's owner; it is never an external agent.
    if (refusedConsent(gate)) throw new Error("a job pass needs no consent");
    const { spentTodayUsd } = gate;

    // The decision ladder. Max-stay gate: the stay allowance left to buy is
    // either too small to be a meaningful extension or already inside the
    // no-extend buffer before the legal limit — warn the driver to move.
    let rule: string;
    let expiringReason:
      | ExpiringReason
      | "position_unknown"
      | "car_moved"
      | "back_at_car"
      | "reconnect_provider"
      | null = null;
    const nearMaxStay =
      judged.maxStayMinutes !== null &&
      stayLeftMin <=
        Math.max(MIN_EXTEND_MINUTES - 1, policy.auto_extend.no_extend_within_minutes_of_max_stay);

    if (remainingMin > (nearMaxStay ? MAX_STAY_WARN_MIN : DECISION_WINDOW_MIN)) {
      rule = "hold_not_near_expiry";
    } else if (nearMaxStay) {
      rule = "warn_max_stay";
      expiringReason = "max_stay";
    } else if (costTicketUsd <= costExtendUsd * TICKET_COST_MARGIN) {
      rule = "hold_return_likely";
    } else if (position === "returned") {
      // The phone came back: the park is over, and nothing more is bought.
      rule = "hold_returned";
    } else if (position === "moved") {
      rule = "hold_car_moved";
      expiringReason = "car_moved";
    } else if (position === "at_car") {
      // At or in the car, where the cost rule alone would still buy a
      // cheap enough extension: they can drive off or pay themselves.
      rule = "hold_at_car";
    } else if (position === "back") {
      rule = "hold_back_at_car";
      expiringReason = "back_at_car";
    } else if (position === "unknown") {
      rule = "hold_position_unknown";
      expiringReason = "position_unknown";
    } else if (!policy.auto_extend.enabled) {
      rule = "hold_auto_extend_disabled";
      expiringReason = "no_auto_extend";
    } else if (session.extendCount >= policy.auto_extend.max_count) {
      rule = "hold_max_extensions";
      expiringReason = "no_auto_extend";
    } else {
      const violation = gate.ok ? null : gate.rule;
      if (violation === "session_cap_exceeded") {
        rule = "hold_session_cap";
        expiringReason = "budget";
      } else if (violation === "daily_cap_exceeded") {
        rule = "hold_daily_cap";
        expiringReason = "budget";
      } else if (violation === "max_stay_exceeded") {
        rule = "warn_max_stay";
        expiringReason = "max_stay";
      } else if (violation === "receipt_needs_review") {
        rule = "hold_needs_review";
        expiringReason = "receipt_review";
      } else if (violation === "provider_not_linked") {
        // The parking account was unlinked or expired since the start:
        // nothing can pay more time; the driver is asked to reconnect.
        rule = "hold_provider_not_linked";
        expiringReason = "reconnect_provider";
      } else if (violation !== null) {
        // amount_invalid, minutes_invalid, or a rule named after this
        // ladder was written: a refusal holds, never extends.
        rule = "hold_gate_refused";
        expiringReason = "no_auto_extend";
      } else {
        rule = "extend";
      }
    }

    const inputs = {
      remainingMin: Math.round(remainingMin * 10) / 10,
      elapsedMin: Math.round(elapsedMin * 10) / 10,
      fixCount: trend.fixCount,
      staleFixCount: trend.staleFixCount,
      distanceM: distanceM !== null ? Math.round(distanceM) : null,
      walkEtaMin: walkEtaMin !== null ? Math.round(walkEtaMin * 10) / 10 : null,
      heading,
      position,
      leftCarAt: park?.leftCarAt?.toISOString() ?? null,
      // What `back` is read from: the phone back at the car since it left,
      // and the first fix of a drive-off pair since.
      backAt: park?.backAt?.toISOString() ?? null,
      driveAt: park?.driveAt?.toISOString() ?? null,
      dwell,
      pReturn,
      desiredMinutes: Math.floor(desiredMinutes),
      price,
      costExtendUsd,
      costTicketUsd: Math.round(costTicketUsd * 100) / 100,
      spentTodayUsd,
      sessionSpentUsd: sessionSpentUsd(session),
      purchasedMinutes: session.purchasedMinutes,
      extendCount: session.extendCount,
      maxStayMinutes: judged.maxStayMinutes,
      dryRun,
      policyHash: deps.policy.hash(),
      // The account the gate judged (it refuses before reading today's
      // spend, so spentTodayUsd is null on this hold).
      ...(rule === "hold_provider_not_linked"
        ? { provider: provider?.id ?? null, accountStatus: gate.accountStatus ?? "none" }
        : {}),
    };

    // Hysteresis: a freshly settled rule stands for 5 minutes; a tick that
    // wants something different logs and waits.
    const changed = rule !== session.lastExtenderRule;
    if (
      changed &&
      session.lastExtenderRule !== null &&
      session.lastExtenderRuleAt !== null &&
      at.getTime() - session.lastExtenderRuleAt.getTime() < HYSTERESIS_MS
    ) {
      await deps.db.decision.create({
        data: {
          kind: "extend_tick",
          inputs: { ...inputs, desiredRule: rule, heldRule: session.lastExtenderRule },
          rule: "hysteresis_hold",
          outcome: { action: "none" },
          userId: session.userId,
          sessionId: session.id,
        },
      });
      return;
    }

    let outcome: Record<string, unknown> = { action: "hold" };
    let heldUnderLock = false;
    if (rule === "extend") {
      const minutes = Math.floor(desiredMinutes);
      const result = await applyExtension(
        deps,
        jobPrincipal(session.userId),
        session,
        minutes,
        price,
        "auto",
      );
      if (result.ok) {
        outcome = {
          action: "extend",
          minutes,
          price,
          expiresAt: result.expiresAt.toISOString(),
          durationMs: result.durationMs,
          ...(result.executor ? { executor: result.executor } : {}),
          ...(result.shadow ? { shadow: result.shadow } : {}),
          ...(result.hold ? { hold: result.hold } : {}),
        };
      } else if (
        result.code === "session_cap_exceeded" ||
        result.code === "daily_cap_exceeded" ||
        result.code === "max_stay_exceeded" ||
        result.code === "amount_invalid" ||
        result.code === "minutes_invalid" ||
        result.code === "provider_not_linked"
      ) {
        // The gate refused the fresh row under the lock (another extension
        // landed since this one was priced): the matching cap rule, as a
        // hold, never an executor failure. Not booked as the settled rule:
        // the next tick reads the same hold from its own ladder, sees the
        // change, and sends the driver the warning this tick can't.
        heldUnderLock = true;
        rule =
          result.code === "session_cap_exceeded"
            ? "hold_session_cap"
            : result.code === "daily_cap_exceeded"
              ? "hold_daily_cap"
              : result.code === "amount_invalid" || result.code === "minutes_invalid"
                ? "hold_gate_refused"
                : result.code === "provider_not_linked"
                  ? "hold_provider_not_linked"
                  : "warn_max_stay";
        outcome = {
          action: "hold",
          minutes,
          ok: false,
          code: result.code,
          message: result.message,
          underLock: true,
          ...(result.spentTodayUsd !== undefined ? { spentTodayUsd: result.spentTodayUsd } : {}),
          ...(result.code === "provider_not_linked"
            ? { provider: provider?.id ?? null, accountStatus: result.accountStatus ?? "none" }
            : {}),
        };
      } else if (result.code === "extension_in_progress" || result.code === "phone_not_away") {
        // The user's own Extend (or a racing tick) got there first, or the
        // phone came back to the car while this one was priced; it never
        // started — nothing held, nothing charged, no push. It isn't a
        // rule of ours either, so it must not start the hysteresis window:
        // the next tick decides afresh, from the new expiry or position.
        rule = result.code;
        outcome = {
          action: "none",
          minutes,
          ok: false,
          code: result.code,
          message: result.message,
        };
      } else {
        // free_period is a HOLD, not a failure: applyExtension already
        // pushed "parking is free now" and nothing was charged. A declined
        // ParkAgent-card hold is an extend_failed whose code says so (the
        // push already told the user to update the card in Wallet).
        rule = result.code === "free_period" ? "free_period" : "extend_failed";
        outcome = {
          action: result.code === "free_period" ? "hold" : "extend",
          minutes,
          ok: false,
          code: result.code,
          message: result.message,
          durationMs: result.durationMs,
          ...(result.executor ? { executor: result.executor } : {}),
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
          ...(result.hold ? { hold: result.hold } : {}),
        };
      }
    } else if (expiringReason !== null && changed) {
      // Warn once per rule transition, not every tick.
      const minutesLeft = Math.max(0, Math.round(remainingMin));
      await deps.sendPush(
        session.userId,
        expiringReason === "max_stay"
          ? moveYourCarPush(session.providerZoneNumber, expiresAt)
          : expiringReason === "position_unknown"
            ? positionUnknownPush(session.providerZoneNumber, minutesLeft)
            : expiringReason === "car_moved"
              ? carMovedPush(session.providerZoneNumber, minutesLeft)
              : expiringReason === "back_at_car"
                ? backAtCarPush(session.providerZoneNumber, minutesLeft)
                : expiringReason === "reconnect_provider" && provider
                  ? reconnectToExtendPush({
                      provider: provider.id,
                      displayName: provider.displayName,
                      zoneNumber: session.providerZoneNumber,
                      minutesLeft,
                    })
                  : sessionExpiringPush({
                      zoneNumber: session.providerZoneNumber,
                      minutesLeft,
                      reason:
                        expiringReason === "reconnect_provider" ? "no_auto_extend" : expiringReason,
                    }),
      );
      outcome = { action: "warn", pushed: expiringReason };
    }

    await deps.db.decision.create({
      data: {
        kind: "extend_tick",
        inputs,
        rule,
        outcome,
        userId: session.userId,
        sessionId: session.id,
      },
    });

    if (
      changed &&
      rule !== "extension_in_progress" &&
      rule !== "phone_not_away" &&
      !heldUnderLock
    ) {
      await deps.db.session.update({
        where: { id: session.id },
        data: { lastExtenderRule: rule, lastExtenderRuleAt: at },
      });
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  let inFlight: Promise<void> = Promise.resolve();

  function tick(): Promise<void> {
    if (running) return inFlight; // a slow tick must not overlap the next
    running = true;
    inFlight = pass();
    return inFlight;
  }

  async function pass(): Promise<void> {
    try {
      const at = now();
      const active = await deps.db.session.findMany({ where: { status: "active" } });
      for (const session of active) {
        try {
          // Each session's pass runs as a job acting for its owner, so its
          // decisions say so (services/principal.ts).
          await runAs(jobPrincipal(session.userId), () => evaluateSession(session, at));
        } catch (err) {
          deps.log.warn(`extend tick failed for session ${session.id}: ${String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      deps.log.info(`extension worker started (every ${intervalMs / 1000}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    drain: () => inFlight,
  };
}
