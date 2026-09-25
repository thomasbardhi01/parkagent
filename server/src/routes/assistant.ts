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
import {
  editedItineraryStopSchema,
  itineraryTotalUsd,
  orderStopsByArrival,
} from "../services/assistant/plans.js";
import type { ItineraryPlan, SingleSpotPlan } from "../services/assistant/plans.js";
import { garageHandoffNote, garageProviderInfo } from "../services/garage/garageProvider.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import { easternIso, nycStartOfDay, parseEasternTime } from "../services/hours.js";
import { LINK_PENDING_STATUSES, linkSpentSince } from "../services/link/linkSpend.js";
import { makeRateLimiter } from "../services/rateLimit.js";
import { spentToday } from "../services/sessions.js";
import { normalizeSource } from "../services/wallet/summary.js";

/** A plan time (offset honored, offset-less read as ET wall clock). */
function parseStart(value: string): Date | null {
  return parseEasternTime(value);
}

function endOf(start: Date | null, minutes: number): Date | null {
  return start ? new Date(start.getTime() + minutes * 60_000) : null;
}

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
  stops: z.array(editedItineraryStopSchema).min(1).max(12),
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
    // What the cap checks below saw, filled in once measured.
    const spendInputs: Record<string, number> = {};
    const decide = (rule: string, outcome: Record<string, unknown>) =>
      deps.db.decision.create({
        data: {
          kind: "assistant_confirm",
          inputs: {
            planId: planRow.id,
            optionId: parsed.data.optionId ?? null,
            kind: planRow.kind,
            ...spendInputs,
          },
          rule,
          outcome,
          userId: user.id,
        },
      });
    const ctx = { userId: user.id, conversationId: planRow.conversationId };

    // How this confirm pays. The user's Wallet source decides:
    //  - street meters: the card on their provider account, or the
    //    ParkAgent card (paid at the curb through /session/start). Link
    //    never pays a street meter — see linkWallet.ts.
    //  - garages: Link when it's the active source (one spend request per
    //    paid garage stop, approved in Link, used at the garage's own
    //    checkout); otherwise the user pays at that checkout themselves.
    const userRow = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    const activeSource = normalizeSource(userRow?.paymentSource);
    const streetSource = activeSource === "parkagent_card" ? "parkagent_card" : "provider_card";
    const policy = deps.policy.get();
    const dryRun = deps.policy.effectiveDryRun();
    const linkActive =
      activeSource === "link_wallet" &&
      deps.linkWallet?.configured === true &&
      policy.link_wallet_for_plans !== false &&
      (await deps.linkWallet.status(user.id)).connected;
    // A spend request becomes a spendable card once approved, so it is a
    // money path: never under dry run unless Link itself is in test mode
    // (test requests carry test:true and can't charge).
    const linkBlockedByDryRun = linkActive && dryRun && deps.linkWallet?.testMode !== true;
    // Today's spend, whatever paid (approved Link garages included).
    const spentTodayUsd = await spentToday(deps.db, user.id, at);
    // Requests still awaiting approval become spend the moment the user
    // approves them, so they hold their room too: two confirms can't each
    // fit the cap and together pass it.
    const linkPendingTodayUsd = linkActive
      ? await linkSpentSince(deps.db, user.id, nycStartOfDay(at), LINK_PENDING_STATUSES)
      : 0;
    Object.assign(spendInputs, {
      spentTodayUsd,
      ...(linkActive ? { linkPendingTodayUsd } : {}),
    });

    /** Whether Link may be asked for `amountUsd` right now, and why not. */
    const linkGate = (amountUsd: number, alreadyRequestedUsd = 0): string | null => {
      if (!linkActive) return "link_not_active";
      if (amountUsd <= 0) return "free";
      if (linkBlockedByDryRun) return "dry_run";
      if (amountUsd > policy.session_cap_usd) return "session_cap_exceeded";
      if (
        spentTodayUsd + linkPendingTodayUsd + alreadyRequestedUsd + amountUsd >
        policy.daily_cap_usd
      ) {
        return "daily_cap_exceeded";
      }
      return null;
    };

    if (planRow.kind === "single_spot") {
      const plan = planRow.plan as SingleSpotPlan;
      const option = plan.options.find((o) => o.id === parsed.data.optionId);
      if (!option) {
        await decide("unknown_option", { allowed: false });
        return reply.code(400).send({ error: "unknown_option" });
      }

      if (option.type === "garage") {
        // Link leg: one spend request for this garage, approved by the user
        // at the returned URL. A refusal (dry run, a cap) or a failure to
        // create one never blocks the handoff — the user can still pay at
        // the garage's checkout — and the response says why.
        let linkApproval: { spendRequestId: string; approvalUrl: string | null } | null = null;
        let linkSkipped: string | null =
          activeSource === "link_wallet" ? linkGate(option.priceUsd) : null;
        if (activeSource === "link_wallet" && linkSkipped === null) {
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
            linkSkipped = "link_failed";
            req.log.warn(
              { linkError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
              "link spend request failed; the garage's own checkout still works",
            );
          }
        }
        const paymentSource = linkApproval ? "link_wallet" : "garage_checkout";

        const outcome = await deps.assistantTools.execute(ctx, "book_garage", {
          option_id: option.garageOptionId ?? option.id,
          confirmation_token: token,
        });
        const booked = outcome.result as { deepLink?: string | null; error?: string };
        const cacheExpired =
          booked.error !== undefined && booked.error !== "needs_confirmation" && !!option.deepLink;
        if (booked.error && !cacheExpired) {
          await decide("book_failed", { allowed: true, error: booked.error });
          return reply.code(409).send({ error: "book_failed", detail: booked.error });
        }
        // The provider's search cache expires (10 min, per process); the
        // stored plan's own deepLink still hands the user off.
        const deepLink = cacheExpired
          ? option.deepLink!
          : (booked.deepLink ?? option.deepLink ?? null);
        const booking = await deps.db.garageBooking.create({
          data: {
            userId: user.id,
            planId: planRow.id,
            optionId: option.id,
            provider: option.provider ?? null,
            label: option.label,
            priceUsd: option.priceUsd,
            startsAt: option.startsAt ? parseStart(option.startsAt) : null,
            endsAt: option.startsAt
              ? endOf(parseStart(option.startsAt), option.durationMinutes)
              : null,
            deepLink,
            paymentSource: activeSource,
            linkSpendRequestId: linkApproval?.spendRequestId ?? null,
            status: "handed_off",
          },
        });
        await decide("garage_confirmed", {
          allowed: true,
          optionId: option.id,
          paymentSource,
          activeSource,
          ...(cacheExpired ? { cacheExpired: true } : {}),
          bookingId: booking.id,
          linkSpendRequestId: linkApproval?.spendRequestId ?? null,
          ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
        });
        return {
          kind: "garage_handoff",
          deepLink,
          paymentSource,
          linkApproval,
          ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
          bookingId: booking.id,
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
        paymentSource: streetSource,
        activeSource,
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
        paymentSource: streetSource,
        linkApproval: null,
      };
    }

    // Itinerary sign-off: the whole day at once. Re-check the cap at the
    // moment of truth — spend may have moved since the proposal.
    const plan = planRow.plan as ItineraryPlan;
    const totalUsd = itineraryTotalUsd(plan.stops);
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
    // Link approves each paid GARAGE stop (no batch approval exists);
    // street stops pay at the curb with the street source.
    let approvals: { stopId: string; spendRequestId: string; approvalUrl: string | null }[] = [];
    let linkSkipped: string | null = null;
    if (activeSource === "link_wallet") {
      const paidGarages = plan.stops.filter((s) => s.choice === "garage" && s.costUsd > 0);
      const garagesTotal = paidGarages.reduce((sum, s) => sum + s.costUsd, 0);
      const overStop = paidGarages.find((s) => s.costUsd > policy.session_cap_usd);
      linkSkipped = overStop
        ? "session_cap_exceeded"
        : paidGarages.length === 0
          ? null
          : linkGate(garagesTotal);
      if (linkSkipped === "free") linkSkipped = null;
      if (linkSkipped === null && paidGarages.length > 0) {
        try {
          approvals = await deps.linkWallet!.createSpendRequestsForStops(user.id, {
            planId: planRow.id,
            itineraryId,
            stops: paidGarages.map((s) => ({
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
          linkSkipped = "link_failed";
          req.log.warn(
            { linkError: err instanceof Error ? err.message.split("\n")[0] : String(err) },
            "link spend requests failed; garage stops fall back to their own checkout",
          );
          approvals = [];
        }
      }
    }
    const stopSource = (s: { id: string; choice: "street" | "garage" }) =>
      s.choice === "street"
        ? streetSource
        : approvals.some((a) => a.stopId === s.id)
          ? "link_wallet"
          : "garage_checkout";
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
          paymentSource: stopSource(s),
        })),
        totalUsd,
      },
    });
    for (const s of plan.stops.filter((stop) => stop.choice === "garage")) {
      const arrival = parseStart(s.arrival);
      await deps.db.garageBooking.create({
        data: {
          userId: user.id,
          planId: planRow.id,
          itineraryId,
          optionId: s.id,
          provider: garageProviderInfo(undefined, s.deepLink)?.id ?? null,
          label: s.label,
          priceUsd: s.costUsd,
          startsAt: arrival,
          endsAt: arrival ? endOf(arrival, s.durationMinutes) : null,
          deepLink: s.deepLink ?? null,
          paymentSource: activeSource,
          linkSpendRequestId: approvals.find((a) => a.stopId === s.id)?.spendRequestId ?? null,
          status: "planned",
        },
      });
    }
    await decide("itinerary_signed_off", {
      allowed: true,
      itineraryId,
      totalUsd,
      stops: plan.stops.length,
      activeSource,
      linkApprovals: approvals.length,
      ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
    });
    return {
      kind: "itinerary_signed_off",
      itineraryId,
      totalUsd,
      capUsd: policy.daily_cap_usd,
      paymentSource: activeSource,
      linkApprovals: approvals,
      ...(linkSkipped && linkSkipped !== "link_not_active" ? { linkSkipped } : {}),
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
          // Arrival order (untimed stops where the user put them), even
          // for a day stored before the rule existed.
          stops: orderStopsByArrival(r.stops as { arrival?: string | null }[]),
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
    // A time is either cleared (null — "no set time") or readable: an
    // unreadable one would silently order as untimed and never trigger
    // the worker's garage push.
    const unreadable = parsed.data.stops.find((s) => s.arrival && !parseEasternTime(s.arrival));
    if (unreadable) {
      return reply
        .code(400)
        .send({ error: "unreadable_time", stopId: unreadable.id, value: unreadable.arrival });
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
    // A stop new to the day pays like a fresh one: street with the user's
    // street source, a garage at its own checkout (no Link request exists
    // for it).
    const userRow = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    const streetSource =
      normalizeSource(userRow?.paymentSource) === "parkagent_card"
        ? "parkagent_card"
        : "provider_card";
    // Stored in the one canonical form sign-off uses (ET with its offset),
    // and in arrival order — the same rule the app displays with, so a
    // client can't store a later stop above an earlier one.
    const edited = parsed.data.stops.map((s) => ({
      ...s,
      arrival: s.arrival ? easternIso(parseEasternTime(s.arrival)!) : null,
    }));
    const stops = orderStopsByArrival(edited).map((s) => ({
      ...s,
      sessionId: previous.get(s.id)?.["sessionId"] ?? null,
      garageLinkPushedAt: previous.get(s.id)?.["garageLinkPushedAt"] ?? null,
      paymentSource:
        previous.get(s.id)?.["paymentSource"] ??
        (s.choice === "street" ? streetSource : "garage_checkout"),
    }));
    await deps.db.itinerary.update({ where: { id }, data: { stops, totalUsd } });
    await deps.db.decision.create({
      data: {
        kind: "assistant_confirm",
        inputs: {
          itineraryId: id,
          edit: true,
          stops: stops.length,
          untimedStops: stops.filter((s) => s.arrival === null).length,
        },
        rule: "itinerary_edited",
        outcome: { totalUsd },
        userId: user.id,
      },
    });
    return { id, stops, totalUsd, capUsd: policy.daily_cap_usd };
  });
}
