import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({
    ok: true,
    dryRun: process.env["DRY_RUN"] === "true",
    // Injected at image build (Dockerfile ARG -> ENV); "dev" under tsx/vitest.
    commit: process.env["GIT_SHA"] ?? "dev",
    builtAt: process.env["BUILD_TIME"] ?? "dev",
  }));
  return app;
}
