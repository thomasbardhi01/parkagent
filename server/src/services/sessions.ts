/**
 * Session money operations shared by the /session routes and the extension
 * worker: daily-spend accounting, extension policy checks, and the
 * executor-backed extension itself. Everything here runs behind
 * effectiveDryRun() — the executor a call gets is chosen per call, so a
 * PUT /policy flip takes effect immediately.
 */

import type { AppDb, SessionRow } from "../db.js";
import type { PushSender } from "./apns.js";
import { paymentFailedPush, sessionExtendedPush } from "./apns.js";
import type { ExecutorDiagnostics, ExecutorErrorCode, ExecutorProvider } from "./executor.js";
import type { HoursInterval } from "./hours.js";
import { nycStartOfDay } from "./hours.js";
import type { Policy } from "./policy.js";
import type { RatedTerms, StayPrice } from "./quote.js";
import { priceStay } from "./quote.js";

export interface SessionDeps {
  db: AppDb;
  policy: { get(): Policy; hash(): string; effectiveDryRun(): boolean };
  executorFor: ExecutorProvider;
  sendPush: PushSender;
  now?: () => Date;
}

/**
 * Real dollars this user has committed today (NYC calendar day). Dry-run
 * sessions are excluded — they moved no money — and failed ones never
 * charged.
 */
export async function spentToday(db: AppDb, userId: string, at: Date): Promise<number> {
  const rows = await db.session.findMany({
    where: {
      userId,
      dryRun: false,
      status: { in: ["pending", "active", "stopped", "expired"] },
      createdAt: { gte: nycStartOfDay(at) },
    },
  });
  return rows.reduce((sum, s) => sum + Number(s.amountUsd ?? 0) + Number(s.feeUsd ?? 0), 0);
}

/** The rate terms the session was sold under (snapshotted at start). */
export function sessionTerms(session: SessionRow): RatedTerms {
  return {
    rateFirstHourUsd: Number(session.rateFirstHour ?? 0),
    rateAdditionalHourUsd: Number(session.rateAdditionalHour ?? 0),
    hours: (session.hoursJson ?? []) as HoursInterval[],
  };
}

export function sessionSpentUsd(session: SessionRow): number {
  return Number(session.amountUsd ?? 0) + Number(session.feeUsd ?? 0);
}

/**
 * Would this extension violate policy? Returns the rule that fires, or
 * null when the extension is allowed. Order matches /parked's ladder:
 * stay limit, then per-session cap, then daily cap.
 */
export function extensionPolicyViolation(
  policy: Policy,
  session: SessionRow,
  minutes: number,
  price: StayPrice,
  spentTodayUsd: number,
): "max_stay_exceeded" | "session_cap_exceeded" | "daily_cap_exceeded" | null {
  if (
    session.maxStayMinutes !== null &&
    session.purchasedMinutes + minutes > session.maxStayMinutes
  ) {
    return "max_stay_exceeded";
  }
  if (sessionSpentUsd(session) + price.totalUsd > policy.session_cap_usd) {
    return "session_cap_exceeded";
  }
  // Dry-run sessions never count toward the daily cap (no money moved), so
  // only a real extension can trip it.
  if (!session.dryRun && spentTodayUsd + price.totalUsd > policy.daily_cap_usd) {
    return "daily_cap_exceeded";
  }
  return null;
}

export function priceExtension(session: SessionRow, policy: Policy, minutes: number): StayPrice {
  // Extensions start where the paid time ends and continue the rate ladder
  // from the charged minutes already bought.
  return priceStay(
    sessionTerms(session),
    policy,
    session.expiresAt ?? new Date(),
    minutes,
    session.chargedMinutes,
  );
}

export type ExtensionOutcome =
  | { ok: true; session: SessionRow; price: StayPrice; expiresAt: Date; durationMs: number }
  | {
      ok: false;
      code: ExecutorErrorCode;
      message: string;
      price: StayPrice;
      durationMs: number;
      diagnostics?: ExecutorDiagnostics;
    };

/**
 * Run an already-policy-checked extension through the executor and record
 * what happened (session row, session_events, push). The caller writes the
 * decisions row — route and worker log different inputs.
 */
export async function applyExtension(
  deps: SessionDeps,
  session: SessionRow,
  minutes: number,
  price: StayPrice,
  source: "manual" | "auto",
): Promise<ExtensionOutcome> {
  const now = deps.now?.() ?? new Date();
  const dryRun = deps.policy.effectiveDryRun();
  const executor = deps.executorFor(dryRun);
  const startedAtMs = Date.now();
  const result = await executor.extendSession({
    providerSessionId: session.parknycConfirmation ?? session.id,
    minutes,
    currentExpiresAt: session.expiresAt ?? now,
    amountUsd: price.meterUsd,
    feeUsd: price.feeUsd,
  });
  const durationMs = Date.now() - startedAtMs;

  if (!result.ok) {
    await deps.db.sessionEvent.create({
      data: {
        sessionId: session.id,
        kind: "failed",
        at: now,
        minutes,
        dryRun,
        details: { source, op: "extend", code: result.code, message: result.message, durationMs },
      },
    });
    await deps.sendPush(
      session.userId,
      paymentFailedPush({
        zoneNumber: session.parknycZoneNumber,
        what: "extend",
        code: result.code,
      }),
    );
    return {
      ok: false,
      code: result.code,
      message: result.message,
      price,
      durationMs,
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    };
  }

  const updated = await deps.db.session.update({
    where: { id: session.id },
    data: {
      expiresAt: result.expiresAt,
      amountUsd: Number(session.amountUsd ?? 0) + price.meterUsd,
      feeUsd: Number(session.feeUsd ?? 0) + price.feeUsd,
      purchasedMinutes: session.purchasedMinutes + minutes,
      chargedMinutes: session.chargedMinutes + price.chargedMinutes,
      extendCount: session.extendCount + 1,
    },
  });
  await deps.db.sessionEvent.create({
    data: {
      sessionId: session.id,
      kind: "extended",
      at: now,
      minutes,
      amountUsd: price.meterUsd,
      feeUsd: price.feeUsd,
      expiresAt: result.expiresAt,
      providerSessionId: result.providerSessionId,
      dryRun,
      details: { source, durationMs },
    },
  });
  await deps.sendPush(
    session.userId,
    sessionExtendedPush({
      zoneNumber: session.parknycZoneNumber,
      minutes,
      totalUsd: price.totalUsd,
      expiresAt: result.expiresAt,
      dryRun,
    }),
  );
  return { ok: true, session: updated, price, expiresAt: result.expiresAt, durationMs };
}
