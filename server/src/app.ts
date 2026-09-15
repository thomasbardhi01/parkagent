import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ ok: true, dryRun: process.env["DRY_RUN"] === "true" }));
  return app;
}
