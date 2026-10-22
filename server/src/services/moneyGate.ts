/**
 * The one money gate. Every path that would buy time or move money asks
 * it first, with what it means to do (`GateIntent`), and gets back the
 * first rule that refuses, or none, plus the facts it judged on (the
 * caller's policy, the effective dry run, today's spend). The rules
 * themselves live only here: per-stop and daily caps (`policyFor` +
 * `spentToday`), max stay, the effective dry run, the provider link, what
 * the tap was shown, the phone's position for an auto extension, and
 * consent for an external agent (`users.agents_may_act`).
 *
 * Each intent runs its checks in the order its path refused in before
 * the gate existed, so a caller's decision rows and responses read the
 * same. A new money path adds an intent here, never a check of its own
 * (`test/limitsScan.test.ts` fails a cap read anywhere else).
 */

import type { AppDb, SessionRow } from "../db.js";
import type { ProviderInfo } from "../providers/registry.js";
import { providerStatusUsable } from "../providers/registry.js";
import { nycStartOfDay } from "./hours.js";
import { policyFor } from "./limits.js";
import { LINK_COMMITTED_STATUSES, linkSpentSince } from "./link/linkSpend.js";
import type { Policy, PolicyService } from "./policy.js";
import type { Principal } from "./principal.js";
import type { StayPrice } from "./quote.js";
import { inSpan } from "./telemetry.js";

export interface GateDeps {
  db: AppDb;
  policy: Pick<PolicyService, "effectiveDryRun" | "get">;
}

/** What a refusal is called: the rule on the decision row and the error
 * the caller answers with. */
export type GateRule =
  | "agents_not_allowed"
  | "provider_not_linked"
  | "needs_zone_number"
  | "max_stay_exceeded"
  | "free_period"
  | "rate_above_ceiling"
  | "session_cap_exceeded"
  | "daily_cap_exceeded"
  | "quote_changed"
  | "zone_number_changed"
  | "dry_run_changed"
  | "phone_not_away"
  | "amount_over_daily_cap"
  /** An amount the gate would judge, or a cap it would judge it against,
   * is not a finite number >= 0. */
  | "amount_invalid";

export type GateIntent =
  /** A street start (POST /session/start, the tap, the walk-away). */
  | {
      kind: "start";
      provider: ProviderInfo | null;
      zoneNumber: string;
      minutes: number;
      maxStayMinutes: number | null;
      price: StayPrice;
      /** What the tap agreed to: a start may not cost more, type another
       * zone number, or charge for real what was shown as a dry run. */
      shown?: {
        maxTotalUsd?: number | undefined;
        zoneNumber?: string | undefined;
        dryRun?: boolean | undefined;
      };
    }
  /** /parked's auto-pay rule for a fresh quote. */
  | { kind: "quote"; totalUsd: number; ladderMaxRateUsd: number }
  /** The walk-away prompt: the start's own refusals, said in words. */
  | { kind: "prompt"; provider: ProviderInfo | null; zoneNumber: string; totalUsd: number }
  /** An extension, priced; `underLock` is applyExtension's own re-check on
   * the fresh row, where an auto extension also needs the phone away. */
  | {
      kind: "extend";
      session: SessionRow;
      minutes: number;
      price: StayPrice;
      source: "manual" | "auto";
      underLock?: boolean;
    }
  /** Stopping buys nothing; only consent applies. */
  | { kind: "stop" }
  /** Consuming a mandate (confirmPlan): the plan was judged when it was
   * proposed, so only consent applies here; the spend is judged again by
   * the start or the hold it leads to. */
  | { kind: "confirm" }
  /** The assistant's confirm: each stop is its own purchase against the
   * per-stop cap (when `perStop`), the day as a whole against what is
   * left of today's cap, requests still awaiting Link approval included. */
  | { kind: "plan"; stopsUsd: number[]; totalUsd: number; pendingUsd?: number; perStop: boolean }
  /** A funding move (card top-up or withdraw, provider wallet top-up):
   * an amount-only ceiling, not spend. */
  | { kind: "funding"; amountUsd: number };

export interface GateFacts {
  policy: Policy;
  dryRun: boolean;
  /** Today's spend as the gate read it; null when it never read it (a
   * refusal before the read, or a funding move, which doesn't count it). */
  spentTodayUsd: number | null;
  /** The linked account the start or prompt was judged on (`start`, `prompt`). */
  accountStatus: string | null;
}

/** A refused agent learns nothing: no policy, no dry run, no spend. */
export interface ConsentRefusal {
  ok: false;
  rule: "agents_not_allowed";
}

export type GateResult =
  | ConsentRefusal
  | (GateFacts &
      ({ ok: true; rule: null } | { ok: false; rule: Exclude<GateRule, "agents_not_allowed"> }));

export function refusedConsent(result: GateResult): result is ConsentRefusal {
  return !("policy" in result);
}

