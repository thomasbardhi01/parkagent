/**
 * User-sourced pay-by-app zone numbers. Boston's open data carries none
 * and ParkBoston's web app has no map to resolve them from (2026-09-21
 * recording) — so drivers read the number off the meter once, and every
 * later park at that block is automatic.
 *
 * One report per (zone, user); the zone's stored number is the latest
 * report, and it flips to verified once two different users agree on it.
 * A number that is already verified stays until a NEW two-user consensus
 * replaces it — a single dissenting report (a typo at the meter) is
 * recorded but changes nothing.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { isEnforcedAt, todaysIntervals } from "../services/hours.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import { NEARBY_ZONE_LIMIT } from "../services/zoneLookup.js";

/** The map layer's window. Capped hard: this is a PostGIS read per call. */
const MAX_NEAR_RADIUS_M = 400;
const DEFAULT_NEAR_RADIUS_M = 250;

const nearQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(MAX_NEAR_RADIUS_M).default(DEFAULT_NEAR_RADIUS_M),
});

const bodySchema = z.object({
  // Loose on purpose: Passport zone numbers are short digit strings — the
  // 2026-09-22 Find Parking sweep has real numbers from 1 to 5 digits
  // (zone "1" exists), so only the digits-only shape is enforced.
  number: z.string().regex(/^\d{1,10}$/, "the posted zone number, digits only"),
  source: z.enum(["user", "scan"]).default("user"),
});

export function registerZones(app: FastifyInstance, deps: AppDeps): void {
  // Number reports change what the executor types at the provider; nobody
  // legitimately reports more than a few blocks a minute.
  const limit = makeRateLimiter({ max: 12, windowMs: 60_000 });

  // The map's curb layer: what's metered around a point, with the geometry
  // to draw it. Read-only and cheap per call, but it is a PostGIS query per
  // pan, so it is both radius-capped and rate-limited.
  const nearLimit = makeRateLimiter({ max: 60, windowMs: 60_000 });
  app.get("/zones/near", { preHandler: nearLimit }, async (req, reply) => {
    if (!deps.findNearbyZones) {
      return reply.code(501).send({ error: "zone_geometry_unavailable" });
    }
    const parsed = nearQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const { lat, lng, radius } = parsed.data;
    const at = deps.now ? deps.now() : new Date();
    const zones = await deps.findNearbyZones({ lat, lng, radiusM: radius });
    return {
      radiusM: radius,
      at: at.toISOString(),
      // Truncation would read as "nothing more is metered here", so say it.
      truncated: zones.length >= NEARBY_ZONE_LIMIT,
      zones: zones.map((zone) => ({
        zoneId: zone.zoneId,
        city: zone.city,
        providerZoneNumber: zone.providerZoneNumber,
        street: zone.street,
        rateFirstHourUsd: zone.rateFirstHourUsd,
        rateAdditionalHourUsd: zone.rateAdditionalHourUsd,
        maxStayMinutes: zone.maxStayMinutes,
        distanceM: Math.round(zone.distanceM * 10) / 10,
        // What the map colors by: paying now vs free now.
        enforcedNow: isEnforcedAt(zone.hours, at),
        /** Today's posted windows, for the tapped-zone card. */
        todayHours: todaysIntervals(zone.hours, at),
        hours: zone.hours,
        centerline: zone.centerline,
      })),
    };
  });
  app.post("/zones/:zoneId/provider-number", { preHandler: limit }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const { zoneId } = req.params as { zoneId: string };
    const user = req.authedUser!;
    const body = parsed.data;

    const zone = await deps.db.zone.findUnique({ where: { zoneId } });
    if (!zone) {
      return reply.code(404).send({ error: "zone_not_found" });
    }

    await deps.db.zoneNumberReport.upsert({
      where: { zoneId_userId: { zoneId, userId: user.id } },
      create: { zoneId, userId: user.id, number: body.number, source: body.source },
      update: { number: body.number, source: body.source },
    });

    // Confirmations = distinct users whose current report says this number;
    // verified at two (the second person at the meter is the check).
    const reports = await deps.db.zoneNumberReport.findMany({ where: { zoneId } });
    const confirmations = new Set(
      reports.filter((r) => r.number === body.number).map((r) => r.userId),
    ).size;
    const verified = confirmations >= 2;

    // Precedence: an ALREADY-verified number on the zone is never
    // displaced by a single dissenting report (or by the import that
    // report would otherwise let win) — only a NEW two-user consensus
    // replaces it. Below verified: a verified report beats an import; an
    // import beats a single unverified report. The report is stored
    // either way — a second voice agreeing later still flips the zone.
    const imported = await deps.db.zoneNumberImport.findUnique({ where: { zoneId } });
    const storedVerified = zone.providerZoneNumberVerified && zone.providerZoneNumber !== "";
    // The stored verified number survives anything short of a NEW two-user
    // consensus on a different number. That covers both the dissenting
    // typo and the agreeing report whose recount happens to fall under 2
    // (a rebuilt reports table must not hand the zone to an import).
    const storedVerifiedStands =
      storedVerified && !(zone.providerZoneNumber !== body.number && verified);
    const importWins =
      !storedVerifiedStands && !verified && imported !== null && imported.number !== body.number;
    const applied = storedVerifiedStands
      ? {
          number: zone.providerZoneNumber,
          verified: true,
          source:
            zone.providerZoneNumber === body.number ? ("report" as const) : ("verified" as const),
        }
      : importWins
        ? { number: imported!.number, verified: false, source: "import" as const }
        : { number: body.number, verified, source: "report" as const };

    await deps.db.zone.update({
      where: { zoneId },
      data: { providerZoneNumber: applied.number, providerZoneNumberVerified: applied.verified },
    });

    // Not a money decision, but it changes what the executor will type at
    // the provider — keep the audit trail.
    const decision = await deps.db.decision.create({
      data: {
        kind: "zone_number_report",
        inputs: { zoneId, number: body.number, source: body.source },
        rule: storedVerifiedStands
          ? "verified_precedence"
          : importWins
            ? "import_precedence"
            : "report_ok",
        outcome: {
          number: applied.number,
          appliedSource: applied.source,
          verified: applied.verified,
          confirmations,
          importNumber: imported?.number ?? null,
        },
        userId: user.id,
      },
    });

    return {
      ok: true,
      zoneId,
      // The number now on the zone — what the executor will type. When an
      // import outranks this single report, that's the import's number.
      number: applied.number,
      appliedSource: applied.source,
      verified: applied.verified,
      confirmations,
      decisionId: decision.id,
    };
  });
}
