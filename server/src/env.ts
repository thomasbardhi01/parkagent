/**
 * The server's settings, read once at boot.
 *
 * Only the core can refuse boot: DATABASE_URL, AUTH_JWT_SECRET,
 * API_KEY_PEPPER, and a PROVIDER_STATE_KEY that is set but malformed. The
 * server can't do its job safely without them. Everything else belongs to
 * an optional feature (FEATURES below), and a feature can only switch
 * itself off:
 *
 *   - none of its settings present → off;
 *   - some present, or one in the wrong format → off and DEGRADED. One log
 *     line names the variable, and /health lists the feature under
 *     `degraded`.
 *
 * On 2026-09-26 a misnamed Maps secret (APPLE_MAPS_PRIVATE_KEY instead of
 * APPLE_MAPS_KEY) made the old "set all three or none" rule refuse boot,
 * and prod was down for four hours (docs/incidents.md). A misconfigured
 * optional feature can no longer take prod down.
 *
 * Contents are checked, not just presence: an Apple .p8 must parse as a
 * P-256 private key, ids and vendor keys must look like what they claim to
 * be, and a key that is also configured under another name is flagged by
 * name. A variable with one of our prefixes that the server doesn't read
 * is flagged with the name it probably meant.
 *
 * `pnpm -C server check-secrets NAME=value …` runs this same evaluation on
 * proposed values before they're set (src/scripts/check-secrets.ts).
 */

import { createPrivateKey, createPublicKey } from "node:crypto";

type Flag = "true" | "false";

export interface Env {
  // Core: the server refuses to boot without these.
  DATABASE_URL: string;
  // Signs the 15-minute access JWTs and peppers refresh-token hashes.
  // Any string ≥ 32 chars: `openssl rand -base64 32`. Rotating it signs
  // everyone out (access tokens fail verify; refresh hashes stop matching).
  AUTH_JWT_SECRET: string;
  // Pepper for api-key hashing (users.api_key_hash = SHA-256(pepper:key)).
  // Any string ≥ 16 chars. Changing it invalidates every key.
  API_KEY_PEPPER: string;
  // Seals linked provider session state (provider_accounts), the Sign in
  // with Apple refresh token, and Link cards. 32 bytes of base64
  // (`openssl rand -base64 32`). Unset → provider linking is off (503) and
  // real executor calls fail typed; set but malformed → refuse to boot,
  // because a wrong key can't open anything already sealed.
  PROVIDER_STATE_KEY: string | undefined;

  // "true" unless explicitly "false". A missing or unreadable value runs in
  // dry run: the safe reading of a setting that gates money.
  DRY_RUN: Flag;
  // NYC open-data token for the data scripts; the server doesn't need it.
  SOCRATA_APP_TOKEN: string | undefined;

  // Stripe, as a pair: without the webhook secret, /webhooks/stripe would
  // accept unsigned events, so a key alone keeps Stripe off.
  STRIPE_SECRET_KEY: string | undefined;
  STRIPE_WEBHOOK_SECRET: string | undefined;
  // fa_… the cards draw from; discovered from an existing card when unset.
  STRIPE_FINANCIAL_ACCOUNT: string | undefined;
  // Global Payouts recipient for /card/funding/withdraw; without it
  // withdrawals answer funding_unavailable.
  STRIPE_PAYOUT_RECIPIENT: string | undefined;
  // Whether the ParkAgent card is live as a selectable payment source.
  // Until then the Wallet shows it as "Coming soon — pending approval" and
  // PUT /wallet/source refuses "parkagent_card" (a Debug build may still
  // choose it in sandbox while STRIPE_SECRET_KEY is a test-mode key).
  ISSUING_LIVE: Flag;

  // APNs, as a set of four: the .p8 contents (literal newlines or "\n"
  // escapes), its key id, the team id, and the app's bundle id. Otherwise
  // pushes log and drop.
  APNS_KEY: string | undefined;
  APNS_KEY_ID: string | undefined;
  APNS_TEAM_ID: string | undefined;
  APNS_BUNDLE_ID: string | undefined;

  // How many provider browser calls run at once (pay, extend, stop, link,
  // card read, health check). Each is a Chromium context; 2 fits the 1 GB
  // machine with room for the server. More wait in a queue.
  EXECUTOR_CONCURRENCY: number;
  // Start Chromium at boot (when PROVIDER_STATE_KEY is set), so the first
  // link or payment after a deploy doesn't also pay for launching it.
  EXECUTOR_WARM_AT_BOOT: Flag;
  // Plate of the vehicle to park when a session doesn't name one.
  PARKNYC_PLATE: string | undefined;

  // Sign in with Apple audience: the app's bundle id.
  APPLE_AUDIENCE: string;
  // A Sign in with Apple key (developer.apple.com → Keys, "Sign in with
  // Apple" enabled): signs the client secret for Apple's token and revoke
  // endpoints, so DELETE /me can revoke the user's Apple tokens (App Store
  // 5.1.1(v)). A set of three; without it sign-in works and no token is
  // stored or revoked (services/appleTokens.ts).
  APPLE_SIGNIN_KEY: string | undefined;
  APPLE_SIGNIN_KEY_ID: string | undefined;
  APPLE_SIGNIN_TEAM_ID: string | undefined;
  // The assistant's place search (Apple Maps Server API): a Maps key, its
  // key id, and the team id. A set of three; without them the assistant
  // searches places with Nominatim alone, which knows few businesses by
  // name. One Apple key may carry several services (APNs and Maps, say).
  APPLE_MAPS_KEY: string | undefined;
  APPLE_MAPS_KEY_ID: string | undefined;
  APPLE_MAPS_TEAM_ID: string | undefined;

