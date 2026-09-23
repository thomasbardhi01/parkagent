/**
 * Turn a zone's posted terms into a dollar quote for the default stay.
 *
 * Stay = min(policy.default_stay_minutes, zone max stay). Only minutes of
 * the stay that fall inside enforcement hours are charged; charged minutes
 * consume the rate ladder in order (first 60 at the 1st-hour rate, the rest
 * at the 2nd-hour rate, both prorated). A wholly free window quotes $0 and
 * carries no ParkNYC fee.
 */

import type { HoursInterval } from "./hours.js";
import { enforcementProfile } from "./hours.js";
import type { Policy } from "./policy.js";
import { cityPolicy } from "./policy.js";

export interface ZoneTerms {
  zoneId: string;
  /** "nyc" | "bos"; absent means pre-city data and prices as NYC. */
  city?: string;
  providerZoneNumber: string;
  rateFirstHourUsd: number;
  rateAdditionalHourUsd: number;
  maxStayMinutes: number | null;
  hours: HoursInterval[];
}

export interface Quote {
  zoneId: string;
  providerZoneNumber: string;
  stayMinutes: number;
  chargedMinutes: number;
  meterUsd: number;
  feeUsd: number;
  totalUsd: number;
}

function roundCents(usd: number): number {
  return Math.round((usd + Number.EPSILON) * 100) / 100;
}

export interface StayPrice {
  stayMinutes: number;
  chargedMinutes: number;
  meterUsd: number;
  feeUsd: number;
  totalUsd: number;
}

export interface RatedTerms {
  /** Picks the per-city fee (policy.city_overrides); absent prices as NYC. */
  city?: string;
  rateFirstHourUsd: number;
  rateAdditionalHourUsd: number;
  hours: HoursInterval[];
  /** ParkBoston sells parking in a per-zone duration increment (the
   * duration picker's `incrementalMinutes` — zone 456 is 12 minutes,
   * observed 2026-09-23), so a 15-minute request is billed as 12 minutes.
   * When set, the charged minutes are snapped to a whole number of
   * increments (minimum one) BEFORE pricing, so the quote matches the
   * receipt to the cent.
   *
   * NOTE — no producer yet, by design: the increment is operator-configured
   * per zone and is NOT in Analyze Boston's open data (only in the picker's
   * shortcut API, reachable by starting a session), so nothing populates
   * this field in production today and the quote stays per-minute (an upper
   * bound for sub-hour Boston stays). It is the ready hook for when
   * increments are collected per zone during the field test; until then the
   * live reconciliation is the executor's real receipt, recorded on the
   * session (session start), which already matches the card to the cent.
   * See the acceptance report, Job 2. */
  billingIncrementMinutes?: number;
}

/** Snap `minutes` to a whole number of provider increments, nearest, with a
 * floor of one increment — how ParkBoston's duration picker rounds a
 * request. A non-positive/absent increment leaves the minutes unchanged. */
export function snapToIncrement(minutes: number, incrementMinutes?: number): number {
  if (!incrementMinutes || incrementMinutes <= 0) return minutes;
  const steps = Math.max(1, Math.round(minutes / incrementMinutes));
  return steps * incrementMinutes;
}

/**
 * Price `minutes` of stay starting at `from`. `priorChargedMinutes` is how
 * many charged minutes the session has already bought — an extension
 * continues the ladder from there instead of restarting the first hour.
 * The pay-by-app fee is per transaction and per city (ParkNYC vs
 * ParkBoston), charged whenever the meter portion is nonzero.
 */
export function priceStay(
  zone: RatedTerms,
  policy: Policy,
  from: Date,
  minutes: number,
  priorChargedMinutes = 0,
): StayPrice {
  // ParkBoston bills the granted duration, which its picker snaps to the
  // zone's increment; do the same before counting enforced minutes so the
  // quote matches the receipt. NYC / unknown-increment zones pass through.
  const requestedMinutes = snapToIncrement(minutes, zone.billingIncrementMinutes);
  const chargedMinutes = policy.respect_enforcement_hours
    ? enforcementProfile(zone.hours, from, requestedMinutes).filter(Boolean).length
    : requestedMinutes;

  const firstHourMinutes = Math.min(Math.max(60 - priorChargedMinutes, 0), chargedMinutes);
  const additionalMinutes = chargedMinutes - firstHourMinutes;
  const meterUsd = roundCents(
    (firstHourMinutes / 60) * zone.rateFirstHourUsd +
      (additionalMinutes / 60) * zone.rateAdditionalHourUsd,
  );
  const feeUsd = meterUsd > 0 ? roundCents(cityPolicy(policy, zone.city).parkingFeeUsd) : 0;

  return {
    // The stay is what will actually be bought (snapped to the increment
    // when one applies), so it matches the receipt's duration.
    stayMinutes: requestedMinutes,
    chargedMinutes,
    meterUsd,
    feeUsd,
    totalUsd: roundCents(meterUsd + feeUsd),
  };
}

export function quoteZone(zone: ZoneTerms, policy: Policy, at: Date): Quote {
  const stayMinutes = Math.min(
    policy.default_stay_minutes,
    zone.maxStayMinutes ?? policy.default_stay_minutes,
  );
  const price = priceStay(zone, policy, at, stayMinutes);
  return {
    zoneId: zone.zoneId,
    providerZoneNumber: zone.providerZoneNumber,
    ...price,
  };
}
