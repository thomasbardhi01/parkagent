/**
 * Identity + session core: who a sign-in belongs to (find-or-create with
 * verified-email merging), email one-time codes, and the rotating
 * refresh-token families the app's session rides on. Routes stay thin;
 * tests drive this through the routes with fake verifiers/senders.
 *
 * Merging rule: an account is keyed by provider subject first (apple_sub /
 * google_sub), then by VERIFIED email — so Apple, Google, and email
 * sign-ins with the same verified address all land on one user. Unverified
 * emails never merge (they'd let anyone claim an address they don't own).
 */

import { randomUUID, createHash, randomInt } from "node:crypto";

import type { AppDb, UserIdentityRow } from "../db.js";
import {
  REFRESH_TOKEN_TTL_MS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "./authTokens.js";
import type { EmailSender } from "./emailer.js";

export interface AuthDeps {
  db: AppDb;
  jwtSecret: string;
  now: () => Date;
  emailSender?: EmailSender | undefined;
}

export interface IssuedSession {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  appleLinked: boolean;
  googleLinked: boolean;
}

export function publicUser(row: UserIdentityRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    emailVerified: row.emailVerified ?? false,
    phone: row.phone ?? null,
    phoneVerified: row.phoneVerified ?? false,
    appleLinked: row.appleSub != null,
    googleLinked: row.googleSub != null,
  };
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Sessions: access JWT + rotating refresh family.

export async function issueSession(
  deps: AuthDeps,
  user: UserIdentityRow,
  deviceId: string,
): Promise<IssuedSession> {
  const now = deps.now();
  const refreshToken = generateRefreshToken();
  await deps.db.refreshToken.create({
    data: {
      userId: user.id,
      familyId: randomUUID(),
      tokenHash: hashRefreshToken(deps.jwtSecret, refreshToken),
      deviceId,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  });
  const access = signAccessToken(deps.jwtSecret, user, now);
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    user: publicUser(user),
  };
}

export type RefreshResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; code: "invalid_token" | "token_reused" | "token_expired" | "device_mismatch" };

/**
 * Rotate: the presented token is retired, a sibling with the same family id
 * takes over, and the 60-day clock restarts. A token that was ALREADY
 * rotated is replay (theft or a very stale client) — the whole family is
 * revoked and everyone holding a descendant must sign in again.
 */
export async function rotateRefreshToken(
  deps: AuthDeps,
  token: string,
  deviceId: string,
): Promise<RefreshResult> {
  const now = deps.now();
  const row = await deps.db.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(deps.jwtSecret, token) },
  });
  if (!row || row.revokedAt) return { ok: false, code: "invalid_token" };
  if (row.rotatedAt) {
    await deps.db.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { ok: false, code: "token_reused" };
  }
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, code: "token_expired" };
  if (row.deviceId !== deviceId) return { ok: false, code: "device_mismatch" };

  const user = await deps.db.user.findUnique({ where: { id: row.userId } });
  if (!user || user.deletedAt) return { ok: false, code: "invalid_token" };

  // Claim the rotation atomically. Two requests racing with the same token
  // both pass the rotatedAt check above; without a conditional write both
  // would mint a successor and the family would fork, which is exactly the
  // replay reuse detection exists to catch. The loser is reuse.
  const claimed = await deps.db.refreshToken.updateMany({
    where: { id: row.id, rotatedAt: null, revokedAt: null },
    data: { rotatedAt: now },
  });
  if (claimed.count !== 1) {
    await deps.db.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { ok: false, code: "token_reused" };
  }

  const next = generateRefreshToken();
  await deps.db.refreshToken.create({
    data: {
      userId: row.userId,
      familyId: row.familyId,
      tokenHash: hashRefreshToken(deps.jwtSecret, next),
      deviceId,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  });
  const access = signAccessToken(deps.jwtSecret, user, now);
  return {
    ok: true,
    session: {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: next,
      user: publicUser(user),
    },
  };
}

/** Logout: kill the presented token's whole family. Unknown tokens are a
 * no-op — logout must never fail. */
