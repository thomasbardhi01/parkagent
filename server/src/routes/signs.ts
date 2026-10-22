/**
 * The parking-sign reader (Issue N), behind SIGN_READER:
 *
 * - POST /parked/:id/signs: the driver asks what the signs at this park
 *   say. The phone sends the text it recognized on them, its fix (else the
 *   park's own), and one
 *   photo only when that recognition was unsure; the answer is agrees,
 *   stricter (with a shorter max stay offered), conflicts, or unreadable.
 * - POST /parked/:id/signs/:checkId/accept: the driver takes a stricter
 *   check's shorter max stay for this park. It only ever tightens: a
 *   running session's max stay drops to it now (every extension, manual
 *   or automatic, is then held to it by the money gate), and a session
 *   started later for this park starts under it.
 * - GET /admin/sign-checks: the zone-data review queue, the checks whose
 *   driver chose to keep a photo (kept 30 days).
 *
 * Advisory only. Nothing here starts, stops, extends or pays, and no
 * reading changes a price or lengthens a limit.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { requireAdmin } from "../app.js";
import { readSigns } from "../services/capabilities/readSigns.js";
import { PARK_OPEN, PARK_TTL_MS } from "../services/pendingSession.js";
import { principalFor } from "../services/principal.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import { tightenedMaxStay } from "../services/signs/signRules.js";

/** How long the OCR text, and a photo the driver chose to keep, stay. */
export const SIGN_CHECK_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

/** A downscaled photo, base64: well under a megabyte and a half. */
const MAX_PHOTO_BASE64 = 1_500_000;

const bodySchema = z.strictObject({
  text: z.string().max(4000),
  photo: z
    .strictObject({
      mediaType: z.enum(["image/jpeg", "image/png"]),
      data: z
        .string()
        .min(1)
        .max(MAX_PHOTO_BASE64)
        .regex(/^[A-Za-z0-9+/]+=*$/),
    })
    .optional(),
  /** Where the phone is now; absent → where the park was reported. */
  fix: z
    .strictObject({
      lat: z.number().gte(-90).lte(90),
      lng: z.number().gte(-180).lte(180),
      accuracy: z.number().nonnegative().lte(10_000),
    })
    .optional(),
  /** Keep this photo for the zone-data review queue (30 days). */
  storePhoto: z.boolean().optional(),
});

/** The most checks one admin page lists. */
const ADMIN_PAGE_MAX = 20;

