/** proposePlan: the card, held to the latest search and the request by the
 * rules V1–V5 (FR-43). The model names options by id; the server fills the rest. */

import { coveredCitiesSentence } from "../../providers/registry.js";
import { assumptionsFor } from "../assistant/clarify.js";
import { type TimeRequest } from "../assistant/requestedTime.js";
import { type RequestState } from "../assistant/requestState.js";
import { easternIso, parseEasternTime } from "../hours.js";
import { confirmWarnUsd } from "../policy.js";
import { moneyGate, refusedConsent } from "../moneyGate.js";
import type { CandidateFetcher } from "../zoneLookup.js";
import {
  itineraryTotalUsd,
  orderStopsByArrival,
  proposedPlanSchema,
  recommendationReason,
} from "../assistant/plans.js";
import type {
  AssistantPlanBody,
  NoDataPlan,
  NoneMeetsPlan,
  ProposedPlan,
  SingleSpotPlan,
} from "../assistant/plans.js";
import {
  constraintsFailedFor,
  isFresh,
  isGarageOnly,
  noneMeetsHeadline,
  poolOptions,
  requestSummaryFor,
} from "../assistant/search.js";
import type { SearchResult } from "../assistant/search.js";
import {
  MAX_STREET_RADIUS_M,
  displayStreet,
  nearestPointOn,
  walkMinutesFor,
} from "../assistant/streetOptions.js";
import { policyFor } from "../limits.js";
import { scrubUngroundedAmounts } from "../assistant/replyText.js";
import type { Principal } from "../principal.js";
import {
  ownAmounts,
  TIME_FORMAT_HINT,
  NEAREST_ZONE_RADIUS_M,
  now,
  audit,
  stateOf,
  currentSearch,
  requestedTimeMoved,
} from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome } from "./turn.js";
import { cardOption, cardFrame, presentPlan } from "./cards.js";
import { completeSearch } from "./search.js";

/**
 * propose_plan. A single-spot plan is options from the latest search,
 * by id, held to the request by these rules — in this order, each
 * refusal audited under its own name (FR-43):
 *
 *  V1  every option id is in the latest search, and that search was run
 *      at the request's current version and is fresh
 *      (`stale_or_unknown_option`);
 *  V2  the price, walk, zone, window, and link are the search's; a price
 *      the model typed that differs is recorded (`model_price_mismatch`);
 *  V3  an option that breaks a limit rides along only as nearMiss: true,
 *      with the server's `violates` (`hard_constraint_violation`);
 *  V4  with nothing satisfying, the only plan is the "no" (`must_say_no`);
 *      with something satisfying, a "no" is refused (`options_available`);
 *  V5  an itinerary's total is recomputed and held to the caller's daily
 *      cap (`over_daily_cap`). There is no per-plan cap (decision 9).
 *
 * The reply's own check (V6, `ungrounded_number`) is the loop's.
 */
export async function proposePlan(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const parsed = proposedPlanSchema.safeParse(input["plan"]);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 8);
    await audit(deps, principal, turn, "propose_plan", input, "invalid_plan", { issues });
    return { result: { error: "invalid plan shape", issues } };
  }
  const proposed = parsed.data;
  if (proposed.kind === "itinerary") return proposeItinerary(deps, principal, turn, proposed);
  if (proposed.kind === "none_meets")
    return proposeNoneMeets(deps, principal, turn, input, proposed);
  return proposeSingleSpot(deps, principal, turn, input, proposed);
}

/** Why the latest search can't be proposed from, in the model's words. */
export function staleHint(deps: CapabilityDeps, turn: TurnState): string {
  const last = turn.lastSearch;
  const version = stateOf(turn).version;
  if (!last) {
    return "Nothing has been searched for this request yet: call quote_street and search_garages, then propose options by the ids they return.";
  }
  if (last.stateVersion !== version) {
    return `The request changed after that search (it is at version ${version} now): search again, then propose options by the new ids.`;
  }
  if (!isFresh(last, now(deps))) {
    return "That search is more than 10 minutes old, and prices are for when they were fetched: search again, then propose by the new ids.";
  }
  return "Use option ids exactly as the latest search returned them (validIds).";
}

