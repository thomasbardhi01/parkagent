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
import { registerAuth } from "./routes/auth.js";
import { hashApiKey } from "./services/apiKeys.js";
import { verifyAccessToken } from "./services/authTokens.js";
import type { EmailSender } from "./services/emailer.js";
import type { IdTokenResult } from "./services/idToken.js";
import { registerCard } from "./routes/card.js";
import { registerCity } from "./routes/city.js";
import { registerDevice } from "./routes/device.js";
import { registerLocation } from "./routes/location.js";
import { registerMe } from "./routes/me.js";
import { registerParked } from "./routes/parked.js";
import { registerPolicy } from "./routes/policy.js";
import { registerProviders } from "./routes/providers.js";
import { registerSession } from "./routes/session.js";
import { registerStripeWebhook } from "./routes/webhooksStripe.js";
import { registerZones } from "./routes/zones.js";
import { registerAssistant } from "./routes/assistant.js";
import { registerLink } from "./routes/link.js";
import { registerWallet } from "./routes/wallet.js";
import type { ApnsSendReport, Push, PushSender } from "./services/apns.js";
import type { AppleTokenClient } from "./services/appleTokens.js";
import type { ModelClient } from "./services/assistant/loop.js";
import type { AssistantTools } from "./services/assistant/tools.js";
import type { LinkWallet } from "./services/link/linkWallet.js";
import type { StateCrypto } from "./services/crypto.js";
import type { ExecutorProvider } from "./services/executor.js";
import type { PendingSessionCheck } from "./services/pendingSession.js";
import type { PolicyService } from "./services/policy.js";
import type { ExecutorRuntime } from "./services/parknycExecutor.js";
import type { ProviderOpsFactory } from "./services/providerOps.js";
import type { StripeGateway } from "./services/stripeGateway.js";
import type { CandidateFetcher, NearbyZoneFetcher } from "./services/zoneLookup.js";

declare module "fastify" {
  interface FastifyRequest {
    authedUser?: { id: string; name: string; isAdmin: boolean };
  }
}

/** Everything /auth/* needs. The token verifiers are injectable so tests
 * sign with their own keys; index.ts wires the real JWKS-backed ones. */
export interface AuthConfig {
  jwtSecret: string;
  /** Absent → POST /auth/email/start answers 503. */
  emailSender?: EmailSender | undefined;
  verifyAppleToken: (token: string, now: Date) => Promise<IdTokenResult>;
  /** Absent → POST /auth/google answers 403 google_signin_disabled. */
  verifyGoogleToken?: ((token: string, now: Date) => Promise<IdTokenResult>) | undefined;
}

export interface AppDeps {
  db: AppDb;
  policy: PolicyService;
  /** Identity + sessions; absent → /auth/* answers 503 and bearer tokens
   * never authenticate (api keys still do). */
  auth?: AuthConfig;
  findCandidates: CandidateFetcher;
  /** The map layer's geometry read (GET /zones/near); absent → that route
   * 501s. Separate from findCandidates because the pay path never needs
   * geometry and tests fake the two independently. */
  findNearbyZones?: NearbyZoneFetcher;
  authenticate: preHandlerHookHandler;
  /** Picks the dry-run or real executor per call (dry_run can flip at runtime). */
  executorFor: ExecutorProvider;
  sendPush: PushSender;
  /** Reporting APNs delivery for the admin push-test endpoint; absent →
   * that endpoint answers 503. The money path uses sendPush, not this. */
  apnsDelivery?: (userId: string, push: Push) => Promise<ApnsSendReport>;
  /** Absent when STRIPE_SECRET_KEY isn't set; /webhooks/stripe then 503s. */
  stripe?: StripeGateway;
  /** The issuing webhook's "is a session awaiting payment?" check. */
  hasPendingSession?: PendingSessionCheck;
  /** Seals provider session state; absent when PROVIDER_STATE_KEY isn't
   * set, and provider linking then answers 503. Also seals the Sign in
   * with Apple refresh token. */
  stateCrypto?: StateCrypto;
  /** Sign in with Apple's token + revoke endpoints (APPLE_SIGNIN_* set).
   * Absent → no Apple token is stored at sign-in or revoked on delete. */
  appleTokens?: AppleTokenClient;
  /** Real Playwright-backed account ops (parknycExecutor.ts) or test fakes;
   * absent → provider linking answers 503. */
  providerOps?: ProviderOpsFactory;
  /** Runs link jobs (jobs/linkWorker.ts); POST …/link kicks it so a new
   * job starts now rather than at the next poll. */
  linkWorker?: { kick(): void };
  /** The executor's browser gate and circuit breakers, for /admin/summary. */
  executorRuntime?: ExecutorRuntime;
  /** The assistant's Anthropic transport; absent (no ANTHROPIC_API_KEY)
   * → /assistant/* answers 503. Tests inject a scripted fake. */
  assistantModel?: ModelClient;
  /** Tool implementations (policy enforcement lives in them). */
  assistantTools?: AssistantTools;
  /** ASSISTANT_DAILY_SPEND_CAP_USD: per-user daily ceiling on estimated
   * model spend; unset → uncapped. Over the cap → /assistant/message 429. */
  assistantDailySpendCapUsd?: number;
  /** ASSISTANT_CONVERSATION_RETENTION_DAYS; the history list reports it. */
  conversationRetentionDays?: number;
  /** Link wallet for agents; absent/unconfigured → /link/* answers 503. */
  linkWallet?: LinkWallet;
  /** ISSUING_LIVE env: whether the ParkAgent card may be chosen as the
   * Wallet's payment source (PUT /wallet/source). Default false — the app
   * shows "Coming soon — pending approval". */
  issuingLive?: boolean;
  /** STRIPE_SECRET_KEY is a test-mode key: before ISSUING_LIVE, a Debug
   * build may still choose the ParkAgent card (sandbox: true) — test-mode
   * keys can't move real money. */
  issuingSandbox?: boolean;
  /** Injectable clock for tests; routes fall back to `new Date()`. */
  now?: () => Date;
}

