import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { loadEnv } from "./env.js";
import { buildApp, makeAuthenticate } from "./app.js";
import { asAppDb, createPrisma } from "./db.js";
import { makeCardJanitor } from "./jobs/cardJanitor.js";
import { makeLinkJobJanitor } from "./jobs/linkJobJanitor.js";
import { makeExtender } from "./jobs/extendTick.js";
import { makeProviderHealth } from "./jobs/providerHealthTick.js";
import { makeResendSender } from "./services/emailer.js";
import {
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  GOOGLE_ISSUERS,
  GOOGLE_JWKS_URL,
  makeJwksFetcher,
  verifyIdToken,
} from "./services/idToken.js";
import { makeApnsDelivery, makeApnsSender } from "./services/apns.js";
import { makeStateCrypto } from "./services/crypto.js";
import { withDecisionLogging } from "./services/decisionLog.js";
import { DryRunExecutor } from "./services/executor.js";
import {
  closeExecutorBrowser,
  makeProviderOpsFactory,
  makeUserExecutorProvider,
} from "./services/parknycExecutor.js";
import { makePendingSessionCheck } from "./services/pendingSession.js";
import { PolicyService, snapshotPolicy } from "./services/policy.js";
import { makeAnthropicModelClient } from "./services/assistant/anthropicClient.js";
import { resolveAssistantModels } from "./services/assistant/loop.js";
import { AssistantTools } from "./services/assistant/tools.js";
import { makeMultiGarageProvider } from "./services/garage/multiProvider.js";
import { makeParkWhizProvider } from "./services/garage/parkwhiz.js";
import { makeSpotHeroProvider } from "./services/garage/spotheroDeepLink.js";
import { NominatimGeocoder } from "./services/assistant/geocoder.js";
import { makeLinkHttpClient } from "./services/link/linkClient.js";
import { LinkWallet } from "./services/link/linkWallet.js";
import { makeItineraryWorker } from "./jobs/itineraryTick.js";
import { makeStripeGateway } from "./services/stripeGateway.js";
import { makeCandidateFetcher, makeNearbyZoneFetcher } from "./services/zoneLookup.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
// Resolved from this module, so it works from src/ under tsx and from dist/ under node.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const env = loadEnv();

// policy.json lives at the repo root next to .env; an invalid file is a
// refusal to boot, not a warning.
const policy = new PolicyService(
  fileURLToPath(new URL("../../policy.json", import.meta.url)),
  env.DRY_RUN === "true",
);

const prisma = createPrisma(env.DATABASE_URL);
// Every decisions row also emits one structured log line (kind, rule, ids
// — never inputs/outcome), wrapped here once so routes, the extension
// worker, and the janitor can't forget. `app` is bound lazily below.
const db = withDecisionLogging(asAppDb(prisma), {
  info: (payload, msg) => app.log.info(payload, msg),
});
await snapshotPolicy(db, policy.get(), "boot");

// APNs sends only with the full credential set; otherwise pushes log and drop.
const apnsConfig =
  env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID
    ? {
        key: env.APNS_KEY,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        bundleId: env.APNS_BUNDLE_ID,
      }
    : null;

const log = {
  info: (msg: string) => app.log.info(msg),
  warn: (msg: string) => app.log.warn(msg),
};
const sendPush = makeApnsSender(apnsConfig, db, log);
// Same delivery, but reporting per-device APNs status — the admin
// push-test endpoint's transport (money path stays on sendPush).
const apnsDelivery = makeApnsDelivery(apnsConfig, db, log);

// Executor auth is per user now: linked provider accounts, sealed under
// PROVIDER_STATE_KEY (env.ts validated its shape). No key → linking is off
// and real executor calls fail typed; dry run is unaffected.
const stateCrypto = env.PROVIDER_STATE_KEY ? makeStateCrypto(env.PROVIDER_STATE_KEY) : undefined;
const executorOptions = {
  ...(env.PARKNYC_PLATE ? { defaultPlate: env.PARKNYC_PLATE } : {}),
  ...(process.env["EXECUTOR_CAPTURE_DIR"]
    ? { captureDir: process.env["EXECUTOR_CAPTURE_DIR"] }
    : {}),
  // Verification runs: save every real Passport step as fixture screens.
  ...(process.env["EXECUTOR_STEP_CAPTURE_DIR"]
    ? { stepCaptureDir: process.env["EXECUTOR_STEP_CAPTURE_DIR"] }
    : {}),
};
const dryRunExecutor = new DryRunExecutor((msg) => app.log.info(msg));
const executorFor = makeUserExecutorProvider({
  db,
  ...(stateCrypto ? { stateCrypto } : {}),
  dryRunExecutor,
  sendPush,
  ...executorOptions,
  warn: (msg) => app.log.warn(msg),
});
const providerOps = makeProviderOpsFactory(executorOptions);

// env.ts guarantees the webhook secret is present whenever the key is.
const stripe =
  env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? makeStripeGateway(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, {
        financialAccount: env.STRIPE_FINANCIAL_ACCOUNT,
        payoutRecipient: env.STRIPE_PAYOUT_RECIPIENT,
      })
    : undefined;

