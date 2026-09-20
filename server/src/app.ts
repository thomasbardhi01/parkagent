import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppDb } from "./db.js";
import { registerParked } from "./routes/parked.js";
import { registerPolicy } from "./routes/policy.js";
import { registerStubs } from "./routes/stubs.js";
import type { PolicyService } from "./services/policy.js";
import type { CandidateFetcher } from "./services/zoneLookup.js";

declare module "fastify" {
  interface FastifyRequest {
    authedUser?: { id: string; name: string };
  }
}

export interface AppDeps {
  db: AppDb;
  policy: PolicyService;
  findCandidates: CandidateFetcher;
  authenticate: preHandlerHookHandler;
}

/** x-api-key → users.api_key. Everything but /health sits behind this. */
export function makeAuthenticate(db: AppDb): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers["x-api-key"];
    const user =
      typeof key === "string" && key.length > 0
        ? await db.user.findUnique({ where: { apiKey: key } })
        : null;
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.authedUser = user;
  };
}

/**
 * Build the Fastify app. Without deps only /health exists — enough for the
 * health tests and for boot-order flexibility; index.ts always passes deps.
 */
export function buildApp(deps?: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({
    ok: true,
    dryRun: process.env["DRY_RUN"] === "true",
    // Injected at image build (Dockerfile ARG -> ENV); "dev" under tsx/vitest.
    commit: process.env["GIT_SHA"] ?? "dev",
    builtAt: process.env["BUILD_TIME"] ?? "dev",
  }));
  if (deps) {
    registerParked(app, deps);
    registerPolicy(app, deps);
    registerStubs(app, deps);
  }
  return app;
}
