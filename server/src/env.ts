import { z } from "zod";

// Required now; the server refuses to boot without them.
// The APNS_* group is optional as a set: with all four present pushes send,
// otherwise the sender is a logging no-op (index.ts checks the group).
// STRIPE_* is optional as a pair: without it /webhooks/stripe 503s.
const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DRY_RUN: z.enum(["true", "false"]),
    // Server-side pepper for api-key hashing (users.api_key_hash =
    // SHA-256(pepper:key)). Any string ≥ 16 chars; generate with
    // `openssl rand -base64 32`. Changing it invalidates every key.
    API_KEY_PEPPER: z.string().min(16),
    SOCRATA_APP_TOKEN: z.string().min(1),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // fa_… the cards draw from; discovered from an existing card when unset.
    STRIPE_FINANCIAL_ACCOUNT: z.string().min(1).optional(),
    // Global Payouts recipient for /card/funding/withdraw; without it
    // withdrawals answer funding_unavailable.
    STRIPE_PAYOUT_RECIPIENT: z.string().min(1).optional(),
    // Contents of the .p8 AuthKey file (literal newlines or "\n" escapes).
    APNS_KEY: z.string().min(1).optional(),
    APNS_KEY_ID: z.string().min(1).optional(),
    APNS_TEAM_ID: z.string().min(1).optional(),
    APNS_BUNDLE_ID: z.string().min(1).optional(),
    // Whether the ParkAgent Issuing card is live as a selectable payment
    // source. Until then onboarding/Settings show it as "coming soon" and
    // PUT /me/payment-source refuses "issuing_card".
    ISSUING_LIVE: z.enum(["true", "false"]).default("false"),
    // Seals linked provider session state (provider_accounts). 32 bytes of
    // base64: `openssl rand -base64 32`. Without it provider linking is
    // off (503) and real executor calls fail typed.
    PROVIDER_STATE_KEY: z.string().min(1).optional(),
    // Plate of the vehicle to park when a session doesn't name one.
    PARKNYC_PLATE: z.string().min(1).optional(),
    // The assistant's model access; without it /assistant/* answers 503.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Which Claude model the assistant loop (and so every Anthropic call,
    // explain_decision phrasing included) runs on.
    ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
    // Link wallet for agents (Stripe agentic commerce) — optional as a
    // set: all four present → /link/* live; any missing → 503.
    LINK_CLIENT_ID: z.string().min(1).optional(),
    LINK_CLIENT_SECRET: z.string().min(1).optional(),
    LINK_PUBLISHABLE_KEY: z.string().min(1).optional(),
    LINK_REDIRECT_URI: z.string().url().optional(),
    // Sandbox rehearsal: spend requests carry test:true, credentials are
    // test cards, nothing charges.
    LINK_TEST_MODE: z.enum(["true", "false"]).optional(),
    PORT: z.coerce.number().int().positive().default(3000),
  })
  .superRefine((env, ctx) => {
    // A Stripe key without the webhook secret means /webhooks/stripe would
    // accept unsigned events — refuse to run half-configured.
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET"],
        message: "required when STRIPE_SECRET_KEY is set (webhook signature verification)",
      });
    }
    const linkKeys = [
      env.LINK_CLIENT_ID,
      env.LINK_CLIENT_SECRET,
      env.LINK_PUBLISHABLE_KEY,
      env.LINK_REDIRECT_URI,
    ];
    const linkSet = linkKeys.filter((k) => k !== undefined).length;
    if (linkSet > 0 && linkSet < linkKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["LINK_CLIENT_ID"],
        message:
          "LINK_CLIENT_ID, LINK_CLIENT_SECRET, LINK_PUBLISHABLE_KEY, and LINK_REDIRECT_URI are a set — set all four or none",
      });
    }
    // A malformed key must refuse boot, not fail the first link.
    if (env.PROVIDER_STATE_KEY && Buffer.from(env.PROVIDER_STATE_KEY, "base64").length !== 32) {
      ctx.addIssue({
        code: "custom",
        path: ["PROVIDER_STATE_KEY"],
        message: "must be 32 bytes of base64 (openssl rand -base64 32)",
      });
    }
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
