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
    // Whether the ParkAgent card is live as a selectable payment source.
    // Until then the Wallet shows it as "Coming soon — pending approval" and
    // PUT /wallet/source refuses "parkagent_card" (a Debug build may still
    // choose it in sandbox while STRIPE_SECRET_KEY is a test-mode key).
    ISSUING_LIVE: z.enum(["true", "false"]).default("false"),
    // Seals linked provider session state (provider_accounts). 32 bytes of
    // base64: `openssl rand -base64 32`. Without it provider linking is
    // off (503) and real executor calls fail typed.
    PROVIDER_STATE_KEY: z.string().min(1).optional(),
    // How many provider browser calls run at once (pay, extend, stop,
    // link, card read, health check). Each is a Chromium context; 2 fits
    // the 1 GB machine with room for the server. More wait in a queue.
    EXECUTOR_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    // Start Chromium at boot (when PROVIDER_STATE_KEY is set), so the first
    // link or payment after a deploy doesn't also pay for launching it.
    EXECUTOR_WARM_AT_BOOT: z.enum(["true", "false"]).default("true"),
    // Signs the 15-minute access JWTs and peppers refresh-token hashes.
    // Any string ≥ 32 chars: `openssl rand -base64 32`. Rotating it signs
    // everyone out (access tokens fail verify; refresh hashes stop
    // matching) — they sign in again.
    AUTH_JWT_SECRET: z.string().min(32),
    // Sign in with Apple audience — the app's bundle id.
    APPLE_AUDIENCE: z.string().min(1).default("com.thomasbardhi.parkagent"),
    // A Sign in with Apple key (developer.apple.com → Keys, "Sign in with
    // Apple" enabled): signs the client secret for Apple's token and revoke
    // endpoints, so DELETE /me can revoke the user's Apple tokens (App Store
    // 5.1.1(v)). Optional as a set of three; without it sign-in works and
    // no token is stored or revoked (services/appleTokens.ts).
    APPLE_SIGNIN_KEY: z.string().min(1).optional(),
    APPLE_SIGNIN_KEY_ID: z.string().min(1).optional(),
    APPLE_SIGNIN_TEAM_ID: z.string().min(1).optional(),
    // The assistant's place search (Apple Maps Server API): a Maps key
    // (.p8 contents, literal newlines or "\n" escapes), its key id, and the
    // team id. A set of three; without them the assistant searches places
    // with Nominatim alone, which knows few businesses by name.
    APPLE_MAPS_KEY: z.string().min(1).optional(),
    APPLE_MAPS_KEY_ID: z.string().min(1).optional(),
    APPLE_MAPS_TEAM_ID: z.string().min(1).optional(),
    // Sign in with Apple is the only method on by default. Email codes are
    // off until this is "true" (and then need RESEND_API_KEY); while off,
    // /auth/email/* answers 403 email_signin_disabled and GET /auth/methods
    // tells the app not to show the button.
    EMAIL_SIGNIN_ENABLED: z.enum(["true", "false"]).default("false"),
    // Resend (resend.com) sends the email sign-in codes; required when
    // EMAIL_SIGNIN_ENABLED=true, ignored otherwise.
    RESEND_API_KEY: z.string().min(1).optional(),
    // The From header on sign-in mail; the domain must be verified in
    // Resend (and registered with Apple's private email relay so codes
    // reach @privaterelay.appleid.com addresses).
    RESEND_FROM: z.string().min(1).default("ParkAgent <sign-in@parkagent.app>"),
    // Google Sign-In is off by default (App Store rule: offering Google
    // requires offering Sign in with Apple too — we lead with Apple).
    GOOGLE_SIGNIN_ENABLED: z.enum(["true", "false"]).default("false"),
    // OAuth client id the Google ID tokens must be issued to; required
    // when GOOGLE_SIGNIN_ENABLED=true.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    // Plate of the vehicle to park when a session doesn't name one.
    PARKNYC_PLATE: z.string().min(1).optional(),
    // The assistant's model access; without it /assistant/* answers 503.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Model routing (resolved in loop.ts resolveAssistantModels):
    // ASSISTANT_MODEL runs the tool loop (falls back to the legacy
    // ANTHROPIC_MODEL, then claude-sonnet-5); EXPLAIN_MODEL phrases
    // explain_decision output (cheap — haiku by default).
    ASSISTANT_MODEL: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).optional(),
    EXPLAIN_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
    // Per-user daily cap on ESTIMATED model spend (USD) for the assistant.
    // Defaults ON: a spend control that a missing env var switches off is
    // no control. Each turn's cost estimate is logged on its
    // assistant_turn decision row; a user over the cap gets 429.
    ASSISTANT_DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(5),
    // How long a saved assistant conversation is kept after it was last
    // used; the retention job deletes older ones (plans, bookings, and the
    // decisions ledger keep their own rows).
    ASSISTANT_CONVERSATION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    // ParkWhiz is a read-only public search (no credentials — verified
    // live 2026-09-23); flip to "false" to drop back to SpotHero only.
    PARKWHIZ_ENABLED: z.enum(["true", "false"]).default("true"),
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
    const appleKeys = [env.APPLE_SIGNIN_KEY, env.APPLE_SIGNIN_KEY_ID, env.APPLE_SIGNIN_TEAM_ID];
    const appleSet = appleKeys.filter((k) => k !== undefined).length;
    if (appleSet > 0 && appleSet < appleKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["APPLE_SIGNIN_KEY"],
        message:
          "APPLE_SIGNIN_KEY, APPLE_SIGNIN_KEY_ID, and APPLE_SIGNIN_TEAM_ID are a set — set all three or none",
      });
    }
    const mapsKeys = [env.APPLE_MAPS_KEY, env.APPLE_MAPS_KEY_ID, env.APPLE_MAPS_TEAM_ID];
    const mapsSet = mapsKeys.filter((k) => k !== undefined).length;
    if (mapsSet > 0 && mapsSet < mapsKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["APPLE_MAPS_KEY"],
        message:
          "APPLE_MAPS_KEY, APPLE_MAPS_KEY_ID, and APPLE_MAPS_TEAM_ID are a set — set all three or none",
      });
    }
    // Email sign-in switched on with no way to send the code would answer
    // every start with a failure — refuse to run half-configured.
    if (env.EMAIL_SIGNIN_ENABLED === "true" && !env.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "required when EMAIL_SIGNIN_ENABLED=true (it sends the codes)",
      });
    }
    // Google Sign-In without a client id would accept tokens minted for
    // anyone's app — refuse to run half-configured.
    if (env.GOOGLE_SIGNIN_ENABLED === "true" && !env.GOOGLE_CLIENT_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_ID"],
        message: "required when GOOGLE_SIGNIN_ENABLED=true (ID token audience)",
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

/** The validation alone, without loadEnv's exit — for tests. */
export function parseEnv(source: NodeJS.ProcessEnv) {
  return schema.safeParse(source);
}

/**
 * Parse and validate process.env. Call once at boot, after dotenv has run.
 * Exits the process with a readable list of missing/invalid keys rather
 * than letting the server come up half-configured.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = parseEnv(source);
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