export async function staleOrUnknown(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
  optionIds: string[],
  validIds: string[],
): Promise<ToolOutcome> {
  const stateVersion = stateOf(turn).version;
  await audit(deps, principal, turn, "propose_plan", input, "stale_or_unknown_option", {
    optionIds,
    stateVersion,
    searchVersion: turn.lastSearch?.stateVersion ?? null,
  });
  return {
    result: {
      error: "stale_or_unknown_option",
      optionIds,
      validIds,
      stateVersion,
      hint: staleHint(deps, turn),
    },
  };
}

export async function proposeSingleSpot(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
  proposed: Extract<ProposedPlan, { kind: "single_spot" }>,
): Promise<ToolOutcome> {
  const last = currentSearch(deps, turn);
  const meets = new Map((last?.satisfying ?? []).map((o) => [o.id, o]));
  const misses = new Map((last?.nearMisses ?? []).map((n) => [n.option.id, n]));

  // V1: an option is a result of the latest search or it isn't on the card.
  const unknown = proposed.options.filter((o) => !meets.has(o.id) && !misses.has(o.id));
  if (!last || unknown.length > 0) {
    return staleOrUnknown(
      deps,
      principal,
      turn,
      input,
      (last ? unknown : proposed.options).map((o) => o.id),
      [...meets.keys(), ...misses.keys()],
    );
  }
  // V3: a near-miss is shown as one, or not at all.
  const dressed = proposed.options.filter((o) => misses.has(o.id) && o.nearMiss !== true);
  if (dressed.length > 0) {
    const optionIds = dressed.map((o) => o.id);
    await audit(deps, principal, turn, "propose_plan", input, "hard_constraint_violation", {
      optionIds,
    });
    return {
      result: {
        error: "hard_constraint_violation",
        optionIds,
        violates: Object.fromEntries(optionIds.map((id) => [id, misses.get(id)!.violates])),
        hint: "These options break a limit of the request. Leave them out, or include one with nearMiss: true — never as if it met the request.",
      },
    };
  }
  // V4: nothing satisfies, so the only honest plan is the "no".
  if (last.satisfying.length === 0) {
    await audit(deps, principal, turn, "propose_plan", input, "must_say_no", {
      stateVersion: last.stateVersion,
    });
    return {
      result: {
        error: "must_say_no",
        instruction:
          'Nothing in the latest search meets the request, so there is no single_spot plan to propose. Call propose_plan with {kind: "none_meets"}.',
      },
    };
  }

  // The time the user named is the plan's (requestedTime.ts): a plan
  // starting anywhere else goes back to the model with the time they
  // asked for.
  const now = deps.now?.() ?? new Date();
  const moved = requestedTimeMoved(turn, last.window, now);
  if (moved) {
    await audit(deps, principal, turn, "propose_plan", input, "requested_time_moved", {
      startsAt: last.window.startsNow ? null : last.window.startsAt,
    });
    return {
      result: {
        error: "requested_time_moved",
        instruction: `${moved} The plan's time is the request's: set it with update_request (startsAt), then search and propose again.`,
      },
    };
  }

  // The card's options, in the search's order (the model never
  // reorders). Decision 8: the option that honors the ask is always on
  // the card and first — with no ask, the cheapest and the closest both
  // lead — and the best on the other axis is always shown as the
  // secondary alternative. Then what the model chose, then any flagged
  // near-miss.
  const state = stateOf(turn);
  const chosen = new Set(proposed.options.map((o) => o.id));
  const [first, second] = last.satisfying;
  const coPrimary = first?.axis === "cheapest" && second?.axis === "closest" && !second.secondary;
  const leading = new Set(
    [first?.id, coPrimary ? second?.id : undefined].filter((id): id is string => !!id),
  );
  // A garage-only request's cheaper meter (search.ts) is the server's to
  // show: once, last, whatever the model chose — never as a fit.
  const cheaperStreet = isGarageOnly(state.hard)
    ? last.nearMisses.find((n) => n.option.type === "street")?.option
    : undefined;
  const fits = [
    ...last.satisfying.filter((o) => leading.has(o.id) || o.secondary === true || chosen.has(o.id)),
    ...last.nearMisses
      .filter((n) => chosen.has(n.option.id) && n.option.id !== cheaperStreet?.id)
      .map((n) => n.option),
  ];
  const picked = cheaperStreet ? [...fits.slice(0, 2), cheaperStreet] : fits.slice(0, 3);
  // The approval threshold: an amount, not a cap (policy.ts).
  const warnOverUsd = confirmWarnUsd(await policyFor(deps, principal.userId));

  const words = new Map(proposed.options.map((o) => [o.id, o]));
  for (const option of picked) {
    const typed = words.get(option.id)?.priceUsd;
    if (typeof typed === "number" && Math.abs(typed - option.priceUsd) >= 0.005) {
      // V2: the card shows the search's price; the model's is on record.
      await audit(
        deps,
        principal,
        turn,
        "propose_plan",
        { optionId: option.id },
        "model_price_mismatch",
        {
          optionId: option.id,
          modelPriceUsd: typed,
          priceUsd: option.priceUsd,
        },
      );
    }
  }
  const options = picked.map((option, index) => {
    // The model's words reach the card only where they can't mislead: a
    // near-miss is named by the server (with what it breaks), and a
    // label or detail quoting an amount that isn't this option's own
    // falls back to the server's.
    const nearMiss = misses.get(option.id);
    const own = ownAmounts(option);
    const said = (text: string | undefined) =>
      text !== undefined && !nearMiss && scrubUngroundedAmounts(text, own).dropped.length === 0
        ? text
        : undefined;
    return {
      ...cardOption(option, last.window, now, {
        label: said(words.get(option.id)?.label),
        detail: said(words.get(option.id)?.detail),
        violates: nearMiss?.violates,
        primary: leading.has(option.id),
        warnOverUsd,
      }),
      // The first option is the one that honors the ask: it holds the
      // badge whatever the model marked.
      recommended: index === 0,
    };
  });

  // The card's note is the model's prose: held to the same check as the
  // reply (V6), against the prices of the options that meet the request.
  const sayable = new Set(
    picked.filter((o) => !misses.has(o.id)).flatMap((o) => [...ownAmounts(o)]),
  );
  const note = proposed.note ? scrubUngroundedAmounts(proposed.note, sayable).text : "";
  const plan: SingleSpotPlan = {
    kind: "single_spot",
    options,
    ...cardFrame(last, options, now, turn.timeRequest),
    ...(note.length > 0 ? { note } : {}),
    verdict: "meets",
    requestSummary: requestSummaryFor(state, last),
  };
  const reason = recommendationReason(plan.options);
  if (reason) plan.recommendedReason = reason;
  return presentPlan(deps, principal, turn, input, plan, "proposed");
}

