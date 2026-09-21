import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
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
