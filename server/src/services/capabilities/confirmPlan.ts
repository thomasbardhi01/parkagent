/** confirmPlan: the two consequential tools behind one gate — a token the
 * user's tap minted, single-use, for this option. Nothing here pays a meter. */

import type { SingleSpotPlan } from "../assistant/plans.js";
import type { Principal } from "../principal.js";
import { num, audit } from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome } from "./turn.js";

/** Shared gate for the two consequential tools: a token minted by the
 * user's tap, unused, unexpired, owned by this user, and for THIS call —
 * the tool's input must be the option the tap confirmed — or a refusal
 * the model can read. Claims the token atomically on success
 * (single-use even under concurrent calls). */
export async function consumeConfirmation(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  token: unknown,
  tool: "book_garage" | "start_session",
  input: Record<string, unknown>,
): Promise<{ ok: true; planId: string; optionId: string | null } | { ok: false; result: unknown }> {
  const refusal = async (why: string) => {
    await audit(deps, principal, turn, tool, input, "needs_confirmation", { refused: why });
    return {
      ok: false as const,
      result: {
        error: "needs_confirmation",
        message: `${why}. Nothing books or spends without the user's explicit Confirm tap on a proposed plan.`,
      },
    };
  };
  if (typeof token !== "string" || token.length === 0) {
    return refusal("no confirmation_token was provided");
  }
  const row = await deps.db.assistantConfirmation.findUnique({ where: { token } });
  if (!row || row.userId !== principal.userId)
    return refusal("the confirmation token is not valid");
  if (row.usedAt !== null) return refusal("the confirmation token was already used");
  const now = deps.now?.() ?? new Date();
  if (row.expiresAt.getTime() <= now.getTime()) {
    return refusal("the confirmation token expired — propose the plan again");
  }
  // The token authorizes the option that was tapped, not "a" booking.
  const planRow = await deps.db.assistantPlan.findUnique({ where: { id: row.planId } });
  const option =
    planRow?.kind === "single_spot"
      ? (planRow.plan as SingleSpotPlan).options.find((o) => o.id === row.optionId)
      : undefined;
  const matches =
    option !== undefined &&
    (tool === "book_garage"
      ? option.type === "garage" &&
        String(input["option_id"]) === (option.garageOptionId ?? option.id)
      : option.type === "street" &&
        String(input["zone"]) === option.zoneId &&
        num(input["duration_minutes"]) === option.durationMinutes);
  if (!matches) return refusal("the confirmation token is for a different option");
  const claimed = await deps.db.assistantConfirmation.updateMany({
    where: { token, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return refusal("the confirmation token was already used");
  return { ok: true, planId: row.planId, optionId: row.optionId };
}

export async function bookGarage(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const gate = await consumeConfirmation(
    deps,
    principal,
    turn,
    input["confirmation_token"],
    "book_garage",
    {
      option_id: input["option_id"],
    },
  );
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
  const gate = await consumeConfirmation(
    deps,
    principal,
    turn,
    input["confirmation_token"],
    "start_session",
    {
      zone: input["zone"],
      duration_minutes: input["duration_minutes"],
    },
  );
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
