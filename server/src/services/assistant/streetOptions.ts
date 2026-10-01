/**
 * Street parking within a walk of a destination, and what each block is
 * doing during the requested window.
 *
 * The 2026-09-25 device test asked for 7 PM near Lola 42 and was told
 * "no metered street parking within reach of Seaport center": the quote
 * looked for a zone within 25 m of ONE point (the neighborhood's
 * centroid), while our data has six metered blocks within 400 m of it —
 * the nearest 33 m away — and most are free at 7 PM. A destination isn't
 * a curb, so this searches every zone within a walking radius, prices the
 * stay at each, and says what the block is doing in plain words:
 *
 *   "Free after 6 PM on Seaport Blvd — 4 min walk"
 *   "Metered until 8 PM, then free on Northern Ave — 3 min walk"
 *   "$3.75/hr, 2 hr max on Congress St — 5 min walk"
 *
 * Blocks of one street in the same state collapse to the nearest one, and
 * the cheapest (then nearest) comes first. "No street parking" is only
 * ever said when the radius truly holds no zone — with the radius.
 */

import type { AppDb } from "../../db.js";
import type { HoursInterval } from "../hours.js";
import { enforcementProfile, nycWeekdayAndMinute, todaysIntervals } from "../hours.js";
import type { Policy } from "../policy.js";
import { priceStay } from "../quote.js";
import type { Candidate, CandidateFetcher, NearbyZoneFetcher } from "../zoneLookup.js";
import { applyObservedToCandidates } from "../zoneTermsObserved.js";
import type { Preference, Rank } from "./requestState.js";

/** Default walking radius: about a 7-minute walk (walkMinutesFor). */
export const DEFAULT_STREET_RADIUS_M = 400;
export const MAX_STREET_RADIUS_M = 800;
/** Straight line → walking: streets aren't straight lines. */
const DETOUR_FACTOR = 1.3;
const WALK_M_PER_MIN = 80;
const MAX_OPTIONS = 5;

/** What a block is doing during the stay. */
export type StreetState =
  | "free" // not enforced at all during the window
  | "metered" // enforced the whole window
  | "metered_then_free" // enforced at the start, free from some time on
  | "free_then_metered" // free at the start, metered from some time on
  | "mixed"; // on and off (rare: split intervals)

export interface StreetOption {
  zoneId: string;
  city: string;
  /** The street, display-cased ("Seaport Blvd"); null when our data has none. */
  street: string | null;
  /** The pay-by-app number, null when the zone has none yet. */
  zoneNumber: string | null;
  /** The curb point nearest the destination — the map pin. */
  lat: number;
  lng: number;
  distanceM: number;
  walkMinutes: number;
  state: StreetState;
  /** The block in one line: "Free after 6 PM on Seaport Blvd — 4 min walk". */
  summary: string;
  /** Just the state, without the street and walk: "Free after 6 PM". */
  stateText: string;
  costUsd: number;
  meterUsd: number;
  feeUsd: number;
  ratePerHourUsd: number;
  rateAdditionalHourUsd: number;
  maxStayMinutes: number | null;
  /** The minutes the stay is priced for: the whole stay, or the max stay
   * when the meter runs longer than it allows. */
  clampedMinutes: number;
  /** Minutes of the stay the meter is enforced. */
  enforcedMinutes: number;
  /** The meter runs longer than the max stay allows. */
  exceedsMaxStay: boolean;
  /** The posted hours on the stay's day, "HH:MM" pairs. */
  hoursToday: { start: string; end: string }[];
  termsSource?: "observed";
}

export interface StreetSearch {
  radiusM: number;
  /** Zones in the radius before collapsing blocks of the same street. */
  zonesInRadius: number;
  /** The five cheapest (then nearest): what an itinerary stop prices from. */
  options: StreetOption[];
  /** Every block after collapsing, cheapest (then nearest) first: what a
   * request's search filters and ranks. */
  all: StreetOption[];
}

export interface StreetSearchDeps {
  db: AppDb;
  policy: Policy;
  findCandidates: CandidateFetcher;
  /** The geometry-carrying fetcher (/zones/near's): street names and the
   * nearest curb point. Absent → findCandidates, pinned at the query point. */
  findNearbyZones?: NearbyZoneFetcher | undefined;
}