// Assistant: the model transports (503 without the key), the garage
// providers (SpotHero + ParkWhiz, both read-only public searches, merged
// and address-deduped; PARKWHIZ_ENABLED=false drops the second), and the
// Link wallet.
const garageProviders = [makeSpotHeroProvider()];
if (env.PARKWHIZ_ENABLED === "true") {
  garageProviders.push(makeParkWhizProvider());
}
const garage = makeMultiGarageProvider(garageProviders);
const linkClient =
  env.LINK_CLIENT_ID && env.LINK_CLIENT_SECRET && env.LINK_PUBLISHABLE_KEY && env.LINK_REDIRECT_URI
    ? makeLinkHttpClient({
        clientId: env.LINK_CLIENT_ID,
        clientSecret: env.LINK_CLIENT_SECRET,
        publishableKey: env.LINK_PUBLISHABLE_KEY,
        redirectUri: env.LINK_REDIRECT_URI,
        testMode: env.LINK_TEST_MODE === "true",
      })
    : undefined;
const linkWallet = new LinkWallet({ db, stateCrypto, linkClient });
// Model routing: ASSISTANT_MODEL (→ ANTHROPIC_MODEL → sonnet) runs the
// tool loop; EXPLAIN_MODEL (haiku) phrases explanations.
const models = resolveAssistantModels(env);
const assistantModel = env.ANTHROPIC_API_KEY
  ? makeAnthropicModelClient(env.ANTHROPIC_API_KEY, models.assistant)
  : undefined;
const explainModel = env.ANTHROPIC_API_KEY
  ? makeAnthropicModelClient(env.ANTHROPIC_API_KEY, models.explain)
  : undefined;
const findCandidates = makeCandidateFetcher(prisma);
// The map's curb layer (GET /zones/near) — same prefilter, plus geometry.
const findNearbyZones = makeNearbyZoneFetcher(prisma);
// Named-place geocoding for the assistant, biased to the covered cities
// (Nominatim, the same free geocoder the Boston zone importer uses).
const geocoder = new NominatimGeocoder();
const assistantTools = new AssistantTools({
  db,
  policy,
  findCandidates,
  garage,
  geocoder,
  linkWallet,
  ...(explainModel ? { explainModel } : {}),
});

// Identity: Sign in with Apple always on. Email codes and Google each sit
// behind their own switch (EMAIL_SIGNIN_ENABLED, GOOGLE_SIGNIN_ENABLED),
// off by default; a method that's off has no sender/verifier here, its
// routes answer 403 "<method>_signin_disabled", and GET /auth/methods
// reports it off so the app never shows the button.
const appleKeys = makeJwksFetcher(APPLE_JWKS_URL);
const googleKeys = makeJwksFetcher(GOOGLE_JWKS_URL);
const auth = {
  jwtSecret: env.AUTH_JWT_SECRET,
  emailSender:
    env.EMAIL_SIGNIN_ENABLED === "true" && env.RESEND_API_KEY
      ? makeResendSender(env.RESEND_API_KEY, env.RESEND_FROM)
      : undefined,
  verifyAppleToken: (token: string, now: Date) =>
    verifyIdToken({
      token,
      issuers: [APPLE_ISSUER],
      audience: env.APPLE_AUDIENCE,
      fetchKeys: appleKeys,
      now,
    }),
  verifyGoogleToken:
    env.GOOGLE_SIGNIN_ENABLED === "true" && env.GOOGLE_CLIENT_ID
      ? (token: string, now: Date) =>
          verifyIdToken({
            token,
            issuers: GOOGLE_ISSUERS,
            audience: env.GOOGLE_CLIENT_ID!,
            fetchKeys: googleKeys,
            now,
          })
      : undefined,
};

const app = buildApp({
  db,
  policy,
  findCandidates,
  findNearbyZones,
  auth,
  authenticate: makeAuthenticate(db, env.API_KEY_PEPPER, env.AUTH_JWT_SECRET),
  ...(assistantModel ? { assistantModel } : {}),
  assistantTools,
  assistantDailySpendCapUsd: env.ASSISTANT_DAILY_SPEND_CAP_USD,
  linkWallet,
  executorFor,
  sendPush,
  apnsDelivery,
  ...(stripe ? { stripe } : {}),
  hasPendingSession: makePendingSessionCheck(db),
  ...(stateCrypto ? { stateCrypto } : {}),
  providerOps,
  issuingLive: env.ISSUING_LIVE === "true",
});

const extender = makeExtender({
  db,
  policy,
  executorFor,
  sendPush,
  log,
  // Shadow mode's test authorizations for auto-extends fire through this.
  ...(stripe ? { stripe } : {}),
});
const cardJanitor = makeCardJanitor({ db, stripe, log });
const linkJobJanitor = makeLinkJobJanitor({ db, log });
const itineraryWorker = makeItineraryWorker({ db, sendPush, log });
// Daily headless check of every linked provider session, so a dead or
// dying session is re-linked from the couch, not discovered at the curb.
const providerHealth = makeProviderHealth({ db, sendPush, stateCrypto, providerOps, log });

app.listen({ port: env.PORT, host: "0.0.0.0" });
extender.start();
cardJanitor.start();
linkJobJanitor.start();
itineraryWorker.start();
providerHealth.start();

// Graceful shutdown: stop the jobs and close the executor's warm Chromium
// (otherwise every Fly restart leaks the browser process to container
// teardown). The executor package is loaded lazily, so import it the same
// way — never at boot.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    extender.stop();
    cardJanitor.stop();
    linkJobJanitor.stop();
    itineraryWorker.stop();
    providerHealth.stop();
    void closeExecutorBrowser()
      .catch(() => {})
      .finally(() => {
        void app.close().finally(() => process.exit(0));
      });
  });
}