/**
 * The "no". The model names the kind; the server decides whether it
 * stands and fills the card. Not before the request's whole search has
 * run: an unsearched kind is searched here first, and if that turns
 * something up, the "no" is refused with it (`options_available`).
 */
export async function proposeNoneMeets(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: unknown,
  proposed: Extract<ProposedPlan, { kind: "none_meets" }>,
): Promise<ToolOutcome> {
  if (!currentSearch(deps, turn)) return staleOrUnknown(deps, principal, turn, input, [], []);
  const ended = await completeSearch(deps, principal, turn);
  if (ended) return ended;
  const last = currentSearch(deps, turn)!;
  const state = stateOf(turn);
  const now = deps.now?.() ?? new Date();

  if (last.verdict === "meets") {
    await audit(deps, principal, turn, "propose_plan", input, "options_available", {
      stateVersion: last.stateVersion,
      satisfying: last.satisfying.map((o) => o.id),
    });
    return {
      result: {
        error: "options_available",
        stateVersion: last.stateVersion,
        satisfying: last.satisfying,
        nearMisses: last.nearMisses,
        instruction:
          "Options that meet the request exist, so this is not a none_meets. Propose a single_spot plan from `satisfying`, by id.",
      },
    };
  }
  if (last.verdict === "outside_coverage") {
    await audit(deps, principal, turn, "propose_plan", input, "outside_coverage", {
      stateVersion: last.stateVersion,
    });
    return {
      result: {
        error: "outside_coverage",
        instruction: `That place is outside the cities ParkAgent covers (${coveredCitiesSentence()}). Say so in one sentence; there is no card for it.`,
      },
    };
  }
  if (last.verdict === "no_data") {
    return presentPlan(
      deps,
      principal,
      turn,
      input,
      await noDataPlan(deps, last, state, now, turn.timeRequest),
      "no_zone_here",
    );
  }

  // V1 for the near-misses the model named; by default, the nearest three.
  const misses = new Map(last.nearMisses.map((n) => [n.option.id, n]));
  const named = proposed.nearMissIds ?? [];
  const unknown = named.filter((id) => !misses.has(id));
  if (unknown.length > 0)
    return staleOrUnknown(deps, principal, turn, input, unknown, [...misses.keys()]);
  const shown = (
    named.length > 0 ? last.nearMisses.filter((n) => named.includes(n.option.id)) : last.nearMisses
  ).slice(0, 3);
  const warnOverUsd = confirmWarnUsd(await policyFor(deps, principal.userId));
  const nearMisses = shown.map((n) =>
    cardOption(n.option, last.window, now, { violates: n.violates, warnOverUsd }),
  );
  const pool =
    turn.searchPool?.stateVersion === last.stateVersion
      ? poolOptions(turn.searchPool)
      : last.nearMisses.map((n) => n.option);
  const garageDown = last.garage?.unavailable === true;
  const plan: NoneMeetsPlan = {
    kind: "none_meets",
    headline:
      noneMeetsHeadline(state.hard, last.place, shown[0]?.option) +
      (garageDown ? " I couldn't check garages right now." : ""),
    constraintsFailed: constraintsFailedFor(pool, state.hard),
    nearMisses,
    relaxSuggestions: (last.relaxSuggestions ?? []).slice(0, 3),
    ...cardFrame(last, nearMisses, now, turn.timeRequest),
    verdict: "none_meets",
    requestSummary: requestSummaryFor(state, last),
  };
  return presentPlan(deps, principal, turn, input, plan, "none_meets");
}

