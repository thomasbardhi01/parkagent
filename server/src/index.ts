import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { loadEnv } from "./env.js";
import { buildApp, makeAuthenticate } from "./app.js";
import { asAppDb, createPrisma } from "./db.js";
import { makeExtender } from "./jobs/extendTick.js";
import { makeApnsSender } from "./services/apns.js";
import { DryRunExecutor } from "./services/executor.js";
import { ParkNycExecutorStub } from "./services/parknycExecutor.js";
import { makePendingSessionCheck } from "./services/pendingSession.js";
import { PolicyService, snapshotPolicy } from "./services/policy.js";
import { makeStripeGateway } from "./services/stripeGateway.js";
import { makeCandidateFetcher } from "./services/zoneLookup.js";

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
const db = asAppDb(prisma);
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
const dryRunExecutor = new DryRunExecutor((msg) => app.log.info(msg));
const realExecutor = new ParkNycExecutorStub();
const executorFor = (dryRun: boolean) => (dryRun ? dryRunExecutor : realExecutor);

// env.ts guarantees the webhook secret is present whenever the key is.
const stripe =
  env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? makeStripeGateway(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
    : undefined;

const app = buildApp({
  db,
  policy,
  findCandidates: makeCandidateFetcher(prisma),
  authenticate: makeAuthenticate(db),
  executorFor,
  sendPush,
  ...(stripe ? { stripe } : {}),
  hasPendingSession: makePendingSessionCheck(db),
});

const extender = makeExtender({ db, policy, executorFor, sendPush, log });

app.listen({ port: env.PORT, host: "0.0.0.0" });
extender.start();
