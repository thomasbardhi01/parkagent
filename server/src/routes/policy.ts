import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { requireAdmin } from "../app.js";
import { snapshotPolicy } from "../services/policy.js";

function policyResponse(deps: AppDeps) {
  return {
    policy: deps.policy.get(),
    hash: deps.policy.hash(),
    dryRun: deps.policy.effectiveDryRun(),
  };
}

export function registerPolicy(app: FastifyInstance, deps: AppDeps): void {
  app.get("/policy", async () => policyResponse(deps));

  app.put("/policy", async (req, reply) => {
    // The policy is the shared spending contract: caps, dry_run, the rate
    // ceiling. Reading it is for everyone (the app renders it); changing
    // it is the owner's call alone.
    if (!requireAdmin(req, reply)) return;
    try {
      deps.policy.update(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: z.treeifyError(error) });
      }
      throw error;
    }
    await snapshotPolicy(deps.db, deps.policy.get(), "put");
    return policyResponse(deps);
  });
}
