/**
 * Phone fixes reported every 60 s while a session is active (the iOS
 * LocationReporter). Fixes are keyed to the user's single active session;
 * the extension worker reads the latest few to estimate distance to the
 * car and heading. No decisions row — storing a fix decides nothing.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";

const bodySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().nonnegative().lte(10_000),
  ts: z.iso.datetime({ offset: true }),
});

export function registerLocation(app: FastifyInstance, deps: AppDeps): void {
  app.post("/location", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;

    const session = await deps.db.session.findFirst({
      where: { userId: user.id, status: "active" },
    });
    if (!session) {
      return reply.code(409).send({ error: "no_active_session" });
    }
    await deps.db.locationFix.create({
      data: {
        sessionId: session.id,
        userId: user.id,
        lat: body.lat,
        lng: body.lng,
        accuracyM: body.accuracy,
        ts: new Date(body.ts),
      },
    });
    return { ok: true, sessionId: session.id };
  });
}