  // Sign in with Apple is the only method on by default. Email codes are
  // off until this is "true" (and then need RESEND_API_KEY); while off,
  // /auth/email/* answers 403 email_signin_disabled and GET /auth/methods
  // tells the app not to show the button.
  EMAIL_SIGNIN_ENABLED: Flag;
  // Resend (resend.com) sends the email sign-in codes.
  RESEND_API_KEY: string | undefined;
  // The From header on sign-in mail; the domain must be verified in Resend
  // (and registered with Apple's private email relay so codes reach
  // @privaterelay.appleid.com addresses).
  RESEND_FROM: string;
  // Google Sign-In is off by default (App Store rule: offering Google
  // requires offering Sign in with Apple too, and we lead with Apple).
  GOOGLE_SIGNIN_ENABLED: Flag;
  // OAuth client id the Google ID tokens must be issued to.
  GOOGLE_CLIENT_ID: string | undefined;

  // The assistant's model access; without it /assistant/* answers 503.
  ANTHROPIC_API_KEY: string | undefined;
  // Model routing (loop.ts resolveAssistantModels): ASSISTANT_MODEL runs
  // the tool loop (falls back to the legacy ANTHROPIC_MODEL, then
  // claude-sonnet-5); EXPLAIN_MODEL phrases explain_decision output.
  ASSISTANT_MODEL: string | undefined;
  ANTHROPIC_MODEL: string | undefined;
  EXPLAIN_MODEL: string;
  // Per-user daily cap on ESTIMATED model spend (USD). Defaults ON: a spend
  // control that a missing env var switches off is no control. A user over
  // the cap gets 429.
  ASSISTANT_DAILY_SPEND_CAP_USD: number;
  // How long a saved assistant conversation is kept after it was last used.
  ASSISTANT_CONVERSATION_RETENTION_DAYS: number;
  // ParkWhiz is a read-only public search (no credentials); "false" drops
  // back to SpotHero only.
  PARKWHIZ_ENABLED: Flag;

  // Link wallet for agents (Stripe agentic commerce), as a set of four:
  // all present → /link/* live; otherwise 503.
  LINK_CLIENT_ID: string | undefined;
  LINK_CLIENT_SECRET: string | undefined;
  LINK_PUBLISHABLE_KEY: string | undefined;
  LINK_REDIRECT_URI: string | undefined;
  // Sandbox rehearsal: spend requests carry test:true, credentials are
  // test cards, nothing charges.
  LINK_TEST_MODE: Flag | undefined;

  PORT: number;
}

/** Every variable the server reads through Env. */
export const ENV_NAMES = [
  "DATABASE_URL",
  "AUTH_JWT_SECRET",
  "API_KEY_PEPPER",
  "PROVIDER_STATE_KEY",
  "DRY_RUN",
  "SOCRATA_APP_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_FINANCIAL_ACCOUNT",
  "STRIPE_PAYOUT_RECIPIENT",
  "ISSUING_LIVE",
  "APNS_KEY",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_BUNDLE_ID",
  "EXECUTOR_CONCURRENCY",
  "EXECUTOR_WARM_AT_BOOT",
  "PARKNYC_PLATE",
  "APPLE_AUDIENCE",
  "APPLE_SIGNIN_KEY",
  "APPLE_SIGNIN_KEY_ID",
  "APPLE_SIGNIN_TEAM_ID",
  "APPLE_MAPS_KEY",
  "APPLE_MAPS_KEY_ID",
  "APPLE_MAPS_TEAM_ID",
  "EMAIL_SIGNIN_ENABLED",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "GOOGLE_SIGNIN_ENABLED",
  "GOOGLE_CLIENT_ID",
  "ANTHROPIC_API_KEY",
  "ASSISTANT_MODEL",
  "ANTHROPIC_MODEL",
  "EXPLAIN_MODEL",
  "ASSISTANT_DAILY_SPEND_CAP_USD",
  "ASSISTANT_CONVERSATION_RETENTION_DAYS",
  "PARKWHIZ_ENABLED",
  "LINK_CLIENT_ID",
  "LINK_CLIENT_SECRET",
  "LINK_PUBLISHABLE_KEY",
  "LINK_REDIRECT_URI",
  "LINK_TEST_MODE",
  "PORT",
] as const satisfies readonly (keyof Env)[];

/** Everything the server reads: Env, plus two debug knobs index.ts reads
 * directly. Anything else with a watched prefix is flagged. */
export const KNOWN_NAMES: readonly string[] = [
  ...ENV_NAMES,
  "EXECUTOR_CAPTURE_DIR",
  "EXECUTOR_STEP_CAPTURE_DIR",
];