export async function revokeRefreshFamily(deps: AuthDeps, token: string): Promise<void> {
  const row = await deps.db.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(deps.jwtSecret, token) },
  });
  if (!row) return;
  await deps.db.refreshToken.updateMany({
    where: { familyId: row.familyId, revokedAt: null },
    data: { revokedAt: deps.now() },
  });
}

// ---------------------------------------------------------------------------
// Email one-time codes.

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Codes per address per window — a mailbox is not a bell to ring. */
export const EMAIL_START_MAX_PER_WINDOW = 5;
export const EMAIL_START_WINDOW_MS = 15 * 60 * 1000;
/** And per day: with 5 attempts a code, this bounds guessing at any one
 * address to 50 a day however many IPs the guesser has — against a
 * 6-digit code that is ~0.005% a day, where the 15-minute cap alone
 * allowed 2,400 guesses (~0.24% a day). */
export const EMAIL_START_MAX_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const hashCode = (secret: string, email: string, code: string): string =>
  createHash("sha256").update(`${secret}:${email}:${code}`).digest("hex");

export type EmailStartResult =
  { ok: true } | { ok: false; code: "email_rate_limited" | "email_not_configured" | "send_failed" };

export async function startEmailLogin(deps: AuthDeps, rawEmail: string): Promise<EmailStartResult> {
  if (!deps.emailSender) return { ok: false, code: "email_not_configured" };
  const email = normalizeEmail(rawEmail);
  const now = deps.now();
  const recent = await deps.db.emailLoginCode.count({
    where: { email, createdAt: { gte: new Date(now.getTime() - EMAIL_START_WINDOW_MS) } },
  });
  if (recent >= EMAIL_START_MAX_PER_WINDOW) return { ok: false, code: "email_rate_limited" };
  const today = await deps.db.emailLoginCode.count({
    where: { email, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  if (today >= EMAIL_START_MAX_PER_DAY) return { ok: false, code: "email_rate_limited" };

  // 6 digits, leading zeros allowed, from the CSPRNG — the code is a
  // credential, so Math.random is not acceptable.
  const code = randomInt6();
  await deps.db.emailLoginCode.create({
    data: {
      email,
      codeHash: hashCode(deps.jwtSecret, email, code),
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      // The app's clock, not the database's: the throttle windows above
      // are measured with it.
      createdAt: now,
    },
  });
  const sent = await deps.emailSender.sendLoginCode(email, code);
  if (!sent.ok) return { ok: false, code: "send_failed" };
  return { ok: true };
}

const randomInt6 = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

export type EmailVerifyResult =
  | { ok: true; session: IssuedSession; created: boolean }
  | { ok: false; code: "invalid_code" | "code_expired" | "too_many_attempts" };

export async function verifyEmailLogin(
  deps: AuthDeps,
  rawEmail: string,
  code: string,
  deviceId: string,
): Promise<EmailVerifyResult> {
  const email = normalizeEmail(rawEmail);
  const now = deps.now();
  const row = await deps.db.emailLoginCode.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { ok: false, code: "invalid_code" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, code: "code_expired" };
  // Claim an attempt BEFORE comparing, as one conditional write. Reading
  // `attempts` and writing it back +1 let concurrent guesses all read the
  // same count, so a burst got far more than five tries at the code.
  const attemptsBefore = row.attempts;
  const claimed = await deps.db.emailLoginCode.updateMany({
    where: { id: row.id, consumedAt: null, attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return { ok: false, code: "too_many_attempts" };
  if (row.codeHash !== hashCode(deps.jwtSecret, email, code)) {
    return {
      ok: false,
      code: attemptsBefore + 1 >= EMAIL_CODE_MAX_ATTEMPTS ? "too_many_attempts" : "invalid_code",
    };
  }
  // Consume conditionally too: two right answers racing get one session.
  const consumed = await deps.db.emailLoginCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) return { ok: false, code: "invalid_code" };

  const found = await findOrCreateByEmail(deps, email);
  const session = await issueSession(deps, found.user, deviceId);
  return { ok: true, session, created: found.created };
}

// ---------------------------------------------------------------------------
// Identity resolution.

async function findOrCreateByEmail(
  deps: AuthDeps,
  email: string,
): Promise<{ user: UserIdentityRow; created: boolean }> {
  const existing = await deps.db.user.findUnique({ where: { email } });
  if (existing && !existing.deletedAt && existing.emailVerified) {
    return { user: existing, created: false };
  }
  // An account holding this address UNVERIFIED is not the mailbox owner's
  // account — handing it over would give the owner someone else's cars and
  // provider links, and leave that someone able to sign in to what the
  // owner then adds. Free the address and make the prover their own.
  await releaseUnverifiedEmail(deps, existing);
  const user = await deps.db.user.create({
    data: { name: nameFromEmail(email), email, emailVerified: true },
  });
  await recordIdentityDecision(deps, user.id, "user_created", { via: "email" });
  return { user, created: true };
}

const nameFromEmail = (email: string): string => email.split("@")[0] ?? "Driver";

export interface ProviderIdentity {
  /** "apple" | "google" */
  provider: "apple" | "google";
  sub: string;
  email?: string | undefined;
  emailVerified: boolean;
  /** Name supplied by the client on first Apple sign-in (Apple sends the
   * full name exactly once, to the app, not in the token). */
  name?: string | undefined;
}

/**
 * Resolve a verified Apple/Google identity to a user: by subject, else by
 * verified-email merge (the subject is attached to that account), else a
 * new account.
 */
export async function findOrCreateByProviderIdentity(
  deps: AuthDeps,
  identity: ProviderIdentity,
): Promise<{ user: UserIdentityRow; created: boolean }> {
  const subField = identity.provider === "apple" ? "appleSub" : "googleSub";
  const bySub = await deps.db.user.findUnique(
    identity.provider === "apple"
      ? { where: { appleSub: identity.sub } }
      : { where: { googleSub: identity.sub } },
  );
  if (bySub && !bySub.deletedAt) return { user: bySub, created: false };

  // Only a VERIFIED address is kept at all. Google, and Apple for some
  // managed accounts, can hand over an email the IdP never verified; stored
  // in the unique email column, it would squat the real owner's address —
  // their email sign-in would land in this account, or their verified
  // Apple sign-in would collide on the unique index and fail forever.
  const email = identity.email && identity.emailVerified ? normalizeEmail(identity.email) : null;
  if (email) {
    const byEmail = await deps.db.user.findUnique({ where: { email } });
    if (byEmail && !byEmail.deletedAt && byEmail.emailVerified) {
      // Attach the subject only where the account has none: a DIFFERENT
      // subject already there stays, rather than being silently replaced
      // (and ping-ponged on each identity's next sign-in). The verified
      // address alone is what lets this identity in, as with email codes.
      const updated = byEmail[subField]
        ? byEmail
        : await deps.db.user.update({
            where: { id: byEmail.id },
            data: { [subField]: identity.sub },
          });
      await recordIdentityDecision(deps, byEmail.id, "identity_merged", {
        provider: identity.provider,
        subjectAttached: !byEmail[subField],
      });
      return { user: updated, created: false };
    }
    await releaseUnverifiedEmail(deps, byEmail);
  }

  const user = await deps.db.user.create({
    data: {
      name: identity.name ?? (email ? nameFromEmail(email) : "Driver"),
      ...(email ? { email, emailVerified: true } : {}),
      [subField]: identity.sub,
    },
  });
  await recordIdentityDecision(deps, user.id, "user_created", { via: identity.provider });
  return { user, created: true };
}

/** A live account holding an address it never verified gives it up, so
 * the verified owner can have it. None should exist (nothing stores an
 * unverified address any more); this is the backstop. */
async function releaseUnverifiedEmail(
  deps: AuthDeps,
  holder: UserIdentityRow | null,
): Promise<void> {
  if (!holder || holder.deletedAt || holder.emailVerified) return;
  await deps.db.user.update({ where: { id: holder.id }, data: { email: null } });
  await recordIdentityDecision(deps, holder.id, "unverified_email_released", {});
}

/** Identity changes are consequential enough to audit — but the inputs
 * never carry tokens or codes, only which path ran. */
async function recordIdentityDecision(
  deps: AuthDeps,
  userId: string,
  rule: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  await deps.db.decision.create({
    data: { kind: "auth_identity", inputs, rule, outcome: { ok: true }, userId },
  });
}
