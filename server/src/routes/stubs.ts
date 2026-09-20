import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../app.js";

/**
 * Phase 5 (executor-backed sessions) and Phase 7 (extender's /location
 * feed) endpoints. Stubbed at 501 so the app can wire against real paths;
 * planned request/response shapes are in API.md. The session routes are the
 * money-moving paths — when they land they check DRY_RUN and policy first.
 */
export function registerStubs(app: FastifyInstance, deps: AppDeps): void {
  for (const path of ["/session/start", "/session/stop", "/session/extend", "/location"]) {
    app.post(path, { preHandler: deps.authenticate }, async (_req, reply) =>
      reply.code(501).send({ error: "not_implemented" }),
    );
  }
}
