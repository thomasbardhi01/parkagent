/**
 * Per-user settings. Today that is exactly one: which payment source pays
 * sessions — "provider_card" (the card already on the user's ParkNYC /
 * ParkBoston account; onboarding default, skips card setup and funding) or
 * "issuing_card" (the ParkAgent Issuing card, selectable only when the
 * ISSUING_LIVE env flag is on). The daily and session caps apply to every
 * source — the choice moves where the charge lands, never what is allowed.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";

const putSchema = z.object({
  paymentSource: z.enum(["provider_card", "issuing_card"]),
});

export function registerMe(app: FastifyInstance, deps: AppDeps): void {
  const issuingLive = deps.issuingLive === true;

  app.get("/me/payment-source", async (req) => {
    const user = req.authedUser!;
    const row = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    return { paymentSource: row?.paymentSource ?? "provider_card", issuingLive };
  });

  app.put("/me/payment-source", async (req, reply) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const wanted = parsed.data.paymentSource;

    // The Issuing card isn't live yet: the app shows it as "coming soon",
    // and the server refuses to let it become what pays.
    if (wanted === "issuing_card" && !issuingLive) {
      const decision = await deps.db.decision.create({
        data: {
          kind: "payment_source",
          inputs: { paymentSource: wanted, issuingLive },
          rule: "issuing_not_live",
          outcome: { allowed: false },
          userId: user.id,
        },
      });
      return reply.code(409).send({ error: "issuing_not_live", decisionId: decision.id });
    }

    const updated = await deps.db.user.update({
      where: { id: user.id },
      data: { paymentSource: wanted },
      select: { paymentSource: true },
    });
    await deps.db.decision.create({
      data: {
        kind: "payment_source",
        inputs: { paymentSource: wanted, issuingLive },
        rule: "set",
        outcome: { allowed: true, paymentSource: updated.paymentSource },
        userId: user.id,
      },
    });
    return { paymentSource: updated.paymentSource, issuingLive };
  });
}
