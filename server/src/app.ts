import Fastify from "fastify";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import type { AppDb } from "./db.js";
import { registerAdmin } from "./routes/admin.js";
import { registerCard } from "./routes/card.js";
import { registerCity } from "./routes/city.js";
import { registerDevice } from "./routes/device.js";
import { registerLocation } from "./routes/location.js";
import { registerParked } from "./routes/parked.js";
import { registerPolicy } from "./routes/policy.js";
import { registerProviders } from "./routes/providers.js";
import { registerSession } from "./routes/session.js";
import { registerStripeWebhook } from "./routes/webhooksStripe.js";
import { registerZones } from "./routes/zones.js";
import type { PushSender } from "./services/apns.js";
import type { StateCrypto } from "./services/crypto.js";
import type { ExecutorProvider } from "./services/executor.js";
import type { PendingSessionCheck } from "./services/pendingSession.js";
import type { PolicyService } from "./services/policy.js";
import type { ProviderOpsFactory } from "./services/providerOps.js";
import type { StripeGateway } from "./services/stripeGateway.js";
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
  /** Absent when STRIPE_SECRET_KEY isn't set; /webhooks/stripe then 503s. */
  stripe?: StripeGateway;
  /** The issuing webhook's "is a session awaiting payment?" check. */
  hasPendingSession?: PendingSessionCheck;
  /** Seals provider session state; absent when PROVIDER_STATE_KEY isn't
   * set, and provider linking then answers 503. */
  stateCrypto?: StateCrypto;
  /** Real Playwright-backed account ops (parknycExecutor.ts) or test fakes;
   * absent → provider linking answers 503. */
  providerOps?: ProviderOpsFactory;
  /** Injectable clock for tests; routes fall back to `new Date()`. */
  now?: () => Date;
}

/** x-api-key → users.api_key. Everything but /health and /webhooks/stripe
 * sits behind this — enforced app-wide by an onRequest hook in buildApp,
 * so a route forgotten from an allowlist fails closed, never open. */
export function makeAuthenticate(db: AppDb): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers["x-api-key"];
    // select is load-bearing: without it the runtime row includes the
    // caller's api_key, one careless spread away from a response body.
    const user =
      typeof key === "string" && key.length > 0
        ? await db.user.findUnique({
            where: { apiKey: key },
            select: { id: true, name: true },
          })
        : null;
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.authedUser = user;
  };
}

/** Reachable without an api key: health probes, and the Stripe webhook
 * (its signature is the auth). Everything else 401s by default. */
const PUBLIC_PATHS = new Set(["/health", "/webhooks/stripe"]);

/**
 * Build the Fastify app. Without deps only /health exists — enough for the
 * health tests and for boot-order flexibility; index.ts always passes deps.
 */
export function buildApp(deps?: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      // Belt and braces: Fastify's default req serializer logs no headers,
      // but nothing should be one serializer tweak away from logging
      // credentials.
      redact: {
        paths: [
          "req.headers['x-api-key']",
          "req.headers.authorization",
          "req.headers['stripe-signature']",
          "req.headers.cookie",
        ],
        censor: "[redacted]",
      },
    },
  });

  // Unhandled errors must not echo their message to the caller — Stripe,
  // Prisma, and Playwright errors carry request ids, DB topology, and page
  // state. Log server-side, answer generic. Fastify's own 4xx errors
  // (malformed JSON, oversized body) keep their status and code.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({ error: err.code ?? "bad_request" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });

  // Auth is default-on: a new route that forgets about auth is private,
  // not silently public. Runs for unknown paths too — probing 401s.
  if (deps) {
    // The stored handler is async (makeAuthenticate) — the done-callback
    // arm of the preHandler type never applies.
    const authenticate = deps.authenticate as unknown as (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
    app.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0] ?? req.url;
      if (PUBLIC_PATHS.has(path)) return;
      await authenticate(req, reply);
    });
  }

  app.get("/health", async () => ({
    ok: true,
    dryRun: process.env["DRY_RUN"] === "true",
    // Injected at image build (Dockerfile ARG -> ENV); "dev" under tsx/vitest.
    commit: process.env["GIT_SHA"] ?? "dev",
    builtAt: process.env["BUILD_TIME"] ?? "dev",
  }));
  if (deps) {
    registerParked(app, deps);
    registerCity(app, deps);
    registerZones(app, deps);
    registerPolicy(app, deps);
    registerSession(app, deps);
    registerLocation(app, deps);
    registerDevice(app, deps);
    registerCard(app, deps);
    registerProviders(app, deps);
    registerAdmin(app, deps);
    registerStripeWebhook(app, deps);
  }
  return app;
}
