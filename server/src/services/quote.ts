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

export interface ZoneTerms {
  zoneId: string;
  parknycZoneNumber: string;
  rateFirstHourUsd: number;
  rateAdditionalHourUsd: number;
  maxStayMinutes: number | null;
  hours: HoursInterval[];
}

export interface Quote {
  zoneId: string;
  parknycZoneNumber: string;
  stayMinutes: number;
  chargedMinutes: number;
  meterUsd: number;
  feeUsd: number;
  totalUsd: number;
}

function roundCents(usd: number): number {
  return Math.round((usd + Number.EPSILON) * 100) / 100;
}

export function quoteZone(zone: ZoneTerms, policy: Policy, at: Date): Quote {
  const stayMinutes = Math.min(
    policy.default_stay_minutes,
    zone.maxStayMinutes ?? policy.default_stay_minutes,
  );

  const chargedMinutes = policy.respect_enforcement_hours
    ? enforcementProfile(zone.hours, at, stayMinutes).filter(Boolean).length
    : stayMinutes;

  const firstHourMinutes = Math.min(chargedMinutes, 60);
  const additionalMinutes = chargedMinutes - firstHourMinutes;
  const meterUsd = roundCents(
    (firstHourMinutes / 60) * zone.rateFirstHourUsd +
      (additionalMinutes / 60) * zone.rateAdditionalHourUsd,
  );
  const feeUsd = meterUsd > 0 ? roundCents(policy.parknyc_fee_usd) : 0;

  return {
    zoneId: zone.zoneId,
    parknycZoneNumber: zone.parknycZoneNumber,
    stayMinutes,
    chargedMinutes,
    meterUsd,
    feeUsd,
    totalUsd: roundCents(meterUsd + feeUsd),
  };
}