/** The "we have nothing there" card: the nearest zones we do have. */
export async function noDataPlan(
  deps: CapabilityDeps,
  search: SearchResult,
  state: RequestState,
  now: Date,
  request: TimeRequest | undefined,
): Promise<NoDataPlan> {
  const { place } = search;
  const query = { lat: place.lat, lng: place.lng, radiusM: NEAREST_ZONE_RADIUS_M };
  const zones: (Awaited<ReturnType<CandidateFetcher>>[number] & {
    street?: string | null;
    centerline?: number[][][];
  })[] = deps.findNearbyZones
    ? (await deps.findNearbyZones(query)).zones
    : await deps.findCandidates(query);
  const nearestZones = [...zones]
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, 3)
    .map((zone) => {
      const pin = zone.centerline ? nearestPointOn(zone.centerline, place.lat, place.lng) : null;
      return {
        zoneId: zone.zoneId,
        street: displayStreet(zone.street),
        zoneNumber: zone.providerZoneNumber || null,
        distanceM: Math.round(zone.distanceM),
        walkMinutes: walkMinutesFor(zone.distanceM),
        ...(pin ? { lat: pin.lat, lng: pin.lng } : {}),
      };
    });
  const radiusM = search.street?.radiusM ?? MAX_STREET_RADIUS_M;
  const where = place.source === "user" && place.label ? place.label : "you";
  const nearest = nearestZones[0];
  const headline =
    `Our data has no street parking or garages within ${radiusM} m of ${where}.` +
    (nearest
      ? ` The nearest metered block is ${nearest.street ? `on ${nearest.street}, ` : ""}about ${nearest.distanceM} m away.`
      : "") +
    (search.garage?.unavailable ? " I couldn't check garages right now." : "");
  return {
    kind: "no_data",
    rule: "no_zone_here",
    headline,
    radiusM,
    nearestZones,
    ...cardFrame(search, [], now, request),
    requestSummary: requestSummaryFor(state, search),
  };
}

