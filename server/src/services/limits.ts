/**
 * Each user's own spending limits. policy.json stays the operator's
 * document — dry run, the rate ceiling, auto-extend, fees — and its caps
 * become CEILINGS: a user may set a lower per-stop or per-day cap and a
 * different default stay (GET/PUT /me/limits), never a higher cap. The
 * effective value is min(the user's, the policy's), so the operator
 * lowering a cap binds everyone at once, and a user with no row runs on
 * the policy exactly as before.
 *
 * Every cap check reads `policyFor(user)`: the policy with that user's
 * effective caps and default stay swapped in, so the code below it (the
 * auto-pay decision, quotes, session start and its hold, extensions, the
 * card-authorization webhook, the assistant's budget) reads the same
 * fields it always did. test/limitsScan.test.ts fails any new cap read
 * from the global policy.
 */

import type { AppDb, UserLimitsData, UserLimitsRow } from "../db.js";
import type { Policy } from "./policy.js";

/** The smallest cap a user may set: a dollar still pays a short stop. */
export const MIN_CAP_USD = 1;
/** The default-stay range the app offers (15-minute steps). */
export const STAY_MIN_MINUTES = 15;
export const STAY_MAX_MINUTES = 240;

export interface Limits {
  sessionCapUsd: number;
  dailyCapUsd: number;
  defaultStayMinutes: number;
}

export type LimitField = keyof Limits;

export interface LimitsView {
  /** What every check uses now. */
  limits: Limits;
  /** What the user saved; null = the operator's default. */
  saved: { [K in LimitField]: number | null };
  /** The operator's defaults (policy.json). */
  defaults: Limits;
  /** The most a cap may be (policy.json's caps). */
  ceilings: { sessionCapUsd: number; dailyCapUsd: number };
  bounds: { minCapUsd: number; stayMinutes: { min: number; max: number } };
  /** Fields whose saved value is above today's ceiling (and so capped to
   * it), e.g. after the operator lowered a cap. */
  clamped: LimitField[];
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

function savedOf(row: UserLimitsRow | null): LimitsView["saved"] {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    sessionCapUsd: num(row?.sessionCapUsd),
    dailyCapUsd: num(row?.dailyCapUsd),
    defaultStayMinutes: row?.defaultStayMinutes ?? null,
  };
}

/** The user's limits under this policy. Pure. */
export function limitsView(policy: Policy, row: UserLimitsRow | null): LimitsView {
  const saved = savedOf(row);
  const ceilings = { sessionCapUsd: policy.session_cap_usd, dailyCapUsd: policy.daily_cap_usd };
  const clamped: LimitField[] = [];
  const capped = (field: "sessionCapUsd" | "dailyCapUsd") => {
    const value = saved[field];
    if (value === null) return ceilings[field];
    if (value > ceilings[field]) {
      clamped.push(field);
      return ceilings[field];
    }
    return value;
  };
  const dailyCapUsd = capped("dailyCapUsd");
  // A stop can never cost more than the day allows: a lower daily cap
  // lowers the per-stop one with it.
  const sessionCapUsd = Math.min(capped("sessionCapUsd"), dailyCapUsd);
  return {
    limits: {
      sessionCapUsd,
      dailyCapUsd,
      defaultStayMinutes: saved.defaultStayMinutes ?? policy.default_stay_minutes,
    },
    saved,
    defaults: {
      sessionCapUsd: policy.session_cap_usd,
      dailyCapUsd: policy.daily_cap_usd,
      defaultStayMinutes: policy.default_stay_minutes,
    },
    ceilings,
    bounds: {
      minCapUsd: MIN_CAP_USD,
      stayMinutes: { min: STAY_MIN_MINUTES, max: STAY_MAX_MINUTES },
    },
    clamped,
  };
}

/** The policy with these limits swapped in. Pure. */
export function withLimits(policy: Policy, limits: Limits): Policy {
  return {
    ...policy,
    session_cap_usd: limits.sessionCapUsd,
    daily_cap_usd: limits.dailyCapUsd,
    default_stay_minutes: limits.defaultStayMinutes,
  };
}

interface LimitsDeps {
  db: Pick<AppDb, "userLimits">;
  policy: { get(): Policy };
}

/** This user's policy: every cap check and quote reads this. */
export async function policyFor(deps: LimitsDeps, userId: string): Promise<Policy> {
  const policy = deps.policy.get();
  const row = await deps.db.userLimits.findUnique({ where: { userId } });
  return withLimits(policy, limitsView(policy, row).limits);
}

