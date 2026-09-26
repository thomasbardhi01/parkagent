/**
 * Provider-observed zone terms (the zone_terms_observed table): what the
 * provider's own UI said a zone costs and allows, keyed by (city, zone
 * number). The Passport executor reads the Vehicles chooser's Zone
 * Information line ("$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm") on every start
 * attempt and returns it as `providerTerms`; this module records it and
 * lets quoting prefer the observed rate and max stay over the dataset —
 * Boston's dataset assumed a 2-hour max everywhere, but e.g. zone 456 is
 * posted 5 hours.
 *
 * Observed HOURS are recorded as evidence only; quoting keeps the
 * dataset's enforcement hours (issue: re-derive Boston max stay + hours
 * from observations plus the meter data).
 */

import type { AppDb, ZoneTermsObservedRow, ZoneTermsRow } from "../db.js";
import type { ProviderZoneTerms } from "./executor.js";
import type { Candidate } from "./zoneLookup.js";

/** The dataset terms with any observed overrides applied. */
export interface EffectiveZoneTerms {
  rateFirstHourUsd: number;
  rateAdditionalHourUsd: number;
  maxStayMinutes: number | null;
  /** True when an observed row overrode at least one value. */
  observed: boolean;
}

export async function observedTermsFor(
  db: AppDb,
  city: string,
  zoneNumber: string,
): Promise<ZoneTermsObservedRow | null> {
  if (zoneNumber === "") return null;
  return db.zoneTermsObserved.findUnique({ where: { city_zoneNumber: { city, zoneNumber } } });
}

/** Dataset terms with the observed rate/max stay preferred when present.
 * The observed line carries one flat rate, so it overrides both rungs of
 * the ladder (Boston meters are flat-rate; NYC has no observations yet). */
export function effectiveTerms(
  zone: Pick<ZoneTermsRow, "rateFirstHour" | "rateAdditionalHour" | "maxStayMinutes">,
  observed: ZoneTermsObservedRow | null,
): EffectiveZoneTerms {
  const rate = observed?.ratePerHourUsd == null ? null : Number(observed.ratePerHourUsd);
  const maxStay = observed?.maxStayMinutes ?? null;
  return {
    rateFirstHourUsd: rate ?? Number(zone.rateFirstHour),
    rateAdditionalHourUsd: rate ?? Number(zone.rateAdditionalHour),
    maxStayMinutes: maxStay ?? zone.maxStayMinutes,
    observed: rate !== null || maxStay !== null,
  };
}

/**
 * /parked's batch form: rewrite candidates whose (city, zone number) has an
 * observed row, marking them termsSource "observed" so the decision and the
 * app can tell which quote came from where.
 */
export async function applyObservedToCandidates<T extends Candidate>(
  db: AppDb,
  candidates: T[],
): Promise<T[]> {
  const byCity = new Map<string, string[]>();
  for (const c of candidates) {
    if (c.providerZoneNumber === "") continue;
    byCity.set(c.city, [...(byCity.get(c.city) ?? []), c.providerZoneNumber]);
  }
  const observed = new Map<string, ZoneTermsObservedRow>();
  for (const [city, numbers] of byCity) {
    const rows = await db.zoneTermsObserved.findMany({
      where: { city, zoneNumber: { in: numbers } },
    });
    for (const row of rows) observed.set(`${row.city}:${row.zoneNumber}`, row);
  }
  return candidates.map((c) => {
    const row = observed.get(`${c.city}:${c.providerZoneNumber}`) ?? null;
    const effective = effectiveTerms(
      {
        rateFirstHour: c.rateFirstHourUsd,
        rateAdditionalHour: c.rateAdditionalHourUsd,
        maxStayMinutes: c.maxStayMinutes,
      },
      row,
    );
    if (!effective.observed) return c;
    return {
      ...c,
      rateFirstHourUsd: effective.rateFirstHourUsd,
      rateAdditionalHourUsd: effective.rateAdditionalHourUsd,
      maxStayMinutes: effective.maxStayMinutes,
      termsSource: "observed" as const,
    };
  });
}

/** Does the provider's displayed line disagree with our zone record (the
 * DATASET values, not the effective ones)? Only fields the provider
 * actually showed are compared. */
export function providerTermsMismatch(
  zone: Pick<ZoneTermsRow, "rateFirstHour" | "rateAdditionalHour" | "maxStayMinutes">,
  terms: ProviderZoneTerms,
): boolean {
  if (
    terms.ratePerHourUsd !== null &&
    (Number(zone.rateFirstHour) !== terms.ratePerHourUsd ||
      Number(zone.rateAdditionalHour) !== terms.ratePerHourUsd)
  ) {
    return true;
  }
  return terms.maxStayMinutes !== null && zone.maxStayMinutes !== terms.maxStayMinutes;
}

/** Record one observation (upsert by city + zone number). A line with
 * nothing parsed out of it is not worth a row. */
export async function recordObservedTerms(
  db: AppDb,
  args: {
    city: string;
    zoneNumber: string;
    zoneId: string;
    terms: ProviderZoneTerms;
    at: Date;
  },
): Promise<void> {
  const { terms } = args;
  if (args.zoneNumber === "") return;
  if (terms.ratePerHourUsd === null && terms.maxStayMinutes === null && terms.hours === null) {
    return;
  }
  const fields = {
    ratePerHourUsd: terms.ratePerHourUsd,
    maxStayMinutes: terms.maxStayMinutes,
    rawText: terms.rawText,
    // Omitted (not null) when unparsed: Prisma's nullable-Json write wants
    // JsonNull sentinels, and keeping the last parsed hours is fine.
    ...(terms.hours !== null ? { hoursJson: terms.hours } : {}),
    zoneId: args.zoneId,
    lastSeenAt: args.at,
  };
  await db.zoneTermsObserved.upsert({
    where: { city_zoneNumber: { city: args.city, zoneNumber: args.zoneNumber } },
    create: { city: args.city, zoneNumber: args.zoneNumber, ...fields },
    update: fields,
  });
}
