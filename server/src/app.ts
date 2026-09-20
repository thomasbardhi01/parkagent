import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppDb } from "./db.js";
import { registerDevice } from "./routes/device.js";
import { registerLocation } from "./routes/location.js";
import { registerParked } from "./routes/parked.js";
import { registerPolicy } from "./routes/policy.js";
import { registerSession } from "./routes/session.js";
import type { PushSender } from "./services/apns.js";
import type { ExecutorProvider } from "./services/executor.js";
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
  /** Picks the dry-run or real executor per call (dry_run can flip at runtime). */
  executorFor: ExecutorProvider;
  sendPush: PushSender;
  /** Injectable clock for tests; routes fall back to `new Date()`. */
  now?: () => Date;
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
    registerSession(app, deps);
    registerLocation(app, deps);
    registerDevice(app, deps);
  }
  return app;
}
