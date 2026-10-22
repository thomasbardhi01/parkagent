/** confirmPlan: the two consequential tools behind one gate — a token the
 * user's tap minted, single-use, for this option. Nothing here pays a meter. */

import type { SingleSpotOption, SingleSpotPlan } from "../assistant/plans.js";
import type { Principal } from "../principal.js";
import type { MandateRefusal } from "../mandates.js";
import { claimMandate, planUnchanged, readMandate } from "../mandates.js";
import { moneyGate } from "../moneyGate.js";
import { num, audit } from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome } from "./turn.js";

/** Why a confirm was refused, for a caller that answers in codes (REST). */
export type ConfirmRefusal =
  | { why: "consent"; rule: string }
  | { why: "mandate"; reason: MandateRefusal }
  | { why: "different_option" }
  | { why: "nothing_to_confirm" }
  | { why: "dry_run_changed"; shown: boolean; now: boolean }
  | { why: "over_cap"; rule: string }
  | { why: "option_expired" };

/** What is being confirmed. A model tool's input must be the option the
 * tap confirmed; an agent's REST confirm names only the plan and takes the
 * option its mandate names. */
export type ConfirmFor =
  | { tool: "book_garage"; optionId: unknown }
  | { tool: "start_session"; zone: unknown; durationMinutes: unknown }
  | { tool: "agent_confirm"; planId: string };

export type Confirmation =
  | { ok: true; planId: string; option: SingleSpotOption; expiresAt: Date; dryRun: boolean }
  | { ok: false; refusal: ConfirmRefusal; result: unknown };

/**
 * The one confirm sequence, for every surface (the app's tap, through
 * the model's tools; an agent's REST confirm): consent; a mandate that is
 * unused, unexpired and this principal's; a plan unchanged since it was
 * minted; an option that matches what is being confirmed; the dry run the
 * mandate was minted under, still in force; the person's caps now (the
 * option as one purchase); and, for a garage, an offer still bookable.
 * Only then is the mandate claimed, atomically (single-use even under
 * concurrent calls). A refusal before the claim leaves it unspent; every
 * refusal writes an audit row and reads as a sentence the model can use.
 */
export async function consumeConfirmation(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  token: unknown,
  what: ConfirmFor,
): Promise<Confirmation> {
  const input: Record<string, unknown> =
    what.tool === "book_garage"
      ? { option_id: what.optionId }
      : what.tool === "start_session"
        ? { zone: what.zone, duration_minutes: what.durationMinutes }
        : { planId: what.planId };
  const refuse = async (
    refusal: ConfirmRefusal,
    rule: string,
    result: Record<string, unknown>,
    outcome: Record<string, unknown> = {},
  ) => {
    await audit(deps, principal, turn, what.tool, input, rule, outcome);
    return { ok: false as const, refusal, result };
  };
  const needsConfirmation = (refusal: ConfirmRefusal, why: string) =>
    refuse(
      refusal,
      "needs_confirmation",
      {
        error: "needs_confirmation",
        message: `${why}. Nothing books or spends without the user's explicit Confirm tap on a proposed plan.`,
      },
      { refused: why },
    );
  const mandateRefusal = (reason: MandateRefusal) =>
    needsConfirmation({ why: "mandate", reason }, refusalWords(reason));
  const now = deps.now?.() ?? new Date();
  // Who is acting, before the token is even read: an external agent acts
  // only for a person who said it may (the gate's consent rule).
  const consent = await moneyGate(deps, principal, { kind: "confirm" }, now);
  if (!consent.ok) {
    return refuse({ why: "consent", rule: consent.rule }, consent.rule, { error: consent.rule });
  }
  if (typeof token !== "string" || token.length === 0) return mandateRefusal("not_valid");
  // The mandate is read once, to learn which option it names, and
  // claimed once everything below holds: it authorizes the option that
  // was confirmed, not "a" booking.
  const mandates = { db: deps.db, pepper: deps.apiKeyPepper };
  const read = await readMandate(mandates, principal, token, now);
  if (!read.ok) return mandateRefusal(read.reason);
  const row = read.row;
  if (what.tool === "agent_confirm" && row.planId !== what.planId) {
    return mandateRefusal("not_valid");
  }
  const planRow = await deps.db.assistantPlan.findUnique({ where: { id: row.planId } });
  if (planRow && !planUnchanged(row, planRow.plan)) return mandateRefusal("plan_changed");
  const option =
    planRow?.kind === "single_spot"
      ? (planRow.plan as SingleSpotPlan).options.find((o) => o.id === row.optionId)
      : undefined;
  if (!option && what.tool === "agent_confirm") {
    return needsConfirmation({ why: "nothing_to_confirm" }, "this plan has nothing to confirm");
  }
  const matches =
    option !== undefined &&
    (what.tool === "agent_confirm" ||
      (what.tool === "book_garage"
        ? option.type === "garage" && String(what.optionId) === (option.garageOptionId ?? option.id)
        : option.type === "street" &&
          String(what.zone) === option.zoneId &&
          num(what.durationMinutes) === option.durationMinutes));
  if (!option || !matches) {
    return needsConfirmation(
      { why: "different_option" },
      "the confirmation token is for a different option",
    );
  }
  // What was shown is what is agreed to: a mandate minted under a dry run
  // never confirms a real one, nor the reverse (as the tap's
  // dry_run_changed).
  const dryRun = deps.policy.effectiveDryRun();
  const snapshot = row.capsSnapshot as { dryRun?: unknown } | null;
  if (typeof snapshot?.dryRun === "boolean" && snapshot.dryRun !== dryRun) {
    return refuse(
      { why: "dry_run_changed", shown: snapshot.dryRun, now: dryRun },
      "dry_run_changed",
      {
        error: "dry_run_changed",
        message: "Dry run changed since this plan was proposed. Propose it again.",
      },
      { shownDryRun: snapshot.dryRun, dryRun },
    );
  }
  // The caps, now: the option is one purchase against the per-stop cap
  // and what is left of today's. A garage the person taps for themselves
  // is paid at the garage's own checkout, by them (Link has its own cap
  // gate in the route); an agent confirming anything is held to the caps.
  const capped = option.type === "street" || principal.actor === "external_agent";
  const caps = capped
    ? await moneyGate(
        deps,
        principal,
        { kind: "plan", stopsUsd: [option.priceUsd], totalUsd: option.priceUsd, perStop: true },
        now,
      )
    : ({ ok: true } as const);
  if (!caps.ok) {
    return refuse(
      { why: "over_cap", rule: caps.rule },
      caps.rule,
      {
        error: "policy_violation",
        rule: caps.rule,
        message: `This option is over the user's limits now (${caps.rule}). Nothing was booked.`,
      },
      { priceUsd: option.priceUsd },
    );
  }
  // A garage is booked from the provider's search cache, which expires: a
  // stale offer is refused here, before the claim, so a mandate is never
  // spent on a booking that can't happen.
  if (option.type === "garage" && !deps.garage.optionById(option.garageOptionId ?? option.id)) {
    return refuse({ why: "option_expired" }, "option_expired", {
      error: "option_expired",
      message: "The garage offer expired with the provider's search. Search again.",
    });
  }
  const claimed = await claimMandate(mandates, row, now);
  if (!claimed.ok) return mandateRefusal(claimed.reason);
  return { ok: true, planId: claimed.planId, option, expiresAt: row.expiresAt, dryRun };
}

