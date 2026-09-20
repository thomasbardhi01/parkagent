import { z } from "zod";

// Required now; the server refuses to boot without them.
// STRIPE_* stays optional until Phase 6 wires it up. The APNS_* group is
// optional as a set: with all four present pushes send, otherwise the
// sender is a logging no-op (index.ts checks the group).
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DRY_RUN: z.enum(["true", "false"]),
  SOCRATA_APP_TOKEN: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Contents of the .p8 AuthKey file (literal newlines or "\n" escapes).
  APNS_KEY: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof schema>;

/**
 * Parse and validate process.env. Call once at boot, after dotenv has run.
 * Exits the process with a readable list of missing/invalid keys rather
 * than letting the server come up half-configured.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    console.error(
      [
        "Refusing to start: invalid environment.",
        ...lines,
        "",
        "Local dev reads the repo-root .env (copy .env.example and fill it in;",
        "see docs/parkagent-phase-0-1-setup.md 1.3). On Fly, set the missing",
        "keys with `fly secrets set -a parkagent-api KEY=value`.",
      ].join("\n"),
    );
    process.exit(1);
  }
  return parsed.data;
}
