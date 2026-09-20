/**
 * Zone candidate lookup and the agree/disagree resolution.
 *
 * NYC block faces are buffered one-sided, but streets are mostly narrower
 * than GPS error, so a fix usually lands near several faces (PR #42: 94% of
 * opposite-side pairs still overlap). Design decision from that PR: return
 * candidates ranked by distance to the face centerline; pay silently when
 * the top candidates agree on terms, prompt the driver to pick a side when
 * they don't.
 *
 * Candidates "agree" when their rate ladder, max stay, and minute-by-minute
 * enforcement status over the next 60 minutes all match — hours posted
 * differently but behaving identically for the next hour still agree.
 */

import type { HoursInterval } from "./hours.js";
import { enforcementProfile } from "./hours.js";

export interface Candidate {
  zoneId: string;
  parknycZoneNumber: string;
  rateFirstHourUsd: number;
  rateAdditionalHourUsd: number;
  maxStayMinutes: number | null;
  hours: HoursInterval[];
  distanceM: number;
  containsPoint: boolean;
}

export interface LookupQuery {
  lat: number;
  lng: number;
  radiusM: number;
}

/** Fetches candidates ranked by centerline distance; injectable for tests. */
export type CandidateFetcher = (query: LookupQuery) => Promise<Candidate[]>;

/** How far out to search: at least 25 m, more when the fix is worse. */
export function lookupRadiusM(accuracyM: number): number {
  return Math.max(accuracyM, 25);
}

const AGREEMENT_WINDOW_MINUTES = 60;

export function candidatesAgree(
  a: Candidate,
  b: Candidate,
  at: Date,
  respectEnforcementHours: boolean,
): boolean {
  if (
    a.rateFirstHourUsd !== b.rateFirstHourUsd ||
    a.rateAdditionalHourUsd !== b.rateAdditionalHourUsd ||
    a.maxStayMinutes !== b.maxStayMinutes
  ) {
    return false;
  }
  if (!respectEnforcementHours) return true;
  const profileA = enforcementProfile(a.hours, at, AGREEMENT_WINDOW_MINUTES);
  const profileB = enforcementProfile(b.hours, at, AGREEMENT_WINDOW_MINUTES);
  return profileA.every((enforced, i) => enforced === profileB[i]);
}

export type Resolution =
  | { kind: "unknown" }
  | { kind: "agree"; nearest: Candidate }
  | { kind: "disagree"; nearest: Candidate; alternative: Candidate };

/**
 * Nearest candidate wins when every other candidate in radius agrees with
 * it; otherwise surface the nearest plus the closest disagreeing candidate
 * (the two "sides" the driver must choose between).
 */
export function resolveCandidates(
  candidates: Candidate[],
  at: Date,
  respectEnforcementHours: boolean,
): Resolution {
  const nearest = candidates[0];
  if (!nearest) return { kind: "unknown" };
  const alternative = candidates
    .slice(1)
    .find((c) => !candidatesAgree(nearest, c, at, respectEnforcementHours));
  return alternative ? { kind: "disagree", nearest, alternative } : { kind: "agree", nearest };
}

interface RawQuerier {
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface CandidateRow {
  zone_id: string;
  parknyc_zone_number: string;
  rate_first_hour: number;
  rate_additional_hour: number;
  max_stay_minutes: number | null;
  hours_json: HoursInterval[];
  contains_point: boolean;
  distance_m: number;
}

/**
 * PostGIS-backed fetcher. The geometry ST_DWithin is a cheap prefilter that
 * can use the GiST index (radius in degrees, padded well past the
 * lng-degree shortfall at NYC's latitude); the geography ST_DWithin is the
 * exact meters test.
 */
export function makeCandidateFetcher(db: RawQuerier): CandidateFetcher {
  return async ({ lat, lng, radiusM }) => {
    const radiusDeg = (radiusM / 111_320) * 1.6;
    const rows = await db.$queryRaw<CandidateRow[]>`
      SELECT
        z.zone_id,
        z.parknyc_zone_number,
        z.rate_first_hour::float8   AS rate_first_hour,
        z.rate_additional_hour::float8 AS rate_additional_hour,
        z.max_stay_minutes,
        z.hours_json,
        ST_Contains(z.geom, pt.g)   AS contains_point,
        ST_Distance(z.centerline::geography, pt.g::geography) AS distance_m
      FROM zones z,
           (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS g) pt
      WHERE ST_DWithin(z.centerline, pt.g, ${radiusDeg})
        AND ST_DWithin(z.centerline::geography, pt.g::geography, ${radiusM})
      ORDER BY distance_m
      LIMIT 8`;
    return rows.map((row) => ({
      zoneId: row.zone_id,
      parknycZoneNumber: row.parknyc_zone_number,
      rateFirstHourUsd: row.rate_first_hour,
      rateAdditionalHourUsd: row.rate_additional_hour,
      maxStayMinutes: row.max_stay_minutes,
      hours: row.hours_json,
      distanceM: row.distance_m,
      containsPoint: row.contains_point,
    }));
  };
}
