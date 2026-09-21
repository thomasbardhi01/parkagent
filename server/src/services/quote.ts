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
  const chargedMinutes = policy.respect_enforcement_hours
    ? enforcementProfile(zone.hours, from, minutes).filter(Boolean).length
    : minutes;

  const firstHourMinutes = Math.min(Math.max(60 - priorChargedMinutes, 0), chargedMinutes);
  const additionalMinutes = chargedMinutes - firstHourMinutes;
  const meterUsd = roundCents(
    (firstHourMinutes / 60) * zone.rateFirstHourUsd +
      (additionalMinutes / 60) * zone.rateAdditionalHourUsd,
  );
  const feeUsd = meterUsd > 0 ? roundCents(cityPolicy(policy, zone.city).parkingFeeUsd) : 0;

  return {
    stayMinutes: minutes,
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
