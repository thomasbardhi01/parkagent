/**
 * User-sourced pay-by-app zone numbers. Boston's open data carries none
 * and ParkBoston's web app has no map to resolve them from (2026-09-21
 * recording) — so drivers read the number off the meter once, and every
 * later park at that block is automatic.
 *
 * One report per (zone, user); the zone's stored number is the latest
 * report, and it flips to verified once two different users agree on it.
 * A conflicting later report replaces the number and drops verified until
 * a second user confirms the new one.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { makeRateLimiter } from "../services/rateLimit.js";

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

    // Precedence: a verified report beats an import; an import beats a
    // single unverified report. The report is stored either way — a
    // second voice agreeing with it later still flips the zone.
    const imported = await deps.db.zoneNumberImport.findUnique({ where: { zoneId } });
    const importWins = !verified && imported !== null && imported.number !== body.number;
    const applied = importWins
      ? { number: imported.number, verified: false, source: "import" as const }
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
        rule: importWins ? "import_precedence" : "report_ok",
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
