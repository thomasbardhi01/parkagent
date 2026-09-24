/**
 * Sign-up / sign-in surface. All /auth/* paths are PUBLIC (no JWT, no api
 * key — the credential is in the body) and rate-limited per IP; the email
 * code path is additionally throttled per address. Tokens and codes never
 * appear in logs or decisions.
 *
 *   POST /auth/apple         Sign in with Apple identity token
 *   POST /auth/email/start   mail a 6-digit code (Resend)
 *   POST /auth/email/verify  code → session
 *   POST /auth/google        Google ID token (GOOGLE_SIGNIN_ENABLED only)
 *   POST /auth/refresh       rotate the refresh token
 *   POST /auth/logout        revoke the refresh family
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import {
  issueSession,
  findOrCreateByProviderIdentity,
  revokeRefreshFamily,
  rotateRefreshToken,
  startEmailLogin,
  verifyEmailLogin,
} from "../services/authService.js";
import type { AuthDeps, IssuedSession } from "../services/authService.js";
import { makeRateLimiter } from "../services/rateLimit.js";

const deviceIdSchema = z.string().min(8).max(128);

const appleSchema = z.object({
  identityToken: z.string().min(1),
  deviceId: deviceIdSchema,
  // Apple hands the name to the APP exactly once, at first sign-in — it is
  // never in the token, so the client forwards it here.
  fullName: z
    .object({
      givenName: z.string().max(100).optional(),
      familyName: z.string().max(100).optional(),
    })
    .optional(),
});

const googleSchema = z.object({
  idToken: z.string().min(1),
  deviceId: deviceIdSchema,
});

const emailStartSchema = z.object({
  email: z.string().email().max(254),
});

const emailVerifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
  deviceId: deviceIdSchema,
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: deviceIdSchema,
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

function sessionBody(session: IssuedSession, created: boolean) {
  return {
    accessToken: session.accessToken,
    accessExpiresAt: session.accessExpiresAt.toISOString(),
    refreshToken: session.refreshToken,
    user: session.user,
    created,
  };
}

export function registerAuth(app: FastifyInstance, deps: AppDeps): void {
  const auth = deps.auth;
  const now = () => deps.now?.() ?? new Date();

  // Per-IP throttles (these routes run before user auth, so the limiter
  // keys on req.ip). The email path gets the tightest window — it sends
  // mail; verify gets room for typos; token exchanges are cheap.
  const limitEmailStart = makeRateLimiter({ max: 10, windowMs: 15 * 60_000 });
  const limitEmailVerify = makeRateLimiter({ max: 15, windowMs: 15 * 60_000 });
  const limitTokens = makeRateLimiter({ max: 30, windowMs: 60_000 });

  const authDeps = (): AuthDeps | null =>
    auth ? { db: deps.db, jwtSecret: auth.jwtSecret, now, emailSender: auth.emailSender } : null;

  app.post("/auth/apple", { preHandler: limitTokens }, async (req, reply) => {
    const service = authDeps();
    if (!service || !auth) return reply.code(503).send({ error: "auth_not_configured" });
    const parsed = appleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const verified = await auth.verifyAppleToken(parsed.data.identityToken, now());
    if (!verified.ok) {
      return reply.code(401).send({ error: "invalid_identity_token", code: verified.code });
    }
    const fullName = [parsed.data.fullName?.givenName, parsed.data.fullName?.familyName]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" ");
    const { user, created } = await findOrCreateByProviderIdentity(service, {
      provider: "apple",
      sub: verified.token.sub,
      email: verified.token.email,
      emailVerified: verified.token.emailVerified,
      name: fullName || verified.token.name,
    });
    const session = await issueSession(service, user, parsed.data.deviceId);
    return sessionBody(session, created);
  });

  app.post("/auth/google", { preHandler: limitTokens }, async (req, reply) => {
    const service = authDeps();
    if (!service || !auth) return reply.code(503).send({ error: "auth_not_configured" });
    if (!auth.verifyGoogleToken) {
      return reply.code(403).send({ error: "google_signin_disabled" });
    }
    const parsed = googleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const verified = await auth.verifyGoogleToken(parsed.data.idToken, now());
    if (!verified.ok) {
      return reply.code(401).send({ error: "invalid_identity_token", code: verified.code });
    }
    const { user, created } = await findOrCreateByProviderIdentity(service, {
      provider: "google",
      sub: verified.token.sub,
      email: verified.token.email,
      emailVerified: verified.token.emailVerified,
      name: verified.token.name,
    });
    const session = await issueSession(service, user, parsed.data.deviceId);
    return sessionBody(session, created);
  });

  app.post("/auth/email/start", { preHandler: limitEmailStart }, async (req, reply) => {
    const service = authDeps();
    if (!service) return reply.code(503).send({ error: "auth_not_configured" });
    const parsed = emailStartSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const result = await startEmailLogin(service, parsed.data.email);
    if (!result.ok) {
      const status =
        result.code === "email_rate_limited" ? 429 : result.code === "send_failed" ? 502 : 503;
      return reply.code(status).send({ error: result.code });
    }
    return { ok: true };
  });

  app.post("/auth/email/verify", { preHandler: limitEmailVerify }, async (req, reply) => {
    const service = authDeps();
    if (!service) return reply.code(503).send({ error: "auth_not_configured" });
    const parsed = emailVerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const result = await verifyEmailLogin(
      service,
      parsed.data.email,
      parsed.data.code,
      parsed.data.deviceId,
    );
    if (!result.ok) return reply.code(401).send({ error: result.code });
    return sessionBody(result.session, result.created);
  });

  app.post("/auth/refresh", { preHandler: limitTokens }, async (req, reply) => {
    const service = authDeps();
    if (!service) return reply.code(503).send({ error: "auth_not_configured" });
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const result = await rotateRefreshToken(
      service,
      parsed.data.refreshToken,
      parsed.data.deviceId,
    );
    if (!result.ok) return reply.code(401).send({ error: result.code });
    return sessionBody(result.session, false);
  });

  app.post("/auth/logout", { preHandler: limitTokens }, async (req, reply) => {
    const service = authDeps();
    if (!service) return reply.code(503).send({ error: "auth_not_configured" });
    const parsed = logoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    await revokeRefreshFamily(service, parsed.data.refreshToken);
    return { ok: true };
  });
}