/** A variable with one of these prefixes that nothing reads is a typo
 * until proven otherwise. */
export const WATCHED_PREFIXES = [
  "APPLE_",
  "APNS_",
  "STRIPE_",
  "RESEND_",
  "GOOGLE_",
  "LINK_",
  "ANTHROPIC_",
  "ASSISTANT_",
  "EXECUTOR_",
  "ISSUING_",
  "PARKWHIZ_",
  "EMAIL_",
  "PROVIDER_",
  "AUTH_",
];

/** The optional features, and what each needs. Feature ids are what
 * /health's `degraded` lists. */
export const FEATURES = {
  live_payments: { vars: ["DRY_RUN"], what: "real payments (DRY_RUN=false)" },
  provider_accounts: { vars: ["PROVIDER_STATE_KEY"], what: "linking parking accounts" },
  push: {
    vars: ["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID"],
    what: "push notifications",
  },
  stripe: {
    vars: [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_FINANCIAL_ACCOUNT",
      "STRIPE_PAYOUT_RECIPIENT",
    ],
    what: "Stripe (card holds, the Issuing webhook)",
  },
  issuing: { vars: ["ISSUING_LIVE"], what: "the ParkAgent card as a live payment source" },
  link_wallet: {
    vars: [
      "LINK_CLIENT_ID",
      "LINK_CLIENT_SECRET",
      "LINK_PUBLISHABLE_KEY",
      "LINK_REDIRECT_URI",
      "LINK_TEST_MODE",
    ],
    what: "Stripe Link for garages",
  },
  apple_signin_revoke: {
    vars: ["APPLE_SIGNIN_KEY", "APPLE_SIGNIN_KEY_ID", "APPLE_SIGNIN_TEAM_ID"],
    what: "revoking Apple tokens on account deletion",
  },
  apple_maps: {
    vars: ["APPLE_MAPS_KEY", "APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID"],
    what: "Apple Maps place search",
  },
  email_signin: {
    vars: ["EMAIL_SIGNIN_ENABLED", "RESEND_API_KEY", "RESEND_FROM"],
    what: "email sign-in codes",
  },
  google_signin: { vars: ["GOOGLE_SIGNIN_ENABLED", "GOOGLE_CLIENT_ID"], what: "Google sign-in" },
  parkwhiz: { vars: ["PARKWHIZ_ENABLED"], what: "ParkWhiz garage search" },
  assistant: { vars: ["ANTHROPIC_API_KEY"], what: "the assistant" },
} as const satisfies Record<string, { vars: readonly (keyof Env)[]; what: string }>;

export type FeatureId = keyof typeof FEATURES;

export interface FeatureStatus {
  id: FeatureId;
  state: "on" | "off" | "degraded";
  /** Why it's off or degraded; for degraded, names the variable. */
  detail: string;
}

export interface EnvReport {
  /** The resolved settings: anything a degraded feature needs is removed,
   * so wiring that tests `env.X && env.Y` can't switch it back on. */
  env: Env;
  /** Core problems. Non-empty → loadEnv refuses to boot. */
  fatal: string[];
  features: FeatureStatus[];
  /** Feature ids that are off because of a settings mistake. */
  degraded: FeatureId[];
  /** One line each: fallbacks to a default, unknown names, duplicate keys. */
  warnings: string[];
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface CheckOptions {
  /** Names that are set but whose values aren't available (check-secrets'
   * view of what's already on the Fly app): present, content unchecked. */
  unchecked?: ReadonlySet<string>;
}

// ---------------------------------------------------------------- checks

const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function appleIdProblem(value: string): string | null {
  return APPLE_ID.test(value)
    ? null
    : "isn't a 10-character Apple id (capital letters and digits, from developer.apple.com)";
}

function bundleIdProblem(value: string): string | null {
  return BUNDLE_ID.test(value) ? null : "isn't a bundle id (like com.example.app)";
}

function prefixProblem(prefixes: readonly RegExp[], expected: string) {
  return (value: string): string | null =>
    prefixes.some((p) => p.test(value)) ? null : `doesn't look like ${expected}`;
}

const stripeSecretProblem = prefixProblem(
  [/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/],
  "a Stripe secret key (sk_live_…, sk_test_…, rk_…)",
);
const stripeWebhookProblem = prefixProblem([/^whsec_\S+$/], "a webhook signing secret (whsec_…)");
const financialAccountProblem = prefixProblem([/^fa_\S+$/], "a financial account id (fa_…)");
const resendKeyProblem = prefixProblem([/^re_\S+$/], "a Resend API key (re_…)");
const anthropicKeyProblem = prefixProblem([/^sk-ant-\S+$/], "an Anthropic API key (sk-ant-…)");
const googleClientProblem = prefixProblem(
  [/^\S+\.apps\.googleusercontent\.com$/],
  "a Google OAuth client id (….apps.googleusercontent.com)",
);
const publishableKeyProblem = prefixProblem(
  [/^pk_(live|test)_\S+$/],
  "a publishable key (pk_live_…, pk_test_…)",
);
const modelProblem = prefixProblem([/^claude-[a-z0-9.-]+$/], "a Claude model id (claude-…)");

function httpsUrlProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return null;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return null;
    return "must be an https URL";
  } catch {
    return "isn't a URL";
  }
}