/** Two credentials authenticate a request, tried in this order:
 *
 *  1. `Authorization: Bearer <jwt>` — the app's 15-minute access token
 *     (AUTH_JWT_SECRET). The user row is re-read so a deleted account's
 *     still-valid JWT stops working immediately.
 *  2. `x-api-key` → SHA-256(pepper:key) → users.api_key_hash — the owner's
 *     admin key and scripts; user-facing clients use JWTs now.
 *
 * Everything but the PUBLIC_PATHS sits behind this — enforced app-wide by
 * an onRequest hook in buildApp, so a route forgotten from an allowlist
 * fails closed, never open. Rows still carrying a plaintext api_key (the
 * pre-migration state) do NOT authenticate — run
 * `pnpm -C server migrate:api-keys` first. */
export function makeAuthenticate(
  db: AppDb,
  pepper: string,
  jwtSecret?: string,
  now: () => Date = () => new Date(),
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = req.headers.authorization;
    if (jwtSecret && typeof bearer === "string" && bearer.startsWith("Bearer ")) {
      const claims = verifyAccessToken(jwtSecret, bearer.slice(7), now());
      if (claims) {
        const user = await db.user.findUnique({
          where: { id: claims.sub },
          select: { id: true, name: true, isAdmin: true, deletedAt: true },
        });
        if (user && !user.deletedAt) {
          req.authedUser = { id: user.id, name: user.name, isAdmin: user.isAdmin };
          return;
        }
      }
      return reply.code(401).send({ error: "unauthorized" });
    }

    const key = req.headers["x-api-key"];
    // select is load-bearing: nothing beyond id/name should ride on the
    // request, one careless spread away from a response body.
    const user =
      typeof key === "string" && key.length > 0
        ? await db.user.findUnique({
            where: { apiKeyHash: hashApiKey(pepper, key) },
            select: { id: true, name: true, isAdmin: true },
          })
        : null;
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.authedUser = { id: user.id, name: user.name, isAdmin: user.isAdmin };
  };
}

/** Reachable without a session: health probes, the Stripe webhook (its
 * signature is the auth), the Link OAuth callback, and the /auth/* surface
 * (the credential is in the body). Everything else 401s by default. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/webhooks/stripe",
  "/link/callback",
  "/auth/methods",
  "/auth/apple",
  "/auth/google",
  "/auth/email/start",
  "/auth/email/verify",
  "/auth/refresh",
  "/auth/logout",
]);

/** 403 unless the authenticated user is an admin. Guards mutations of the
 * shared policy and everything under /admin/ — authorization on top of
 * the app-wide authentication hook. */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.authedUser?.isAdmin === true) return true;
  void reply.code(403).send({ error: "forbidden" });
  return false;
}

/**
 * The bare Fastify instance, logger configured, no routes. index.ts makes
 * it before anything else so `app.log` exists for every dependency built
 * on the way to buildApp — a logger that forward-references a later
 * `const app` crash-loops the process the first time boot logs through it.
 */
export function createFastify(): FastifyInstance {
  return Fastify({
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
}

/**
 * Build the Fastify app. Without deps only /health exists — enough for the
 * health tests; index.ts always passes deps, and its early-made instance.
 */
export function buildApp(deps?: AppDeps, app: FastifyInstance = createFastify()): FastifyInstance {
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
    registerAuth(app, deps);
    registerParked(app, deps);
    registerCity(app, deps);
    registerZones(app, deps);
    registerPolicy(app, deps);
    registerSession(app, deps);
    registerLocation(app, deps);
    registerMe(app, deps);
    registerDevice(app, deps);
    registerCard(app, deps);
    registerProviders(app, deps);
    registerAdmin(app, deps);
    registerAssistant(app, deps);
    registerLink(app, deps);
    registerWallet(app, deps);
    registerStripeWebhook(app, deps);
  }
  return app;
}