/** An itinerary. V5: never trust model arithmetic — the total is
 * recomputed, the cap pinned to the caller's own, and a day that busts
 * what is left of it refused. (Its per-stop prices are still the ones
 * the model read off build_itinerary, #132.) */
export async function proposeItinerary(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  proposed: Extract<ProposedPlan, { kind: "itinerary" }>,
): Promise<ToolOutcome> {
  const totalUsd = itineraryTotalUsd(proposed.stops);
  const gate = await moneyGate(
    deps,
    principal,
    { kind: "plan", stopsUsd: [], totalUsd, perStop: false },
    now(deps),
  );
  if (refusedConsent(gate)) {
    await audit(deps, principal, turn, "propose_plan", { kind: proposed.kind }, gate.rule, {});
    return { result: { error: gate.rule } };
  }
  const { policy, spentTodayUsd } = gate;
  if (!gate.ok) {
    await audit(
      deps,
      principal,
      turn,
      "propose_plan",
      { kind: proposed.kind, totalUsd },
      "over_daily_cap",
      {
        totalUsd,
        spentTodayUsd,
        capUsd: policy.daily_cap_usd,
      },
    );
    return {
      result: {
        error: "plan_over_daily_cap",
        totalUsd,
        spentTodayUsd,
        capUsd: policy.daily_cap_usd,
        hint: "drop or shorten stops until the total fits the remaining budget",
      },
    };
  }
  const unreadable = proposed.stops.find((stop) => !parseEasternTime(stop.arrival));
  if (unreadable) {
    return {
      result: {
        error: "unreadable_time",
        stopId: unreadable.id,
        value: unreadable.arrival,
        instruction: `Couldn't read that stop's arrival. ${TIME_FORMAT_HINT}`,
      },
    };
  }
  const plan: AssistantPlanBody = {
    ...proposed,
    totalUsd,
    capUsd: policy.daily_cap_usd,
    // Stored in arrival order, whatever order the model listed them
    // in: the card shows the day as it will happen.
    stops: orderStopsByArrival(proposed.stops).map((stop) => {
      // Arrivals are stored in one canonical form: the itinerary tick
      // pushes each garage link 15 minutes before this instant, and an
      // offset-less string meant a different instant on every host.
      const arrival = easternIso(parseEasternTime(stop.arrival)!);
      // A garage stop's link is pushed to the phone later — it comes
      // from the search cache, never from model text.
      const cached =
        stop.choice === "garage" && stop.garageOptionId
          ? deps.garage.optionById(stop.garageOptionId)
          : null;
      return { ...stop, arrival, ...(cached ? { deepLink: cached.deepLink } : {}) };
    }),
  };
  // What the plan assumed — server truth from the plan itself, stated
  // on every card however the model phrased its reply.
  const assumptions = assumptionsFor(plan, now(deps), turn.timeRequest);
  return presentPlan(
    deps,
    principal,
    turn,
    { kind: proposed.kind },
    assumptions ? { ...plan, assumptions } : plan,
    "proposed",
  );
}