type SearchedZone = Candidate & { street?: string | null; centerline?: number[][][] };

/** Minutes after midnight → "6 PM", "8:30 PM", "noon", "midnight". */
export function clockText(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  if (m === 0) return "midnight";
  if (m === 720) return "noon";
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h24 < 12 ? "AM" : "PM"}`;
}

function minuteOf(clock: string): number {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return h * 60 + m;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

const WEEKDAY_NAMES: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

/** 120 → "2 hr", 90 → "90 min". */
export function durationText(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

/** "SEAPORT BLVD" → "Seaport Blvd"; mixed-case names are left alone.
 * Boston's block names end in a between-streets code ("CANAL ST V-C",
 * "BOYLSTON ST D-C": Dartmouth to Clarendon) that means nothing on a
 * card, so it goes. */
export function displayStreet(street: string | null | undefined): string | null {
  if (!street) return null;
  const name = street.replace(/\s+[A-Za-z]{1,3}-[A-Za-z]{1,3}$/, "");
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function rateText(zone: { rateFirstHourUsd: number; rateAdditionalHourUsd: number }): string {
  return zone.rateAdditionalHourUsd !== zone.rateFirstHourUsd
    ? `${money(zone.rateFirstHourUsd)} first hr, then ${money(zone.rateAdditionalHourUsd)}/hr`
    : `${money(zone.rateFirstHourUsd)}/hr`;
}

/**
 * What a block does during [when, when + minutes): its state and the
 * words for it. Times are ET wall clock (both cities are Eastern).
 */
export function describeStreetWindow(
  zone: {
    hours: HoursInterval[];
    rateFirstHourUsd: number;
    rateAdditionalHourUsd: number;
    maxStayMinutes: number | null;
  },
  when: Date,
  minutes: number,
  respectEnforcementHours: boolean,
): { state: StreetState; stateText: string; enforcedMinutes: number } {
  const profile = respectEnforcementHours
    ? enforcementProfile(zone.hours, when, minutes)
    : new Array<boolean>(minutes).fill(true);
  const enforcedMinutes = profile.filter(Boolean).length;
  const maxNote =
    zone.maxStayMinutes !== null && enforcedMinutes > zone.maxStayMinutes
      ? ` (${durationText(zone.maxStayMinutes)} max)`
      : "";
  // Runs of the same enforcement: [true, false] = metered then free.
  const runs: boolean[] = [];
  for (const enforced of profile) if (runs[runs.length - 1] !== enforced) runs.push(enforced);
  const at = (index: number) =>
    clockText(nycWeekdayAndMinute(new Date(when.getTime() + index * 60_000)).minute);

  if (enforcedMinutes === 0) {
    const start = nycWeekdayAndMinute(when).minute;
    const today = todaysIntervals(zone.hours, when);
    const endedBefore = today.filter((i) => minuteOf(i.end) <= start);
    const startsAfter = today.filter((i) => minuteOf(i.start) >= start);
    // When the meters come back matters more than when they stopped: a
    // midday gap is "Free until 4 PM", an evening "Free after 6 PM".
    const stateText =
      startsAfter.length > 0
        ? `Free until ${clockText(Math.min(...startsAfter.map((i) => minuteOf(i.start))))}`
        : endedBefore.length > 0
          ? `Free after ${clockText(Math.max(...endedBefore.map((i) => minuteOf(i.end))))}`
          : today.length === 0
            ? `Free all day ${WEEKDAY_NAMES[nycWeekdayAndMinute(when).weekday] ?? ""}`.trim()
            : "Free during your stay";
    return { state: "free", stateText, enforcedMinutes };
  }
  if (enforcedMinutes === profile.length) {
    const max = zone.maxStayMinutes !== null ? `, ${durationText(zone.maxStayMinutes)} max` : "";
    return { state: "metered", stateText: `${rateText(zone)}${max}`, enforcedMinutes };
  }
  if (runs.length === 2 && runs[0] === true) {
    return {
      state: "metered_then_free",
      stateText: `Metered until ${at(profile.indexOf(false))}${maxNote}, then free`,
      enforcedMinutes,
    };
  }
  if (runs.length === 2 && runs[0] === false) {
    return {
      state: "free_then_metered",
      stateText: `Free until ${at(profile.indexOf(true))}, then ${rateText(zone)}${maxNote}`,
      enforcedMinutes,
    };
  }
  return {
    state: "mixed",
    stateText: `Metered part of your stay, ${rateText(zone)}${maxNote}`,
    enforcedMinutes,
  };
}

/** The point on a MultiLineString nearest (lat, lng), by a local flat
 * projection — plenty accurate across a few hundred metres. */
export function nearestPointOn(
  lines: number[][][],
  lat: number,
  lng: number,
): { lat: number; lng: number } | null {
  const kx = Math.cos((lat * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  let best: { lat: number; lng: number; d2: number } | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      const a = line[i]!;
      const b = line[i + 1] ?? a;
      const ax = (a[0]! - lng) * kx;
      const ay = (a[1]! - lat) * ky;
      const bx = (b[0]! - lng) * kx;
      const by = (b[1]! - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d2 = px * px + py * py;
      if (best === null || d2 < best.d2) {
        best = { lat: lat + py / ky, lng: lng + px / kx, d2 };
      }
    }
  }
  return best ? { lat: best.lat, lng: best.lng } : null;
}

export function walkMinutesFor(distanceM: number): number {
  return Math.max(1, Math.round((distanceM * DETOUR_FACTOR) / WALK_M_PER_MIN));
}

/** One block's stay: its state for the window, and its price — the whole
 * stay when the meter allows it; when the meter runs past the max stay,
 * the max stay's worth of metered time from the first metered minute (the
 * rest can't be bought — the card says so). Priced from the first METERED
 * minute, not the arrival: a stay that starts free and runs past the max
 * pays for max-stay minutes of meter, not for its free start. */
function priceWindow(
  zone: Candidate,
  policy: Policy,
  when: Date,
  minutes: number,
): {
  window: ReturnType<typeof describeStreetWindow>;
  exceedsMaxStay: boolean;
  clampedMinutes: number;
  price: ReturnType<typeof priceStay>;
} {
  const window = describeStreetWindow(zone, when, minutes, policy.respect_enforcement_hours);
  const exceedsMaxStay =
    zone.maxStayMinutes !== null && window.enforcedMinutes > zone.maxStayMinutes;
  const clampedMinutes = exceedsMaxStay ? Math.min(minutes, zone.maxStayMinutes!) : minutes;
  const firstMetered = exceedsMaxStay
    ? (policy.respect_enforcement_hours
        ? enforcementProfile(zone.hours, when, minutes)
        : [true]
      ).indexOf(true)
    : 0;
  const price = priceStay(
    {
      city: zone.city,
      rateFirstHourUsd: zone.rateFirstHourUsd,
      rateAdditionalHourUsd: zone.rateAdditionalHourUsd,
      hours: zone.hours,
    },
    policy,
    new Date(when.getTime() + Math.max(firstMetered, 0) * 60_000),
    clampedMinutes,
  );
  return { window, exceedsMaxStay, clampedMinutes, price };
}

/** Every metered block within `radiusM` of a destination, priced for the
 * stay and described, cheapest (then nearest) first. */
export async function streetOptionsNear(
  deps: StreetSearchDeps,
  q: { lat: number; lng: number; when: Date; minutes: number; radiusM?: number | undefined },
): Promise<StreetSearch> {
  const radiusM = Math.min(
    MAX_STREET_RADIUS_M,
    Math.max(50, Math.round(q.radiusM ?? DEFAULT_STREET_RADIUS_M)),
  );
  const fetched: SearchedZone[] = deps.findNearbyZones
    ? (await deps.findNearbyZones({ lat: q.lat, lng: q.lng, radiusM })).zones
    : await deps.findCandidates({ lat: q.lat, lng: q.lng, radiusM });
  const raw = fetched.filter((z) => z.distanceM <= radiusM);
  // Provider-observed terms over the dataset (e.g. Boston's real "Max 5
  // Hr"), as /parked and session start apply them.
  const zones = await applyObservedToCandidates(deps.db, raw);

  // Blocks share a handful of posted terms; the per-minute window work is
  // done once per set of terms, not once per block (150 blocks × a 12-hour
  // stay was ~0.2 s of Intl formatting per search).
  const byTerms = new Map<string, ReturnType<typeof priceWindow>>();
  const all = zones.map((zone): StreetOption => {
    const key = JSON.stringify([
      zone.hours,
      zone.rateFirstHourUsd,
      zone.rateAdditionalHourUsd,
      zone.maxStayMinutes,
      zone.city,
    ]);
    let priced = byTerms.get(key);
    if (!priced) {
      priced = priceWindow(zone, deps.policy, q.when, q.minutes);
      byTerms.set(key, priced);
    }
    const { window, exceedsMaxStay, clampedMinutes, price } = priced;
    const pin = zone.centerline ? nearestPointOn(zone.centerline, q.lat, q.lng) : null;
    const street = displayStreet(zone.street);
    const walkMinutes = walkMinutesFor(zone.distanceM);
    const where = street
      ? `on ${street}`
      : zone.providerZoneNumber
        ? `in zone ${zone.providerZoneNumber}`
        : "on this block";
    return {
      zoneId: zone.zoneId,
      city: zone.city,
      street,
      zoneNumber: zone.providerZoneNumber || null,
      lat: pin?.lat ?? q.lat,
      lng: pin?.lng ?? q.lng,
      distanceM: Math.round(zone.distanceM),
      walkMinutes,
      state: window.state,
      stateText: window.stateText,
      summary: `${window.stateText} ${where} — ${walkMinutes} min walk`,
      costUsd: price.totalUsd,
      meterUsd: price.meterUsd,
      feeUsd: price.feeUsd,
      ratePerHourUsd: zone.rateFirstHourUsd,
      rateAdditionalHourUsd: zone.rateAdditionalHourUsd,
      maxStayMinutes: zone.maxStayMinutes,
      clampedMinutes,
      enforcedMinutes: window.enforcedMinutes,
      exceedsMaxStay,
      hoursToday: todaysIntervals(zone.hours, q.when),
      ...(zone.termsSource === "observed" ? { termsSource: "observed" as const } : {}),
    };
  });

  // One option per street and situation: the two sides and the next block
  // of Seaport Blvd saying the same thing are one choice, at its nearest.
  const nearestFirst = [...all].sort((a, b) => a.distanceM - b.distanceM);
  const seen = new Set<string>();
  const collapsed = nearestFirst.filter((o) => {
    const key = `${o.street ?? o.zoneId}|${o.stateText}|${o.costUsd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = collapsed.sort((a, b) => a.costUsd - b.costUsd || a.distanceM - b.distanceM);
  return {
    radiusM,
    zonesInRadius: zones.length,
    options: sorted.slice(0, MAX_OPTIONS),
    all: sorted,
  };
}

