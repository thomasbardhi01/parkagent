/** A plan as the phone's card takes it: every fact the search's; stored
 * and ended on (presentPlan). Shared by the searches and propose_plan. */

import { randomUUID } from "node:crypto";
import { windowAssumption } from "../assistant/clarify.js";
import { type TimeRequest } from "../assistant/requestedTime.js";
import { easternIso, parseEasternTime } from "../hours.js";
import { planSchema } from "../assistant/plans.js";
import type {
  AssistantPlanBody,
  SingleSpotOption,
  SingleSpotPlan,
  Violation,
} from "../assistant/plans.js";
import type { SearchOption, SearchResult, SearchWindow } from "../assistant/search.js";
import type { Principal } from "../principal.js";
import { isUrl, PAY_ON_ARRIVAL_MS, audit } from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome } from "./turn.js";

/**
 * A search option as a card option: every fact is the search's. Only
 * the label and the one-line detail may be the model's words.
 */
export function cardOption(
  option: SearchOption,
  window: SearchWindow,
  now: Date,
  extra: {
    label?: string | undefined;
    detail?: string | undefined;
    violates?: Violation[] | undefined;
    /** The option leads the card (decision 8). */
    primary?: boolean | undefined;
    /** The approval threshold: a price over it is marked `warn`. */
    warnOverUsd?: number | undefined;
  },
): SingleSpotOption {
  const starts = window.startsNow ? null : parseEasternTime(window.startsAt);
  const facts = option.facts;
  return {
    id: option.id,
    type: option.type,
    label: (extra.label ?? option.label).slice(0, 120),
    detail: (
      extra.detail ??
      (option.type === "street"
        ? (option.summary ?? "Metered street parking")
        : "Off-street garage")
    ).slice(0, 240),
    priceUsd: option.priceUsd,
    durationMinutes: Math.min(720, Math.max(1, Math.round(option.durationMinutes))),
    walkMinutes: Math.min(120, Math.max(0, Math.round(option.walkMinutes))),
    // Only a walking time the search fetched is not an estimate.
    walkEstimate: option.walkEstimate !== false,
    fetchedAt: option.fetchedAt,
    // One canonical form, so the phone parses what the server did.
    ...(starts ? { startsAt: easternIso(starts) } : {}),
    ...(option.lat !== undefined && option.lng !== undefined
      ? { lat: option.lat, lng: option.lng }
      : {}),
    ...(option.axis ? { axis: option.axis } : {}),
    ...(option.secondary ? { secondary: true as const } : {}),
    ...(extra.primary && !extra.violates?.length ? { primary: true as const } : {}),
    // Compared in cents: a price AT the threshold doesn't warn.
    ...(extra.warnOverUsd !== undefined &&
    Math.round(option.priceUsd * 100) > Math.round(extra.warnOverUsd * 100)
      ? { warn: true as const }
      : {}),
    ...(extra.violates?.length ? { nearMiss: true as const, violates: extra.violates } : {}),
    ...(option.type === "street"
      ? {
          zoneId: option.zoneId,
          // A future meter can't be started now (meters run from
          // payment): the detector pays on arrival, and the card shows
          // that instead of Confirm.
          payOnArrival: starts !== null && starts.getTime() - now.getTime() > PAY_ON_ARRIVAL_MS,
          ...(facts
            ? {
                ...(facts.street ? { street: facts.street } : {}),
                zoneNumber: facts.zoneNumber,
                streetState: facts.state,
                streetSummary: facts.summary,
                priceBreakdown: { meterUsd: facts.meterUsd, feeUsd: facts.feeUsd },
                ratePerHourUsd: facts.ratePerHourUsd,
                hoursToday: facts.hoursToday,
                maxStayMinutes: facts.maxStayMinutes,
                exceedsMaxStay: facts.exceedsMaxStay,
              }
            : {}),
        }
      : {
          garageOptionId: option.garageOptionId,
          payOnArrival: false,
          ...(option.provider ? { provider: option.provider } : {}),
          ...(option.entryType ? { entryType: option.entryType } : {}),
          ...(isUrl(option.deepLink) ? { deepLink: option.deepLink } : {}),
        }),
    recommended: false,
  };
}

/** What every single-place card carries besides its options, all from
 * the search: the place it was searched at, where garage prices came
 * from and when, and what the plan assumed in one line ("Now–3:00 PM,
 * near you" when the place is the phone's location). */
export function cardFrame(
  search: SearchResult,
  shown: SingleSpotOption[],
  now: Date,
  request: TimeRequest | undefined,
): Pick<SingleSpotPlan, "destination" | "provenance" | "assumptions"> {
  const { place, window } = search;
  const garages = shown.filter((o) => o.type === "garage");
  // Which sources the SURFACED options came from — with two providers
  // merged, the aggregate id would credit a source with nothing shown.
  const provenance =
    garages.length > 0
      ? {
          provider: [...new Set(garages.map((o) => o.provider ?? ""))]
            .filter((p) => p.length > 0)
            .sort()
            .join("+"),
          searchedAt: garages.map((o) => o.fetchedAt ?? search.searchedAt).sort()[0]!,
        }
      : search.garage?.unavailable
        ? {
            provider: search.garage.provider,
            searchedAt: search.searchedAt,
            garage: "unavailable" as const,
          }
        : null;
  return {
    ...(place.source === "user" && place.label
      ? { destination: { lat: place.lat, lng: place.lng, label: place.label.slice(0, 120) } }
      : {}),
    ...(provenance && provenance.provider.length > 0 ? { provenance } : {}),
    assumptions: windowAssumption(
      {
        start: window.startsNow ? null : parseEasternTime(window.startsAt),
        minutes: window.durationMinutes,
      },
      // The phone's location standing in for a place is an assumption
      // like any other: it is said.
      place.source === "user" ? place.label : "you",
      now,
      request,
    ),
  };
}

/** Store a plan and end the turn on it. The plan is checked against the
 * card contract first: a malformed plan never reaches the client. */
export async function presentPlan(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
  plan: AssistantPlanBody,
  rule: "proposed" | "none_meets" | "no_zone_here" | "garage_search_unavailable",
): Promise<ToolOutcome> {
  const checked = planSchema.safeParse(plan);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 8);
    await audit(deps, principal, turn, "propose_plan", input, "invalid_plan", {
      issues,
      built: true,
    });
    return { result: { error: "invalid plan shape", issues } };
  }
  const planId = randomUUID();
  await deps.db.assistantPlan.create({
    data: {
      id: planId,
      userId: principal.userId,
      conversationId: turn.conversationId,
      kind: plan.kind,
      plan,
    },
  });
  await deps.db.decision.create({
    data: {
      kind: "assistant_plan",
      inputs: { conversationId: turn.conversationId, kind: plan.kind },
      rule,
      outcome: { planId, plan },
      userId: principal.userId,
    },
  });
  return { result: { planId, presented: true, kind: plan.kind }, endTurn: { planId, plan } };
}
