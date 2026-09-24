/**
 * The conversational assistant surface.
 *
 * POST /assistant/message   one turn of the tool-use loop (SSE when the
 *                           client sends Accept: text/event-stream)
 * POST /assistant/confirm   the user's tap on a plan card: mints the
 *                           single-use confirmation token and executes
 *                           the confirmed option THROUGH the token-gated
 *                           tools — the same enforcement the model faces
 * GET  /assistant/itineraries          today's / recent signed-off days
 * PATCH /assistant/itineraries/:id     edit or reorder stops (cap re-checked)
 *
 * Every tool call and every confirmation writes a decisions row.
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { assistantSpendTodayUsd, runAssistantTurn } from "../services/assistant/loop.js";
import type { AssistantResult } from "../services/assistant/loop.js";
import { CONFIRMATION_TTL_MS } from "../services/assistant/tools.js";
import { itineraryStopSchema, itineraryTotalUsd } from "../services/assistant/plans.js";
import type { ItineraryPlan, SingleSpotPlan } from "../services/assistant/plans.js";
import { garageHandoffNote, garageProviderInfo } from "../services/garage/garageProvider.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import { spentToday } from "../services/sessions.js";

const messageSchema = z
  .object({
    text: z.string().min(1).max(2000).optional(),
    transcript: z.string().min(1).max(2000).optional(),
    conversation_id: z.string().max(64).optional(),
    location: z
      .object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) })
      .optional(),
  })
  .refine((b) => b.text !== undefined || b.transcript !== undefined, {
    message: "text or transcript is required",
  });

const confirmSchema = z.object({
  planId: z.string().min(1),
  /** Single-spot plans confirm one option; itineraries sign off whole. */
  optionId: z.string().optional(),
});

const patchItinerarySchema = z.object({
  stops: z.array(itineraryStopSchema).min(1).max(12),
});

/**
 * Who a Link spend request says the user is paying: the garage's own site
 * for a garage (the one its offer came from — a merged search means it
 * isn't always SpotHero), the city's meter app for a street spot. The
 * approval screen shows this to the user, so it must name the real payee.
 */
function merchantFor(stop: {
  type: "street" | "garage";
  zoneId?: string | undefined;
  provider?: string | undefined;
  deepLink?: string | undefined;
}): { merchantName: string; merchantUrl: string } {
  if (stop.type === "garage") {
    const garage = garageProviderInfo(stop.provider, stop.deepLink);
    return {
      merchantName: garage?.name ?? "Garage parking",
      merchantUrl: stop.deepLink ?? garage?.url ?? "https://www.parkagent.app",
    };
  }
  const meters = stop.zoneId ? providerForCity(cityForZone(stop.zoneId)) : null;
  return {
    merchantName: meters?.displayName ?? "City parking meters",
    merchantUrl: meters ? new URL(meters.loginUrl).origin : "https://www.parkagent.app",
  };
}