// ---------------------------------------------------------------------------
// Ranking (FR-43). Pure: the options and the request in, an order out. The
// model is handed the result and never reorders it.
// ---------------------------------------------------------------------------

/** What ranking reads of an option, street or garage. */
export interface RankableOption {
  id: string;
  type: "street" | "garage";
  priceUsd: number;
  walkMinutes: number;
  /** Breaks a tie between two options the same whole minutes away. */
  distanceM?: number | undefined;
  entryType?: string | undefined;
}

/** "balanced" prices a minute of walking at this much. */
export const WALK_USD_PER_MINUTE = 0.5;
/** What a matched preference takes off an option's score. It reorders;
 * it never filters, and it never changes the price shown. */
export const PREFERENCE_BONUS_USD = 1;

/** Whether an option is something the user said they'd like. "covered"
 * matches nothing yet: no source says whether a garage is covered. */
function isPreferred(option: RankableOption, prefer: readonly Preference[] | null): boolean {
  if (!prefer) return false;
  return prefer.some(
    (p) =>
      (p === "valet" && option.entryType === "valet") ||
      (p === "garage" && option.type === "garage") ||
      (p === "street" && option.type === "street"),
  );
}

/**
 * The options in rank order:
 *  - cheapest: price, then walk;
 *  - closest:  walk, then price;
 *  - balanced: price + $0.50 per minute of walk (also the order when the
 *    user asked for none);
 * with a fixed $1.00 off the score of an option the user prefers. Ties go
 * to the cheaper, then the nearer (by minutes, then by metres), then the
 * id, so the order is stable.
 */
