/**
 * APNs device registration. The app re-sends its token on every launch, so
 * registering is idempotent — but a token is BOUND to the user who first
 * registered it: another account presenting the same token is refused
 * (409) instead of silently stealing the push channel (audit finding
 * #74). Moving a handset between testers is explicit now: the old account
 * unbinds (DELETE /device) — or is deleted; the FK cascades — then the
 * new one registers.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";

const bodySchema = z.object({
  token: z.string().min(1).max(200),
  platform: z.literal("ios"),
  environment: z.enum(["development", "production"]),
});

const unbindSchema = z.object({
  token: z.string().min(1).max(200),
});

export function registerDevice(app: FastifyInstance, deps: AppDeps): void {
  app.post("/device", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const existing = await deps.db.deviceToken.findUnique({ where: { token: body.token } });
    if (existing && existing.userId !== user.id) {
      return reply.code(409).send({ error: "token_bound_elsewhere" });
    }
    await deps.db.deviceToken.upsert({
      where: { token: body.token },
      create: {
        userId: user.id,
        token: body.token,
        platform: body.platform,
        environment: body.environment,
      },
      // userId deliberately absent: the binding never moves on update.
      update: {
        platform: body.platform,
        environment: body.environment,
      },
    });
    return { ok: true };
  });

  // Unbind: sign-out/reset, or handing the phone to the other tester.
  // Only the owning user can release their token.
  app.delete("/device", async (req, reply) => {
    const parsed = unbindSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const existing = await deps.db.deviceToken.findUnique({
      where: { token: parsed.data.token },
    });
    if (!existing || existing.userId !== user.id) {
      return reply.code(404).send({ error: "token_not_found" });
    }
    await deps.db.deviceToken.delete({ where: { id: existing.id } });
    return { ok: true };
  });
}
