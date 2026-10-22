/** buildItinerary: a multi-stop day priced per stop; repriceStops re-prices
 * an edited one on the server. */

import { easternIso, parseEasternTime } from "../hours.js";
import { spentToday } from "../moneyGate.js";
import type { EditedItineraryStop, ItineraryStop } from "../assistant/plans.js";
import type { GarageOption } from "../garage/garageProvider.js";
import { walkMinutesFor } from "../assistant/streetOptions.js";
import { policyFor } from "../limits.js";
import type { Principal } from "../principal.js";
import { num, TIME_FORMAT_HINT, now, audit, pastWindowError } from "./turn.js";
import type { CapabilityDeps, TurnState, ToolOutcome } from "./turn.js";
import { streetSearch, searchGarageWindow } from "./search.js";

/**
 * An itinerary stop priced by the server. The client's costUsd, zoneId,
 * garageOptionId, and deepLink are never read: a stop keeps its previous
 * SERVER value when nothing that sets the price changed, or is re-quoted
 * the way build_itinerary quotes it (the nearest zone for street, the
 * search's first option for a garage).
 */
export type PricedStop = Omit<ItineraryStop, "arrival"> & {
  arrival: string | null;
  /** The price is a carry-over, not a fresh quote for these inputs: the
   * stop has no set time, or the quote couldn't be made (no zone there,
   * no garage, or the garage search was down). */
  estimate?: true;
};

/** The server's previous version of a stop: a plan stop or a stored
 * itinerary stop (whose arrival may be null, and which may carry an
 * estimate flag from an earlier re-price). */
export type PreviousStop = Partial<Omit<ItineraryStop, "arrival">> & {
  arrival?: string | null;
  estimate?: boolean;
};

export interface RepriceResult {
  stops: PricedStop[];
  /** Ids actually re-quoted (their price-setting inputs changed). */
  repriced: string[];
  /** Ids that kept a carried-over price, and why. */
  estimates: { id: string; reason: "untimed" | "no_zone" | "no_garage" | "search_unavailable" }[];
}

/** Arrival as an instant; null for no set time (or an unreadable one). */
export function arrivalInstant(arrival: string | null | undefined): number | null {
  return arrival ? (parseEasternTime(arrival)?.getTime() ?? null) : null;
}

/** Whether any input that sets a stop's price changed. */
export function priceInputsChanged(
  edited: EditedItineraryStop,
  previous: {
    arrival?: string | null;
    durationMinutes: number;
    choice: string;
    lat: number;
    lng: number;
  },
): boolean {
  return (
    edited.choice !== previous.choice ||
    edited.durationMinutes !== previous.durationMinutes ||
    edited.lat !== previous.lat ||
    edited.lng !== previous.lng ||
    arrivalInstant(edited.arrival) !== arrivalInstant(previous.arrival)
  );
}

/**
 * Price an edited itinerary's stops on the server. `previous` holds the
 * SERVER's version of each stop (the proposed plan's, or the stored
 * itinerary's), by id. The client's cost, zone, and garage fields are
 * never read:
 *  - nothing that sets the price changed (time, duration, street vs
 *    garage, position) → the previous server price and fields;
 *  - no set time → the last price, marked an estimate (pricing needs a
 *    time);
 *  - otherwise re-quoted like build_itinerary: street at the nearest
 *    zone for the new window; garage = the search's first option for
 *    the new window (its id, link, and price). A quote that can't be
 *    made keeps the last price, marked an estimate.
 * The arrival comes back canonical (ET with its offset) or null.
 */
export async function repriceStops(
  deps: CapabilityDeps,
  edited: EditedItineraryStop[],
  previous: ReadonlyMap<string, PreviousStop>,
): Promise<RepriceResult> {
  const stops: PricedStop[] = [];
  const repriced: string[] = [];
  const estimates: RepriceResult["estimates"] = [];
  for (const stop of edited) {
    const prior = previous.get(stop.id);
    const arrivalAt = stop.arrival ? parseEasternTime(stop.arrival) : null;
    const base = {
      id: stop.id,
      label: stop.label,
      address: stop.address,
      lat: stop.lat,
      lng: stop.lng,
      arrival: arrivalAt ? easternIso(arrivalAt) : null,
      durationMinutes: stop.durationMinutes,
      choice: stop.choice,
    };
    /** The server's previous price and fields, carried over. */
    const carried = (estimate: boolean): PricedStop => ({
      ...base,
      costUsd: typeof prior?.costUsd === "number" ? prior.costUsd : 0,
      ...(prior?.zoneId ? { zoneId: prior.zoneId } : {}),
      ...(prior?.garageOptionId ? { garageOptionId: prior.garageOptionId } : {}),
      ...(prior?.deepLink ? { deepLink: prior.deepLink } : {}),
      ...(estimate || prior?.estimate === true ? { estimate: true as const } : {}),
    });
    if (!arrivalAt) {
      stops.push(carried(true));
      estimates.push({ id: stop.id, reason: "untimed" });
      continue;
    }
    if (
      prior &&
      typeof prior.durationMinutes === "number" &&
      (prior.choice === "street" || prior.choice === "garage") &&
      typeof prior.lat === "number" &&
      typeof prior.lng === "number" &&
      !priceInputsChanged(stop, {
        arrival: prior.arrival ?? null,
        durationMinutes: prior.durationMinutes,
        choice: prior.choice,
        lat: prior.lat,
        lng: prior.lng,
      })
    ) {
      stops.push(carried(false));
      continue;
    }
    repriced.push(stop.id);
    if (stop.choice === "street") {
      const best = (await streetSearch(deps, stop.lat, stop.lng, arrivalAt, stop.durationMinutes))
        .options[0];
      if (!best) {
        stops.push(carried(true));
        estimates.push({ id: stop.id, reason: "no_zone" });
        continue;
      }
      stops.push({ ...base, costUsd: best.costUsd, zoneId: best.zoneId });
      continue;
    }
    const garages = await searchGarageWindow(
      deps,
      stop.lat,
      stop.lng,
      arrivalAt,
      stop.durationMinutes,
    );
    const option: GarageOption | undefined = garages.ok ? garages.options[0] : undefined;
    if (!option) {
      stops.push(carried(true));
      estimates.push({ id: stop.id, reason: garages.ok ? "no_garage" : "search_unavailable" });
      continue;
    }
    stops.push({
      ...base,
      costUsd: option.priceUsd,
      garageOptionId: option.id,
      deepLink: option.deepLink,
    });
  }
  return { stops, repriced, estimates };
}