export async function limitsFor(deps: LimitsDeps, userId: string): Promise<LimitsView> {
  const row = await deps.db.userLimits.findUnique({ where: { userId } });
  return limitsView(deps.policy.get(), row);
}

// ---------------------------------------------------------------- saving

export type LimitsIssueCode =
  "above_ceiling" | "below_minimum" | "session_above_daily" | "out_of_range";

export interface LimitsIssue {
  field: LimitField;
  code: LimitsIssueCode;
  /** The sentence the app shows as is. */
  message: string;
  /** The bound that was crossed. */
  limit: number;
}

/** A PUT body: a field set to null goes back to the operator's default;
 * a field left out keeps its saved value. */
export type LimitsChange = Partial<{ [K in LimitField]: number | null }>;

const LABEL: Record<LimitField, string> = {
  sessionCapUsd: "Per stop",
  dailyCapUsd: "Per day",
  defaultStayMinutes: "Default stay",
};

const money = (usd: number) => `$${usd.toFixed(2)}`;
const duration = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`;

/**
 * The saved values after `change`, or every problem with it — checked
 * against the policy as it is now. Pure.
 */
export function applyChange(
  policy: Policy,
  current: LimitsView["saved"],
  change: LimitsChange,
): { ok: true; saved: UserLimitsData } | { ok: false; issues: LimitsIssue[] } {
  const next: UserLimitsData = {
    sessionCapUsd:
      change.sessionCapUsd !== undefined ? change.sessionCapUsd : current.sessionCapUsd,
    dailyCapUsd: change.dailyCapUsd !== undefined ? change.dailyCapUsd : current.dailyCapUsd,
    defaultStayMinutes:
      change.defaultStayMinutes !== undefined
        ? change.defaultStayMinutes
        : current.defaultStayMinutes,
  };
  if (next.sessionCapUsd !== null) next.sessionCapUsd = cents(next.sessionCapUsd);
  if (next.dailyCapUsd !== null) next.dailyCapUsd = cents(next.dailyCapUsd);

  const issues: LimitsIssue[] = [];
  const cap = (field: "sessionCapUsd" | "dailyCapUsd", ceiling: number) => {
    // Only what this request sets is judged: a value saved earlier that a
    // lowered ceiling now caps is reported as clamped, not refused.
    if (change[field] === undefined || change[field] === null) return;
    const value = next[field]!;
    if (value < MIN_CAP_USD) {
      issues.push({
        field,
        code: "below_minimum",
        message: `${LABEL[field]} must be at least ${money(MIN_CAP_USD)}.`,
        limit: MIN_CAP_USD,
      });
    } else if (value > ceiling) {
      issues.push({
        field,
        code: "above_ceiling",
        message: `${LABEL[field]} can't be more than ${money(ceiling)} — the most ParkAgent pays right now.`,
        limit: ceiling,
      });
    }
  };
  cap("sessionCapUsd", policy.session_cap_usd);
  cap("dailyCapUsd", policy.daily_cap_usd);

  if (change.sessionCapUsd !== undefined || change.dailyCapUsd !== undefined) {
    const session = next.sessionCapUsd ?? policy.session_cap_usd;
    const daily = Math.min(next.dailyCapUsd ?? policy.daily_cap_usd, policy.daily_cap_usd);
    // Explicitly asking for a per-stop cap above the day's is a mistake to
    // say out loud (a lower default is simply capped, see limitsView).
    if (
      next.sessionCapUsd !== null &&
      session > daily &&
      !issues.some((i) => i.field === "sessionCapUsd")
    ) {
      issues.push({
        field: "sessionCapUsd",
        code: "session_above_daily",
        message: `Per stop can't be more than per day (${money(daily)}).`,
        limit: daily,
      });
    }
  }

  const stay = change.defaultStayMinutes;
  if (stay !== undefined && stay !== null && (stay < STAY_MIN_MINUTES || stay > STAY_MAX_MINUTES)) {
    issues.push({
      field: "defaultStayMinutes",
      code: "out_of_range",
      message: `Default stay must be between ${duration(STAY_MIN_MINUTES)} and ${duration(STAY_MAX_MINUTES)}.`,
      limit: stay < STAY_MIN_MINUTES ? STAY_MIN_MINUTES : STAY_MAX_MINUTES,
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, saved: next };
}
