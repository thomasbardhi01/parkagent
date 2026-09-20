import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { loadEnv } from "./env.js";
import { buildApp, makeAuthenticate } from "./app.js";
import { asAppDb, createPrisma } from "./db.js";
import { PolicyService, snapshotPolicy } from "./services/policy.js";
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

const app = buildApp({
  db,
  policy,
  findCandidates: makeCandidateFetcher(prisma),
  authenticate: makeAuthenticate(db),
});
app.listen({ port: env.PORT, host: "0.0.0.0" });