export function rankOptions<T extends RankableOption>(
  options: readonly T[],
  soft: { rank: Rank | null; prefer: readonly Preference[] | null },
): T[] {
  const scored = (o: T) => o.priceUsd - (isPreferred(o, soft.prefer) ? PREFERENCE_BONUS_USD : 0);
  const keys = (o: T): number[] => {
    switch (soft.rank) {
      case "cheapest":
        return [scored(o), o.walkMinutes, o.priceUsd];
      case "closest":
        return [o.walkMinutes, scored(o), o.priceUsd];
      default:
        return [scored(o) + WALK_USD_PER_MINUTE * o.walkMinutes, o.priceUsd, o.walkMinutes];
    }
  };
  return [...options].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i += 1) {
      // Scores are dollars: compare to the cent, not to float noise.
      const diff = Math.round((ka[i]! - kb[i]!) * 100);
      if (diff !== 0) return diff;
    }
    const metres = Math.round((a.distanceM ?? 0) - (b.distanceM ?? 0));
    if (metres !== 0) return metres;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Which of price and walk an option is the best on. */
export type Axis = "cheapest" | "closest" | "both";

/** What the user asked about ranking: an explicit rank, or a limit on one
 * of price and walk (a limit on an axis is an ask about that axis). */
export interface RequestAsk {
  rank: Rank | null;
  prefer: readonly Preference[] | null;
  /** hard.maxPriceUsd is set. */
  priceLimited: boolean;
  /** hard.maxWalkMinutes is set. */
  walkLimited: boolean;
}

