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
  | "amount_over_daily_cap";

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
  spentTodayUsd: number;
  /** The linked account the start or prompt was judged on (`start`, `prompt`). */
  accountStatus: string | null;
}

export type GateResult = GateFacts & ({ ok: true; rule: null } | { ok: false; rule: GateRule });

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

export async function moneyGate(
  deps: GateDeps,
  principal: Principal,
  intent: GateIntent,
  at: Date,
): Promise<GateResult> {
  const policy = await policyFor(deps, principal.userId);
  const dryRun = deps.policy.effectiveDryRun();
  const facts: GateFacts = { policy, dryRun, spentTodayUsd: 0, accountStatus: null };
  const refuse = (rule: GateRule): GateResult => ({ ...facts, ok: false, rule });
  const allow = (): GateResult => ({ ...facts, ok: true, rule: null });

  // An external agent acts only for a person who said it may. Checked
  // first, before any fact about the money, so a refused agent learns
  // nothing about caps or spend.
  if (principal.actor === "external_agent") {
    const user = await deps.db.user.findUnique({
      where: { id: principal.userId },
      select: { agentsMayAct: true },
    });
    if (user?.agentsMayAct !== true) return refuse("agents_not_allowed");
  }

  if (intent.kind === "stop") return allow();
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

  facts.spentTodayUsd = await spentToday(deps.db, principal.userId, at, { dryRun });
  const overDaily = (usd: number) => facts.spentTodayUsd + usd > policy.daily_cap_usd;

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