/**
 * One itinerary stop's street quote: the blocks within a walk of the
 * stop's own point, for the stop's own window. A day's stops each have
 * their place and time, so this takes them as arguments — unlike
 * quote_street, which searches the one request.
 */
export async function quoteStreetAt(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const past = await pastWindowError(
    deps,
    principal,
    turn,
    "quote_street",
    input,
    String(input["when"] ?? ""),
  );
  if (past) return past;
  const lat = num(input["lat"]);
  const lng = num(input["lng"]);
  const minutes = num(input["duration_minutes"]);
  // Readable by construction: pastWindowError bounced anything else.
  const when = parseEasternTime(String(input["when"]))!;
  const search = await streetSearch(
    deps,
    lat,
    lng,
    when,
    minutes,
    input["radius_m"] !== undefined ? num(input["radius_m"]) : undefined,
  );
  const radiusText = `${search.radiusM} m (about a ${walkMinutesFor(search.radiusM)}-minute walk)`;
  if (search.options.length === 0) {
    await audit(deps, principal, turn, "quote_street", input, "unknown_zone", {
      radiusM: search.radiusM,
    });
    return {
      result: {
        found: false,
        radiusM: search.radiusM,
        reason: `No metered street parking in our data within ${radiusText} of that point.`,
        instruction: `Say there's no metered street parking within ${radiusText} of the place — say the radius — and still offer garages.`,
      },
    };
  }
  const window = {
    startsAt: easternIso(when),
    endsAt: easternIso(new Date(when.getTime() + minutes * 60_000)),
  };
  await audit(deps, principal, turn, "quote_street", input, "ok", {
    radiusM: search.radiusM,
    zonesInRadius: search.zonesInRadius,
    options: search.options.map((o) => ({
      zoneId: o.zoneId,
      costUsd: o.costUsd,
      state: o.state,
    })),
  });
  return {
    result: {
      found: true,
      radiusM: search.radiusM,
      window,
      options: search.options,
      instruction:
        "Offer the street options that fit (usually the best one or two) with their summary; each option's zoneId goes on its plan option. A free block is $0.00.",
    },
  };
}

export async function buildItinerary(
  deps: CapabilityDeps,
  principal: Principal,
  turn: TurnState,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const stops = input["stops"] as Record<string, unknown>[];
  const policy = await policyFor(deps, principal.userId);
  const at = now(deps);
  const out = [];
  for (const stop of stops) {
    const arrivalAt = parseEasternTime(String(stop["arrival"]));
    if (!arrivalAt) {
      await audit(
        deps,
        principal,
        turn,
        "build_itinerary",
        { stopCount: stops.length },
        "unreadable_time",
        {
          arrival: stop["arrival"],
        },
      );
      return {
        result: {
          error: "unreadable_time",
          value: stop["arrival"],
          instruction: `Couldn't read that arrival time. ${TIME_FORMAT_HINT}`,
        },
      };
    }
    const arrival = easternIso(arrivalAt);
    const minutes = num(stop["duration_minutes"]);
    // A day's stops each have their own time: the message's one
    // requested time (if any) isn't theirs to honor.
    const street = await quoteStreetAt(
      deps,
      principal,
      { ...turn, timeRequest: undefined },
      {
        lat: stop["lat"],
        lng: stop["lng"],
        duration_minutes: minutes,
        when: arrival,
      },
    );
    const garages = await searchGarageWindow(
      deps,
      num(stop["lat"]),
      num(stop["lng"]),
      arrivalAt,
      minutes,
    );
    // The model picks street vs garage per stop from the best street
    // option or two; five per stop across a 12-stop day is tokens, not
    // information.
    const streetResult = street.result as { options?: unknown[] };
    out.push({
      label: stop["label"],
      address: stop["address"] ?? "",
      arrival,
      durationMinutes: minutes,
      street: Array.isArray(streetResult.options)
        ? { ...streetResult, options: streetResult.options.slice(0, 2) }
        : street.result,
      garage: garages.ok ? (garages.options[0] ?? null) : null,
      ...(garages.ok ? {} : { garageSearchUnavailable: true, garageSearchError: garages.error }),
    });
  }
  // The budget line counts spend the way the confirm gate will: under a
  // dry run, today's dry runs included.
  const spentTodayUsd = await spentToday(deps.db, principal.userId, at, {
    dryRun: deps.policy.effectiveDryRun(),
  });
  const summary = {
    stops: out,
    dailyCapUsd: policy.daily_cap_usd,
    spentTodayUsd,
    remainingBudgetUsd: Math.max(0, policy.daily_cap_usd - spentTodayUsd),
  };
  await audit(deps, principal, turn, "build_itinerary", { stopCount: stops.length }, "ok", {
    stops: out.length,
  });
  return { result: summary };
}