export type Ordered<T> = T & { axis?: Axis; secondary?: true };

/**
 * The order a search presents options in (decision 8,
 * docs/decisions/2026-09-29-v1-scope.md):
 *
 *  - no ask (no rank, and a limit on neither or both of price and walk):
 *    the cheapest and the closest lead, each labeled — one entry when one
 *    option is both — and the rest follow by balanced score;
 *  - an ask (a rank, or a limit on exactly one axis): the option that best
 *    honors it comes first, and the best option on the other axis rides
 *    second as `secondary` — an alternative, never the recommendation.
 *    "balanced" has two other axes, so both ride along.
 *
 * `axis` says what an option truly is among these options (by price and
 * walk alone, preferences aside), so a label never claims "cheapest" for
 * an option a preference lifted over a cheaper one.
 */
export function orderForRequest<T extends RankableOption>(
  options: readonly T[],
  ask: RequestAsk,
): Ordered<T>[] {
  if (options.length === 0) return [];
  const cheapest = rankOptions(options, { rank: "cheapest", prefer: null })[0]!;
  const closest = rankOptions(options, { rank: "closest", prefer: null })[0]!;
  const tagged = (o: T, secondary: boolean): Ordered<T> => {
    const axis: Axis | null =
      o === cheapest && o === closest
        ? "both"
        : o === cheapest
          ? "cheapest"
          : o === closest
            ? "closest"
            : null;
    return { ...o, ...(axis ? { axis } : {}), ...(secondary ? { secondary: true as const } : {}) };
  };
  const asked: Rank | null =
    ask.rank ??
    (ask.priceLimited && !ask.walkLimited
      ? "cheapest"
      : ask.walkLimited && !ask.priceLimited
        ? "closest"
        : null);

  let leads: { option: T; secondary: boolean }[];
  let rest: T[];
  if (asked === null) {
    leads = [cheapest, closest]
      .filter((o, i, all) => all.indexOf(o) === i)
      .map((option) => ({ option, secondary: false }));
    rest = rankOptions(
      options.filter((o) => o !== cheapest && o !== closest),
      { rank: "balanced", prefer: ask.prefer },
    );
  } else {
    const sorted = rankOptions(options, { rank: asked, prefer: ask.prefer });
    const first = sorted[0]!;
    const others = (
      asked === "cheapest" ? [closest] : asked === "closest" ? [cheapest] : [cheapest, closest]
    ).filter((o, i, all) => o !== first && all.indexOf(o) === i);
    leads = [
      { option: first, secondary: false },
      ...others.map((option) => ({ option, secondary: true })),
    ];
    rest = sorted.filter((o) => o !== first && !others.includes(o));
  }
  return [
    ...leads.map(({ option, secondary }) => tagged(option, secondary)),
    ...rest.map((o) => tagged(o, false)),
  ];
}
