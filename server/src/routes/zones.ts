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

const bodySchema = z.object({
  // Loose on purpose: Passport zone numbers are short digit strings.
  number: z.string().regex(/^\d{3,10}$/, "the posted zone number, digits only"),
  source: z.enum(["user", "scan"]).default("user"),
});

export function registerZones(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    "/zones/:zoneId/provider-number",
    { preHandler: deps.authenticate },
    async (req, reply) => {
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

      await deps.db.zone.update({
        where: { zoneId },
        data: { providerZoneNumber: body.number, providerZoneNumberVerified: verified },
      });

      // Not a money decision, but it changes what the executor will type at
      // the provider — keep the audit trail.
      const decision = await deps.db.decision.create({
        data: {
          kind: "zone_number_report",
          inputs: { zoneId, number: body.number, source: body.source },
          rule: "report_ok",
          outcome: { number: body.number, verified, confirmations },
          userId: user.id,
        },
      });

      return {
        ok: true,
        zoneId,
        number: body.number,
        verified,
        confirmations,
        decisionId: decision.id,
      };
    },
  );
}