/**
 * Dollars this user has committed today (NYC calendar day), whatever
 * paid: street sessions on any source, plus garages approved in Link. The
 * daily cap is measured against this everywhere — quotes, starts,
 * extensions, the assistant, the Wallet. Dry-run sessions are excluded —
 * they moved no money — and failed ones never charged. Under a dry run
 * (`opts.dryRun`, the effective one) they count too, so a dry run is
 * refused wherever the same day for real would be.
 */
export async function spentToday(
  db: AppDb,
  userId: string,
  at: Date,
  opts: { dryRun?: boolean } = {},
): Promise<number> {
  const since = nycStartOfDay(at);
  const rows = await db.session.findMany({
    where: {
      userId,
      ...(opts.dryRun === true ? {} : { dryRun: false }),
      status: { in: ["pending", "active", "stopped", "expired"] },
      createdAt: { gte: since },
    },
  });
  const streetUsd = rows.reduce(
    (sum, s) => sum + Number(s.amountUsd ?? 0) + Number(s.feeUsd ?? 0),
    0,
  );
  return streetUsd + (await linkSpentSince(db, userId, since, LINK_COMMITTED_STATUSES));
}

export function sessionSpentUsd(session: SessionRow): number {
  return Number(session.amountUsd ?? 0) + Number(session.feeUsd ?? 0);
}

/** Every comparison here is `amount > cap`, and NaN or undefined makes
 * each one false, so a missing or garbled amount, or cap, would pass.
 * Each amount and each cap is held to this first, and the gate refuses
 * otherwise. */
function validAmount(usd: unknown): boolean {
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0;
}

/** The amounts an intent asks the gate to judge, before any is compared. */
function intentAmounts(intent: GateIntent): unknown[] {
  switch (intent.kind) {
    case "start":
      return [
        intent.price?.totalUsd,
        // "Not shown" is undefined; a shown amount must be a real one.
        ...(intent.shown?.maxTotalUsd !== undefined ? [intent.shown.maxTotalUsd] : []),
      ];
    case "quote":
      return [intent.totalUsd, intent.ladderMaxRateUsd];
    case "prompt":
      return [intent.totalUsd];
    case "extend":
      return [intent.price?.totalUsd, sessionSpentUsd(intent.session)];
    case "plan":
      return [
        intent.totalUsd,
        ...(Array.isArray(intent.stopsUsd) ? intent.stopsUsd : [Number.NaN]),
        ...(intent.pendingUsd !== undefined ? [intent.pendingUsd] : []),
      ];
    case "funding":
      return [intent.amountUsd];
    case "stop":
    case "confirm":
      return [];
  }
}

/** What the intent would spend, for its span: amounts are fine on a
 * span, what anyone wrote never is. Read before the gate has judged it,
 * so it may be missing or garbled: the span then goes without it, and
 * the gate refuses as it would (validAmount). */
function amountOf(intent: GateIntent): unknown {
  switch (intent.kind) {
    case "start":
    case "extend":
      return intent.price?.totalUsd;
    case "quote":
    case "prompt":
    case "plan":
      return intent.totalUsd;
    case "funding":
      return intent.amountUsd;
    case "stop":
    case "confirm":
      return 0;
  }
}

/** The one money gate, as a `money_gate` span with its intent, who asked,
 * and how it ruled (services/telemetry.ts). */
export function moneyGate(
  deps: GateDeps,
  principal: Principal,
  intent: GateIntent,
  at: Date,
): Promise<GateResult> {
  const amount = amountOf(intent);
  return inSpan(
    "money_gate",
    {
      "parkagent.gate.intent": intent.kind,
      "parkagent.gate.actor": principal.actor,
      ...(validAmount(amount) ? { "parkagent.gate.amount_usd": amount as number } : {}),
    },
    async (span) => {
      const result = await decide(deps, principal, intent, at);
      span.setAttributes({
        "parkagent.gate.ok": result.ok,
        "parkagent.gate.rule": result.rule ?? "allowed",
        ...("dryRun" in result ? { "parkagent.gate.dry_run": result.dryRun } : {}),
      });
      return result;
    },
  );
}