export function registerSigns(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();
  // Each check is a model call: a few a minute is all a driver needs.
  const limit = makeRateLimiter({
    max: 6,
    windowMs: 60_000,
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  });

  /** The caller's own park, or null. */
  const ownPark = async (userId: string, id: string) => {
    const park = await deps.db.parkedEvent.findUnique({ where: { id } });
    return park && park.userId === userId ? park : null;
  };

  /** Is this park still the car's, for a check or an accept? A session
   * running for it, or its walk-away hold still open (FR-55), or (a park
   * the server never held) one reported within the park TTL. A park the
   * driver drove away from, declined, or that a newer park replaced is
   * over: reading its signs could only tighten a stay nobody is in. */
  const parkOpen = async (park: { id: string; userId: string; ts: Date }, at: Date) => {
    const running = await deps.db.session.findFirst({
      where: { userId: park.userId, status: "active", parkedEventId: park.id },
    });
    if (running) return true;
    const held = await deps.db.pendingPark.findUnique({ where: { parkedEventId: park.id } });
    if (held) return PARK_OPEN.includes(held.status);
    return at.getTime() - park.ts.getTime() <= PARK_TTL_MS;
  };

  app.post(
    "/parked/:id/signs",
    { preHandler: limit, bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const model = deps.signReaderModel;
      if (!model) return reply.code(503).send({ error: "sign_reader_off" });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
      const body = parsed.data;
      const userId = req.authedUser!.id;
      const { id } = req.params as { id: string };
      const park = await ownPark(userId, id);
      if (!park) {
        return reply.code(404).send({ error: "parked_event_not_found" });
      }
      const at = now();
      if (!(await parkOpen(park, at))) return reply.code(409).send({ error: "park_closed" });
      const principal = req.principal ?? principalFor(userId);
      const outcome = await readSigns(
        {
          db: deps.db,
          model,
          findCandidates: deps.findCandidates,
          ...(deps.assistantDailySpendCapUsd !== undefined
            ? { dailySpendCapUsd: deps.assistantDailySpendCapUsd }
            : {}),
          now,
        },
        principal,
        {
          text: body.text,
          ...(body.photo ? { photo: body.photo } : {}),
          fix: body.fix ?? { lat: park.lat, lng: park.lng, accuracy: park.accuracyM },
          parkedEventId: id,
        },
      );
      if ("refused" in outcome) {
        return reply.code(429).send({ error: outcome.refused, decisionId: outcome.decisionId });
      }
      const keepPhoto = body.photo !== undefined && body.storePhoto === true;
      const check = await deps.db.signCheck.create({
        data: {
          userId,
          parkedEventId: id,
          verdict: outcome.verdict,
          result: {
            rules: outcome.rules,
            confidence: outcome.confidence,
            reasons: outcome.reasons,
            zone: outcome.zone,
            fallback: outcome.fallback,
            dropped: outcome.dropped,
            decisionId: outcome.decisionId,
          },
          // On the request's clock: the review queue pages by createdAt.
          createdAt: at,
          ocrText: body.text,
          textExpiresAt: new Date(at.getTime() + SIGN_CHECK_RETENTION_DAYS * DAY_MS),
          ...(keepPhoto
            ? {
                photo: Buffer.from(body.photo!.data, "base64"),
                photoMediaType: body.photo!.mediaType,
                photoExpiresAt: new Date(at.getTime() + SIGN_CHECK_RETENTION_DAYS * DAY_MS),
              }
            : {}),
          offerMaxStayMinutes: outcome.offerMaxStayMinutes,
        },
      });
      return {
        checkId: check.id,
        verdict: outcome.verdict,
        rules: outcome.rules,
        confidence: outcome.confidence,
        reasons: outcome.reasons,
        offer:
          outcome.offerMaxStayMinutes !== null
            ? { maxStayMinutes: outcome.offerMaxStayMinutes }
            : null,
        zone: outcome.zone
          ? { zoneId: outcome.zone.zoneId, maxStayMinutes: outcome.zone.maxStayMinutes }
          : null,
        photoKept: keepPhoto,
        // Says what this is, for every caller: a reading, not a decision.
        advisory: true,
        decisionId: outcome.decisionId,
      };
    },
  );

  app.post("/parked/:id/signs/:checkId/accept", async (req, reply) => {
    const userId = req.authedUser!.id;
    const { id, checkId } = req.params as { id: string; checkId: string };
    const check = await deps.db.signCheck.findUnique({ where: { id: checkId } });
    if (!check || check.userId !== userId || check.parkedEventId !== id) {
      return reply.code(404).send({ error: "sign_check_not_found" });
    }
    const offer = check.offerMaxStayMinutes;
    if (offer === null) return reply.code(409).send({ error: "nothing_to_accept" });
    const at = now();
    const park = await ownPark(userId, id);
    if (!park || !(await parkOpen(park, at))) {
      return reply.code(409).send({ error: "park_closed" });
    }
    const won = await deps.db.signCheck.updateMany({
      where: { id: checkId, acceptedAt: null },
      data: { acceptedAt: at },
    });
    // A running session for this park: its max stay tightens now, and the
    // money gate holds every extension to it. Never loosened, and never
    // below what the session has already bought.
    const session = await deps.db.session.findFirst({
      where: { userId, status: "active", parkedEventId: id },
    });
    let tightenedSession: string | null = null;
    // What the session is held to, and what it had bought (the floor).
    const held = session
      ? {
          sessionMaxStayMinutes: tightenedMaxStay(
            session.maxStayMinutes ?? null,
            offer,
            session.purchasedMinutes,
          ),
          paidMinutes: session.purchasedMinutes,
        }
      : null;
    if (session && held && held.sessionMaxStayMinutes !== (session.maxStayMinutes ?? null)) {
      await deps.db.session.update({
        where: { id: session.id },
        data: { maxStayMinutes: held.sessionMaxStayMinutes },
      });
      tightenedSession = session.id;
    }
    if (won.count > 0) {
      await deps.db.decision.create({
        data: {
          kind: "sign_check",
          inputs: { checkId, parkedEventId: id },
          rule: "accepted_shorter_stay",
          outcome: { maxStayMinutes: offer, tightenedSession, ...held },
          userId,
          parkedEventId: id,
        },
      });
    }
    return { accepted: true, maxStayMinutes: offer, sessionId: session?.id ?? null };
  });

  /** The zone-data review queue: checks whose driver kept a photo, a
   * page at a time (newest first; `before` is the last page's `next`). A
   * photo is up to ~1 MB, so the list carries none: each is its own GET. */
  const pageSchema = z.strictObject({
    limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(10),
    before: z.iso.datetime({ offset: true }).optional(),
  });
  app.get("/admin/sign-checks", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const page = pageSchema.safeParse(req.query ?? {});
    if (!page.success) return reply.code(400).send({ error: z.treeifyError(page.error) });
    const { limit: take, before } = page.data;
    const rows = await deps.db.signCheck.findMany({
      where: {
        photoExpiresAt: { not: null },
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });
    return {
      checks: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        parkedEventId: r.parkedEventId,
        verdict: r.verdict,
        result: r.result,
        ocrText: r.ocrText,
        photoUrl: r.photo ? `/admin/sign-checks/${r.id}/photo` : null,
        photoExpiresAt: r.photoExpiresAt?.toISOString() ?? null,
      })),
      next: rows.length === take ? rows.at(-1)!.createdAt.toISOString() : null,
    };
  });

  app.get("/admin/sign-checks/:checkId/photo", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { checkId } = req.params as { checkId: string };
    const row = await deps.db.signCheck.findUnique({ where: { id: checkId } });
    if (!row?.photo || !row.photoMediaType) {
      return reply.code(404).send({ error: "photo_not_found" });
    }
    return reply
      .header("content-type", row.photoMediaType)
      .header("cache-control", "no-store")
      .send(Buffer.from(row.photo));
  });
}
