/**
 * GET/PUT /me/limits — the signed-in user's own spending limits: per stop,
 * per day, and the default stay. Everyone may set their own, within the
 * operator's policy.json caps (the ceilings); see services/limits.ts.
 * PUT /policy stays the operator's (admin-only) and no longer backs the
 * app's limit screens.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { applyChange, limitsFor, limitsView } from "../services/limits.js";

const amount = z.number().finite();

const putSchema = z.strictObject({
  sessionCapUsd: amount.nullable().optional(),
  dailyCapUsd: amount.nullable().optional(),
  defaultStayMinutes: z.number().int().nullable().optional(),
});

export function registerLimits(app: FastifyInstance, deps: AppDeps): void {
  app.get("/me/limits", async (req) => limitsFor(deps, req.authedUser!.id));

  app.put("/me/limits", async (req, reply) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_limits",
        issues: parsed.error.issues.map((issue) => ({
          field: String(issue.path[0] ?? ""),
          code: "invalid",
          message: "That isn't a limit ParkAgent understands.",
          limit: null,
        })),
      });
    }
    const userId = req.authedUser!.id;
    const policy = deps.policy.get();
    const before = await limitsFor(deps, userId);
    const change = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    );
    const result = applyChange(policy, before.saved, change);
    if (!result.ok) {
      await deps.db.decision.create({
        data: {
          kind: "limits_update",
          inputs: {
            change,
            before: before.saved,
            ceilings: before.ceilings,
            policyHash: deps.policy.hash(),
          },
          rule: "refused",
          outcome: { ok: false, issues: result.issues },
          userId,
        },
      });
      return reply.code(400).send({ error: "invalid_limits", issues: result.issues });
    }
    const row = await deps.db.userLimits.upsert({
      where: { userId },
      create: { userId, ...result.saved },
      update: result.saved,
    });
    const after = limitsView(policy, row);
    // Limits decide what gets paid without asking: every change is on the
    // ledger with what it replaced.
    await deps.db.decision.create({
      data: {
        kind: "limits_update",
        inputs: {
          change,
          before: before.saved,
          ceilings: before.ceilings,
          policyHash: deps.policy.hash(),
        },
        rule: "saved",
        outcome: { ok: true, saved: after.saved, effective: after.limits },
        userId,
      },
    });
    return after;
  });
}
