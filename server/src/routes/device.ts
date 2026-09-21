/**
 * APNs device registration. The app re-sends its token on every launch, so
 * the row is upserted by token — re-registering is idempotent, and a token
 * that moves between users (fresh install, second tester) follows the most
 * recent registration.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";

const bodySchema = z.object({
  token: z.string().min(1).max(200),
  platform: z.literal("ios"),
  environment: z.enum(["development", "production"]),
});

export function registerDevice(app: FastifyInstance, deps: AppDeps): void {
  app.post("/device", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    await deps.db.deviceToken.upsert({
      where: { token: body.token },
      create: {
        userId: user.id,
        token: body.token,
        platform: body.platform,
        environment: body.environment,
      },
      update: {
        userId: user.id,
        platform: body.platform,
        environment: body.environment,
      },
    });
    return { ok: true };
  });
}
