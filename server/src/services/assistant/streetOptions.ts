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
  options: StreetOption[];
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
  const respect = deps.policy.respect_enforcement_hours;

  const all = zones.map((zone): StreetOption => {
    const window = describeStreetWindow(zone, q.when, q.minutes, respect);
    const exceedsMaxStay =
      zone.maxStayMinutes !== null && window.enforcedMinutes > zone.maxStayMinutes;
    // The whole stay when the meter allows it; the max stay otherwise
    // (the rest can't be bought — the card says so).
    const clampedMinutes = exceedsMaxStay
      ? Math.min(q.minutes, zone.maxStayMinutes ?? q.minutes)
      : q.minutes;
    const price = priceStay(
      {
        city: zone.city,
        rateFirstHourUsd: zone.rateFirstHourUsd,
        rateAdditionalHourUsd: zone.rateAdditionalHourUsd,
        hours: zone.hours,
      },
      deps.policy,
      q.when,
      clampedMinutes,
    );
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
  const options = collapsed
    .sort((a, b) => a.costUsd - b.costUsd || a.distanceM - b.distanceM)
    .slice(0, MAX_OPTIONS);
  return { radiusM, zonesInRadius: zones.length, options };
}