async function decide(
  deps: GateDeps,
  principal: Principal,
  intent: GateIntent,
  at: Date,
): Promise<GateResult> {
  // An external agent acts only for a person who said it may. Checked
  // first, before any fact about the money is read, so a refused agent
  // learns nothing about caps, dry run or spend.
  if (principal.actor === "external_agent") {
    const user = await deps.db.user.findUnique({
      where: { id: principal.userId },
      select: { agentsMayAct: true },
    });
    if (user?.agentsMayAct !== true) return { ok: false, rule: "agents_not_allowed" };
  }

  const policy = await policyFor(deps, principal.userId);
  const dryRun = deps.policy.effectiveDryRun();
  const facts: GateFacts = { policy, dryRun, spentTodayUsd: null, accountStatus: null };
  const refuse = (rule: Exclude<GateRule, "agents_not_allowed">): GateResult => ({
    ...facts,
    ok: false,
    rule,
  });
  const allow = (): GateResult => ({ ...facts, ok: true, rule: null });

  // Fail closed, before any account or spend is read and before any
  // comparison: the amounts the intent carries, and the caps they are
  // compared to (a saved cap Postgres stores as 'NaN' would pass them all).
  if (!intentAmounts(intent).every(validAmount)) return refuse("amount_invalid");
  if (intent.kind === "stop" || intent.kind === "confirm") return allow();
  const caps = [
    policy.session_cap_usd,
    policy.daily_cap_usd,
    ...(intent.kind === "quote" ? [policy.auto_pay_max_rate_per_hour] : []),
  ];
  if (!caps.every(validAmount)) return refuse("amount_invalid");
  if (intent.kind === "funding") {
    return intent.amountUsd > policy.daily_cap_usd ? refuse("amount_over_daily_cap") : allow();
  }

  if (intent.kind === "start" || intent.kind === "prompt") {
    // The zone's city names its provider; without the user's own linked
    // account there the executor has nothing to pay with. A
    // provider-covered zone without a known pay-by-app number can't be
    // typed into the provider's Enter Zone screen either.
    if (intent.provider) {
      const account = await deps.db.providerAccount.findUnique({
        where: { userId_provider: { userId: principal.userId, provider: intent.provider.id } },
      });
      facts.accountStatus = account?.status ?? null;
      if (!account || !providerStatusUsable(account.status)) return refuse("provider_not_linked");
      if (intent.zoneNumber === "") return refuse("needs_zone_number");
    }
  }

  const spent = await spentToday(deps.db, principal.userId, at, { dryRun });
  facts.spentTodayUsd = spent;
  // A garbled ledger amount makes today's sum NaN, and NaN passes the cap.
  if (!validAmount(spent)) return refuse("amount_invalid");
  const overDaily = (usd: number) => spent + usd > policy.daily_cap_usd;

  switch (intent.kind) {
    case "start": {
      const { price } = intent;
      if (intent.maxStayMinutes !== null && intent.minutes > intent.maxStayMinutes) {
        return refuse("max_stay_exceeded");
      }
      // A wholly free window: there is nothing to buy, and typing minutes
      // into the provider anyway could charge real money our quote said
      // was $0 (/parked answers "ignore" for the same reason).
      if (price.totalUsd === 0) return refuse("free_period");
      if (price.totalUsd > policy.session_cap_usd) return refuse("session_cap_exceeded");
      if (overDaily(price.totalUsd)) return refuse("daily_cap_exceeded");
      const shown = intent.shown;
      if (shown?.maxTotalUsd !== undefined && price.totalUsd > shown.maxTotalUsd + 0.001) {
        // The tap agreed to an amount; this start would cost more than it.
        return refuse("quote_changed");
      }
      if (shown?.zoneNumber && shown.zoneNumber !== intent.zoneNumber) {
        // …to a zone number; the table now holds another (a newer report).
        return refuse("zone_number_changed");
      }
      if (shown?.dryRun === true && !dryRun) {
        // …to a dry run, "nothing is charged"; this one would charge.
        return refuse("dry_run_changed");
      }
      return allow();
    }
    case "quote": {
      if (intent.totalUsd === 0) return refuse("free_period");
      if (intent.ladderMaxRateUsd > policy.auto_pay_max_rate_per_hour) {
        return refuse("rate_above_ceiling");
      }
      if (intent.totalUsd > policy.session_cap_usd) return refuse("session_cap_exceeded");
      if (overDaily(intent.totalUsd)) return refuse("daily_cap_exceeded");
      return allow();
    }
    case "prompt": {
      if (intent.totalUsd > policy.session_cap_usd) return refuse("session_cap_exceeded");
      if (overDaily(intent.totalUsd)) return refuse("daily_cap_exceeded");
      return allow();
    }
    case "extend": {
      const { session, minutes, price } = intent;
      if (intent.underLock && intent.source === "auto") {
        // The worker buys time only for a phone known to be away (FR-55),
        // and read that before it took the lock: a phone back within reach
        // of the car since, or a car that parked somewhere else, buys
        // nothing.
        const park = await deps.db.pendingPark.findUnique({ where: { sessionId: session.id } });
        if (
          park &&
          (park.status !== "started" || park.backAt !== null || park.carMovedAt !== null)
        ) {
          return refuse("phone_not_away");
        }
      }
      // Order matches /parked's ladder: stay limit, per-session cap, daily cap.
      if (
        session.maxStayMinutes !== null &&
        session.purchasedMinutes + minutes > session.maxStayMinutes
      ) {
        return refuse("max_stay_exceeded");
      }
      if (sessionSpentUsd(session) + price.totalUsd > policy.session_cap_usd) {
        return refuse("session_cap_exceeded");
      }
      if (overDaily(price.totalUsd)) return refuse("daily_cap_exceeded");
      return allow();
    }
    case "plan": {
      if (intent.perStop && intent.stopsUsd.some((usd) => usd > policy.session_cap_usd)) {
        return refuse("session_cap_exceeded");
      }
      if (overDaily((intent.pendingUsd ?? 0) + intent.totalUsd))
        return refuse("daily_cap_exceeded");
      return allow();
    }
  }
}