function emailFromProblem(value: string): string | null {
  return /^([^<>]+<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(value)
    ? null
    : 'isn\'t a From address ("Name <sign-in@example.com>" or an address)';
}

/** A .p8's contents, checked: PEM, a private key, EC on P-256 (what ES256
 * signs with). `spki` identifies the key whatever its line endings. */
export function inspectP8(
  value: string,
): { ok: true; spki: string } | { ok: false; problem: string } {
  const pem = value.replace(/\\n/g, "\n").trim();
  if (!pem.includes("-----BEGIN")) {
    return {
      ok: false,
      problem:
        "isn't a PEM key (a .p8 file's contents start with -----BEGIN PRIVATE KEY-----); " +
        "set the file's contents, not its name or path",
    };
  }
  let key;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : "";
    return {
      ok: false,
      problem: `doesn't parse as a private key${why ? ` (${why})` : ""}; is it the whole .p8?`,
    };
  }
  if (key.asymmetricKeyType !== "ec") {
    return {
      ok: false,
      problem: `is not an EC key (it's ${(key.asymmetricKeyType ?? "unknown").toUpperCase()}); Apple keys are EC P-256`,
    };
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== "prime256v1") {
    return { ok: false, problem: `is an EC key on ${curve ?? "an unknown curve"}, not P-256` };
  }
  const spki = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  return { ok: true, spki };
}

/** Byte length of a base64 value, the way PROVIDER_STATE_KEY is decoded. */
function base64Bytes(value: string): number {
  return Buffer.from(value, "base64").length;
}

// ---------------------------------------------------------------- names

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The known name an unknown one most likely meant, or undefined. A near
 * spelling wins (APPLE_MAPS_KEYID → APPLE_MAPS_KEY_ID); otherwise the most
 * shared words (APPLE_MAPS_PRIVATE_KEY → APPLE_MAPS_KEY). */
