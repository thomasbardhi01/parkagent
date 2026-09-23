/**
 * The extension worker: every 60 s, look at each active session and decide
 * — extend, hold, or warn — from where the driver is relative to the car,
 * how they're moving, what they historically do at this zone, and what a
 * ticket would cost versus more meter time. Every tick writes a decisions
 * row (kind "extend_tick") with all of its inputs; that table is the whole
 * debugging story for the dry-run week.
 *
 * Money only moves through applyExtension → executor, which is picked per
 * call by effectiveDryRun(). Pushes fire on rule *transitions* (a session
 * that stays in "warn_max_stay" for ten ticks warns once), except the
 * extended/failed pushes, which accompany the actual event.
 */

import type { SessionRow } from "../db.js";
import type { ExpiringReason } from "../services/apns.js";
import { sessionExpiringPush } from "../services/apns.js";
import { cityPolicy } from "../services/policy.js";
import type { SessionDeps } from "../services/sessions.js";
import {
  applyExtension,
  extensionPolicyViolation,
  priceExtension,
  sessionSpentUsd,
  spentToday,
} from "../services/sessions.js";

const DECISION_WINDOW_MIN = 12; // only act when expiry is this close
const HYSTERESIS_MS = 5 * 60_000; // don't flip a fresh decision
const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h
const ROUTE_FACTOR = 1.3; // straight-line → street grid
const HEADING_NOISE_M = 15; // GPS jitter floor over the 3-fix window
const MIN_EXTEND_MINUTES = 15;
const TICKET_COST_MARGIN = 1.2; // extend only when ticket risk clearly wins
const FIX_MAX_AGE_MS = 10 * 60_000; // older fixes say nothing about "now"
const AT_CAR_ETA_MIN = 2; // within ~2 walking minutes = standing at the car

export type Heading = "toward" | "away" | "still" | "unknown";

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Trend of distance-to-car over the last fixes (chronological order). */
export function headingFromDistances(distancesM: number[]): Heading {
  if (distancesM.length < 2) return "unknown";
  const first = distancesM[0]!;
  const last = distancesM[distancesM.length - 1]!;
  const delta = last - first;
  if (Math.abs(delta) < HEADING_NOISE_M) return "still";
  return delta < 0 ? "toward" : "away";
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
}

export function makeExtender(deps: ExtenderDeps): Extender {
  const now = () => deps.now?.() ?? new Date();

  async function evaluateSession(session: SessionRow, at: Date): Promise<void> {
    const policy = deps.policy.get();
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

    // Where the driver is, relative to the car. A fix that's ten minutes
    // old describes where they were, not where they are — stale fixes are
    // dropped, and with none fresh the model falls back to dwell history
    // (heading "unknown"), same as a phone that never reported.
    const allFixes = await deps.db.locationFix.findMany({
      where: { sessionId: session.id },
      orderBy: { ts: "desc" },
      take: 3,
    });
    const fixes = allFixes.filter((f) => at.getTime() - f.ts.getTime() <= FIX_MAX_AGE_MS);
    const chronological = [...fixes].reverse();
    const distances =
      session.carLat !== null && session.carLng !== null
        ? chronological.map((f) => haversineM(f.lat, f.lng, session.carLat!, session.carLng!))
        : [];
    const distanceM = distances.length > 0 ? distances[distances.length - 1]! : null;
    const walkEtaMin =
      distanceM !== null ? (distanceM * ROUTE_FACTOR) / WALK_SPEED_M_PER_MIN : null;
    const heading = headingFromDistances(distances);

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
    const stayLeftMin =
      session.maxStayMinutes !== null
        ? session.maxStayMinutes - session.purchasedMinutes
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
    const spentTodayUsd = await spentToday(deps.db, session.userId, at);

    // The decision ladder. Max-stay gate: the stay allowance left to buy is
    // either too small to be a meaningful extension or already inside the
    // no-extend buffer before the legal limit — warn the driver to move.
    let rule: string;
    let expiringReason: ExpiringReason | null = null;
    const nearMaxStay =
      session.maxStayMinutes !== null &&
      stayLeftMin <=
        Math.max(MIN_EXTEND_MINUTES - 1, policy.auto_extend.no_extend_within_minutes_of_max_stay);

    if (remainingMin > DECISION_WINDOW_MIN) {
      rule = "hold_not_near_expiry";
    } else if (nearMaxStay) {
      rule = "warn_max_stay";
      expiringReason = "max_stay";
    } else if (costTicketUsd <= costExtendUsd * TICKET_COST_MARGIN) {
      rule = "hold_return_likely";
    } else if (!policy.auto_extend.enabled) {
      rule = "hold_auto_extend_disabled";
      expiringReason = "no_auto_extend";
    } else if (session.extendCount >= policy.auto_extend.max_count) {
      rule = "hold_max_extensions";
      expiringReason = "no_auto_extend";
    } else {
      const violation = extensionPolicyViolation(
        policy,
        session,
        Math.floor(desiredMinutes),
        price,
        spentTodayUsd,
      );
      if (violation === "session_cap_exceeded") {
        rule = "hold_session_cap";
        expiringReason = "budget";
      } else if (violation === "daily_cap_exceeded") {
        rule = "hold_daily_cap";
        expiringReason = "budget";
      } else if (violation === "max_stay_exceeded") {
        rule = "warn_max_stay";
        expiringReason = "max_stay";
      } else {
        rule = "extend";
      }
    }

    const inputs = {
      remainingMin: Math.round(remainingMin * 10) / 10,
      elapsedMin: Math.round(elapsedMin * 10) / 10,
      fixCount: fixes.length,
      staleFixCount: allFixes.length - fixes.length,
      distanceM: distanceM !== null ? Math.round(distanceM) : null,
      walkEtaMin: walkEtaMin !== null ? Math.round(walkEtaMin * 10) / 10 : null,
      heading,
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
      maxStayMinutes: session.maxStayMinutes,
      dryRun,
      policyHash: deps.policy.hash(),
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
    if (rule === "extend") {
      const minutes = Math.floor(desiredMinutes);
      const result = await applyExtension(deps, session, minutes, price, "auto");
      if (result.ok) {
        outcome = {
          action: "extend",
          minutes,
          price,
          expiresAt: result.expiresAt.toISOString(),
          durationMs: result.durationMs,
          ...(result.shadow ? { shadow: result.shadow } : {}),
        };
      } else {
        // free_period is a HOLD, not a failure: applyExtension already
        // pushed "parking is free now" and nothing was charged.
        rule = result.code === "free_period" ? "free_period" : "extend_failed";
        outcome = {
          action: result.code === "free_period" ? "hold" : "extend",
          minutes,
          ok: false,
          code: result.code,
          message: result.message,
          durationMs: result.durationMs,
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        };
      }
    } else if (expiringReason !== null && changed) {
      // Warn once per rule transition, not every tick.
      await deps.sendPush(
        session.userId,
        sessionExpiringPush({
          zoneNumber: session.providerZoneNumber,
          minutesLeft: Math.max(0, Math.round(remainingMin)),
          reason: expiringReason,
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

    if (changed) {
      await deps.db.session.update({
        where: { id: session.id },
        data: { lastExtenderRule: rule, lastExtenderRuleAt: at },
      });
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // a slow tick must not overlap the next
    running = true;
    try {
      const at = now();
      const active = await deps.db.session.findMany({ where: { status: "active" } });
      for (const session of active) {
        try {
          await evaluateSession(session, at);
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
  };
}