function sseWrite(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerAssistant(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();
  // Each turn is a paid model call; a runaway client shouldn't buy 500.
  const limitMessages = makeRateLimiter({ max: 20, windowMs: 60_000 });
  const limitOther = makeRateLimiter({ max: 60, windowMs: 60_000 });

  app.post("/assistant/message", { preHandler: limitMessages }, async (req, reply) => {
    if (!deps.assistantModel || !deps.assistantTools) {
      return reply.code(503).send({ error: "assistant_not_configured" });
    }
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const body = parsed.data;
    const user = req.authedUser!;
    const conversationId = body.conversation_id ?? `conv_${randomUUID()}`;
    const text = (body.text ?? body.transcript)!;

    // Someone else's conversation id: the turn would be saved over their
    // transcript (the upsert keys on id alone), and that transcript is
    // what the next turn's grounding is read from. Refuse before any
    // paid call.
    if (body.conversation_id !== undefined) {
      const existing = await deps.db.conversation.findUnique({ where: { id: conversationId } });
      if (existing && existing.userId !== user.id) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
    }

    // Per-user daily model-spend cap (estimated from logged token usage).
    // Checked before the paid call, refused with the numbers on record.
    if (deps.assistantDailySpendCapUsd !== undefined) {
      const spentUsd = await assistantSpendTodayUsd(deps.db, user.id, now());
      if (spentUsd >= deps.assistantDailySpendCapUsd) {
        await deps.db.decision.create({
          data: {
            kind: "assistant_turn",
            inputs: { conversationId },
            rule: "daily_spend_cap",
            outcome: {
              refused: true,
              spentUsd: Math.round(spentUsd * 10_000) / 10_000,
              capUsd: deps.assistantDailySpendCapUsd,
              estimatedCostUsd: 0,
            },
            userId: user.id,
          },
        });
        return reply.code(429).send({
          error: "assistant_budget_exhausted",
          spentUsd: Math.round(spentUsd * 100) / 100,
          capUsd: deps.assistantDailySpendCapUsd,
        });
      }
    }

    const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
    let result: AssistantResult;
    if (wantsStream) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      try {
        result = await runAssistantTurn({
          db: deps.db,
          model: deps.assistantModel,
          tools: deps.assistantTools,
          userId: user.id,
          conversationId,
          text,
          location: body.location,
          onText: (delta) => sseWrite(reply, "text", { delta }),
          // The plan gets its own event the moment propose_plan lands, so
          // the card renders before the reply text settles.
          onPlan: (plan) => sseWrite(reply, "plan", plan),
          now: deps.now,
        });
        sseWrite(reply, "done", {
          conversationId: result.conversationId,
          reply: result.reply,
          plan: result.plan,
        });
      } catch (err) {
        req.log.error(
          { assistantError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
          "assistant turn failed",
        );
        sseWrite(reply, "error", { error: "assistant_failed" });
      }
      reply.raw.end();
      return reply;
    }

    result = await runAssistantTurn({
      db: deps.db,
      model: deps.assistantModel,
      tools: deps.assistantTools,
      userId: user.id,
      conversationId,
      text,
      location: body.location,
      now: deps.now,
    });
    return {
      conversationId: result.conversationId,
      reply: result.reply,
      plan: result.plan,
    };
  });

  app.post("/assistant/confirm", { preHandler: limitOther }, async (req, reply) => {
    if (!deps.assistantTools) {
      return reply.code(503).send({ error: "assistant_not_configured" });
    }
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const at = now();
    const planRow = await deps.db.assistantPlan.findUnique({ where: { id: parsed.data.planId } });
    if (!planRow || planRow.userId !== user.id) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    // A future street option has nothing to confirm — the detector pays
    // when the car parks there. Refuse BEFORE minting anything.
    if (planRow.kind === "single_spot" && parsed.data.optionId !== undefined) {
      const plan = planRow.plan as SingleSpotPlan;
      const option = plan.options.find((o) => o.id === parsed.data.optionId);
      if (option?.type === "street" && option.payOnArrival === true) {
        await deps.db.decision.create({
          data: {
            kind: "assistant_confirm",
            inputs: { planId: planRow.id, optionId: option.id },
            rule: "street_pay_on_arrival",
            outcome: { allowed: false },
            userId: user.id,
          },
        });
        return reply.code(409).send({ error: "street_pay_on_arrival" });
      }
    }

    // The tap IS the authorization: mint the single-use token here and
    // nowhere else, then run the consequential tool through the same
    // gate the model faces.
    const token = randomBytes(24).toString("base64url");
    await deps.db.assistantConfirmation.create({
      data: {
        token,
        userId: user.id,
        planId: planRow.id,
        optionId: parsed.data.optionId ?? null,
        expiresAt: new Date(at.getTime() + CONFIRMATION_TTL_MS),
      },
    });
    const decide = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: {
          kind: "assistant_confirm",
          inputs: {
            planId: planRow.id,
            optionId: parsed.data.optionId ?? null,
            kind: planRow.kind,
          },
          rule,
          outcome,
          userId: user.id,
        },
      });
    const ctx = { userId: user.id, conversationId: planRow.conversationId };

    const linkEnabled =
      deps.linkWallet?.configured === true &&
      deps.policy.get().link_wallet_for_plans !== false &&
      (await deps.linkWallet.status(user.id)).connected;

    if (planRow.kind === "single_spot") {
      const plan = planRow.plan as SingleSpotPlan;
      const option = plan.options.find((o) => o.id === parsed.data.optionId);
      if (!option) {
        await decide("unknown_option", { allowed: false });
        return reply.code(400).send({ error: "unknown_option" });
      }

      // Link leg: one spend request for this option, approved by the
      // user at the returned URL. Failure to create one never blocks the
      // confirm — it falls back to the Issuing card and says so.
      let linkApproval: { spendRequestId: string; approvalUrl: string | null } | null = null;
      if (linkEnabled && option.priceUsd > 0) {
        try {
          const created = await deps.linkWallet!.createSpendRequestsForStops(user.id, {
            planId: planRow.id,
            stops: [
              {
                stopId: option.id,
                label: option.label,
                amountUsd: option.priceUsd,
                ...merchantFor(option),
              },
            ],
          });
          linkApproval = created[0]
            ? { spendRequestId: created[0].spendRequestId, approvalUrl: created[0].approvalUrl }
            : null;
        } catch (err) {
          req.log.warn(
            { linkError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
            "link spend request failed; falling back to issuing card",
          );
        }
      }
      const paymentSource = linkApproval ? "link_wallet" : "issuing_card";

      if (option.type === "garage") {
        const outcome = await deps.assistantTools.execute(ctx, "book_garage", {
          option_id: option.garageOptionId ?? option.id,
          confirmation_token: token,
        });
        const booked = outcome.result as { deepLink?: string | null; error?: string };
        if (booked.error && booked.error !== "needs_confirmation" && option.deepLink) {
          // The provider's search cache expired (10 min, per process) —
          // the stored plan's own deepLink still hands the user off.
          await decide("garage_confirmed", {
            allowed: true,
            optionId: option.id,
            paymentSource,
            cacheExpired: true,
            linkSpendRequestId: linkApproval?.spendRequestId ?? null,
          });
          return {
            kind: "garage_handoff",
            deepLink: option.deepLink,
            paymentSource,
            linkApproval,
            note: garageHandoffNote(option.provider, option.deepLink),
          };
        }
        if (booked.error) {
          await decide("book_failed", { allowed: true, error: booked.error });
          return reply.code(409).send({ error: "book_failed", detail: booked.error });
        }
        await decide("garage_confirmed", {
          allowed: true,
          optionId: option.id,
          paymentSource,
          linkSpendRequestId: linkApproval?.spendRequestId ?? null,
        });
        return {
          kind: "garage_handoff",
          deepLink: booked.deepLink ?? option.deepLink ?? null,
          paymentSource,
          linkApproval,
          note: garageHandoffNote(option.provider, option.deepLink),
        };
      }

      const outcome = await deps.assistantTools.execute(ctx, "start_session", {
        zone: option.zoneId ?? "",
        duration_minutes: option.durationMinutes,
        confirmation_token: token,
      });
      const confirmed = outcome.result as { error?: string; zoneId?: string };
      if (confirmed.error) {
        await decide("start_failed", { allowed: true, error: confirmed.error });
        return reply.code(409).send({ error: "start_failed", detail: confirmed.error });
      }
      await decide("street_confirmed", {
        allowed: true,
        optionId: option.id,
        zoneId: option.zoneId,
        paymentSource,
        linkSpendRequestId: linkApproval?.spendRequestId ?? null,
      });
      // The pay-by-app number, so the client can show something the user
      // can verify against the posted sign — zoneId is an internal slug
      // and must never surface in chat copy.
      const zoneRow = option.zoneId
        ? await deps.db.zone.findUnique({ where: { zoneId: option.zoneId } })
        : null;
      return {
        kind: "street_confirmed",
        zoneId: option.zoneId,
        providerZoneNumber: zoneRow?.providerZoneNumber || null,
        durationMinutes: option.durationMinutes,
        paymentSource,
        linkApproval,
      };
    }

    // Itinerary sign-off: the whole day at once. Re-check the cap at the
    // moment of truth — spend may have moved since the proposal.
    const plan = planRow.plan as ItineraryPlan;
    const totalUsd = itineraryTotalUsd(plan.stops);
    const spentTodayUsd = await spentToday(deps.db, user.id, at);
    const policy = deps.policy.get();
    if (spentTodayUsd + totalUsd > policy.daily_cap_usd) {
      await decide("over_daily_cap", { allowed: false, totalUsd, spentTodayUsd });
      return reply.code(409).send({
        error: "over_daily_cap",
        totalUsd,
        spentTodayUsd,
        capUsd: policy.daily_cap_usd,
      });
    }
    const itineraryId = randomUUID();
    let approvals: { stopId: string; spendRequestId: string; approvalUrl: string | null }[] = [];
    if (linkEnabled) {
      const paidStops = plan.stops.filter((s) => s.costUsd > 0);
      try {
        approvals = await deps.linkWallet!.createSpendRequestsForStops(user.id, {
          planId: planRow.id,
          itineraryId,
          stops: paidStops.map((s) => ({
            stopId: s.id,
            label: s.label,
            amountUsd: s.costUsd,
            ...merchantFor({
              type: s.choice,
              zoneId: s.zoneId,
              ...(s.deepLink ? { deepLink: s.deepLink } : {}),
            }),
          })),
        });
      } catch (err) {
        req.log.warn(
          { linkError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
          "link spend requests failed; itinerary falls back to issuing card",
        );
        approvals = [];
      }
    }
    await deps.db.itinerary.create({
      data: {
        id: itineraryId,
        userId: user.id,
        planId: planRow.id,
        status: "signed_off",
        date: new Date(plan.date),
        stops: plan.stops.map((s) => ({
          ...s,
          sessionId: null,
          garageLinkPushedAt: null,
          paymentSource: approvals.some((a) => a.stopId === s.id) ? "link_wallet" : "issuing_card",
        })),
        totalUsd,
      },
    });
    await decide("itinerary_signed_off", {
      allowed: true,
      itineraryId,
      totalUsd,
      stops: plan.stops.length,
      linkApprovals: approvals.length,
    });
    return {
      kind: "itinerary_signed_off",
      itineraryId,
      totalUsd,
      capUsd: policy.daily_cap_usd,
      paymentSource: approvals.length > 0 ? "link_wallet" : "issuing_card",
      linkApprovals: approvals,
    };
  });

  app.get("/assistant/itineraries", { preHandler: limitOther }, async (req) => {
    const user = req.authedUser!;
    const rows = await deps.db.itinerary.findMany({ where: { userId: user.id } });
    return {
      itineraries: rows
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 10)
        .map((r) => ({
          id: r.id,
          status: r.status,
          date: r.date.toISOString(),
          stops: r.stops,
          totalUsd: Number(r.totalUsd),
        })),
    };
  });

  app.patch("/assistant/itineraries/:id", { preHandler: limitOther }, async (req, reply) => {
    const parsed = patchItinerarySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    const row = await deps.db.itinerary.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) {
      return reply.code(404).send({ error: "itinerary_not_found" });
    }
    if (row.status !== "signed_off") {
      return reply.code(409).send({ error: "itinerary_not_editable", status: row.status });
    }
    const totalUsd = itineraryTotalUsd(parsed.data.stops);
    const spentTodayUsd = await spentToday(deps.db, user.id, now());
    const policy = deps.policy.get();
    if (spentTodayUsd + totalUsd > policy.daily_cap_usd) {
      return reply.code(409).send({
        error: "over_daily_cap",
        totalUsd,
        spentTodayUsd,
        capUsd: policy.daily_cap_usd,
      });
    }
    // Preserve per-stop linkage (sessions, pushes, payment source) for
    // stops that survive the edit, keyed by stop id.
    const previous = new Map(
      (row.stops as Record<string, unknown>[]).map((s) => [String(s["id"]), s]),
    );
    const stops = parsed.data.stops.map((s) => ({
      ...s,
      sessionId: previous.get(s.id)?.["sessionId"] ?? null,
      garageLinkPushedAt: previous.get(s.id)?.["garageLinkPushedAt"] ?? null,
      paymentSource: previous.get(s.id)?.["paymentSource"] ?? "issuing_card",
    }));
    await deps.db.itinerary.update({ where: { id }, data: { stops, totalUsd } });
    await deps.db.decision.create({
      data: {
        kind: "assistant_confirm",
        inputs: { itineraryId: id, edit: true, stops: stops.length },
        rule: "itinerary_edited",
        outcome: { totalUsd },
        userId: user.id,
      },
    });
    return { id, stops, totalUsd, capUsd: policy.daily_cap_usd };
  });
}