export function suggestName(
  name: string,
  known: readonly string[] = KNOWN_NAMES,
): string | undefined {
  let nearest: string | undefined;
  let nearestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(name, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  if (nearest && nearestDistance <= 2) return nearest;

  const words = name.split("_").filter(Boolean);
  const same = (a: string, b: string) =>
    a === b || (a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1);
  let best: string | undefined;
  let bestScore = 0;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const theirs = candidate.split("_");
    const shared = words.filter((w) => theirs.some((t) => same(w, t))).length;
    const score = shared / (words.length + theirs.length - shared);
    const distance = editDistance(name, candidate);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = candidate;
      bestScore = score;
      bestDistance = distance;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

/** Secrets that must each be their own value. */
const SECRET_NAMES = [
  "DATABASE_URL",
  "AUTH_JWT_SECRET",
  "API_KEY_PEPPER",
  "PROVIDER_STATE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "ANTHROPIC_API_KEY",
  "LINK_CLIENT_SECRET",
] as const;

/** Apple .p8 slots, with the key id that belongs to each and what the key
 * must have enabled at developer.apple.com → Keys. */
const P8_SLOTS = [
  { key: "APNS_KEY", keyId: "APNS_KEY_ID", service: "Apple Push Notifications" },
  { key: "APPLE_SIGNIN_KEY", keyId: "APPLE_SIGNIN_KEY_ID", service: "Sign in with Apple" },
  { key: "APPLE_MAPS_KEY", keyId: "APPLE_MAPS_KEY_ID", service: "Maps" },
] as const;

// ---------------------------------------------------------------- evaluation

const ALL: Record<number, string> = { 2: "both", 3: "all three", 4: "all four" };

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Evaluate a set of variables: what's fatal, which features are on, off,
 * or degraded, and what deserves a warning. Pure: never exits or logs.
 */
export function checkEnv(source: EnvSource, options: CheckOptions = {}): EnvReport {
  const unchecked = options.unchecked ?? new Set<string>();
  const fatal: string[] = [];
  const warnings: string[] = [];
  const features: FeatureStatus[] = [];

  /** The value as given; whitespace-only counts as unset. */
  const raw = (name: string): string | undefined => {
    const value = source[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  /** Trimmed, for ids, flags, URLs, and numbers. */
  const text = (name: string) => raw(name)?.trim();
  const has = (name: string) => raw(name) !== undefined;
  /** Run a check unless the value is unavailable (check-secrets). */
  const problemOf = (name: string, check: (value: string) => string | null) =>
    unchecked.has(name) || !has(name) ? null : check(text(name)!);

  // Unknown names with our prefixes, and what they probably meant: the
  // group checks below mention them next to the variable that's missing.
  const known = new Set<string>(KNOWN_NAMES);
  const meant = new Map<string, string>();
  for (const name of Object.keys(source).sort()) {
    if (known.has(name) || !WATCHED_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (source[name] === undefined) continue;
    const suggestion = suggestName(name);
    if (suggestion) meant.set(suggestion, name);
    warnings.push(
      `${name} is set, but the server doesn't read it` +
        (suggestion ? ` — did you mean ${suggestion}?` : ""),
    );
  }
  const hint = (missing: readonly string[]) => {
    const typos = missing.filter((n) => meant.has(n)).map((n) => `${meant.get(n)} is set`);
    return typos.length ? ` (${typos.join("; ")} — a misspelling?)` : "";
  };

  const set = (id: FeatureId, state: FeatureStatus["state"], detail: string) => {
    features.push({ id, state, detail });
    return state === "on";
  };
  /** Turn a feature that passed its own checks off after all. */
  const demote = (id: FeatureId, detail: string): false => {
    const index = features.findIndex((f) => f.id === id);
    features[index] = { id, state: "degraded", detail };
    return false;
  };
  const p8Problem = (value: string): string | null => {
    const inspected = inspectP8(value);
    return inspected.ok ? null : inspected.problem;
  };

  /** A group that is all-or-nothing, each member with its own check. */
  const group = (
    id: FeatureId,
    members: readonly { name: string; check: (value: string) => string | null }[],
  ): boolean => {
    const names = members.map((m) => m.name);
    const present = names.filter(has);
    if (present.length === 0) return set(id, "off", `not configured (${listNames(names)})`);
    const missing = names.filter((n) => !has(n));
    if (missing.length > 0) {
      return set(
        id,
        "degraded",
        `${listNames(missing)} ${missing.length === 1 ? "is" : "are"} not set, but ` +
          `${listNames(present)} ${present.length === 1 ? "is" : "are"}; ` +
          `set ${ALL[names.length] ?? `all ${names.length}`} or none${hint(missing)}`,
      );
    }
    for (const { name, check } of members) {
      const problem = problemOf(name, check);
      if (problem) return set(id, "degraded", `${name} ${problem}`);
    }
    return set(id, "on", "");
  };

  /** "true" or "false"; anything else is reported and reads as `fallback`. */
  const flag = (name: string, fallback: Flag): { value: Flag; problem: string | null } => {
    if (!has(name) || unchecked.has(name)) {
      return { value: unchecked.has(name) ? "true" : fallback, problem: null };
    }
    const value = text(name)!;
    if (value === "true" || value === "false") return { value, problem: null };
    return { value: fallback, problem: `is "${value}"; expected true or false` };
  };

  /** A tuning value: a bad one falls back to its default with a warning. */
  const number = (
    name: string,
    fallback: number,
    valid: (n: number) => boolean,
    expected: string,
  ): number => {
    if (!has(name) || unchecked.has(name)) return fallback;
    const value = Number(text(name));
    if (valid(value)) return value;
    warnings.push(`${name} is "${text(name)}"; expected ${expected}. Using ${fallback}`);
    return fallback;
  };

  const optionalText = (name: string, check: (value: string) => string | null) => {
    const problem = problemOf(name, check);
    if (problem) {
      warnings.push(`${name} ${problem}; ignoring it`);
      return undefined;
    }
    return text(name);
  };

  // -------- core
  const core = (name: string, problem: string | null) => {
    if (problem) fatal.push(`${name}: ${problem}`);
  };
  core(
    "DATABASE_URL",
    !has("DATABASE_URL")
      ? "required (the Postgres connection string)"
      : problemOf("DATABASE_URL", (v) =>
          /^postgres(ql)?:\/\//.test(v) ? null : "must be a postgres:// or postgresql:// URL",
        ),
  );
  core(
    "AUTH_JWT_SECRET",
    !has("AUTH_JWT_SECRET")
      ? "required (openssl rand -base64 32)"
      : problemOf("AUTH_JWT_SECRET", () =>
          raw("AUTH_JWT_SECRET")!.length >= 32 ? null : "must be at least 32 characters",
        ),
  );
  core(
    "API_KEY_PEPPER",
    !has("API_KEY_PEPPER")
      ? "required (openssl rand -base64 32)"
      : problemOf("API_KEY_PEPPER", () =>
          raw("API_KEY_PEPPER")!.length >= 16 ? null : "must be at least 16 characters",
        ),
  );
  const stateKeyProblem = problemOf("PROVIDER_STATE_KEY", (v) =>
    base64Bytes(v) === 32 ? null : "must be 32 bytes of base64 (openssl rand -base64 32)",
  );
  core("PROVIDER_STATE_KEY", stateKeyProblem);
  const stateKeyOn = has("PROVIDER_STATE_KEY") && !stateKeyProblem;
  set(
    "provider_accounts",
    stateKeyOn ? "on" : "off",
    stateKeyOn ? "" : "PROVIDER_STATE_KEY is not set: provider linking answers 503",
  );

  // -------- dry run: unreadable means dry run
  const dryRun = flag("DRY_RUN", "true");
  if (!has("DRY_RUN")) {
    set("live_payments", "degraded", "DRY_RUN is not set; running in dry run");
  } else if (dryRun.problem) {
    set("live_payments", "degraded", `DRY_RUN ${dryRun.problem}; running in dry run`);
  } else {
    set("live_payments", dryRun.value === "false" ? "on" : "off", "DRY_RUN is true");
  }

  // -------- APNs
  const pushOn = group("push", [
    { name: "APNS_KEY", check: p8Problem },
    { name: "APNS_KEY_ID", check: appleIdProblem },
    { name: "APNS_TEAM_ID", check: appleIdProblem },
    { name: "APNS_BUNDLE_ID", check: bundleIdProblem },
  ]);

  // -------- Stripe, then Issuing on top of it
  const stripeOn = group("stripe", [
    { name: "STRIPE_SECRET_KEY", check: stripeSecretProblem },
    { name: "STRIPE_WEBHOOK_SECRET", check: stripeWebhookProblem },
  ]);
  const financialAccount = stripeOn
    ? optionalText("STRIPE_FINANCIAL_ACCOUNT", financialAccountProblem)
    : undefined;
  const payoutRecipient = stripeOn ? text("STRIPE_PAYOUT_RECIPIENT") : undefined;

  const issuing = flag("ISSUING_LIVE", "false");
  let issuingOn = false;
  if (issuing.problem) {
    set("issuing", "degraded", `ISSUING_LIVE ${issuing.problem}`);
  } else if (issuing.value === "true" && !stripeOn) {
    set(
      "issuing",
      "degraded",
      "ISSUING_LIVE is true, but Stripe is off (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)",
    );
  } else {
    issuingOn = issuing.value === "true";
    set("issuing", issuingOn ? "on" : "off", "ISSUING_LIVE is false");
  }

  // -------- Link: a set of four, sealed with the state key
  const linkTest = flag("LINK_TEST_MODE", "false");
  let linkOn = group("link_wallet", [
    { name: "LINK_CLIENT_ID", check: () => null },
    { name: "LINK_CLIENT_SECRET", check: () => null },
    { name: "LINK_PUBLISHABLE_KEY", check: publishableKeyProblem },
    { name: "LINK_REDIRECT_URI", check: httpsUrlProblem },
  ]);
  if (linkOn && linkTest.problem) {
    linkOn = demote("link_wallet", `LINK_TEST_MODE ${linkTest.problem}`);
  } else if (linkOn && !stateKeyOn) {
    linkOn = demote("link_wallet", "needs PROVIDER_STATE_KEY (Link cards are stored sealed)");
  } else if (linkTest.problem) {
    warnings.push(`LINK_TEST_MODE ${linkTest.problem}`);
  }

  // -------- Sign in with Apple revocation: a set of three, plus the state key
  let revokeOn = group("apple_signin_revoke", [
    { name: "APPLE_SIGNIN_KEY", check: p8Problem },
    { name: "APPLE_SIGNIN_KEY_ID", check: appleIdProblem },
    { name: "APPLE_SIGNIN_TEAM_ID", check: appleIdProblem },
  ]);
  if (revokeOn && !stateKeyOn) {
    revokeOn = demote(
      "apple_signin_revoke",
      "needs PROVIDER_STATE_KEY (the Apple refresh token is stored sealed)",
    );
  }
  let audience = text("APPLE_AUDIENCE") ?? DEFAULT_APPLE_AUDIENCE;
  const audienceProblem = problemOf("APPLE_AUDIENCE", bundleIdProblem);
  if (audienceProblem) {
    warnings.push(`APPLE_AUDIENCE ${audienceProblem}; using ${DEFAULT_APPLE_AUDIENCE}`);
    audience = DEFAULT_APPLE_AUDIENCE;
  }

  // -------- Apple Maps: a set of three
  const mapsOn = group("apple_maps", [
    { name: "APPLE_MAPS_KEY", check: p8Problem },
    { name: "APPLE_MAPS_KEY_ID", check: appleIdProblem },
    { name: "APPLE_MAPS_TEAM_ID", check: appleIdProblem },
  ]);

  // -------- email and Google sign-in: a switch, then what it needs
  const email = flag("EMAIL_SIGNIN_ENABLED", "false");
  const resendKeyBad = problemOf("RESEND_API_KEY", resendKeyProblem);
  const resendFromBad = problemOf("RESEND_FROM", emailFromProblem);
  let emailOn = false;
  if (email.problem) {
    set("email_signin", "degraded", `EMAIL_SIGNIN_ENABLED ${email.problem}`);
  } else if (email.value === "false") {
    set("email_signin", "off", "EMAIL_SIGNIN_ENABLED is false");
    if (resendKeyBad) warnings.push(`RESEND_API_KEY ${resendKeyBad}`);
  } else if (!has("RESEND_API_KEY")) {
    set(
      "email_signin",
      "degraded",
      `EMAIL_SIGNIN_ENABLED is true, but RESEND_API_KEY is not set${hint(["RESEND_API_KEY"])}`,
    );
  } else if (resendKeyBad) {
    set("email_signin", "degraded", `RESEND_API_KEY ${resendKeyBad}`);
  } else if (resendFromBad) {
    set("email_signin", "degraded", `RESEND_FROM ${resendFromBad}`);
  } else {
    emailOn = set("email_signin", "on", "");
  }

  const google = flag("GOOGLE_SIGNIN_ENABLED", "false");
  const googleIdBad = problemOf("GOOGLE_CLIENT_ID", googleClientProblem);
  let googleOn = false;
  if (google.problem) {
    set("google_signin", "degraded", `GOOGLE_SIGNIN_ENABLED ${google.problem}`);
  } else if (google.value === "false") {
    set("google_signin", "off", "GOOGLE_SIGNIN_ENABLED is false");
  } else if (!has("GOOGLE_CLIENT_ID")) {
    set(
      "google_signin",
      "degraded",
      `GOOGLE_SIGNIN_ENABLED is true, but GOOGLE_CLIENT_ID is not set${hint(["GOOGLE_CLIENT_ID"])}`,
    );
  } else if (googleIdBad) {
    set("google_signin", "degraded", `GOOGLE_CLIENT_ID ${googleIdBad}`);
  } else {
    googleOn = set("google_signin", "on", "");
  }

  // -------- ParkWhiz and the assistant
  const parkwhiz = flag("PARKWHIZ_ENABLED", "true");
  const parkwhizOn = parkwhiz.problem
    ? set("parkwhiz", "degraded", `PARKWHIZ_ENABLED ${parkwhiz.problem}`)
    : set("parkwhiz", parkwhiz.value === "true" ? "on" : "off", "PARKWHIZ_ENABLED is false");

  const anthropicBad = problemOf("ANTHROPIC_API_KEY", anthropicKeyProblem);
  const assistantOn = !has("ANTHROPIC_API_KEY")
    ? set("assistant", "off", "ANTHROPIC_API_KEY is not set: /assistant/* answers 503")
    : anthropicBad
      ? set("assistant", "degraded", `ANTHROPIC_API_KEY ${anthropicBad}`)
      : set("assistant", "on", "");

  // -------- the same key or secret under two names
  const p8s = P8_SLOTS.filter((s) => has(s.key) && !unchecked.has(s.key)).flatMap((slot) => {
    const inspected = inspectP8(raw(slot.key)!);
    return inspected.ok ? [{ ...slot, spki: inspected.spki }] : [];
  });
  for (let i = 0; i < p8s.length; i++) {
    for (let j = i + 1; j < p8s.length; j++) {
      const [a, b] = [p8s[i]!, p8s[j]!];
      if (a.spki !== b.spki) continue;
      const [idA, idB] = [text(a.keyId), text(b.keyId)];
      warnings.push(
        `${b.key} is the same key as ${a.key}. One Apple key can carry several services, ` +
          `so this works only if that key has ${b.service} enabled as well as ${a.service}` +
          (idA && idB && idA !== idB
            ? `; but ${b.keyId} (${idB}) differs from ${a.keyId} (${idA}), ` +
              `and one key has one id: one of the two ids is wrong`
            : ""),
      );
    }
  }
  const secrets = SECRET_NAMES.filter((n) => has(n) && !unchecked.has(n));
  for (let i = 0; i < secrets.length; i++) {
    for (let j = i + 1; j < secrets.length; j++) {
      const [a, b] = [secrets[i]!, secrets[j]!];
      if (raw(a) === raw(b)) {
        warnings.push(`${b} has the same value as ${a}; each should be its own secret`);
      }
    }
  }

  const port = number(
    "PORT",
    3000,
    (n) => Number.isInteger(n) && n > 0 && n < 65536,
    "a port number",
  );
  const executorConcurrency = number(
    "EXECUTOR_CONCURRENCY",
    2,
    (n) => Number.isInteger(n) && n >= 1 && n <= 8,
    "a whole number from 1 to 8",
  );
  const warm = flag("EXECUTOR_WARM_AT_BOOT", "true");
  if (warm.problem) warnings.push(`EXECUTOR_WARM_AT_BOOT ${warm.problem}; using true`);
  const spendCap = number(
    "ASSISTANT_DAILY_SPEND_CAP_USD",
    5,
    (n) => Number.isFinite(n) && n > 0,
    "a positive number of dollars",
  );
  const retentionDays = number(
    "ASSISTANT_CONVERSATION_RETENTION_DAYS",
    90,
    (n) => Number.isInteger(n) && n > 0,
    "a positive whole number of days",
  );
  const assistantModel = optionalText("ASSISTANT_MODEL", modelProblem);
  const anthropicModel = optionalText("ANTHROPIC_MODEL", modelProblem);
  const explainModel = optionalText("EXPLAIN_MODEL", modelProblem) ?? DEFAULT_EXPLAIN_MODEL;

  const env: Env = {
    DATABASE_URL: raw("DATABASE_URL") ?? "",
    AUTH_JWT_SECRET: raw("AUTH_JWT_SECRET") ?? "",
    API_KEY_PEPPER: raw("API_KEY_PEPPER") ?? "",
    PROVIDER_STATE_KEY: stateKeyOn ? raw("PROVIDER_STATE_KEY") : undefined,
    DRY_RUN: dryRun.value,
    SOCRATA_APP_TOKEN: text("SOCRATA_APP_TOKEN"),
    STRIPE_SECRET_KEY: stripeOn ? text("STRIPE_SECRET_KEY") : undefined,
    STRIPE_WEBHOOK_SECRET: stripeOn ? text("STRIPE_WEBHOOK_SECRET") : undefined,
    STRIPE_FINANCIAL_ACCOUNT: financialAccount,
    STRIPE_PAYOUT_RECIPIENT: payoutRecipient,
    ISSUING_LIVE: issuingOn ? "true" : "false",
    APNS_KEY: pushOn ? raw("APNS_KEY") : undefined,
    APNS_KEY_ID: pushOn ? text("APNS_KEY_ID") : undefined,
    APNS_TEAM_ID: pushOn ? text("APNS_TEAM_ID") : undefined,
    APNS_BUNDLE_ID: pushOn ? text("APNS_BUNDLE_ID") : undefined,
    EXECUTOR_CONCURRENCY: executorConcurrency,
    EXECUTOR_WARM_AT_BOOT: warm.value,
    PARKNYC_PLATE: text("PARKNYC_PLATE"),
    APPLE_AUDIENCE: audience,
    APPLE_SIGNIN_KEY: revokeOn ? raw("APPLE_SIGNIN_KEY") : undefined,
    APPLE_SIGNIN_KEY_ID: revokeOn ? text("APPLE_SIGNIN_KEY_ID") : undefined,
    APPLE_SIGNIN_TEAM_ID: revokeOn ? text("APPLE_SIGNIN_TEAM_ID") : undefined,
    APPLE_MAPS_KEY: mapsOn ? raw("APPLE_MAPS_KEY") : undefined,
    APPLE_MAPS_KEY_ID: mapsOn ? text("APPLE_MAPS_KEY_ID") : undefined,
    APPLE_MAPS_TEAM_ID: mapsOn ? text("APPLE_MAPS_TEAM_ID") : undefined,
    EMAIL_SIGNIN_ENABLED: emailOn ? "true" : "false",
    RESEND_API_KEY: emailOn ? text("RESEND_API_KEY") : undefined,
    RESEND_FROM: (emailOn ? text("RESEND_FROM") : undefined) ?? DEFAULT_RESEND_FROM,
    GOOGLE_SIGNIN_ENABLED: googleOn ? "true" : "false",
    GOOGLE_CLIENT_ID: googleOn ? text("GOOGLE_CLIENT_ID") : undefined,
    ANTHROPIC_API_KEY: assistantOn ? text("ANTHROPIC_API_KEY") : undefined,
    ASSISTANT_MODEL: assistantModel,
    ANTHROPIC_MODEL: anthropicModel,
    EXPLAIN_MODEL: explainModel,
    ASSISTANT_DAILY_SPEND_CAP_USD: spendCap,
    ASSISTANT_CONVERSATION_RETENTION_DAYS: retentionDays,
    PARKWHIZ_ENABLED: parkwhizOn ? "true" : "false",
    LINK_CLIENT_ID: linkOn ? text("LINK_CLIENT_ID") : undefined,
    LINK_CLIENT_SECRET: linkOn ? text("LINK_CLIENT_SECRET") : undefined,
    LINK_PUBLISHABLE_KEY: linkOn ? text("LINK_PUBLISHABLE_KEY") : undefined,
    LINK_REDIRECT_URI: linkOn ? text("LINK_REDIRECT_URI") : undefined,
    LINK_TEST_MODE: linkOn && has("LINK_TEST_MODE") ? linkTest.value : undefined,
    PORT: port,
  };

  const degraded = features.filter((f) => f.state === "degraded").map((f) => f.id);
  return { env, fatal, features, degraded, warnings };
}

export const DEFAULT_APPLE_AUDIENCE = "com.thomasbardhi.parkagent";
const DEFAULT_RESEND_FROM = "ParkAgent <sign-in@parkagent.app>";
const DEFAULT_EXPLAIN_MODEL = "claude-haiku-4-5-20251001";

/** The boot log for a report: one line per degraded feature and warning,
 * then which features are on. */
export function bootLog(report: EnvReport): { warn: string[]; info: string } {
  const warn = [
    ...report.features
      .filter((f) => f.state === "degraded")
      .map((f) => `config: ${f.id} is off — ${f.detail}`),
    ...report.warnings.map((w) => `config: ${w}`),
  ];
  const on = report.features.filter((f) => f.state === "on").map((f) => f.id);
  const off = report.features.filter((f) => f.state !== "on").map((f) => f.id);
  return { warn, info: `config: on: ${on.join(", ") || "-"}; off: ${off.join(", ") || "-"}` };
}

/**
 * Read process.env once at boot, after dotenv has run. Exits only on a
 * core problem, with a readable list; everything else comes back in the
 * report for index.ts to log through the app's logger.
 */
export function loadEnv(source: EnvSource = process.env): EnvReport {
  const report = checkEnv(source);
  if (report.fatal.length > 0) {
    console.error(
      [
        "Refusing to start: invalid core settings.",
        ...report.fatal.map((line) => `  - ${line}`),
        "",
        "Only DATABASE_URL, AUTH_JWT_SECRET, API_KEY_PEPPER, and a malformed",
        "PROVIDER_STATE_KEY stop the server; every other setting switches its",
        "feature off instead. Local dev reads the repo-root .env (copy",
        ".env.example). On Fly, check a value with `pnpm -C server check-secrets",
        "NAME=value` before `fly secrets set -a parkagent-api NAME=value`.",
      ].join("\n"),
    );
    process.exit(1);
  }
  return report;
}
