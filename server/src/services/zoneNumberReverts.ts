/**
 * Pure planning for load:zone-numbers' withdrawn-import reverts, kept out
 * of the script so tests can import it without running the loader.
 */

export interface WithdrawnClaim {
  zoneId: string;
  number: string;
}

export interface ZoneNumberState {
  zoneId: string;
  providerZoneNumber: string;
  providerZoneNumberVerified: boolean;
}

export interface ReportRow {
  zoneId: string;
  userId: string;
  number: string;
  createdAt: Date;
}

/**
 * When a re-run withdraws an import claim (the importer reclassified the
 * block as ambiguous, say), the number it previously put on the zone must
 * not linger with no backing source. For each withdrawn claim whose
 * number is still on the zone (and not user-verified), fall back to the
 * zone's reports: the latest report's number, verified if two distinct
 * users agree with it — or "" when nobody has reported. Pure so it's
 * unit-testable; the SQL below just applies the plan.
 */
export function planWithdrawnReverts(
  withdrawn: WithdrawnClaim[],
  zones: ZoneNumberState[],
  reports: ReportRow[],
): { zoneId: string; number: string; verified: boolean }[] {
  const zoneById = new Map(zones.map((z) => [z.zoneId, z]));
  const reverts: { zoneId: string; number: string; verified: boolean }[] = [];
  for (const claim of withdrawn) {
    const zone = zoneById.get(claim.zoneId);
    if (!zone) continue;
    // A verified user consensus, or a number from some other source,
    // stands on its own — only the import's own orphaned number reverts.
    if (zone.providerZoneNumberVerified) continue;
    if (zone.providerZoneNumber !== claim.number) continue;
    const zoneReports = reports
      .filter((r) => r.zoneId === claim.zoneId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = zoneReports[0];
    if (!latest) {
      reverts.push({ zoneId: claim.zoneId, number: "", verified: false });
      continue;
    }
    const confirmations = new Set(
      zoneReports.filter((r) => r.number === latest.number).map((r) => r.userId),
    ).size;
    reverts.push({ zoneId: claim.zoneId, number: latest.number, verified: confirmations >= 2 });
  }
  return reverts;
}