/** What the model is told when a mandate can't be consumed. */
function refusalWords(reason: MandateRefusal): string {
  switch (reason) {
    case "used":
      return "the confirmation token was already used";
    case "expired":
      return "the confirmation token expired — propose the plan again";
    case "plan_changed":
      return "the plan changed since it was confirmed — propose it again";
    case "scope":
      return "this key may not confirm";
    case "not_valid":
      return "the confirmation token is not valid";
  }
}

export async function bookGarage(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const gate = await consumeConfirmation(deps, principal, turn, input["confirmation_token"], {
    tool: "book_garage",
    optionId: input["option_id"],
  });
  if (!gate.ok) return { result: gate.result };
  const booking = await deps.garage.book(String(input["option_id"]));
  await audit(
    deps,
    principal,
    turn,
    "book_garage",
    { option_id: input["option_id"], planId: gate.planId },
    "booked",
    { kind: booking.kind, provider: booking.option.provider, priceUsd: booking.option.priceUsd },
  );
  return {
    result: {
      kind: booking.kind,
      deepLink: booking.deepLink ?? null,
      option: booking.option,
      note:
        booking.kind === "deeplink_handoff"
          ? "The user completes checkout at the provider; the pass lives in the provider's app."
          : "Reserved.",
    },
  };
}

export async function startSession(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const gate = await consumeConfirmation(deps, principal, turn, input["confirmation_token"], {
    tool: "start_session",
    zone: input["zone"],
    durationMinutes: input["duration_minutes"],
  });
  if (!gate.ok) return { result: gate.result };
  // The meter session itself starts through the app's existing paid
  // flow (detector → /parked → /session/start): a meter runs from the
  // moment it's paid, so the confirmed choice is handed to the client
  // to execute at the curb rather than paid from here early.
  await audit(
    deps,
    principal,
    turn,
    "start_session",
    { zone: input["zone"], minutes: input["duration_minutes"], planId: gate.planId },
    "confirmed",
    { directive: "start_via_app" },
  );
  return {
    result: {
      confirmed: true,
      directive: "start_via_app",
      zoneId: String(input["zone"]),
      durationMinutes: num(input["duration_minutes"]),
    },
  };
}
