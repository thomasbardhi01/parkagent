/**
 * Session money operations shared by the /session routes and the extension
 * worker: daily-spend accounting, extension policy checks, and the
 * executor-backed extension itself. Everything here runs behind
 * effectiveDryRun() — the executor a call gets is chosen per call, so a
 * PUT /policy flip takes effect immediately.
 */

import type { AppDb, SessionRow } from "../db.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import type { PushSender } from "./apns.js";
import { freePeriodPush, paymentFailedPush, sessionExtendedPush } from "./apns.js";
import type { ExecutorDiagnostics, ExecutorErrorCode, ExecutorProvider } from "./executor.js";
import type { HoursInterval } from "./hours.js";
import { nycStartOfDay } from "./hours.js";
import type { Policy } from "./policy.js";
import type { RatedTerms, StayPrice } from "./quote.js";
import { priceStay } from "./quote.js";
import type { ShadowResult } from "./shadow.js";
import { fireShadowAuthorization } from "./shadow.js";
import type { StripeGateway } from "./stripeGateway.js";

export interface SessionDeps {
  db: AppDb;
  policy: { get(): Policy; hash(): string; effectiveDryRun(): boolean };
  executorFor: ExecutorProvider;
  sendPush: PushSender;
  /** Shadow mode fires its test authorizations through this; absent →
   * shadow results record stripe_not_configured. */
  stripe?: StripeGateway;
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

/** The rate terms the session was sold under (snapshotted at start). The
 * city rides along so extensions pick the right per-city fee. */
export function sessionTerms(session: SessionRow): RatedTerms {
  return {
    city: session.city,
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
  | {
      ok: true;
      session: SessionRow;
      price: StayPrice;
      expiresAt: Date;
      durationMs: number;
      /** Present when shadow mode fired (or tried to fire) a test auth. */
      shadow?: ShadowResult;
    }
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
  const executor = deps.executorFor({
    userId: session.userId,
    city: cityForZone(session.zoneId),
    dryRun,
  });
  const startedAtMs = Date.now();
  const result = await executor.extendSession({
    providerSessionId: session.parknycConfirmation ?? session.id,
    minutes,
    currentExpiresAt: session.expiresAt ?? now,
    amountUsd: price.meterUsd,
    feeUsd: price.feeUsd,
  });
  const durationMs = Date.now() - startedAtMs;

  if (!result.ok && result.code === "free_period") {
    // The provider says the zone isn't charging now (after hours) — a
    // hold, never a payment failure: the session keeps its current time,
    // nothing is marked failed, and the push says parking is free rather
    // than "tap to pay".
    await deps.db.sessionEvent.create({
      data: {
        sessionId: session.id,
        kind: "free_period",
        at: now,
        minutes,
        dryRun,
        details: { source, op: "extend", message: result.message, durationMs },
      },
    });
    await deps.sendPush(
      session.userId,
      freePeriodPush({ zoneNumber: session.providerZoneNumber, notice: result.message }),
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
        zoneNumber: session.providerZoneNumber,
        what: "extend",
        code: result.code,
        providerName: providerForCity(session.city)?.displayName ?? "your parking account",
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
      zoneNumber: session.providerZoneNumber,
      minutes,
      totalUsd: price.totalUsd,
      expiresAt: result.expiresAt,
      dryRun,
    }),
  );

  // Shadow mode: rehearse the Stripe pipeline (webhook → budget checks →
  // ledger) with a test-mode authorization for the same amount. Recorded on
  // the caller's decisions row; never fails the extension.
  const shadow =
    deps.policy.get().shadow_mode === true
      ? await fireShadowAuthorization(deps, session.userId, price.totalUsd, session.city)
      : undefined;

  return {
    ok: true,
    session: updated,
    price,
    expiresAt: result.expiresAt,
    durationMs,
    ...(shadow ? { shadow } : {}),
  };
}
